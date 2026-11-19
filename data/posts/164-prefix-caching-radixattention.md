---
title: "Prefix Caching in Depth: RadixAttention, Block Hashes and Cache-Aware Scheduling"
tag: ai
description: How automatic prefix caching turns a repeated system prompt, a few-shot preamble or a multi-turn history into a cache hit instead of another prefill — why causal attention makes only a leading prefix reusable, how vLLM chains block hashes and SGLang's RadixAttention stores prefixes in a radix tree, the alignment tax of full-block caching, cache-aware scheduling and routing, where a disaggregated KV pool changes the problem, and a runnable model that measures hit rates, eviction and the cost of putting a unique header first
date: "2026-11-19T11:50:00.000Z"
---

## Goal

A serving engine already caches keys and values for the lifetime of a single request: that is the KV cache described in [an earlier post](/blog/140-llm-inference-kv-cache-paged-attention/en). The moment the request finishes, a naive engine discards those tensors. The next user who arrives with the same system prompt, the same tool definitions, or the same first three turns of a conversation pays for that prefill again.

**Automatic prefix caching** keeps the KV of finished — and still-running — prefixes and reuses it when a later prompt starts with the same tokens. For agent and multi-turn traffic, a long stable preamble plus a short new suffix, this is often the difference between a long prefill and a first token that is almost immediate. It is also why hosted APIs offer a discounted rate for cached input tokens, and why a one-line change at the *front* of a prompt can throw that discount away.

This article covers:

1. Why only a leading prefix is safely reusable, given causal attention and position-dependent keys.
2. What a cache hit is worth, and what it does not save.
3. vLLM's hash-chained automatic prefix caching, which reuses only full blocks.
4. SGLang's RadixAttention, which keeps prefixes in a radix tree and evicts LRU leaves.
5. How that automatic, exact-prefix design differs from schema-driven modular reuse such as Prompt Cache.
6. Prompt layout, cache-aware scheduling, and cache-aware routing.
7. What changes when the cache is no longer local to one replica.
8. When prefix caching is the wrong lever.
9. A runnable model that measures hit rates, the block-alignment tax, eviction under a tight budget, and the effect of longest-prefix-first scheduling.

## 1. Why only a leading prefix is reusable

In a decoder-only transformer, the key and value at position `i` are functions of token `i`, of its position, and of every token that came before it. Rotary position embeddings make the position dependence explicit; causal attention makes the prefix dependence inescapable. Two consequences follow, and they are not the same:

- Two requests that share a token-for-token prefix of length `L`, starting at position 0, have identical K/V for those `L` tokens. Reusing that prefix is exact. It does not change the output distribution.
- Two requests that share a paragraph *in the middle*, or the same document inserted at two different offsets, generally do not. The keys at those positions were computed with a different preceding context and different position ids, so a naive copy would be wrong.

That is why automatic prefix caching is a *prefix* cache, not a general substring cache. A single token inserted, deleted, or changed near the start invalidates every cached block after it. The useful engineering rule is correspondingly simple: put the stable parts of the prompt first — system instructions, tool schemas, few-shot exemplars, the conversation so far — and put the variable part at the end.

## 2. What a hit is worth

SGLang's paper defines the cache hit rate as

```
hit rate = (number of cached prompt tokens) / (number of prompt tokens)
```

A hit removes those tokens from the prefill that has to run *now*. Time to first token drops; GPU compute and the memory traffic of building those K/V rows are saved. The tensors themselves still occupy memory, typically with a reference count so several requests can share one physical block, which is a natural extension of [PagedAttention](/blog/140-llm-inference-kv-cache-paged-attention/en).

Three things a hit does *not* do:

- It does not cheapen decode. After the first token, each step is still memory-bound on the growing context, shared prefix or not.
- It does not create capacity out of nothing. The cached prefix still counts against the same GPU HBM budget as live requests. A popular 800-token system prompt on Llama 3 70B is `800 × 320 KiB ≈ 250 MiB` of KV, using the per-token size from the earlier post. That is a bargain if a hundred users share it, and a tax if the cache evicts working-set blocks to keep a prefix nobody is about to reuse.
- It does not help the first request that writes the prefix. Someone has to pay for the prefill; later arrivals ride on it.

The first-token win is largest when the reusable prefix is long and the new suffix is short — exactly the shape of a tool-using agent, a multi-turn chat, a few-shot classifier, or a tree-of-thought fan-out that forks several continuations from one stem.

## 3. Hash-chained blocks: vLLM's automatic prefix caching

vLLM already stores KV in fixed-size **pages** (commonly 16 tokens). Automatic prefix caching hangs a hash index off those pages. As the official design document describes it, a block is identified by a hash of three components:

- the hash of its **parent** block (the preceding prefix),
- the **token ids** in this block,
- optional **extra keys**: a LoRA adapter id, a hash of multimodal inputs, a **cache salt** used to isolate tenants, and similar.

