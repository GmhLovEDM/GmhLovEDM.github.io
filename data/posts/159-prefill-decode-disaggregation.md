---
title: "Prefill-Decode Disaggregation: Why LLM Serving Splits Prompt Computation from Token Generation"
tag: ai
description: How LLM serving splits the compute-bound prefill phase from the memory-bound decode phase — why colocating them on one GPU couples TTFT and TPOT and fights over parallelism, how KV-cache transfer size is computed, pull versus push transfer and chunked streaming, why the prefill-to-decode replica ratio has to match the workload, what DistServe, Splitwise, Mooncake, vLLM and NVIDIA Dynamo actually do, when disaggregation is the wrong call, and a runnable roofline model that compares colocated and disaggregated goodput under latency objectives
date: "2026-11-14T13:30:00.000Z"
---

## Goal

Every LLM request has two phases that could hardly be more different. **Prefill** reads the prompt and builds the key-value (KV) cache; it is compute-bound and wants wide tensor parallelism. **Decode** then emits one token at a time, each step rereading the model weights and attending over the growing cache; it is memory-bandwidth bound and wants many replicas with a stable batch.

Most serving stacks still run both phases on the same GPU. That is simple, and with *chunked prefill* it is tolerable — until a burst of long prompts lands in the same batch as ongoing generations. Time to first token (TTFT) and time per output token (TPOT) start stealing from each other, and a single parallelism plan has to compromise for both.

Prefill-decode (P/D) disaggregation puts the two phases on different workers and ships the KV cache between them. This article covers:

1. Why the two phases have opposite bottlenecks, and why colocation couples TTFT and TPOT.
2. The disaggregated data path: prefill workers, decode workers, and KV transfer.
3. How large that KV payload actually is, and what the network has to sustain.
4. Pull versus push transfer, overlapping compute with communication, and cache-aware multi-turn routing.
5. Why the prefill-to-decode replica ratio is a first-class capacity decision.
6. What DistServe, Splitwise, Mooncake, vLLM and NVIDIA Dynamo do in practice.
7. When disaggregation is the wrong tool.
8. A runnable first-order model that compares colocated and disaggregated goodput under explicit latency objectives.

## 1. Two phases, two bottlenecks

A Transformer forward pass is dominated by large matrix multiplies with the projected weights. During prefill, *every* prompt token participates, so arithmetic intensity is high: the same weights are reused across a long sequence (and often a packed batch of prompts). The GPU's tensor cores stay busy. Attention can be kept near-linear in sequence length with IO-aware kernels such as FlashAttention (see the earlier article in this series), but the phase as a whole is still a compute problem.

Decode flips the ratio. Each step typically adds a single token per sequence. The engine must stream nearly all of the weights from HBM for a relatively small amount of arithmetic, then read the per-request KV cache. Until the batch is large, the roofline is the memory ceiling, not the FLOP ceiling. That is why a lone request can leave most of the compute units idle, and why continuous batching — adding and removing requests at iteration granularity, rather than waiting for a whole batch to finish — is so effective at filling the memory pipe.

The two phases also disagree about parallelism:

- Prefill scales with more **tensor parallelism** (TP): split large matmuls across GPUs, pay an all-reduce, finish the prompt sooner.
- Decode often prefers **more replicas with smaller TP**: each replica needs the memory bandwidth to hold a batch, and all-reduce on the tiny decode step is almost pure overhead.

A colocated instance can pick only one plan.

## 2. The colocation tax

