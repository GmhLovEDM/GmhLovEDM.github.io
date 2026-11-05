---
title: "Mixture of Experts Internals: Routing, Load Balancing, Expert Parallelism and Serving Sparse Transformers"
tag: ai
description: How sparse MoE Transformers actually work — token-choice versus expert-choice routing, top-k gating and auxiliary balance losses, capacity factors and dropless designs, shared experts in DeepSeekMoE, expert parallelism with all-to-all, and what Mixtral, Switch, GShard, ST-MoE and DeepSeek-V3 changed for training and serving stacks such as vLLM
date: "2026-11-05T11:20:00.000Z"
---

## Goal

Dense Transformers apply the same feed-forward weights to every token. Mixture-of-Experts (MoE) layers break that rule: a cheap **router** picks a small subset of expert MLPs per token, so total parameter count can grow far past what dense FLOPs would allow, while activated compute per token stays roughly constant. That idea powered GShard and Switch Transformer, then re-entered the open ecosystem with Mixtral and DeepSeekMoE / DeepSeek-V2/V3.

This article focuses on the systems and algorithms that make sparse MoE work in practice — not on a high-level "bigger models are better" story:

1. What an MoE layer replaces inside a Transformer, and the capacity versus FLOP trade-off.
2. Token-choice versus expert-choice routing.
3. Top-k gating, gate values, and a verified NumPy walk-through.
4. Load balancing: auxiliary losses, capacity factors, dropping, dropless MoE, and DeepSeek-V3's bias-based scheme.
5. Expert parallelism, all-to-all dispatch/combine, and communication shape.
6. Shared experts and fine-grained expert segmentation (DeepSeekMoE).
7. How Switch, Mixtral, ST-MoE and DeepSeek-V3 differ in routing choices.
8. Serving implications for engines in the vLLM / SGLang / TensorRT-LLM family.
9. When MoE beats dense models — and when it does not.

## 1. Sparse capacity, dense FLOPs

In a standard Transformer block the expensive piece after attention is the position-wise FFN (often SwiGLU today): two or three dense linear maps applied identically to every token. An MoE layer keeps the attention path dense and replaces that FFN with a bank of expert FFNs plus a router.

For each token \(x\):

1. The router produces scores over \(N\) experts.
2. A sparse rule keeps only \(k\) experts (\(k \ll N\)).
3. Those \(k\) experts run on \(x\); their outputs are combined with the gate weights.
4. Unchosen experts do no compute for that token.

So if each expert has \(P\) parameters, total MoE parameters are about \(N \cdot P\) (plus a tiny router), while activated parameters per token are about \(k \cdot P\). Mixtral 8×7B is the canonical open illustration: eight experts per MoE layer, top-2 routing, roughly 47B total parameters but only about 13B activated per token (Jiang et al., 2024). DeepSeek-V3 pushes the same idea further: 671B total parameters with 37B activated per token (DeepSeek-AI, 2024).

Attention, embeddings and the residual stream still see every token. MoE is a **conditional compute** bet on the FFN path: more memory footprint and more communication, in exchange for more capacity at nearly fixed FLOPs per token.

```text
 token x
    │
    ▼
 router  →  scores over N experts  →  keep top-k
    │
    ├──▶ expert e₁(x) ──┐
    ├──▶ expert e₂(x) ──┼── weighted sum → y
    └──▶ ...            │
```

Two numbers matter when you compare MoE to dense:

- **Activated FLOPs / token** — should stay close to a dense baseline you could afford to train or serve.
- **Total parameters resident in memory** — grows with \(N\), and that is what EP and quantization have to carry.

If someone quotes only total parameters ("671B MoE"), they are describing capacity. If they quote only activated parameters ("37B active"), they are describing compute. You need both to reason about quality, cost and hardware.

## 2. Token-choice versus expert-choice

Almost every production LLM MoE uses **token-choice** routing: each token independently picks its top-k experts. That is natural for autoregressive decoding (one token arrives at a time) and matches Switch, Mixtral and DeepSeekMoE.

