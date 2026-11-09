---
title: "Speculative Decoding Deep Dive: Why LLMs Can Generate Several Tokens per Forward Pass Without Changing the Output"
tag: ai
description: How speculative decoding speeds up LLM inference — why decoding is memory-bandwidth bound, the propose-then-verify loop, the modified rejection sampling rule that provably preserves the target distribution, expected speedup math, and the design space from separate small models to Medusa heads, EAGLE, multi-token prediction, lookahead and prompt lookup decoding, plus how serving systems like vLLM deal with batching
date: "2026-11-09T14:25:00.000Z"
---

## Goal

A 70B-parameter model generating one token at a time spends most of each step not computing, but waiting: every decoding step streams all the weights from HBM into the compute units to produce a single token per sequence. Speculative decoding is the trick that lets the model emit **several tokens per expensive forward pass** while producing output with **exactly the same distribution** as ordinary decoding. It is now built into vLLM, SGLang, TensorRT-LLM and Hugging Face Transformers, and variants of it (EAGLE, multi-token prediction) ship in production models.

This article covers:

1. Why autoregressive decoding is memory-bandwidth bound, and why verifying k tokens costs about the same as generating one.
2. The propose-then-verify loop.
3. The modified rejection sampling rule and why it is lossless — with a runnable Python model that checks it.
4. The expected-speedup formula and how to choose k.
5. The design space: separate small models, Medusa, EAGLE, multi-token prediction, token trees, lookahead and prompt lookup decoding.
6. Production concerns: batching, KV cache rollback, and when speculation stops paying off.

## 1. Decoding is memory-bound

During decoding, each new token requires a full forward pass. For a single sequence, the matrix multiplications are really matrix-vector products: every weight is loaded once and used for one multiply-add per token. A rough rule of thumb from the roofline model: an accelerator such as the H100 delivers on the order of hundreds of FLOPs per byte of HBM bandwidth, while a batch-1 decoding step performs about 2 FLOPs per weight (2 bytes in FP16). Arithmetic intensity is roughly 1 FLOP/byte, two orders of magnitude below what the hardware could sustain. The chip is idle most of the time, waiting on memory.

The key consequence: **running the model on k+1 positions at once costs almost the same wall-clock time as running it on one position**, as long as k is small. The weights are loaded once either way; the extra positions just turn matrix-vector products into skinny matrix-matrix products that use compute that was idle anyway. This is exactly what happens during prefill, which is why prompt processing is so much faster per token than generation.

So if we could *guess* the next few tokens cheaply, the big model could check all the guesses in a single pass.

## 2. Propose, then verify

Speculative decoding (Leviathan, Kalman & Matias, ICML 2023; Chen et al., DeepMind, 2023, independently) has two models:

- **Target model** `p` — the large model whose output distribution we want.
- **Proposer** `q` — something much cheaper that approximates `p`: a small model from the same family, extra heads on the target, or even a string-matching heuristic.

One iteration:

1. The proposer autoregressively generates k candidate tokens `x1..xk`, recording its distributions `q1..qk`.
2. The target runs **one** forward pass over the prefix plus `x1..xk`, producing distributions `p1..p(k+1)` for every position.
3. Walk the candidates left to right, accepting or rejecting each with the rule below. At the first rejection, replace that token with a corrected one and discard the rest.
4. If all k are accepted, take one bonus token from `p(k+1)` for free.

Every iteration produces between 1 and k+1 tokens for one target pass. In the worst case (everything rejected) you still get one correct token, so the output is never worse than plain decoding — only the proposer's time is wasted.

## 3. The acceptance rule and why it is lossless

With greedy decoding the rule is obvious: accept `xi` iff it equals `argmax pi`. With stochastic decoding (temperature, top-p) we want something stronger: the produced token must be distributed **exactly** as `p`, not just "close". The rule is a variant of rejection sampling:

- Accept proposed token `x` with probability `min(1, p(x) / q(x))`.
- If rejected, draw a replacement from the **residual distribution** `norm(max(0, p(x) − q(x)))`.

Why this gives exactly `p`: the probability that the final token is `x` equals

```
P(propose x and accept)       + P(reject) · residual(x)
= q(x) · min(1, p(x)/q(x))    + (1 − Σ min(p, q)) · max(0, p(x) − q(x)) / Σ max(0, p − q)
= min(p(x), q(x))             + max(0, p(x) − q(x))
= p(x)
```

The middle step uses `Σ max(0, p − q) = 1 − Σ min(p, q)`, so the normalizer cancels the rejection probability. Where the proposer over-estimates a token, we reject the excess; where it under-estimates, the residual fills in exactly the missing mass. The proof does not depend on how good `q` is — a bad proposer only lowers the acceptance rate, never the quality.

Note that temperature, top-k and top-p must be applied to **both** `p` and `q` before the comparison; the rule preserves whatever *processed* distribution you hand it.

### A runnable check

The script below uses toy six-token "models" (the proposer is a flattened version of the target), runs the speculative step 200,000 times, and compares the distribution of the first produced token against direct draws from the target:

```python
import random
from collections import Counter

VOCAB = list(range(6))

def target_dist(ctx):
    last = ctx[-1] if ctx else 0
    w = [((last + i) % 6) + 1 for i in VOCAB]
    s = sum(w)
    return [x / s for x in w]

def proposer_dist(ctx):
    p = target_dist(ctx)
    return [0.6 * x + 0.4 / 6 for x in p]   # cheaper, flatter guess

def draw(dist, rng):
    return rng.choices(VOCAB, weights=dist, k=1)[0]

def speculative_step(ctx, k, rng):
    proposed, qs, c = [], [], list(ctx)
    for _ in range(k):
        q = proposer_dist(c)
        t = draw(q, rng)
        proposed.append(t); qs.append(q); c.append(t)
    # A real system gets all k+1 target distributions from ONE forward pass.
    out, c = [], list(ctx)
    for t, q in zip(proposed, qs):
        p = target_dist(c)
        if rng.random() < min(1.0, p[t] / q[t]):
            out.append(t); c.append(t)
        else:
            resid = [max(0.0, pi - qi) for pi, qi in zip(p, q)]
            z = sum(resid)
            out.append(draw([r / z for r in resid], rng))
            return out
    out.append(draw(target_dist(c), rng))  # bonus token
    return out
```

Output on my run (seed 42, context `[3]`, k = 4):

| token | exact p | speculative | plain |
|---|---|---|---|
| 0 | 0.1905 | 0.1910 | 0.1924 |
| 1 | 0.2381 | 0.2383 | 0.2365 |
| 2 | 0.2857 | 0.2847 | 0.2848 |
| 3 | 0.0476 | 0.0474 | 0.0476 |
| 4 | 0.0952 | 0.0963 | 0.0958 |
| 5 | 0.1429 | 0.1423 | 0.1430 |

The speculative column matches the exact distribution as closely as plain decoding does — the differences are Monte Carlo noise.

## 4. How much faster? The math

Let α be the probability that a proposed token is accepted. For a single position, α = Σ min(p, q) = 1 − TV(p, q), one minus the total-variation distance. Assuming α is the same at every position, the number of tokens produced per target pass is a truncated geometric series:

```
E[tokens per iteration] = (1 − α^(k+1)) / (1 − α)
```

In the toy model α = 0.9143 (the same in every context by construction), and the simulation agrees with the formula:

| k | simulated | closed form |
|---|---|---|
| 1 | 1.914 | 1.914 |
| 2 | 2.745 | 2.750 |
| 4 | 4.207 | 4.213 |
| 8 | 6.468 | 6.459 |

Tokens per pass is not wall-clock speedup. If one proposer step costs a fraction c of a target step, an iteration costs roughly `k·c + 1` target-steps, so

