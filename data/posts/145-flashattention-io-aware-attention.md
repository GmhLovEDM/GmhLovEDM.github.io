---
title: "FlashAttention Deep Dive: IO-Aware Attention, Online Softmax, Tiling and FA2/FA3"
tag: ai
description: Why standard attention is memory-bound rather than compute-bound, how FlashAttention uses tiling, online softmax and recomputation to never materialize the N×N score matrix, what FlashAttention-2 and FlashAttention-3 changed for A100 and H100 GPUs, how Flash-Decoding and paged KV caches fit in, and how to use it from PyTorch SDPA in real training and serving stacks
date: "2026-10-31T13:20:00.000Z"
---

## Goal

Attention is the heart of every Transformer, and for long contexts it dominates both memory and time. In 2022 Tri Dao and colleagues published *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness* and showed something surprising: the standard implementation was not slow because of FLOPs, it was slow because of **memory traffic**. By reorganizing the computation around the GPU memory hierarchy, they got exact attention (no approximation) that was several times faster and used memory linear in sequence length.

This article covers:

1. The GPU memory hierarchy and why naive attention is memory-bound.
2. Online softmax: the trick that makes tiling possible.
3. The FlashAttention forward pass, step by step, with code.
4. The backward pass and why recomputation is cheaper than storage.
5. FlashAttention-2: better parallelism and fewer non-matmul FLOPs.
6. FlashAttention-3: Hopper-specific asynchrony and FP8.
7. Inference: Flash-Decoding, paged KV caches and variable-length batches.
8. Using it in practice, and what it does *not* solve.

## 1. Attention is memory-bound

For a single head with sequence length `N` and head dimension `d`, attention computes:

```text
S = Q Kᵀ / sqrt(d)        # N × N
P = softmax(S)            # N × N, row-wise
O = P V                   # N × d
```

The naive implementation runs these as three separate kernels, writing `S` and `P` to GPU main memory (HBM) and reading them back. For `N = 8192` that is 67M elements per head per matrix. In fp16 that is 128 MiB for `S` alone, per head, per batch element.

The FlashAttention paper frames the cost using the A100's hierarchy:

| Level | Size | Bandwidth (approx.) |
|---|---|---|
| On-chip SRAM (shared memory) | 192 KB per SM, 108 SMs | ~19 TB/s aggregate |
| HBM | 40–80 GB | 1.5–2.0 TB/s |

The matmuls `QKᵀ` and `PV` have high arithmetic intensity. But softmax, masking and dropout are element-wise: each element is read, touched with a few FLOPs, and written back. Those operations are bound by HBM bandwidth, and they operate on the quadratic `N × N` matrices. The result: the GPU's tensor cores spend much of their time waiting on memory.

The key insight is **IO-awareness**: count HBM reads and writes, not just FLOPs. The paper shows standard attention needs `Θ(Nd + N²)` HBM accesses, while FlashAttention needs `Θ(N²d²/M)` where `M` is the SRAM size. For typical `d` (64–128) and `M` (~100 KB), `d²/M` is much smaller than 1, so far fewer bytes move.

## 2. Online softmax

To avoid materializing `S`, we want to process `K` and `V` in blocks and accumulate the output incrementally. The obstacle is softmax: it needs the row maximum (for numerical stability) and the row sum over **all** columns before any output can be normalized.

The fix is the online softmax recurrence (Milakov & Gimelshein, 2018). Keep, for each query row, a running maximum `m` and running denominator `ℓ`. When a new block of scores `s` arrives:

```text
m_new = max(m, max(s))
ℓ_new = exp(m - m_new) * ℓ + sum(exp(s - m_new))
```

The output accumulator gets the same correction:

```text
O_new = exp(m - m_new) * O + exp(s - m_new) @ V_block
```

At the end, divide by `ℓ`. Rescaling by `exp(m_old - m_new)` retroactively fixes the contributions computed under an older maximum. This is algebraically exact, not an approximation.

A tiny NumPy check shows the blocked version matches the reference:

```python
import numpy as np

def attention_ref(q, k, v):
    s = q @ k.T / np.sqrt(q.shape[-1])
    p = np.exp(s - s.max(-1, keepdims=True))
    return (p / p.sum(-1, keepdims=True)) @ v

def attention_tiled(q, k, v, block=64):
    n, d = q.shape
    scale = 1.0 / np.sqrt(d)
    o = np.zeros_like(q)
    m = np.full((n, 1), -np.inf)
    l = np.zeros((n, 1))
    for j in range(0, k.shape[0], block):
        kj, vj = k[j:j+block], v[j:j+block]
        s = (q @ kj.T) * scale                 # n × block, lives in "SRAM"
        m_new = np.maximum(m, s.max(-1, keepdims=True))
        p = np.exp(s - m_new)
        alpha = np.exp(m - m_new)
        l = alpha * l + p.sum(-1, keepdims=True)
        o = alpha * o + p @ vj
        m = m_new
    return o / l

rng = np.random.default_rng(0)
q, k, v = (rng.standard_normal((512, 64)) for _ in range(3))
print(np.abs(attention_ref(q, k, v) - attention_tiled(q, k, v)).max())  # ~1e-15
```