The failure mode is load imbalance. Popular experts get flooded; unpopular ones starve. Training systems therefore introduce a **capacity** per expert — a hard budget of how many tokens an expert may accept in a micro-batch — and either drop the overflow or pay for padding. Dropped tokens lose that expert's contribution (often replaced by a residual or zeros), which hurts quality if dropping is frequent.

**Expert-choice** routing (Zhou et al., 2022) flips the assignment: each expert selects its top-c tokens by affinity. By construction every expert fills its capacity, so load is balanced without an auxiliary loss. The cost is that a given token may be taken by zero, one, or many experts — variable expert fan-in per token — which complicates both training dynamics and decode-time serving. Expert-choice is important research context; most open LLM checkpoints you actually run still use token-choice.

A third historical variant is **noisy top-k** from Shazeer et al. (2017): Gaussian noise is added to the gate logits before selecting experts, which encourages exploration early in training so a few experts cannot monopolize the batch from step one. Modern LLM MoEs often replace explicit noise with careful initialization, auxiliary terms, or DeepSeek-style bias updates.

## 3. Top-k gating, step by step

The classic sparsely-gated MoE (Shazeer et al., 2017) and its Transformer descendants share the same core math. Let \(W_r\) be the router matrix. For token \(x\):

\[
h = W_r x, \qquad
p_i = \frac{e^{h_i}}{\sum_j e^{h_j}}
\]

Keep the top-k indices \(\mathcal{T}\). The layer output is

\[
y = \sum_{i \in \mathcal{T}} p_i \, E_i(x)
\]

(sometimes with \(p_i\) renormalized over the selected experts only). Switch Transformer argued that **k = 1** is enough if training is stabilized, which cuts communication versus top-2 (Fedus, Zoph and Shazeer, 2021). Mixtral kept **k = 2** with eight experts. DeepSeek-V3 activates **eight** routed experts out of 256, plus shared experts (see §6), and uses **sigmoid** affinities with normalization over the selected set rather than a full softmax over all experts.

Below is a compact NumPy illustration of softmax top-k routing and the Switch-style auxiliary load-balance term. Torch is not installed on the machine used to verify this snippet; NumPy 2.x is.

```python
import numpy as np

def softmax(x, axis=-1):
    x = x - np.max(x, axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)

def topk_route(x, W_r, k):
    """x: (B, D), W_r: (D, E) → gates (B, k), indices (B, k)"""
    logits = x @ W_r
    probs = softmax(logits, axis=-1)
    # argpartition is O(E); fine for didactic E
    idx = np.argpartition(-probs, k - 1, axis=-1)[:, :k]
    rows = np.arange(x.shape[0])[:, None]
    gates = probs[rows, idx]
    gates = gates / gates.sum(axis=-1, keepdims=True)
    return gates, idx, probs

def switch_aux_loss(probs, idx, k):
    """Switch-style: E * sum_i f_i * P_i (batch-averaged)."""
    B, E = probs.shape
    rows = np.arange(B)[:, None]
    one_hot = np.zeros_like(probs)
    one_hot[rows, idx] = 1.0 / k
    f = one_hot.mean(axis=0)          # fraction of tokens routed to expert i
    P = probs.mean(axis=0)            # mean router probability for expert i
    return float(E * np.sum(f * P))

rng = np.random.default_rng(0)
B, D, E, K = 8, 16, 8, 2
x = rng.normal(size=(B, D))
W_r = rng.normal(size=(D, E)) * 0.1
gates, idx, probs = topk_route(x, W_r, K)
aux = switch_aux_loss(probs, idx, K)
assert np.allclose(probs.sum(-1), 1.0)
assert np.allclose(gates.sum(-1), 1.0)
print("aux", round(aux, 4), "idx[0]", idx[0].tolist())
```

On a fixed seed this prints `aux 1.0489` and the top-2 expert indices for the first row. In a real training step you would dispatch tokens to expert modules (often remote ranks), run the FFNs, then combine with `gates`.

### 3.1 A tiny end-to-end MoE step (single device)