The parent link is essential: the K/V of a block depend on everything before it, so two blocks with the same local tokens but different prefixes must not collide. Chaining the parent hash makes the identifier a digest of the entire leading prefix, not just of that block's own tokens. Extra keys stop a block computed under one adapter, image, or tenant from being served to another.

Two operational constraints follow from this representation:

1. **Only full blocks are cached.** A prompt of 805 tokens with a 16-token block size can share the first 800 tokens; the last 5 are a partial block and are recomputed even if the next request has the same 805-token prefix. That remainder is the **alignment tax**. It is usually small, but it is not zero, and a shared prefix that is just a few tokens past a block boundary pays it on every hit.
2. **Hash collisions are a correctness problem**, not just a performance one. A collision would attach the wrong K/V to a prefix and silently change outputs — or, in a multi-tenant setting, risk leaking another tenant's prefix into a later request. Early versions of the index were not guaranteed to be collision-free; as of vLLM v0.11 the default algorithm is SHA-256. Faster non-cryptographic hashes exist as options, and the documentation is explicit that they raise the collision risk.

On admission, the engine hashes the incoming prompt block by block, looks each hash up, and reuses a leading run of hits. Freed blocks are not immediately recycled: they stay in an LRU pool until some other request needs the memory. Insertion and lookup are O(number of blocks), which is cheap compared with a prefill, and the same block table already used for paging does the sharing.

## 4. RadixAttention

SGLang's runtime keeps the KV of finished prompts and generations in a **radix tree** rather than discarding it (Zheng, Yin, Xie, Sun, Huang, Yu, Cao, Kozyrakis, Stoica, Gonzalez, Barrett, and Sheng, NeurIPS 2024). A radix tree is a compressed trie: each edge is labelled with a *sequence* of tokens, not a single token, so a long shared system prompt can sit on one edge until a later request forces a split.

The operations are the classic ones, applied to token ids:

- **Match.** Walk from the root, comparing the incoming prompt to edge labels, and stop at the first mismatch. The walk is longest-prefix matching; the matched nodes are the reusable K/V.
- **Split.** If a new prompt shares only a proper prefix of an existing edge, that edge is split so the two suffixes hang off a common parent — the same move a filesystem makes when two paths share a directory.
- **Insert.** The unmatched suffix becomes a new edge, with its newly computed K/V stored in a paged pool.
- **Evict.** GPU memory is finite. RadixAttention evicts **leaf** nodes in LRU order, recursively, so a shared trunk is not dropped while a child still depends on it.

The original design stores the tree metadata on the CPU and uses a page size of one token for the KV pool, so matching is not block-aligned: an 805-token shared prefix is reusable in full. The tree also makes *structure* visible to the scheduler. The paper's cache-aware policy, in the batch-processing setting, sorts waiting requests by matched prefix length and runs the longer matches first, instead of first-come, first-served. The point is to avoid **cache thrashing**: if two families of prompts, each with a large private prefix, are interleaved on a budget that cannot hold both prefixes at once, FCFS evicts one family to admit the other, over and over, and the hit rate collapses. Longest-prefix-first finishes one family while its trunk is hot, then switches.

The published evaluation reports up to **6.4×** higher throughput and up to **3.7×** lower latency than Guidance, vLLM, and LMQL across agent, reasoning, few-shot, JSON, RAG, and multi-turn workloads, on models from Llama 7B to Mixtral and LLaVA, on A10G and A100 GPUs. Those speedups are not from RadixAttention alone — the system also parallelizes inside one program and speeds up constrained decoding — but on those benchmarks the cache hit rate ranged from **50% to 99%**, and cache-aware scheduling reached **96% of the optimal hit rate** on average. On a Vicuna-33B chat and vision workload, prefix hits reduced first-token latency by **1.7×** on average. The LMSYS announcement blog, with a slightly earlier baseline set, reported up to 5× throughput versus Guidance and vLLM v0.2.5 on Llama-7B and Mixtral-8x7B. An ablation in the paper found no noticeable overhead when nothing hits, which is why the runtime leaves RadixAttention on.

RadixAttention is compatible with continuous batching, PagedAttention, and tensor parallelism. For multi-modal models, image tokens participate in the same tree.

## 5. Modular reuse, and why a repeated middle span is harder

Automatic prefix caching, in both of the designs above, is exact and conservative: it only reuses a contiguous prefix that has already been computed in the same order, at the same positions. A lot of real prompts also repeat material that is *not* a prefix — a document reused across questions, a policy paragraph inserted after a per-request header, a tool result that later turns will quote.

**Prompt Cache** (Gim, Chen, Lee, Sarda, Khandelwal, and Zhong, MLSys 2024) attacks that broader overlap with an explicit schema of **prompt modules**. Modules are precomputed and stored; a later prompt *imports* them rather than hoping the runtime will notice a shared leading string. The schema is there to keep position ids coherent. The paper reports time-to-first-token reductions of up to **8×** on GPU and **60×** on CPU in their prototype, on long document-based prompts, without changing model weights.