```
speedup ≈ (1 − α^(k+1)) / ((1 − α) · (k·c + 1))
```

Two lessons fall out:

- **Returns diminish fast in k.** Going from k = 4 to k = 8 in the table adds only ~2.3 tokens while doubling proposer cost; with real α around 0.6–0.8 the curve flattens much sooner.
- **Proposer cost matters as much as accuracy.** A proposer that is 10% of the target's cost with α = 0.8 beats one that is 30% of the cost with α = 0.85. This is why the field moved from separate small models toward heads attached to the target.

Real α varies a lot by content: boilerplate code, JSON, and text that copies from the prompt are highly predictable; creative writing at high temperature is not. The original papers report around 2–3x for T5-XXL (Leviathan et al.) and 2–2.5x for Chinchilla 70B (Chen et al.) — numbers that depend heavily on workload, hardware and batch size.

## 5. The design space of proposers

### 5.1 A separate small model

The classic setup: e.g. a 1B model proposing for a 70B one of the same family, sharing the tokenizer. Hugging Face Transformers exposes it as "assisted generation" (`assistant_model=` in `generate`). Simple and effective, but you must host, load and keep in sync a second model, and its KV cache costs memory.

### 5.2 Medusa: extra decoding heads

Medusa (Cai et al., 2024) adds several lightweight heads on top of the target's last hidden state; head i predicts the token i+1 positions ahead. No second model, and the heads are cheap to train (Medusa-1 freezes the backbone). Because each head predicts independently, it proposes several top candidates per position and combines them into a **tree** verified with a tree attention mask. Its weakness: head i does not know what heads 1..i−1 chose, so accuracy drops quickly with distance.

### 5.3 EAGLE: autoregression at the feature level

EAGLE (Li et al., 2024) observes that predicting the next *hidden feature* is easier than predicting the next token directly. It trains a single small transformer layer that takes the target's top-layer features plus the already-chosen token and autoregressively predicts the next features, which the target's own LM head turns into tokens. Feeding the chosen token resolves the uncertainty Medusa ignores. EAGLE-2 makes the candidate tree dynamic based on confidence, and EAGLE-3 fuses features from several layers. The EAGLE family is among the most widely supported options in vLLM and SGLang today.

### 5.4 Multi-token prediction built into training

DeepSeek-V3 trains with an extra multi-token-prediction (MTP) module that predicts one more future token. At inference the module can serve as a proposer; the technical report states the second token is accepted about 85–90% of the time, giving roughly 1.8x tokens per second. When the model is trained with speculation in mind, the proposer comes almost for free.

### 5.5 Token trees

Rather than one chain of k tokens, propose a tree: several alternatives at each depth. SpecInfer (Miao et al., 2023) showed that the target can verify an entire tree in one pass by flattening it and using an attention mask in which each node attends only to its ancestors. With a lossless multi-branch acceptance rule, a tree raises the expected accepted length because a miss on one branch can be rescued by a sibling. The trade-off: more positions per verification pass, which eats into the "almost free" compute budget — especially at large batch sizes.

### 5.6 No model at all: lookahead and prompt lookup

- **Prompt lookup decoding** (Saxena, 2023) finds the last few generated tokens as an n-gram in the prompt and proposes whatever followed it there. Zero training, nearly zero cost, and very effective for summarization, code editing and RAG answers that quote sources. vLLM ships this as an n-gram proposer.
- **Lookahead decoding** (Fu et al., 2024) runs Jacobi iterations to generate n-grams in parallel from the target itself, caches them, and verifies candidates from that pool — again no extra model.

| Proposer | Extra weights | Training | Typical strength |
|---|---|---|---|
| Separate small model | full model | none (reuse) | general text; easy to adopt |
| Medusa heads | a few heads | light | simple integration |
| EAGLE | ~one layer | moderate | high acceptance, widely supported |
| MTP module | built-in | during pretraining | near-free if the model has it |
| Prompt lookup / n-gram | none | none | copy-heavy tasks: editing, RAG, summarization |
| Lookahead | none | none | no training budget |