## 3. The forward pass

FlashAttention fuses everything into one kernel:

1. Split `Q` into row blocks `Q_i` and `K, V` into column blocks `K_j, V_j`, sized so that they fit in shared memory together with the accumulators.
2. For each `Q_i` (in FA1 the loop order was outer over `K/V`; FA2 flipped it, see below), load the block into SRAM.
3. For each `K_j, V_j`: compute `S_ij = Q_i K_jᵀ` on tensor cores, apply the causal mask and scale, update `m`, `ℓ`, and the output accumulator with the online-softmax rule, apply dropout in-register if needed.
4. Write only `O_i` (`N × d`) and the per-row log-sum-exp `L_i = m_i + log ℓ_i` (`N` floats) back to HBM.

The `N × N` matrix never touches HBM. Memory goes from `O(N²)` to `O(N)` beyond the inputs and outputs. That is what made 16K, 64K and longer contexts practical to train.

Causal masking adds a free win: blocks entirely above the diagonal are skipped, so roughly half the work disappears.

## 4. The backward pass: recompute instead of store

The gradient of attention needs `P`. The standard implementation saves it from the forward pass, which is again `O(N²)` memory. FlashAttention instead stores only `O` and the log-sum-exp `L`, then **recomputes** `S_ij` and `P_ij = exp(S_ij - L_i)` block by block in the backward kernel.

This costs extra FLOPs, yet the paper reports the backward pass is still faster than the standard one, because the avoided HBM traffic is worth more than the recomputed matmuls. It is the same trade as gradient checkpointing, but done inside a single fused kernel where the recomputation is nearly free.

A useful identity in the backward: `dS = P ∘ (dP - D)` where `D_i = rowsum(dO_i ∘ O_i)`. Computing `D` up front lets every block be processed independently.

## 5. FlashAttention-2

FA1 reached roughly 25–40% of the A100's theoretical peak FLOPs in the forward pass. *FlashAttention-2* (Dao, 2023) reported about 2× speedup over FA1 and up to 73% of peak in the forward pass, via three changes:

- **Fewer non-matmul FLOPs.** On A100, fp16 matmul throughput is 312 TFLOPs, while non-matmul fp32 throughput is only 19.5 TFLOPs. So every exponent and rescale is ~16× more expensive than a matmul FLOP. FA2 delays the final `1/ℓ` division to the end and only stores the log-sum-exp, trimming rescaling work.
- **Parallelism over sequence length.** FA1 parallelized over batch × heads. With long sequences and small batches, that leaves SMs idle. FA2 makes the outer loop over `Q` blocks and parallelizes it across thread blocks, so even batch size 1 fills the GPU.
- **Better work partitioning within a thread block.** FA1 split `K/V` across warps ("split-K"), which required warps to exchange partial results through shared memory. FA2 splits `Q` across warps instead, so each warp owns its rows and no inter-warp reduction is needed.

FA2 also added support for head dimensions up to 256 and for multi-query and grouped-query attention (MQA/GQA), where several query heads share one K/V head.

## 6. FlashAttention-3

On H100 (Hopper), FA2 reached only about 35% utilization, because Hopper's tensor cores are so fast that everything else becomes the bottleneck. *FlashAttention-3* (Shah, Bikshandi, Zhang, Thakkar, Ramani, Dao, 2024) uses Hopper-specific features:

- **Asynchrony via warp specialization.** Producer warps issue TMA (Tensor Memory Accelerator) loads while consumer warps run WGMMA (asynchronous warpgroup matmul) instructions. Data movement and compute overlap.
- **Ping-pong scheduling.** Two warpgroups alternate: while one runs softmax, the other runs its GEMM, hiding the slow exponentials behind matmuls. Within a warpgroup, softmax of one block is also pipelined with the GEMM of the next.
- **FP8 with incoherent processing.** FP8 doubles tensor core throughput but loses precision, and outlier values in LLM activations hurt. FA3 multiplies Q and K by a random orthogonal (Hadamard-based) matrix before quantization, spreading outliers out; the paper reports 2.6× lower numerical error than a baseline FP8 attention.

The paper reports up to 740 TFLOPs in FP16 (about 75% of H100 peak) and close to 1.2 PFLOPs in FP8.

## 7. Inference: decoding is a different problem