The next snippet shows the full gather → expert MLP → scatter-combine pattern with toy linear experts. It is still NumPy-only, but the shapes match what a fused CUDA kernel hides.

```python
def moe_forward(x, W_r, expert_w1, expert_w2, k):
    """x: (B, D); expert_w1: (E, H, D); expert_w2: (E, D, H)"""
    gates, idx, _ = topk_route(x, W_r, k)          # (B, k), (B, k)
    B, D = x.shape
    E, H, _ = expert_w1.shape
    out = np.zeros((B, D), dtype=x.dtype)
    # naive loop for clarity — real systems use grouped GEMM
    for b in range(B):
        for j in range(k):
            e = int(idx[b, j])
            h = np.maximum(0.0, expert_w1[e] @ x[b])  # ReLU MLP
            y = expert_w2[e] @ h
            out[b] += gates[b, j] * y
    return out

H = 32
expert_w1 = rng.normal(size=(E, H, D)) * 0.05
expert_w2 = rng.normal(size=(E, D, H)) * 0.05
y = moe_forward(x, W_r, expert_w1, expert_w2, K)
assert y.shape == x.shape
print("moe out std", float(y.std()))
```

Router **z-loss** (ST-MoE; Zoph et al., 2022) adds a penalty on \(\log\sum_i e^{h_i}\) (or similar) so router logits stay well-scaled; without it, deep sparse stacks can diverge even when the aux balance term looks healthy.

## 4. Load balancing without wrecking quality

Unbalanced routing is both a quality bug (collapsed experts) and a systems bug (stragglers under expert parallelism). Three families of fixes dominate.

### 4.1 Auxiliary load-balance loss

GShard and Switch popularized an auxiliary term proportional to \(\sum_i f_i P_i\) (scaled by \(N\)), encouraging the fraction of tokens hard-assigned to expert \(i\) to track the mean router probability for \(i\). Ideal balance gives \(f_i = P_i = 1/N\) and the scaled term equals \(1\). When the loss weight is too large, the router optimizes balance at the expense of task loss — experts become interchangeable and quality drops. ST-MoE and later work treat that weight as a first-class hyper-parameter and often combine it with z-loss.

### 4.2 Capacity factor and dropping

For a micro-batch of \(T\) tokens, \(N\) experts and top-k routing, a balanced expert would see about \(k T / N\) tokens. The **capacity factor** \(c\) sets

\[
\mathrm{capacity} = c \cdot \frac{k T}{N}
\]

Tokens beyond capacity are dropped (or buffered). \(c = 1.0\) is tight; values slightly above \(1\) trade compute/memory for fewer drops. Dropping is simple to implement with static shapes — friendly to XLA/TPU — but training signal is partially discarded. Under expert parallelism, capacity also caps how many tokens a rank must receive, which keeps all-to-all buffers bounded.

```python
def apply_capacity(idx, k, n_experts, capacity):
    """Return boolean mask (B, k): False means that assignment is dropped."""
    B = idx.shape[0]
    counts = np.zeros(n_experts, dtype=np.int32)
    keep = np.zeros((B, k), dtype=bool)
    # process in token order — production code may sort by gate score first
    for b in range(B):
        for j in range(k):
            e = int(idx[b, j])
            if counts[e] < capacity:
                keep[b, j] = True
                counts[e] += 1
    return keep, counts

T, capacity_factor = B, 1.25
cap = int(capacity_factor * (K * T) / E)
keep, counts = apply_capacity(idx, K, E, max(cap, 1))
print("capacity", cap, "per-expert counts", counts.tolist(), "kept", int(keep.sum()))
```

### 4.3 Dropless MoE

MegaBlocks (Gale et al., 2022/2023) reformulates MoE compute as **block-sparse** matrix multiplies sized to the actual token→expert assignment. That removes the need to pad to a fixed capacity or drop tokens for shape reasons, at the cost of more complex GPU kernels and variable work per expert. Tutel and FasterMoE attack related bottlenecks (grouped GEMM, communication scheduling, expert placement). Dropless training is attractive on GPUs where dynamic shapes are acceptable; TPU/XLA stacks historically preferred fixed capacity.