## 6. Production concerns

**Batching erodes the free lunch.** The argument in section 1 assumes the GPU is memory-bound. At high batch sizes the decode step is already closer to compute-bound, so verifying k extra positions per sequence costs real compute, and rejected tokens are pure waste. Serving systems therefore treat speculation as a latency optimization that helps most at low-to-medium load; some systems adapt k or disable speculation as the batch grows.

**KV cache rollback.** Candidates write KV entries for positions that may be rejected. The engine must truncate the sequence's KV cache back to the last accepted position. With paged KV caches (vLLM's PagedAttention) this is mostly bookkeeping — freeing or reusing tail blocks — but the proposer's own cache needs the same treatment.

**Ragged acceptance.** In a batch, sequence A may accept 4 tokens while B accepts 0. Kernels and schedulers must handle variable-length advances per step, which complicates CUDA graphs and fixed-shape batching.

**Correctness is subtle.** The lossless guarantee only holds if `p` and `q` are post-processed identically (temperature, top-p, repetition penalties, grammar constraints). Bugs here produce output that is *subtly* off-distribution and very hard to notice. Greedy verification against stochastic proposals, for instance, is a common mistake.

**Measure on your traffic.** Since α is workload-dependent, the only reliable way to choose a method and k is to replay real prompts and measure accepted length and end-to-end latency at your actual concurrency.

## Summary

- Decoding is memory-bound, so checking k+1 positions costs about the same as generating one.
- Propose cheaply, verify in one target pass, accept with probability `min(1, p/q)`, and repair rejections from `max(0, p − q)` — the output distribution is provably unchanged.
- Expected tokens per pass is `(1 − α^(k+1)) / (1 − α)`; proposer cost and acceptance rate jointly decide the real speedup.
- The field moved from separate small models to heads (Medusa), feature-level proposers (EAGLE), trained-in MTP, and model-free n-gram methods, with token trees to raise accepted length.
- In serving, batching, KV rollback and identical post-processing of both distributions decide whether the theoretical speedup survives.

## References

- Leviathan, Kalman, Matias. *Fast Inference from Transformers via Speculative Decoding*. ICML 2023. [arXiv:2211.17192](https://arxiv.org/abs/2211.17192)
- Chen et al. *Accelerating Large Language Model Decoding with Speculative Sampling*. 2023. [arXiv:2302.01318](https://arxiv.org/abs/2302.01318)
- Stern, Shazeer, Uszkoreit. *Blockwise Parallel Decoding for Deep Autoregressive Models*. NeurIPS 2018. [arXiv:1811.03115](https://arxiv.org/abs/1811.03115)
- Cai et al. *Medusa: Simple LLM Inference Acceleration Framework with Multiple Decoding Heads*. 2024. [arXiv:2401.10774](https://arxiv.org/abs/2401.10774)
- Li et al. *EAGLE: Speculative Sampling Requires Rethinking Feature Uncertainty*. 2024. [arXiv:2401.15077](https://arxiv.org/abs/2401.15077)
- Miao et al. *SpecInfer: Accelerating Generative LLM Serving with Tree-based Speculative Inference and Verification*. 2023. [arXiv:2305.09781](https://arxiv.org/abs/2305.09781)
- Fu et al. *Break the Sequential Dependency of LLM Inference Using Lookahead Decoding*. 2024. [arXiv:2402.02057](https://arxiv.org/abs/2402.02057)
- DeepSeek-AI. *DeepSeek-V3 Technical Report*. 2024. [arXiv:2412.19437](https://arxiv.org/abs/2412.19437)
- [Prompt lookup decoding](https://github.com/apoorvumang/prompt-lookup-decoding)
- [vLLM documentation: Speculative Decoding](https://docs.vllm.ai/en/stable/features/spec_decode.html)