On a colocated engine the unit of scheduling is one model iteration. State-of-the-art systems no longer stall decode completely while a prompt is processed: they split the prompt into chunks (Sarathi-Serve's chunked prefill, now standard in vLLM and SGLang) and mix one chunk with the current decode batch. That bounds the damage, but it does not remove it.

The iteration time becomes, to a first order:

```text
t_iter ≈ t_prefill(chunk_tokens) + t_decode(decode_batch)
```

Every in-flight generation pays `t_prefill(chunk_tokens)` extra on that step. A 512-token chunk that takes 20 ms on a compute-bound roofline turns an 8 ms memory-bound decode step into a 28 ms step. TTFT also suffers in the other direction: each prefill chunk waits for the decode half of the iteration, so a long prompt that would have been 80 ms of pure compute stretches by several decode floors.

The operational result is a forced trade-off. To protect TPOT you shrink chunks or delay new prefills, and TTFT rises. To protect TTFT you admit prefills aggressively, and every ongoing chat slows down. Goodput — the rate of requests that meet *both* SLOs — falls even when raw token throughput still looks healthy.

## 3. Disaggregating the data path

The disaggregated design is conceptually small and operationally large:

1. A **prefill worker** (or pool) accepts the prompt, runs the compute-heavy forward, and produces the KV cache plus the first-token logits.
2. A **transfer path** moves that KV to a decode worker. The bytes are the whole point of the architecture; everything else is scheduling around them.
3. A **decode worker** (or pool) admits the request into a continuous decode batch and generates the remaining tokens, without ever running a prefill kernel.

Because the two pools no longer share an iteration, TPOT is just `t_decode(batch)` and TTFT is queueing plus prefill plus transfer plus the first decode step. Each pool can use its own TP, replica count, batch size, even GPU generation — Splitwise in particular studies *heterogeneous* clusters, with newer high-SM accelerators on prefill and cheaper, lower-power devices on decode.

The cost is that TTFT now includes a network hop, and a request cannot start decoding until its KV has landed. The rest of the design is about making that hop small, overlapped, and rarely on the critical path.

## 4. How large is the KV payload?

For a standard multi-head (or grouped-query) attention model the cache stores a key and a value per layer, per KV head, per token:

```text
bytes/token = n_layers × 2 × n_kv_heads × head_dim × dtype_bytes
```

A 70B-class model with Llama 3 70B's public GQA shape — 80 layers, 8 KV heads, head dimension 128 — in fp16 is:

```text
80 × 2 × 8 × 128 × 2 = 327,680 bytes/token   (320 KiB)
```

A 4096-token prompt is therefore **1.250 GiB** of KV. At a 50 GB/s line rate (about 400 Gbps RDMA, ignoring protocol overhead) that copy takes **26.84 ms**. At a 25 Gbps Ethernet line rate (3.125 GB/s) it takes **429.50 ms** — already more than most interactive TTFT budgets, before any queueing. Those figures come from the arithmetic above, not from a particular NIC benchmark; real transfers are a bit slower than line rate, and a bit faster if you stream layer by layer while prefill is still running.

Several design knobs shrink the payload or hide its latency:

- **GQA / MQA / MLA** already reduced `n_kv_heads` relative to query heads; that is why 70B here is 320 KiB/token rather than eight times that.
- **Lower-precision KV** (fp8, int8, even 4-bit in some engines) cuts the bytes in half or better, at a quality cost you have to measure on your workload.
- **Chunked or layer-wise streaming**, as in Mooncake, starts shipping finished layers or prompt chunks before the last prefill tile is done, overlapping the copy with remaining compute.
- **Prefix cache hits** (a shared system prompt, a retrieved document seen before, the earlier turns of a conversation) mean you only compute and transfer the *suffix*.

If the cluster cannot move roughly a gigabyte in a few tens of milliseconds, disaggregation will lose to colocation on TTFT no matter how clean the decode side looks.

## 5. Pull, push, and the return path

Early vLLM disaggregated prefilling ran two instances and a KV connector under `vllm/distributed/kv_transfer`. The default NIXL connector was **pull-based**: the decode worker learns that a prefill finished, allocates blocks, then reads the cache. Setup — metadata, block allocation, RDMA descriptors — sits on the critical path *after* prefill, and it runs on the decode worker, which is the one whose TPOT you are trying to keep flat.

A **push-based** connector (vLLM's `NixlPushConnector`, described in the project's October 2026 post) flips the handshake. The decode worker can be chosen earlier and can register destination blocks while prefill is still running; the prefill side then pushes the cache on a background thread as soon as blocks are ready. On a 1P1D deployment of Qwen3-32B over AWS EFA, that post reports up to 3× better TTFT and up to 30% better TPOT than pull mode on the same hardware. Those are transfer-mode comparisons, not claims against a colocated baseline, and they depend on the workload.

Multi-turn agents add a second direction. After a tool call the next prompt is "previous context + new observation". If the decode worker drops the KV at the end of a turn, the prefill worker recomputes it. vLLM's bidirectional transfer keeps decode-side blocks alive for a configurable lifetime and lets the prefill worker reuse them, which is the same idea Mooncake takes further by pooling DRAM and SSD as a cluster-wide KV store and scheduling requests where the prefix already lives.

NVIDIA Dynamo follows the same skeleton with a PrefillRouter that picks workers and a NIXL transfer over NVLink, InfiniBand or PCIe as the topology allows.

## 6. The prefill-to-decode ratio is a capacity plan

Disaggregation does not remove the need to provision; it makes the provision visible. A pool with one prefill worker and three decode workers (1P3D) is a bet that decode is the bottleneck — typical of short prompts and long generations. A 3P1D pool is a bet on long prompts and short answers: retrieval-augmented chat, document summarization, many agent traces. Get the ratio wrong and you reintroduce a queue, only now it is confined to one phase and can be worse than a colocated baseline that at least lets every GPU prefill.

Mooncake's Conductor is a global scheduler built around that fact. It chooses a prefill/decode pair, pulls reusable cache to the prefill worker, streams new KV to the decode worker, and — because a production cluster is often overloaded — may reject a request early when predicted TTFT or inter-token time would miss the SLO, rather than admit work it cannot finish in time.

DistServe (OSDI 2024) goes one step further on placement: given TTFT and TPOT targets, it co-optimizes how many GPUs and which parallelism each phase gets, and places the two phases with the cluster's bandwidth in mind so the KV hop stays affordable.

## 7. Systems in production and in the literature

- **DistServe** (Zhong, Liu, Chen, Hu, Zhu, Liu, Jin, Zhang; OSDI 2024) is the paper that framed the problem as *goodput* under per-phase SLOs. By splitting the phases and planning parallelism independently, the authors report serving 7.4× more requests or meeting a 12.6× tighter SLO than a strong colocated baseline, with more than 90% of requests inside the latency limits.
- **Splitwise** (Patel, Choukse, Zhang, Shah, Goiri, Maleki, Bianchini; ISCA 2024) characterizes prompt versus generation on A100 and H100, then splits them across machines — including heterogeneous pools. With production traces the paper reports up to 1.4× higher throughput at 20% lower cost, or 2.35× more throughput under the same power and cost budgets.
- **Mooncake** (Qin, Li, He, Zhang, Wu, Zheng, Xu; arXiv:2407.00079) is Moonshot AI's serving platform for Kimi. It is KV-cache-centric: a disaggregated prefill/decode cluster plus a pooled DRAM/SSD cache, a Conductor scheduler, chunked streaming, and early rejection. The paper reports up to a 525% throughput increase in some simulated settings while holding SLOs, and 75% more requests under real traffic.
- **vLLM** and **SGLang** now ship P/D disaggregation as a deployment mode, with pluggable KV connectors (NIXL over InfiniBand or EFA, plus the push and bidirectional variants above).
- **NVIDIA Dynamo** is a disaggregated serving framework with a prefill router and NIXL GPU-to-GPU transfer, aimed at scaling the same pattern across a cluster.

Two colocated ideas remain complementary rather than competing: **chunked prefill** (Sarathi-Serve, OSDI 2024) and **paged KV management** (the earlier article on PagedAttention). Disaggregated deployments still use both — they just stop mixing prefill tiles into the decode iteration.

## 8. When not to disaggregate

Disaggregation is a systems trade, not a free speedup.

- **Weak or oversubscribed networks.** In the model below, the same 2P2D topology that reaches 94.5% goodput at 50 GB/s falls to 21.8% on a 25 Gbps Ethernet line rate, almost entirely from TTFT. If you do not have RDMA or NVLink-class connectivity, keep the phases together.
- **Wrong P:D ratio.** A long-prompt workload on too few prefill GPUs queues badly; our RAG-like run with mean prompt 4045 tokens is *worse* than colocation under 2P2D, and clearly better under 3P1D. Measure the prompt-to-output token ratio before you freeze the pool shape.
- **Short prompts on small models.** If prefill is a few milliseconds, a 27 ms KV copy is a net loss, and colocation's iteration tax is tiny.
- **Tiny clusters.** With two GPUs you often cannot form a useful pool, and you lose the ability for every device to absorb a prefill burst.
- **Operational complexity.** You now have two autoscalers, a transfer fabric, cache locality, and failure domains (a decode worker dying mid-generation is a different recovery path from a prefill worker dying before the copy). The architecture is worth it when SLOs are tight and the fleet is large enough to hide that cost.

## 9. A runnable roofline model

The script below is not a GPU benchmark. It is a first-order discrete-event model with explicit synthetic timings: 0.040 ms of prefill compute per token, an 8 ms memory-bound decode floor that grows at 0.30 ms per sequence once compute catches up, 512-token prefill chunks, and KV transfers sized from the 70B-class formula above. Colocated workers run chunked prefill mixed into the decode iteration; disaggregated workers split 4 accelerators as 2P2D, 3P1D or 1P3D. The workload is 400 Poisson arrivals over 60 s (mean inter-arrival 100 ms, prompts uniform in 512–3072, outputs uniform in 64–256, seed 7). A request meets the SLO if TTFT ≤ 150 ms and TPOT ≤ 10 ms.

```python
from __future__ import annotations
import math, random
from dataclasses import dataclass, field
from heapq import heappush, heappop

N_LAYERS, N_KV_HEADS, HEAD_DIM, DTYPE_BYTES = 80, 8, 128, 2
KV_BYTES_PER_TOKEN = N_LAYERS * 2 * N_KV_HEADS * HEAD_DIM * DTYPE_BYTES
PREFILL_MS_PER_TOKEN = 0.040
DECODE_MEM_MS = 8.0
DECODE_COMPUTE_MS_PER_SEQ = 0.30
CHUNK_TOKENS = 512

def prefill_ms(n):
    return n * PREFILL_MS_PER_TOKEN

def decode_step_ms(batch):
    return 0.0 if batch <= 0 else max(DECODE_MEM_MS, batch * DECODE_COMPUTE_MS_PER_SEQ)

def kv_bytes(n):
    return n * KV_BYTES_PER_TOKEN

def transfer_ms(n, gbps):
    return (kv_bytes(n) / (gbps * 1e9)) * 1000.0

@dataclass
class Request:
    rid: int
    arrival: float
    prompt: int
    output: int
    first_token: float = 0.0
    finish: float = 0.0
    tokens_done: int = 0
    remaining_prefill: int = 0
    def __post_init__(self):
        self.remaining_prefill = self.prompt

@dataclass
class Metrics:
    ttft: list = field(default_factory=list)
    tpot: list = field(default_factory=list)
    finished: int = 0

def percentile(xs, p):
    ys = sorted(xs)
    i = min(len(ys) - 1, max(0, math.ceil(p / 100.0 * len(ys)) - 1))
    return ys[i]

def record(m, r):
    m.ttft.append(r.first_token - r.arrival)
    m.tpot.append((r.finish - r.first_token) / max(1, r.output - 1))
    m.finished += 1

def summarize(name, m, ttft_slo, tpot_slo):
    meet = sum(1 for t, p in zip(m.ttft, m.tpot) if t <= ttft_slo and p <= tpot_slo)
    miss_t = sum(1 for t in m.ttft if t > ttft_slo)
    miss_p = sum(1 for p in m.tpot if p > tpot_slo)
    return (f"{name:22s}  finished={m.finished:3d}  "
            f"TTFT p50/p90={percentile(m.ttft,50):.1f}/{percentile(m.ttft,90):.1f} ms  "
            f"TPOT p50/p90={percentile(m.tpot,50):.2f}/{percentile(m.tpot,90):.2f} ms  "
            f"goodput={meet}/{m.finished} ({100*meet/m.finished:.1f}%)  "
            f"miss TTFT={miss_t} TPOT={miss_p}")

def make_workload(n, seed, arrive_ms):
    rng = random.Random(seed)
    reqs, t = [], 0.0
    for i in range(n):
        t += rng.expovariate(1.0 / arrive_ms)
        reqs.append(Request(i, t, int(rng.uniform(512, 3072)), int(rng.uniform(64, 256))))
    return reqs

def run_colocated(reqs, n_gpus, horizon):
    queues = [[] for _ in range(n_gpus)]
    for r in reqs:
        queues[r.rid % n_gpus].append(Request(r.rid, r.arrival, r.prompt, r.output))
    m = Metrics()
    for g in range(n_gpus):
        q = sorted(queues[g], key=lambda x: x.arrival)
        now, qi, pending, decoding = 0.0, 0, [], []
        while now < horizon and (qi < len(q) or pending or decoding):
            while qi < len(q) and q[qi].arrival <= now:
                pending.append(q[qi]); qi += 1
            if not pending and not decoding:
                if qi >= len(q):
                    break
                now = q[qi].arrival
                continue
            chunk, new_req = 0, None
            if pending:
                r = pending[0]
                take = min(CHUNK_TOKENS, r.remaining_prefill)
                r.remaining_prefill -= take
                chunk = take
                if r.remaining_prefill == 0:
                    pending.pop(0)
                    new_req = r
            end = now + prefill_ms(chunk) + decode_step_ms(len(decoding))
            still = []
            for r in decoding:
                if r.tokens_done == 0:
                    r.first_token = end
                r.tokens_done += 1
                if r.tokens_done >= r.output:
                    r.finish = end; record(m, r)
                else:
                    still.append(r)
            decoding = still
            if new_req is not None:
                new_req.first_token = end
                new_req.tokens_done = 1
                if new_req.tokens_done >= new_req.output:
                    new_req.finish = end; record(m, new_req)
                else:
                    decoding.append(new_req)
            now = end
    return m

def run_disagg(reqs, n_prefill, n_decode, horizon, gbps):
    pref = [[] for _ in range(n_prefill)]
    for r in reqs:
        pref[r.rid % n_prefill].append(Request(r.rid, r.arrival, r.prompt, r.output))
    ev = []
    for g in range(n_prefill):
        now = 0.0
        for r in sorted(pref[g], key=lambda x: x.arrival):
            if r.arrival > now:
                now = r.arrival
            now += prefill_ms(r.prompt)
            heappush(ev, (now + transfer_ms(r.prompt, gbps), 0, r.rid, r))
    busy = [False] * n_decode
    free_at = [0.0] * n_decode
    batches = [[] for _ in range(n_decode)]
    m = Metrics()
    while ev:
        now, typ, _, payload = heappop(ev)
        if typ == 0:
            if now > horizon:
                continue
            g = min(range(n_decode), key=lambda i: (len(batches[i]), free_at[i]))
            batches[g].append(payload)
            if not busy[g]:
                start = max(now, free_at[g])
                busy[g] = True
                free_at[g] = start + decode_step_ms(len(batches[g]))
                heappush(ev, (free_at[g], 1, g, g))
        else:
            g = payload
            still = []
            for r in batches[g]:
                if r.tokens_done == 0:
                    r.first_token = now
                r.tokens_done += 1
                if r.tokens_done >= r.output:
                    r.finish = now; record(m, r)
                else:
                    still.append(r)
            batches[g] = still
            if batches[g] and now <= horizon + 120000:
                free_at[g] = now + decode_step_ms(len(batches[g]))
                heappush(ev, (free_at[g], 1, g, g))
            else:
                busy[g] = False
                free_at[g] = now
    return m

if __name__ == "__main__":
    print("KV bytes per token (70B-class GQA, fp16):", KV_BYTES_PER_TOKEN)
    print("KV for 4096 tokens: {:.3f} GiB".format(kv_bytes(4096) / (1024**3)))
    print("Transfer 4096 tokens @ 50 GB/s:    {:.2f} ms".format(transfer_ms(4096, 50)))
    print("Transfer 4096 tokens @ 3.125 GB/s: {:.2f} ms".format(transfer_ms(4096, 3.125)))
    horizon, ttft_slo, tpot_slo = 60_000.0, 150.0, 10.0
    reqs = [r for r in make_workload(400, seed=7, arrive_ms=100.0) if r.arrival < horizon]
    print(f"workload: {len(reqs)} req in {horizon/1000:.0f}s, "
          f"mean prompt={sum(r.prompt for r in reqs)/len(reqs):.0f}, "
          f"mean output={sum(r.output for r in reqs)/len(reqs):.0f}")
    print(f"SLOs: TTFT <= {ttft_slo:.0f} ms, TPOT <= {tpot_slo:.0f} ms")
    configs = [
        ("colocated 4-GPU",       lambda: run_colocated(reqs, 4, horizon)),
        ("disagg 2P2D @ 50 GB/s", lambda: run_disagg(reqs, 2, 2, horizon, 50.0)),
        ("disagg 3P1D @ 50 GB/s", lambda: run_disagg(reqs, 3, 1, horizon, 50.0)),
        ("disagg 1P3D @ 50 GB/s", lambda: run_disagg(reqs, 1, 3, horizon, 50.0)),
        ("disagg 2P2D @ 25 GbE",  lambda: run_disagg(reqs, 2, 2, horizon, 3.125)),
    ]
    for name, fn in configs:
        print(summarize(name, fn(), ttft_slo, tpot_slo))
```

Output on CPython 3:

```text
KV bytes per token (70B-class GQA, fp16): 327680
KV for 4096 tokens: 1.250 GiB
Transfer 4096 tokens @ 50 GB/s:    26.84 ms
Transfer 4096 tokens @ 3.125 GB/s: 429.50 ms
workload: 400 req in 60s, mean prompt=1730, mean output=157
SLOs: TTFT <= 150 ms, TPOT <= 10 ms
colocated 4-GPU         finished=400  TTFT p50/p90=103.7/166.6 ms  TPOT p50/p90=9.57/10.72 ms  goodput=228/400 (57.0%)  miss TTFT=88 TPOT=114
disagg 2P2D @ 50 GB/s   finished=400  TTFT p50/p90=89.1/143.1 ms  TPOT p50/p90=8.00/8.00 ms  goodput=378/400 (94.5%)  miss TTFT=22 TPOT=0
disagg 3P1D @ 50 GB/s   finished=400  TTFT p50/p90=84.2/137.2 ms  TPOT p50/p90=8.00/8.00 ms  goodput=397/400 (99.2%)  miss TTFT=3 TPOT=0
disagg 1P3D @ 50 GB/s   finished=400  TTFT p50/p90=146.7/379.6 ms  TPOT p50/p90=8.00/8.00 ms  goodput=207/400 (51.8%)  miss TTFT=193 TPOT=0
disagg 2P2D @ 25 GbE    finished=400  TTFT p50/p90=255.5/424.6 ms  TPOT p50/p90=8.00/8.00 ms  goodput=87/400 (21.8%)  miss TTFT=313 TPOT=0
```

A few readings of those lines. First, disaggregation flattens TPOT: every disaggregated configuration sits on the 8.00 ms memory floor, while colocation's mixed iterations push p50 to 9.57 ms and p90 to 10.72 ms — enough to miss a 10 ms TPOT objective on 114 of 400 requests. Second, given a fast interconnect, 2P2D raises goodput from 57.0% to 94.5%, and 3P1D (a better fit for this prompt-heavy mix) reaches 99.2%. Third, 1P3D is *worse* than colocation (51.8%) because the single prefill worker queues; the architecture does not save you from a bad pool shape. Fourth, the same 2P2D topology on 25 Gbps Ethernet collapses to 21.8% goodput, all from TTFT.

A second run of the same model, tightening only the arrival rate (seed 11, SLOs unchanged), shows the gap widening under load: at a mean inter-arrival of 80 ms, colocated goodput is 37.4% against 92.0% for 2P2D and 99.4% for 3P1D; at 60 ms the figures are 10.1%, 80.6% and 97.3%. At 40 ms even 3P1D falls over, because the lone decode worker starts queueing and that queue shows up in TTFT. A RAG-like mix (mean prompt 4045, mean output 64, 80 ms inter-arrival, SLO TTFT ≤ 400 ms and TPOT ≤ 12 ms) makes the ratio lesson sharper: 2P2D goodput drops to 7.6% — worse than colocation's 20.4% — while 3P1D reaches 89.4%.

## Summary

- Prefill is compute-bound and decode is memory-bandwidth bound; they want different parallelism plans and they hurt each other when they share an iteration, even with chunked prefill.
- Disaggregation isolates the two phases and makes KV-cache transfer the new critical path. For a 70B-class GQA model in fp16 that path is 320 KiB per token: comfortable on 400 Gbps-class RDMA, painful on commodity Ethernet.
- Push transfer, layer-wise streaming and prefix reuse hide or shrink the copy; bidirectional cache is what makes multi-turn agents cheap enough to serve this way.
- The prefill-to-decode replica ratio is a workload decision. A wrong ratio, or a slow network, can lose to a well-tuned colocated engine.
- DistServe, Splitwise, Mooncake, vLLM and Dynamo all implement this split, with different answers to scheduling, heterogeneity and cache placement.

## References

- Zhong, Liu, Chen, Hu, Zhu, Liu, Jin, Zhang. *DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving*. OSDI 2024. https://www.usenix.org/conference/osdi24/presentation/zhong-yinmin
- Patel, Choukse, Zhang, Shah, Goiri, Maleki, Bianchini. *Splitwise: Efficient Generative LLM Inference Using Phase Splitting*. ISCA 2024.
- Qin, Li, He, Zhang, Wu, Zheng, Xu. *Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving*. arXiv:2407.00079, 2024.
- Agrawal, Kedia, Panwar, Mohan, Kwatra, Gulavani, Tumanov, Ramjee. *Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve*. OSDI 2024.
- Kwon et al. *Efficient Memory Management for Large Language Model Serving with PagedAttention*. SOSP 2023.
- Dao, Fu, Ermon, Rudra, Ré. *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*. NeurIPS 2022.
- vLLM. *Push-Based KV Transfer to Improve TTFT and TPOT for Disaggregated Inference in vLLM*. https://vllm.ai/blog/2026-10-14-nixl-push-connector
- vLLM. *Improve TTFT for Multi-Turn Agentic Workloads with Bi-Directional KV Transfer in vLLM*. https://vllm.ai/blog/2026-10-12-bidirectional-kvxfer-multiturn-agentic-workload
- NVIDIA. Dynamo documentation, *Disaggregated Serving*. https://docs.nvidia.com/dynamo/knowledge-base/concepts/system-architecture/disaggregated-serving

