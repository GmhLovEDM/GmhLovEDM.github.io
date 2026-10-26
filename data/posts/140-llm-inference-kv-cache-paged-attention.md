---
title: "Inside LLM Inference Engines: KV Cache, PagedAttention, Continuous Batching and Speculative Decoding"
tag: ai
description: What actually happens between a prompt arriving and tokens streaming back from a modern serving engine such as vLLM or SGLang — the prefill/decode split and why decode is memory-bound, how big the KV cache really is, PagedAttention's block tables and copy-on-write, iteration-level (continuous) batching, chunked prefill, prefix caching with radix trees, speculative decoding's acceptance rule, and prefill/decode disaggregation. Ends with tuning knobs and the trade-offs behind them
date: "2026-10-26T10:20:00.000Z"
---

## Goal

Serving a large language model looks simple from the outside: send a prompt, get tokens back. Inside, an inference engine is mostly a **memory manager and a scheduler** wrapped around a few GPU kernels. Almost every big throughput win of the last few years — PagedAttention, continuous batching, prefix caching, chunked prefill, disaggregated serving — is about using GPU memory and memory bandwidth better, not about doing the math faster.

This article follows a request through an engine like [vLLM](https://github.com/vllm-project/vllm) or [SGLang](https://github.com/sgl-project/sglang) and explains each mechanism from first principles, with small code models of the core ideas. Numbers are computed from public model configs or quoted from the original papers; where something is an engine-specific default it is called out as such, since these change between releases.

## Two Phases: Prefill and Decode

A decoder-only transformer generates text autoregressively. For a request with a prompt of `P` tokens that will produce `N` output tokens, the work splits into two very different phases:

- **Prefill**: all `P` prompt tokens go through the model in one forward pass. Every layer computes attention over the whole prompt in parallel and stores each token's key and value vectors. The pass ends by producing the first output token.
- **Decode**: each subsequent step feeds in exactly **one** new token per sequence, attends to all previous keys/values, and produces the next token. This repeats `N - 1` times.

These phases map onto the two user-visible latency metrics:

| Metric | Meaning | Dominated by |
| --- | --- | --- |
| TTFT (time to first token) | Queueing + prefill | Prompt length, queue depth |
| TPOT / ITL (time per output token / inter-token latency) | Duration of one decode step | Batch size, context length, memory bandwidth |

### Why decode is memory-bound

In a decode step, a batch of `B` sequences each contributes one token. For every weight matrix, the GPU must read the whole matrix from HBM but only performs roughly `2·B` floating-point operations per weight it loads. With 16-bit weights (2 bytes), the **arithmetic intensity** is about `B` FLOPs per byte.

Modern accelerators need far more than that to be compute-bound. An NVIDIA H100 SXM, for example, is specified at roughly 989 dense BF16 TFLOPS and 3.35 TB/s of HBM3 bandwidth, a ratio of roughly 300 FLOPs per byte. So at batch size 1, decode uses well under 1% of the chip's compute; the GPU spends its time streaming weights. Prefill is the opposite: `P` tokens share each weight load, so a long prompt saturates the tensor cores.

Two consequences shape everything else:

1. **Batching decode is almost free** until you approach the compute ridge: reading the weights once for 64 sequences costs about the same as reading them for one. Throughput scales nearly linearly with batch size.
2. What limits batch size is **memory for the KV cache**, not compute.

## How Big Is the KV Cache?

Attention needs the keys and values of every previous token at every layer. Recomputing them each step would make generation quadratic, so engines cache them. Per token:

```
kv_bytes_per_token = 2 (K and V) × num_layers × num_kv_heads × head_dim × bytes_per_element
```

Plugging in public configs (16-bit cache):

| Model | Layers | KV heads × head_dim | KV cache per token |
| --- | --- | --- | --- |
| OPT-13B (MHA) | 40 | 40 × 128 = 5120 | ~800 KB |
| Llama 3 8B (GQA) | 32 | 8 × 128 = 1024 | 128 KiB |
| Llama 3 70B (GQA) | 80 | 8 × 128 = 1024 | 320 KiB |

The OPT-13B figure is the example used in the vLLM paper. For Llama 3 70B, a single 8K-token conversation holds about 2.5 GiB of KV cache, and 32 concurrent such conversations need about 80 GiB — on top of ~140 GB of BF16 weights. This is why the cache, not the weights, decides how many users a node can serve.

Several model-architecture choices exist purely to shrink this number:

- **Multi-Query Attention** (Shazeer, 2019) shares one K/V head across all query heads.
- **Grouped-Query Attention** (Ainslie et al., 2023) shares each K/V head across a group of query heads — Llama 3's 64 query heads use 8 KV heads, an 8× reduction versus full multi-head attention.
- **Multi-head Latent Attention** (DeepSeek-V2, 2024) caches a compressed low-rank latent instead of full K/V.
- **Sliding-window attention** caps how many past tokens a layer can see, bounding cache growth.
- **KV cache quantization** (e.g. FP8) halves the bytes per element at some accuracy cost.

## The Fragmentation Problem and PagedAttention

Early serving systems allocated each request's KV cache as one **contiguous** tensor sized for the maximum possible length (prompt + `max_tokens`). That wastes memory three ways:

- **Reservation**: space for tokens that have not been generated yet sits idle for the request's whole lifetime.
- **Internal fragmentation**: most requests stop well before `max_tokens`, so the tail is never used.
- **External fragmentation**: variable-size contiguous chunks leave unusable gaps between them.

The vLLM paper (Kwon et al., *Efficient Memory Management for Large Language Model Serving with PagedAttention*, SOSP 2023) measured that existing systems used only **20–40%** of KV cache memory for actual token state — 60–80% was wasted.

PagedAttention borrows the operating system's answer: **virtual memory with paging**.

- GPU KV memory is pre-allocated as a pool of fixed-size **physical blocks**, each holding K/V for a fixed number of tokens (vLLM's default block size is 16 tokens).
- Each sequence has a **block table** mapping its logical blocks (tokens 0–15, 16–31, …) to physical block IDs, which need not be contiguous.
- Blocks are allocated **on demand** as the sequence grows; only the last block of each sequence can be partially empty.
- The attention kernel is rewritten to gather K/V through the block table instead of assuming a contiguous tensor.

With this design, waste is bounded by less than one block per sequence; the paper reports under 4% waste and **2–4× higher throughput** than FasterTransformer and Orca at the same latency.

### Sharing and copy-on-write

Because blocks are indirected, multiple sequences can point at the same physical block. Parallel sampling (`n > 1`) and beam search share the prompt's blocks across all candidates, using a **reference count** per block. When a sequence needs to write into a shared, partially filled block, the engine copies it first — exactly like `fork()` with copy-on-write pages.

A minimal model of the allocator:

```python
class BlockAllocator:
    def __init__(self, num_blocks: int, block_size: int = 16):
        self.block_size = block_size
        self.free = list(range(num_blocks))
        self.refcount = [0] * num_blocks

    def alloc(self) -> int:
        if not self.free:
            raise MemoryError("KV cache full: preempt or queue")
        b = self.free.pop()
        self.refcount[b] = 1
        return b

    def share(self, b: int) -> int:
        self.refcount[b] += 1
        return b

    def release(self, b: int) -> None:
        self.refcount[b] -= 1
        if self.refcount[b] == 0:
            self.free.append(b)


class Sequence:
    def __init__(self, alloc: BlockAllocator):
        self.alloc, self.table, self.num_tokens = alloc, [], 0

    def fork(self) -> "Sequence":
        child = Sequence(self.alloc)
        child.table = [self.alloc.share(b) for b in self.table]
        child.num_tokens = self.num_tokens
        return child

    def append_token(self, copy_block) -> None:
        bs = self.alloc.block_size
        if self.num_tokens % bs == 0:            # last block full (or none yet)
            self.table.append(self.alloc.alloc())
        else:
            last = self.table[-1]
            if self.alloc.refcount[last] > 1:    # shared: copy-on-write
                new = self.alloc.alloc()
                copy_block(src=last, dst=new)    # GPU memcpy of one block
                self.alloc.release(last)
                self.table[-1] = new
        self.num_tokens += 1
```

### Preemption

Paging also enables graceful overload. When the pool runs out, the scheduler **preempts** some running sequences: it either swaps their blocks to CPU memory or simply frees them and **recomputes** the cache later (re-running prefill over prompt + generated tokens). Recompute is often cheaper than PCIe transfers because prefill is compute-efficient. Frequent preemption is a sign the batch limits are set too high.

## Continuous (Iteration-Level) Batching

Classic "static" batching groups requests, runs them together until **all** finish, then starts the next batch. Since output lengths vary wildly, short requests sit idle as padding while the longest one finishes, and new arrivals wait for the whole batch.

Orca (Yu et al., OSDI 2022) introduced **iteration-level scheduling**: the scheduler makes a new decision **every decode step**. Finished sequences leave immediately; waiting sequences join at the next step. Combined with paged memory, the batch is always as full as the KV pool allows.

```python
def engine_loop(waiting, running, model, allocator, max_seqs, token_budget):
    while waiting or running:
        # 1. Admit new requests while memory and budget allow.
        budget = token_budget - len(running)          # each decode costs 1 token
        while waiting and len(running) < max_seqs:
            req = waiting[0]
            if req.prompt_len > budget or not allocator.can_fit(req):
                break
            running.append(waiting.pop(0))
            budget -= req.prompt_len

        # 2. One forward pass over a mixed batch: prefills + decodes.
        outputs = model.step(running)

        # 3. Append tokens, stream them out, retire finished sequences.
        for seq, tok in zip(list(running), outputs):
            seq.append(tok)
            stream(seq.id, tok)
            if tok == EOS or seq.num_generated >= seq.max_tokens:
                allocator.free_all(seq)
                running.remove(seq)
```

Making this work required one more trick: different sequences in the batch have different lengths, so attention cannot be one dense batched matmul. Orca's **selective batching** batches the token-wise operations (the linear layers and MLPs, which see a flat list of tokens) and runs attention per sequence. Today's engines do the same with variable-length attention kernels that take the block tables as input.

## Chunked Prefill: Keeping Decode Smooth

Continuous batching mixes prefill and decode in one step, which creates a new problem: a single 30K-token prompt admitted into the batch makes that step take far longer, and **every running user sees a stall** in their token stream.

Sarathi-Serve (Agrawal et al., OSDI 2024) proposed **chunked prefill** with stall-free batching: split long prompts into chunks (say 512–2048 tokens), and in each step fill a fixed **token budget** with all pending decodes first, then as much prefill as fits. Decode steps stay short and predictable, and the prefill's compute fills in the GPU headroom that memory-bound decodes leave unused.

The trade-off is explicit: a smaller budget gives lower, steadier inter-token latency but slower TTFT for long prompts; a larger budget does the opposite. In vLLM this budget is `--max-num-batched-tokens`.

## Prefix Caching: Don't Recompute What You Already Know

Real traffic repeats itself: the same system prompt across all users, the same few-shot examples, the growing history of a multi-turn chat, the same tool definitions in every agent call. Since a block's K/V depends only on the tokens up to and including it, identical prefixes produce identical blocks.

- **Hash-based** (vLLM's automatic prefix caching): each full block is identified by a hash of its tokens plus its parent block's hash. On admission, the engine looks up the request's block hashes and reuses any hits; freed blocks stay in an LRU cache until their memory is needed.
- **Radix tree** (SGLang's RadixAttention, Zheng et al., 2024): cached prefixes are stored in a radix tree keyed by token sequences, which makes longest-prefix matching and LRU eviction of leaves natural. SGLang's scheduler can also order waiting requests to maximize cache hits.

The effect on TTFT for agent workloads — long fixed preambles plus short new turns — is dramatic, because the bulk of prefill disappears. It also explains why hosted APIs bill cached input tokens at a discount, and why it pays to **keep the stable parts of a prompt at the front** and the variable parts at the end: a single changed token early in the prompt invalidates every block after it.

## Speculative Decoding: More Tokens per Weight Load

Decode is memory-bound, so verifying several tokens in one forward pass costs about the same as generating one. Speculative decoding (Leviathan et al., ICML 2023; Chen et al., DeepMind, 2023) exploits that:

1. A cheap **proposer** (speculator) proposes `γ` tokens.
2. The target model scores all `γ` positions in **one** forward pass.
3. Tokens are accepted left to right with a rejection-sampling rule; the first rejected position is redrawn from a corrected distribution.

The acceptance rule guarantees that the output distribution is **exactly** the target model's — this is a lossless speedup, not an approximation:

```python
import numpy as np

def verify(proposed_tokens, q_probs, p_probs, rng):
    """q_probs[i], p_probs[i]: proposer/target distributions at position i.
    p_probs has one extra row for the bonus token after the last proposal."""
    out = []
    for i, x in enumerate(proposed_tokens):
        if rng.random() < min(1.0, p_probs[i][x] / q_probs[i][x]):
            out.append(x)                        # accept
            continue
        residual = np.maximum(p_probs[i] - q_probs[i], 0)
        residual /= residual.sum()
        out.append(rng.choice(len(residual), p=residual))
        return out                               # stop at first rejection
    out.append(rng.choice(len(p_probs[-1]), p=p_probs[-1]))  # all accepted: bonus token
    return out
```

If each proposed token is accepted with probability `α` (assumed independent), the expected tokens per target pass is `(1 − α^(γ+1)) / (1 − α)`. With `α = 0.8` and `γ = 4` that is about 3.4 tokens per pass.

Proposer options trade quality against overhead: a small model from the same family, n-gram/prompt lookup (great for code editing and RAG, where output copies input), extra decoding heads (Medusa), or feature-level speculators (EAGLE). The catch is that speculation spends extra compute to save bandwidth, so its benefit **shrinks as batch size grows** and the GPU becomes compute-bound. It shines for latency-sensitive, low-concurrency serving.

## Disaggregating Prefill and Decode

Even with chunking, prefill and decode compete for the same GPU and want different things: prefill wants compute and benefits from tensor parallelism; decode wants memory capacity and large batches. DistServe (Zhong et al., OSDI 2024) and Splitwise (Patel et al., ISCA 2024) run them on **separate GPU pools**, transferring the KV cache from prefill workers to decode workers over a fast interconnect. Moonshot AI's Mooncake system extends this into a KV-cache-centric architecture with a distributed cache pool spanning GPU, CPU memory and SSD.

Disaggregation lets each pool be sized and parallelized for its own SLO (TTFT for prefill, TPOT for decode). The cost is KV transfer bandwidth and operational complexity; it pays off at large scale with long prompts, and is usually overkill for a single node.

## Kernels Matter Too, Briefly

Everything above is scheduling and memory. The math still has to be fast:

- **FlashAttention** (Dao et al., 2022) tiles attention so the `N × N` score matrix never touches HBM, making attention IO-aware; later versions target newer GPU features.
- **Paged/varlen decode kernels** (vLLM's own, FlashInfer) read K/V through block tables efficiently.
- **CUDA Graphs** capture the decode step to remove per-kernel launch overhead, which matters when each step is only a few milliseconds.
- **Weight quantization** (FP8, INT4 AWQ/GPTQ) directly cuts the bytes read per decode step, which is why it speeds up memory-bound decode even without faster math.

## Practical Tuning

Most knobs map directly to the mechanisms above. Using vLLM flag names:

| Knob | Mechanism | Raise it when | Cost |
| --- | --- | --- | --- |
| `--gpu-memory-utilization` | Size of KV block pool | Preemptions in logs, low concurrency | Less headroom for activations/other processes |
| `--max-num-seqs` | Max concurrent sequences | GPU underutilized at high load | Higher TPOT per user |
| `--max-num-batched-tokens` | Chunked prefill token budget | TTFT too high for long prompts | Burstier inter-token latency |
| `--enable-prefix-caching` | Block reuse across requests | Shared system prompts / multi-turn | Hash lookup overhead (small) |
| `--kv-cache-dtype fp8` | Smaller cache entries | Memory-bound on long contexts | Possible quality loss; validate |
| `--max-model-len` | Upper bound on context | Need long contexts | Fewer sequences fit per block pool |

A few rules of thumb from production setups:

- **Measure TTFT and TPOT separately**, at percentiles, under realistic prompt/output length distributions. Average tokens/sec hides the stalls users notice.
- **Watch KV cache utilization and preemption counters.** A pool constantly at 100% with preemptions means you are trading recompute for nothing; lower concurrency or add memory.
- **Structure prompts for caching**: stable instructions and tool schemas first, user-specific data last.
- **Pick the parallelism per phase**: tensor parallelism reduces per-token latency but adds communication on every layer; for throughput-bound decode, more replicas often beat more TP.
- **Speculative decoding is a latency tool**: enable it for interactive low-concurrency traffic, benchmark before using it for batch workloads.

## Summary

An LLM inference engine is a memory system first. Decode reads every weight for every step, so throughput comes from batching, and batching is limited by the KV cache. PagedAttention made that cache allocatable in small blocks with sharing and copy-on-write; continuous batching keeps the batch full every step; chunked prefill keeps long prompts from stalling everyone else; prefix caching skips work that has been done before; speculative decoding turns spare compute into extra tokens per weight load; and disaggregation separates two phases that never wanted the same hardware. Knowing which of these is the bottleneck for your traffic is what turns flag tuning from guesswork into engineering.

## References

- Kwon et al., [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180), SOSP 2023
- Yu et al., [Orca: A Distributed Serving System for Transformer-Based Generative Models](https://www.usenix.org/conference/osdi22/presentation/yu), OSDI 2022
- Agrawal et al., [Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve](https://arxiv.org/abs/2403.02310), OSDI 2024
- Zheng et al., [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104)
- Leviathan et al., [Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192), ICML 2023
- Chen et al., [Accelerating Large Language Model Decoding with Speculative Sampling](https://arxiv.org/abs/2302.01318)
- Zhong et al., [DistServe: Disaggregating Prefill and Decoding for Goodput-optimized LLM Serving](https://arxiv.org/abs/2401.09670), OSDI 2024
- Patel et al., [Splitwise: Efficient Generative LLM Inference Using Phase Splitting](https://arxiv.org/abs/2311.18677), ISCA 2024
- Ainslie et al., [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245)
- Dao et al., [FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135)
- [vLLM documentation](https://docs.vllm.ai/)