During autoregressive decoding, each step has **one** query token per sequence attending to a long KV cache. The `Q` block is tiny, so parallelizing over `Q` blocks gives almost no parallelism, and the GPU sits mostly idle at small batch sizes.

**Flash-Decoding** (Dao, Haziza, Massa, Sizov, 2023) splits the **KV sequence** into chunks processed in parallel, each producing a partial output plus its log-sum-exp, then a small reduction kernel combines them with the same rescaling rule as online softmax. The authors reported up to 8× faster decoding for very long sequences.

Two more pieces matter in serving stacks:

- **Paged KV caches.** vLLM's PagedAttention stores KV in fixed-size blocks indexed by a block table. FlashAttention added a `block_table` argument so its kernels can read paged caches directly; FlashInfer is another kernel library built around paged and ragged layouts.
- **Variable-length batches.** `flash_attn_varlen_func` takes packed sequences with cumulative sequence offsets (`cu_seqlens`), avoiding padding waste. This is also how sequence packing in training works without cross-contamination between documents.

## 8. Using it in practice

In PyTorch, the simplest entry point is `scaled_dot_product_attention`, which dispatches to FlashAttention, a memory-efficient kernel (derived from xFormers), cuDNN attention, or the math fallback, depending on dtype, hardware, head dim and masks:

```python
import torch
import torch.nn.functional as F
from torch.nn.attention import sdpa_kernel, SDPBackend

q = torch.randn(2, 16, 8192, 128, device="cuda", dtype=torch.bfloat16)
k = torch.randn_like(q)
v = torch.randn_like(q)

# Force the flash backend; raises if inputs are unsupported.
with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
    out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
```

For more control (GQA, sliding windows, paged KV, varlen), use the `flash-attn` package directly:

```python
from flash_attn import flash_attn_func

# shapes: (batch, seqlen, heads, head_dim); k/v may have fewer heads for GQA
out = flash_attn_func(q, k, v, causal=True, window_size=(4096, 0))
```

Engineering notes:

- **Dtype and hardware.** Flash kernels need fp16 or bf16. FA2 supports Ampere, Ada and Hopper; FA3 targets Hopper. On older GPUs, SDPA falls back to the memory-efficient or math path.
- **Arbitrary masks break the fast path.** A dense boolean mask means reading an `N × N` tensor from HBM, defeating the point. Prefer `is_causal`, sliding windows, or varlen packing. PyTorch's FlexAttention compiles custom score modifications and block-sparse masks into fused kernels when you really need custom patterns.
- **Determinism.** The backward pass uses atomic adds for `dQ` in some configurations, so gradients may not be bit-for-bit reproducible; flash-attn exposes a `deterministic` flag at some speed cost.
- **Numerics.** Results are exact up to floating-point reordering. Small differences versus the math path are expected and not a bug.

### What it does not solve

FlashAttention keeps attention **exact** and still quadratic in FLOPs. It removes the memory wall but not the compute wall. For very long contexts, teams combine it with:

- Sliding-window or block-sparse attention (fewer FLOPs, different model behavior).
- Context parallelism such as Ring Attention, which shards the sequence across GPUs and passes K/V blocks around a ring, reusing the same online-softmax merge.
- KV cache compression in serving: GQA/MQA, multi-head latent attention, or quantized KV.

## Takeaways

- Profile in bytes, not just FLOPs. Element-wise ops on quadratic tensors were the real cost.
- Online softmax turns a global reduction into a streaming one, which unlocks tiling, kernel fusion, Flash-Decoding and Ring Attention alike.
- Recomputation inside a fused kernel can beat storing intermediates.
- Each GPU generation shifts the bottleneck: FA2 optimized for Ampere's matmul/non-matmul gap, FA3 for Hopper's asynchrony and FP8.

## References

- Dao et al., *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*, NeurIPS 2022. [arXiv:2205.14135](https://arxiv.org/abs/2205.14135)
- Dao, *FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning*, 2023. [arXiv:2307.08691](https://arxiv.org/abs/2307.08691)
- Shah et al., *FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision*, 2024. [arXiv:2407.08608](https://arxiv.org/abs/2407.08608)
- Milakov & Gimelshein, *Online normalizer calculation for softmax*, 2018. [arXiv:1805.02867](https://arxiv.org/abs/1805.02867)
- Rabe & Staats, *Self-attention Does Not Need O(n²) Memory*, 2021. [arXiv:2112.05682](https://arxiv.org/abs/2112.05682)
- Dao, Haziza, Massa, Sizov, *Flash-Decoding for long-context inference*, 2023. [PyTorch blog](https://pytorch.org/blog/flash-decoding/)
- [Dao-AILab/flash-attention on GitHub](https://github.com/Dao-AILab/flash-attention)
- [PyTorch `scaled_dot_product_attention` docs](https://pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