The trade-off is the contract. Independent precomputation means a module is not, by default, attending to whatever unique text will sit in front of it on a later request. That is a different, more aggressive bet than "reuse K/V only when the causal prefix is identical." Automatic engines stay on the exact side and push the problem back to the prompt author: if you want a document to be reused, put it in a stable prefix, or send it through an API that exposes an explicit cache of that prefix. If you need reuse of non-prefix modules, you need a design that says so, and you need to be honest about what is approximate.

## 6. Layout, scheduling and routing

Three layers decide whether a theoretically shareable prefix is actually a hit.

**Layout.** The cache looks at token ids from the left. A unique request id, a timestamp, a user name, or a "current time is …" line placed *above* a shared system prompt makes every request look distinct, and the system prompt is never reused. The same unique text placed at the end is harmless. This is the single highest-leverage change a prompt author can make, and it requires no engine work.

**Scheduling, on one replica.** Even with a well-laid-out prompt, FCFS can thrash a tight cache. Prioritizing waiting requests that already have a long match — the policy in §4 — keeps a hot trunk in memory until the queue for that trunk is drained. The cost is fairness: a request with a cold prefix may wait behind a burst of cache-friendly ones. Production schedulers mix the two concerns, with a maximum wait or a reservation for new prefixes, rather than sorting only by hit length.

**Routing, across replicas.** The cache is usually local to a process. A load balancer that spreads a multi-turn session, or many users of the same system prompt, uniformly at random will keep missing: the prefix lives on replica A and the next request lands on replica B, which then recomputes it and evicts something else. Cache-aware routing tries to send a request to the replica that already holds the longest matching prefix, while still spilling over when that replica is overloaded. Approximate versions hash a stable prefix, or a session id, onto a replica; more precise versions take cache events from the engine and maintain a per-replica prefix index. This is the same locality problem caches have always had, now sitting in front of an LLM.

Other details that belong in the same checklist:

- **LoRA and multimodal inputs** change the K/V. They have to be part of the cache key, or a block from adapter A will be served to adapter B.
- **Tokenizer, chat template, or weight changes** silently invalidate every entry. A cache salt or a generation id is a cheap way to isolate a new model revision.
- **Multi-tenant isolation.** Without a salt, two tenants who happen to share a prefix share tensors. That may be desirable for a public system prompt and unacceptable for private documents.

## 7. One GPU, a replica set, a disaggregated pool

On a single replica, prefix caching is a memory manager plus an index: the designs in §3 and §4. As soon as prefill and decode no longer share a device, the cache becomes a *cluster* problem. A hit might live in another process's HBM, in CPU DRAM, or on SSD, and fetching it can be slower than recomputing a short suffix.

[Prefill-decode disaggregation](/blog/159-prefill-decode-disaggregation/en) already moves KV from a prefill worker to a decode worker. **Mooncake** (Qin, Li, He, Zhang, Wu, Zheng, and Xu, 2024), the serving platform behind Moonshot's Kimi, goes further and treats a multi-tier KV pool as the centre of scheduling. The global scheduler tries to bring reusable cache to the chosen prefill instance, then streams new KV to a decode instance. Reusing a remote prefix saves compute, but waiting on a cold tier can miss a TTFT SLO; the scheduler has to predict whether a transfer is worth it. Under real traffic they report handling **75% more requests**, and in some simulated long-context settings up to a **525%** throughput increase while still meeting SLOs — figures from the paper, on their workload, not a general promise.

The architectural moral is modest: once the cache is off-box, "is this prefix cached?" is no longer a boolean. It is a location, a transfer cost, and an SLO.

## 8. When prefix caching is the wrong lever

Prefix caching is a poor fit, or a poor thing to rely on, when:

- Prompts are unique and long, with no stable preamble. The index does no work, and the reserved memory would have been better left to the live working set.
- The variable part of the prompt is at the front. No scheduler can repair that layout.
- The working set of *distinct* prefixes does not fit. Then the cache thrashes, and FCFS can look as if caching is broken — see the model in §9 — until you enlarge the budget, shape the traffic, or schedule for locality.
- You need lower *decode* latency or higher decode throughput. Look at batching, [speculative decoding](/blog/154-speculative-decoding-llm-inference/en), or disaggregation; prefix caching will not move that needle.
- A correctness-sensitive multi-tenant deployment cannot tolerate collision or accidental sharing. Use a cryptographic hash, a per-tenant salt, and do not turn those off for speed.

It is also not a substitute for shrinking the cache itself (GQA, MLA, quantization, sliding windows — discussed in the earlier KV-cache post). Prefix reuse and a smaller per-token footprint compound; they do not replace each other.

## 9. A runnable model