### 4.4 Auxiliary-loss-free balancing (DeepSeek-V3)

DeepSeek-V3 keeps sigmoid token–expert affinities and top-k selection, but adds a per-expert **bias** \(b_i\) used only for routing decisions:

\[
\text{route by } s_{i,t} + b_i, \qquad
\text{but mix with } s_{i,t}
\]

After each training step, biases for overloaded experts are decreased and biases for underloaded experts are increased by a step size \(\gamma\). Gate values multiplied onto expert outputs still come from the unbiased affinities, so the balance mechanism does not directly distort the residual mix. The report also keeps a very small complementary sequence-wise balance loss to avoid extreme per-sequence skew, and states that with this scheme DeepSeek-V3 drops no tokens in training (DeepSeek-AI, 2024). Ablations in that report favor the bias scheme over a purely auxiliary-loss baseline on most evaluated benchmarks.

Intuition: the bias is a slow integrator on expert popularity, similar to a control loop, while the aux loss is a per-step soft constraint on the router weights themselves. Soft constraints can fight the main loss; a bias outside the gradient path often fights less.

## 5. Expert parallelism and all-to-all

Once experts no longer fit on one device, **expert parallelism (EP)** places different experts on different ranks. A MoE forward then becomes:

1. **Route** on each rank (local hidden states → expert ids + gates).
2. **Dispatch** all-to-all: send tokens to the ranks that own their experts.
3. **Compute** local experts on the received tokens (often a grouped GEMM).
4. **Combine** all-to-all: return expert outputs to the token's origin rank and weight-sum by gates.

```text
 rank0 tokens ──dispatch──▶ expert shards (EP ranks)
 rank1 tokens ──dispatch──▶        │
                                   ▼
                            local expert FFNs
                                   │
 rank0 ◀──combine──────────────────┤
 rank1 ◀──combine──────────────────┘
```

The communication volume scales with the number of tokens times hidden size times \(k\) (each token is sent to \(k\) experts). Cross-node EP is especially painful because NVLink bandwidth inside a node dwarfs inter-node RDMA. DeepSeek-V3 therefore uses **node-limited routing**: each token may touch at most \(M\) nodes (they use \(M = 4\)), chosen by aggregating affinity mass per node, so IB traffic stays bounded while NVLink finishes intra-node delivery. Their DualPipe schedule overlaps attention/MLP compute with dispatch and combine so that, at their cluster ratio, all-to-all can be nearly hidden (DeepSeek-AI, 2024).

Complementary parallelisms still apply:

| Parallelism | Splits | MoE interaction |
| --- | --- | --- |
| Data (DP / FSDP / ZeRO) | batch | Each DP rank runs its own router; EP groups sit inside |
| Tensor (TP) | matrix dimensions | Attention often TP'd; MoE experts may avoid TP if EP is wide |
| Pipeline (PP) | layers | MoE layers are just heavier PP stages with EP inside |
| Expert (EP) | experts | Dominates MoE communication |

Rule of thumb: widen EP until each expert's token batch is large enough for GEMM efficiency, then stop — extra EP increases all-to-all fan-out without helping arithmetic intensity. DeepSeek-V3's published pre-training layout used 64-way EP spanning 8 nodes together with pipeline and ZeRO-1 data parallelism, deliberately avoiding heavy tensor parallelism on the MoE path to save memory and communication (DeepSeek-AI, 2024).

### 5.1 Dispatch buffer sizing

On each EP rank you need a receive buffer large enough for the worst-case number of tokens that may land on local experts. With capacity factor \(c\), that worst case is bounded; without capacity (dropless), you size from empirical maxima or use dynamic allocation. Inference engines often pre-allocate for the configured max batched tokens times \(k\), then rely on routing constraints (and sometimes redundant experts) to stay inside the buffer.

## 6. Shared experts and fine-grained DeepSeekMoE

Classical MoE treats every expert as interchangeable candidates for top-k. DeepSeekMoE (Dai et al., 2024) adds two structural ideas:

1. **Fine-grained segmentation.** Split what used to be \(N\) coarse experts into \(mN\) smaller ones and activate \(m k\) of them. The activated FLOPs stay comparable, but the combinatorial mixture is richer, which the paper argues improves specialization.
2. **Shared expert isolation.** Always-on shared FFNs capture common knowledge; routed experts specialize. That reduces redundancy among routed experts.

DeepSeek-V3 instantiates this as **1 shared expert + 256 routed experts**, activating **8** routed experts per token, with intermediate size 2048 per expert and sigmoid affinities (DeepSeek-AI, 2024). Mixtral, by contrast, uses eight full-size experts and top-2 with no shared expert — simpler, fewer experts, coarser specialization.

Shared experts also change serving: they are effectively a dense FFN that always runs, often colocated carefully so they do not become a straggler relative to the routed path. DeepSeek's decode deployment notes even treat the shared expert as always selected for load planning, then place replicas of hot routed experts on spare ranks.

## 7. A brief comparative map

| System | Routing | Balance | Notable systems choice |
| --- | --- | --- | --- |
| Shazeer et al. 2017 | noisy top-k | importance / load losses | MoE between LSTMs |
| GShard (2020) | top-2 | aux loss + capacity | automatic sharding on TPU; huge translation MoE |
| Switch (2021) | top-1 | aux loss + capacity | simplified routing; bfloat16 sparse training |
| ST-MoE (2022) | top-k | aux + **router z-loss** | stability and transfer focus |
| Expert-Choice (2022) | experts pick tokens | balanced by design | variable experts per token |
| MegaBlocks (2022) | token-choice | dropless via block-sparse kernels | avoids drop/pad trade-off |
| Mixtral (2024) | top-2 of 8 | standard MoE training | open weights; ~47B total / ~13B active |
| DeepSeekMoE / V3 | top-8 of 256 + shared | **bias** (+ tiny seq aux) | node-limited routing; no token dropping claimed |

MLA (Multi-head Latent Attention) in DeepSeek-V2/V3 is orthogonal to MoE: it compresses the KV cache for attention, while MoE sparsifies the FFN. They compound at serving time — less KV traffic and fewer active FFN weights — but the algorithms are independent; this article stays on the MoE side.

## 8. Serving sparse MoE

Training all-to-all and inference all-to-all rhyme, but decode batches are small and latency-sensitive.

**Prefill** looks like training: long sequences, large token counts, EP can keep experts busy. **Decode** emits one token per sequence per step; without careful batching, each expert sees tiny GEMMs and the router/dispatch overhead dominates. Continuous batching helps by raising the number of concurrent sequences, which indirectly feeds experts more tokens per step.