The script below is a compact model of three policies: no reuse, a vLLM-style hash-chained block cache with 16-token blocks, and a radix tree with token-granularity matching and LRU leaf eviction. Memory is a budget in tokens. Requests are processed one at a time, either in arrival order or with **longest-prefix-first** among the waiting set. Five workloads reuse the same building blocks: an 800-token system prompt, a 400-token tool schema, a 600-token few-shot preamble, short unique user turns, and, in one case, an 8-token unique header placed at the front.

It does not simulate GPU kernels, continuous batching, or network transfer. Hit rate, evicted tokens, and the alignment tax are real properties of the index and the budget, and those are what it measures. The numbers in this section are what this script prints; they are not hardware timings.

```python
#!/usr/bin/env python3
"""A small model of automatic prefix caching: no reuse, block-hash caching, and a radix tree."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Iterable, Optional


# ---------------------------------------------------------------------------
# Shared vocabulary of prompt pieces
# Token ids are arbitrary integers; only equality matters.
# ---------------------------------------------------------------------------

def seq(start: int, length: int) -> tuple[int, ...]:
    return tuple(range(start, start + length))


SYSTEM = seq(1, 800)
TOOLS = seq(10_000, 400)
FEWSHOT = seq(20_000, 600)
USER_BASE = 100_000
ASSIST_BASE = 200_000
NOISE_BASE = 300_000


def user_turn(i: int, length: int = 60) -> tuple[int, ...]:
    return seq(USER_BASE + i * 200, length)


def assistant_turn(i: int, length: int = 80) -> tuple[int, ...]:
    return seq(ASSIST_BASE + i * 200, length)


def noise_prefix(i: int, length: int = 8) -> tuple[int, ...]:
    # A short unique header (request id, timestamp, ...). Placing this at the
    # front of an otherwise shared prompt destroys prefix sharing.
    return seq(NOISE_BASE + i * 20, length)


# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------

@dataclass
class InsertResult:
    prompt_tokens: int
    reused: int
    computed: int
    evicted: int


class PrefixCache:
    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        raise NotImplementedError

    def reset(self) -> None:
        raise NotImplementedError

    def stored_tokens(self) -> int:
        raise NotImplementedError


class NoCache(PrefixCache):
    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        n = len(tokens)
        return InsertResult(n, 0, n, 0)

    def reset(self) -> None:
        return

    def stored_tokens(self) -> int:
        return 0


class BlockHashCache(PrefixCache):
    """vLLM-style automatic prefix caching: only full blocks, hash-chained."""

    def __init__(self, capacity: int, block_size: int = 16) -> None:
        self.capacity = capacity
        self.block_size = block_size
        self.blocks: dict[tuple, tuple[int, ...]] = {}
        self.lru: OrderedDict[tuple, None] = OrderedDict()
        self.stored = 0

    def reset(self) -> None:
        self.blocks.clear()
        self.lru.clear()
        self.stored = 0

    def stored_tokens(self) -> int:
        return self.stored

    def _touch(self, key: tuple) -> None:
        if key in self.lru:
            self.lru.move_to_end(key)

    def _evict(self, needed: int) -> int:
        evicted = 0
        while self.stored + needed > self.capacity and self.lru:
            key, _ = self.lru.popitem(last=False)
            block = self.blocks.pop(key, None)
            if block is not None:
                self.stored -= len(block)
                evicted += len(block)
        return evicted

    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        n = len(tokens)
        bs = self.block_size
        n_full = n // bs
        reused = 0
        computed = 0
        evicted = 0
        parent = ("root",)
        # Walk cached full blocks until a miss, then allocate the rest.
        first_miss = n_full
        for i in range(n_full):
            chunk = tokens[i * bs : (i + 1) * bs]
            key = (parent, chunk)
            if key in self.blocks:
                reused += bs
                self._touch(key)
                parent = key
            else:
                first_miss = i
                break
        for i in range(first_miss, n_full):
            chunk = tokens[i * bs : (i + 1) * bs]
            key = (parent, chunk)
            evicted += self._evict(bs)
            if self.stored + bs > self.capacity:
                # Cannot hold this block; it is computed but not retained.
                computed += bs
                parent = key
                continue
            self.blocks[key] = chunk
            self.lru[key] = None
            self.stored += bs
            computed += bs
            parent = key
        leftover = n - n_full * bs
        computed += leftover  # partial blocks are never cached
        return InsertResult(n, reused, computed, evicted)


@dataclass
class RadixNode:
    tokens: tuple[int, ...]
    children: dict[int, "RadixNode"] = field(default_factory=dict)
    parent: Optional["RadixNode"] = None
    last_used: int = 0


class RadixCache(PrefixCache):
    """SGLang-style radix tree over token sequences, with LRU leaf eviction.

    Matching is at token granularity, matching the page size of one token
    described in the original RadixAttention design.
    """

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.root = RadixNode(tokens=())
        self.clock = 0
        self.stored = 0

    def reset(self) -> None:
        self.root = RadixNode(tokens=())
        self.clock = 0
        self.stored = 0

    def stored_tokens(self) -> int:
        return self.stored

    def _leaves(self) -> list[RadixNode]:
        out: list[RadixNode] = []
        stack = [self.root]
        while stack:
            node = stack.pop()
            if node is not self.root and not node.children:
                out.append(node)
            stack.extend(node.children.values())
        return out

    def _evict(self, needed: int) -> int:
        evicted = 0
        while self.stored + needed > self.capacity:
            leaves = [n for n in self._leaves() if n is not self.root]
            if not leaves:
                break
            victim = min(leaves, key=lambda n: n.last_used)
            evicted += len(victim.tokens)
            self.stored -= len(victim.tokens)
            parent = victim.parent
            if parent is not None and victim.tokens:
                first = victim.tokens[0]
                if parent.children.get(first) is victim:
                    del parent.children[first]
            # Drop the node's tokens; if parent became a leaf it is evictable later.
            victim.tokens = ()
            victim.children.clear()
            victim.parent = None
        return evicted

    def _split(self, node: RadixNode, at: int) -> RadixNode:
        # Split node.tokens at 'at', returning the prefix node (same object)
        # and attaching the suffix as a child.
        prefix = node.tokens[:at]
        suffix = node.tokens[at:]
        child = RadixNode(tokens=suffix, parent=node, last_used=node.last_used)
        child.children = node.children
        for c in child.children.values():
            c.parent = child
        node.tokens = prefix
        node.children = {}
        if suffix:
            node.children[suffix[0]] = child
        return node

    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        self.clock += 1
        n = len(tokens)
        node = self.root
        i = 0
        reused = 0
        while i < n:
            if not node.children or tokens[i] not in node.children:
                break
            child = node.children[tokens[i]]
            edge = child.tokens
            k = 0
            while k < len(edge) and i + k < n and edge[k] == tokens[i + k]:
                k += 1
            if k == 0:
                break
            if k < len(edge):
                self._split(child, k)
            reused += k
            child.last_used = self.clock
            # Mark ancestors as recently used so a shared trunk is not treated
            # as colder than its leaves just because it was not itself a leaf.
            anc = child.parent
            while anc is not None:
                anc.last_used = max(anc.last_used, self.clock)
                anc = anc.parent
            i += k
            node = child
        remaining = tokens[i:]
        evicted = 0
        computed = len(remaining)
        if remaining:
            evicted = self._evict(len(remaining))
            if self.stored + len(remaining) <= self.capacity:
                child = RadixNode(tokens=remaining, parent=node, last_used=self.clock)
                node.children[remaining[0]] = child
                self.stored += len(remaining)
            # else: computed but not retained (capacity filled with warmer nodes)
        return InsertResult(n, reused, computed, evicted)


# ---------------------------------------------------------------------------
# Workloads
# ---------------------------------------------------------------------------

@dataclass
class Workload:
    name: str
    prompts: list[tuple[int, ...]]


def shared_system(n_users: int = 40) -> Workload:
    prompts = [SYSTEM + TOOLS + user_turn(i) for i in range(n_users)]
    return Workload("shared-system+tools + unique questions", prompts)


def fewshot_batch(n_questions: int = 30) -> Workload:
    prompts = [SYSTEM + FEWSHOT + user_turn(i, 40) for i in range(n_questions)]
    return Workload("shared few-shot batch", prompts)


def multi_turn(n_sessions: int = 8, turns: int = 4) -> Workload:
    prompts: list[tuple[int, ...]] = []
    for s in range(n_sessions):
        hist: tuple[int, ...] = SYSTEM
        for t in range(turns):
            uid = s * 20 + t
            hist = hist + user_turn(uid, 50)
            prompts.append(hist)
            hist = hist + assistant_turn(uid, 70)
    return Workload(f"multi-turn chat ({n_sessions} sessions, {turns} turns)", prompts)


def branching(n_questions: int = 6, branches: int = 4) -> Workload:
    # Tree-of-thought / self-consistency style: several continuations share
    # the same question prefix, including the question itself.
    prompts: list[tuple[int, ...]] = []
    for q in range(n_questions):
        stem = SYSTEM + FEWSHOT + user_turn(q, 80)
        for b in range(branches):
            # A short distinct "branch tag" then a continuation, as if the
            # engine were asked to produce another candidate from the same stem.
            tag = seq(400_000 + q * 50 + b * 10, 4)
            prompts.append(stem + tag)
    return Workload(f"branching ({n_questions} questions, {branches} forks)", prompts)


def unstable_front(n_users: int = 40) -> Workload:
    prompts = [noise_prefix(i) + SYSTEM + TOOLS + user_turn(i) for i in range(n_users)]
    return Workload("same body, unique header at the front", prompts)


def mixed_interleave(n_a: int = 12, n_b: int = 12) -> Workload:
    # Two unrelated shared prefixes, arrivals interleaved — FCFS thrashes a
    # tight cache; longest-prefix scheduling keeps each family together.
    a = [SYSTEM + user_turn(i, 50) for i in range(n_a)]
    b = [FEWSHOT + user_turn(1000 + i, 50) for i in range(n_b)]
    prompts: list[tuple[int, ...]] = []
    for i in range(max(n_a, n_b)):
        if i < n_a:
            prompts.append(a[i])
        if i < n_b:
            prompts.append(b[i])
    return Workload("two families, interleaved arrivals", prompts)


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

def run_fcfs(cache: PrefixCache, prompts: Iterable[tuple[int, ...]]) -> dict[str, int]:
    cache.reset()
    tot = reused = computed = evicted = 0
    for p in prompts:
        r = cache.insert(p)
        tot += r.prompt_tokens
        reused += r.reused
        computed += r.computed
        evicted += r.evicted
    return {
        "prompt": tot,
        "reused": reused,
        "computed": computed,
        "evicted": evicted,
        "stored": cache.stored_tokens(),
    }


def run_cache_aware(cache: PrefixCache, prompts: list[tuple[int, ...]]) -> dict[str, int]:
    """Longest-prefix-first among the waiting set, as in SGLang's batch policy."""
    cache.reset()
    waiting = list(prompts)
    tot = reused = computed = evicted = 0

    def matched_len(p: tuple[int, ...]) -> int:
        # Probe the cache without mutating LRU / occupancy: replay a dry insert
        # on a snapshot is expensive; instead, use a side-channel per cache type.
        if isinstance(cache, NoCache):
            return 0
        if isinstance(cache, BlockHashCache):
            bs = cache.block_size
            n_full = len(p) // bs
            parent = ("root",)
            hit = 0
            for i in range(n_full):
                chunk = p[i * bs : (i + 1) * bs]
                key = (parent, chunk)
                if key in cache.blocks:
                    hit += bs
                    parent = key
                else:
                    break
            return hit
        if isinstance(cache, RadixCache):
            node = cache.root
            i = 0
            n = len(p)
            while i < n and p[i] in node.children:
                child = node.children[p[i]]
                edge = child.tokens
                k = 0
                while k < len(edge) and i + k < n and edge[k] == p[i + k]:
                    k += 1
                if k == 0:
                    break
                if k < len(edge):
                    return i + k  # would split; matched k of this edge
                i += k
                node = child
            return i
        return 0

    while waiting:
        # Pick the waiting prompt with the longest current match (stable sort).
        best_i = max(range(len(waiting)), key=lambda j: (matched_len(waiting[j]), -j))
        p = waiting.pop(best_i)
        r = cache.insert(p)
        tot += r.prompt_tokens
        reused += r.reused
        computed += r.computed
        evicted += r.evicted
    return {
        "prompt": tot,
        "reused": reused,
        "computed": computed,
        "evicted": evicted,
        "stored": cache.stored_tokens(),
    }


def fmt(stats: dict[str, int]) -> str:
    hit = (100.0 * stats["reused"] / stats["prompt"]) if stats["prompt"] else 0.0
    return (
        f"prompt={stats['prompt']:<6} reused={stats['reused']:<6} "
        f"computed={stats['computed']:<6} evicted={stats['evicted']:<6} "
        f"stored={stats['stored']:<6} hit={hit:5.1f}%"
    )


def banner(title: str) -> None:
    print(f"\n== {title} ==")


def compare_capacity(workloads: list[Workload], capacities: list[int]) -> None:
    banner("Hit rate versus cache capacity (FCFS, block size 16)")
    for wl in workloads:
        print(f"-- {wl.name}  ({len(wl.prompts)} prompts, "
              f"avg length {sum(map(len, wl.prompts)) // len(wl.prompts)}) --")
        none = run_fcfs(NoCache(), wl.prompts)
        print(f"  no cache          {fmt(none)}")
        for cap in capacities:
            block = run_fcfs(BlockHashCache(cap, block_size=16), wl.prompts)
            radix = run_fcfs(RadixCache(cap), wl.prompts)
            print(f"  block cap={cap:<6} {fmt(block)}")
            print(f"  radix cap={cap:<6} {fmt(radix)}")
        print()


def partial_block_effect() -> None:
    banner("Partial trailing block: 8-token remainder after a shared 800-token system prompt")
    # SYSTEM is 800 tokens, divisible by 16. Add 8 unique tokens in the middle
    # of nowhere — actually, append an 8-token unique tail after SYSTEM.
    prompts = [SYSTEM + noise_prefix(i, 8) for i in range(20)]
    cap = 8_000
    block = run_fcfs(BlockHashCache(cap, block_size=16), prompts)
    radix = run_fcfs(RadixCache(cap), prompts)
    print(f"  20 prompts of 808 tokens, cache capacity {cap}")
    print(f"  block-16          {fmt(block)}")
    print(f"  radix             {fmt(radix)}")
    print("  The 8-token tail is unique each time, so the radix tree also")
    print("  recomputes it; the difference is only that the shared 800 tokens")
    print("  are fully reusable in both, which they are, because 800 % 16 == 0.")
    # Now a shared prefix that is NOT block-aligned: 805 tokens.
    almost = SYSTEM + seq(9_000, 5)  # 805
    prompts2 = [almost + user_turn(i, 40) for i in range(20)]
    block2 = run_fcfs(BlockHashCache(cap, block_size=16), prompts2)
    radix2 = run_fcfs(RadixCache(cap), prompts2)
    print(f"  20 prompts with a shared 805-token prefix + 40 unique tokens")
    print(f"  block-16          {fmt(block2)}")
    print(f"  radix             {fmt(radix2)}")


def scheduling_effect() -> None:
    banner("FCFS versus longest-prefix-first under a tight cache")
    wl = mixed_interleave(12, 12)
    # Each family prefix is 800 or 600 tokens; a tight cache cannot hold both
    # trunks plus working suffixes at once.
    cap = 1_200
    print(f"-- {wl.name}, capacity {cap} --")
    for name, ctor in (
        ("block-16", lambda: BlockHashCache(cap, 16)),
        ("radix   ", lambda: RadixCache(cap)),
    ):
        fcfs = run_fcfs(ctor(), wl.prompts)
        aware = run_cache_aware(ctor(), wl.prompts)
        print(f"  {name} FCFS               {fmt(fcfs)}")
        print(f"  {name} longest-prefix     {fmt(aware)}")


def layout_effect() -> None:
    banner("Prompt layout: shared body with a unique header at the front versus at the end")
    cap = 16_000
    good = shared_system(40)
    bad = unstable_front(40)
    print(f"-- unique question at the end (stable prefix in front), cap {cap} --")
    print(f"  radix             {fmt(run_fcfs(RadixCache(cap), good.prompts))}")
    print(f"  block-16          {fmt(run_fcfs(BlockHashCache(cap, 16), good.prompts))}")
    print(f"-- unique 8-token header at the front, same body, cap {cap} --")
    print(f"  radix             {fmt(run_fcfs(RadixCache(cap), bad.prompts))}")
    print(f"  block-16          {fmt(run_fcfs(BlockHashCache(cap, 16), bad.prompts))}")


def main() -> None:
    capacities = [2_000, 4_000, 8_000, 16_000]
    workloads = [
        shared_system(40),
        fewshot_batch(30),
        multi_turn(8, 4),
        branching(6, 4),
        unstable_front(40),
    ]
    compare_capacity(workloads, capacities)
    partial_block_effect()
    scheduling_effect()
    layout_effect()


if __name__ == "__main__":
    main()
```

Under first-come, first-served, a shared 1,200-token system-and-tools prefix in front of 40 unique 60-token questions (50,400 prompt tokens in total) behaves as one would hope once the cache can hold the trunk:

| Policy | Capacity (tokens) | Reused | Computed | Hit rate |
| --- | ---: | ---: | ---: | ---: |
| No cache | — | 0 | 50,400 | 0% |
| Block-16 or radix | 2,000 and above | 46,800 | 3,600 | 92.9% |

The arithmetic is straightforward. The first request computes `800 + 400 + 60 = 1,260` tokens; each of the next 39 reuses 1,200 and computes 60; total computed is `1,260 + 2,340 = 3,600`. Raising the capacity further does not improve the hit rate: the remaining 3,600 tokens are unique suffixes plus that first write of the prefix, and no index can reuse them. At capacity 2,000 the cache already evicts old user tails to make room, but it keeps the shared trunk, so the hit rate does not budge.

The block size starts to show once the shared prefix is not a multiple of 16. A 1,400-token system-plus-few-shot preamble is `87 × 16 + 8`. The radix tree reuses all 1,400 tokens on a hit; the block cache reuses 1,392 and recomputes the 8-token remainder every time. Over 30 questions of 40 unique tokens each, that is 2,600 tokens computed versus 2,832, or **94.0%** versus **93.4%**. The same gap appears in the branching workload, where several continuations share one 1,480-token stem: **94.5%** versus **93.9%**. The tax is small. It is also real, and it is paid on every request after the first.