Practical serving stacks (vLLM's fused MoE path, SGLang, TensorRT-LLM MoE plugins) typically:

- Fuse routing, dispatch, expert GEMM and combine into few kernels to cut memory traffic.
- Support EP across GPUs, sometimes with different all-to-all backends for throughput versus latency.
- Quantize expert weights aggressively (FP8 / INT4-class schemes) because MoE models are memory-heavy relative to activated FLOPs.
- Optionally replicate hot experts (**redundant experts**) so decode load stays even when the prompt distribution drifts from training — DeepSeek-V3's deployment notes describe periodic hot-expert duplication for prefilling and decoding.

vLLM's design docs describe a modular fused MoE kernel that separates prepare/finalize (quantize, all-to-all dispatch/combine) from the expert compute path (permute, matmul, activation, unpermute). That split lets the same expert GEMM talk to multiple communication backends without rewriting the math.

Compared with a dense model of similar **activated** size, MoE serving:

- Needs more GPU memory (all experts resident, unless offloaded).
- Needs more interconnect for EP.
- Can deliver higher quality per activated FLOP when the checkpoint is strong.
- Is more sensitive to batch composition: a batch that over-concentrates on one expert creates a straggler even if average load looks fine.

If your traffic is low-QPS single-stream chat on one GPU, a dense 7B–70B model is often operationally simpler. MoE shines when you have enough concurrent sequences to amortize routing and when memory/interconnect can hold the full expert bank.

### 8.1 Metrics worth watching in production

- Tokens per expert per step (histogram, not only mean).
- Dispatch/combine time versus expert GEMM time.
- Drop rate (if capacity is enabled) or max expert occupancy (if dropless).
- Hot-expert identity drift over hours — a signal to refresh redundant replicas.
- Quality regressions after changing `k`, quantization, or EP degree — routing is brittle under distribution shift.

## 9. Engineering trade-offs versus dense models

**Choose MoE when:**

- You want more capacity without a proportional FLOP increase at training or decode.
- You can afford the memory to store \(N\) experts and the network to EP them.
- Your batch sizes (train micro-batches or served concurrent sequences) keep experts utilized.
- You have the tooling for load metrics, hot-expert replication and fused MoE kernels.

**Prefer dense when:**

- Single-GPU or small-shard deployment matters more than peak quality.
- Latency SLOs cannot absorb dispatch/combine tails.
- You lack mature MoE kernels for your quantization story.
- Fine-tuning workflows assume every parameter sees every token (MoE fine-tuning can under-update cold experts).

A useful mental model: MoE converts **memory and interconnect** into **quality at fixed activated compute**. Dense models convert **compute** into quality more directly. The industry swung back to MoE once memory capacity and collective libraries caught up with the routing research from 2017–2022.

Training cost comparisons should also separate **GPU-hours** from **wall-clock**. Sparse models can use fewer FLOPs per token yet still need large clusters for memory; DeepSeek-V3's report is unusually explicit about H800 GPU-hours for pre-training, context extension and post-training, which is the right unit when you price MoE versus dense.

## Summary

Sparse MoE layers turn the Transformer FFN into a routed bank of experts: top-k token-choice routing is the workhorse; expert-choice flips the assignment for perfect balance at the cost of variable fan-in. Auxiliary losses, capacity factors and dropless block-sparse kernels are three generations of answers to load imbalance; DeepSeek-V3's per-expert routing bias shows you can often balance without a heavy auxiliary term. Expert parallelism makes all-to-all the central systems problem — node-limited routing and compute/communication overlap are how large MoEs stay efficient across nodes. Shared experts and fine-grained segmentation improve specialization, while serving stacks must fuse kernels, manage EP, and sometimes replicate hot experts so decode does not stall. MoE is not free capacity: it is a deliberate exchange of memory and networking for sparse compute, and it wins when that exchange is priced correctly.

## References

- Shazeer et al., "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer" (2017): https://arxiv.org/abs/1701.06538
- Lepikhin et al., "GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding" (2020): https://arxiv.org/abs/2006.16668
- Fedus, Zoph and Shazeer, "Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity" (2021): https://arxiv.org/abs/2101.03961
- Zoph et al., "ST-MoE: Designing Stable and Transferable Sparse Expert Models" (2022): https://arxiv.org/abs/2202.08906
- Zhou et al., "Mixture-of-Experts with Expert Choice Routing" (2022): https://arxiv.org/abs/2202.09368
- Gale et al., "MegaBlocks: Efficient Sparse Training with Mixture-of-Experts" (2022): https://arxiv.org/abs/2211.15841
- Jiang et al., "Mixtral of Experts" (2024): https://arxiv.org/abs/2401.04088
- Dai et al., "DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models" (2024): https://arxiv.org/abs/2401.06066
- DeepSeek-AI, "DeepSeek-V3 Technical Report" (2024): https://arxiv.org/abs/2412.19437
- Microsoft Research, Tutel MoE system overview: https://www.microsoft.com/en-us/research/blog/tutel-an-efficient-mixture-of-experts-implementation-for-large-dnn-model-training/
- vLLM fused MoE modular kernel design (stable docs): https://docs.vllm.ai/en/stable/design/fused_moe_modular_kernel/
- vLLM MoE kernel features (GitHub): https://github.com/vllm-project/vllm/blob/main/docs/design/moe_kernel_features.md
- MegaBlocks implementation: https://github.com/databricks/megablocks