A shared prefix of 805 tokens plus a 40-token unique suffix makes the tax visible in isolation. After the first write, the block cache can reuse 800 tokens and must recompute 45; the radix tree reuses 805 and recomputes 40. Over 20 prompts the totals are 1,700 computed versus 1,605, or **89.9%** versus **90.5%**.

Layout dominates everything else. The same 1,200-token body with the unique 60-token question at the end hits at **92.9%**. Moving an 8-token unique header *in front of* that body, leaving everything else unchanged, drops the hit rate to **0%** for both indexes, at every capacity in the sweep, including 16,000 tokens — enough to hold many full copies, none of which share a leading prefix. The engine is not failing. It is correctly refusing to reuse K/V that were computed under a different first eight tokens.

Scheduling is the other cliff. Two prompt families, one with an 800-token trunk and one with a 600-token trunk, arrive interleaved. The cache holds 1,200 tokens, which is enough for one trunk and some tails, but not for both trunks at once:

| Policy | Order | Reused | Computed | Hit rate |
| --- | --- | ---: | ---: | ---: |
| Block-16 | FCFS | 0 | 18,000 | 0% |
| Block-16 | Longest-prefix-first | 15,312 | 2,688 | 85.1% |
| Radix | FCFS | 0 | 18,000 | 0% |
| Radix | Longest-prefix-first | 15,400 | 2,600 | 85.6% |

FCFS evicts family A's trunk to admit family B, then evicts B to admit the next A, and never scores a hit. Longest-prefix-first finishes one family while its trunk is resident, then switches, and most of the prefill disappears. The small remaining gap between the two indexes is again the alignment tax. This is the situation the SGLang paper's cache-aware scheduler is built for, and it is easy to mistake for "prefix caching does not work" if the only policy you try is FCFS on a tight budget.

## Summary

- Automatic prefix caching reuses the KV of a leading token-for-token prefix across requests. Because of causal attention and position-dependent keys, that reuse is exact for a prefix starting at position 0, and generally wrong for a repeated span in the middle or at a different offset.
- A hit cuts prefill work and time to first token. It does not cut decode cost, and the cached tensors still occupy HBM. Someone has to pay for the first write of the prefix.
- vLLM's automatic prefix caching identifies each full page by a hash of its parent hash, its token ids, and extra keys such as LoRA ids, multimodal hashes, and a cache salt. Only full blocks are stored, so a shared prefix that is not a multiple of the block size pays an alignment tax on every later request. As of v0.11 the default hash is SHA-256, because a collision is a correctness bug.
- SGLang's RadixAttention keeps prefixes in a radix tree, matches and splits on token sequences, evicts LRU leaves, and can schedule waiting requests by matched prefix length. The paper reports up to 6.4× throughput and 3.7× lower latency against contemporary baselines, with hit rates of 50%–99% on its workloads and cache-aware scheduling at 96% of the optimal hit rate on average.
- Prompt Cache is a different design: an explicit schema of precomputed modules, aimed at overlap that is not necessarily a leading prefix, with a more aggressive contract around positions and cross-module attention.
- The highest-leverage application-level rule is layout: stable content at the front, variable content at the end. In the model, an 8-token unique header in front of an otherwise shared body drives the hit rate from 92.9% to 0%.
- On a tight cache, first-come, first-served can thrash two interleaved families down to a 0% hit rate; longest-prefix-first recovers about 85%. Across replicas, random load balancing has the same shape of problem, and cache-aware routing is the corresponding fix.
- Once prefill, decode, and the KV pool are disaggregated, a hit has a location and a transfer cost, not just a boolean, and a remote fetch can lose to a short recompute if you are up against a TTFT SLO.

## References

- Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie, Chuyue Sun, Jeff Huang, Cody Hao Yu, Shiyi Cao, Christos Kozyrakis, Ion Stoica, Joseph E. Gonzalez, Clark Barrett, and Ying Sheng, [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104), NeurIPS 2024
- Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie, Jeff Huang, Chuyue Sun, Cody Hao Yu, Shiyi Cao, Christos Kozyrakis, Ion Stoica, Joseph E. Gonzalez, Clark Barrett, and Ying Sheng, [Fast and Expressive LLM Inference with RadixAttention and SGLang](https://www.lmsys.org/blog/2024-01-17-sglang/), LMSYS Org, January 2024
- vLLM, [Automatic Prefix Caching](https://docs.vllm.ai/en/stable/design/prefix_caching/) (design notes: hash chaining, full-block caching, extra keys, SHA-256 default as of v0.11)
- Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, Ying Sheng, Lianmin Zheng, Cody Hao Yu, Joseph E. Gonzalez, Hao Zhang, and Ion Stoica, [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180), SOSP 2023
- In Gim, Guojun Chen, Seung-seob Lee, Nikhil Sarda, Anurag Khandelwal, and Lin Zhong, [Prompt Cache: Modular Attention Reuse for Low-Latency Inference](https://arxiv.org/abs/2311.04934), MLSys 2024
- Ruoyu Qin, Zheming Li, Weiran He, Mingxing Zhang, Yongwei Wu, Weimin Zheng, and Xinran Xu, [Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving](https://arxiv.org/abs/2407.00079), 2024
- Yinmin Zhong, Shengyu Liu, Junda Chen, Jianbo Hu, Yibo Zhu, Xuanzhe Liu, Xin Jin, and Hao Zhang, [DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving](https://arxiv.org/abs/2401.09670), OSDI 2024
