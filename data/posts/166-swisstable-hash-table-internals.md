---
title: "Inside Swiss Tables: Control Bytes, SIMD Lookups, and How Go and Rust Rewrote Their Hash Maps"
tag: performance
description: How modern open-addressed hash maps stay dense and still look up in a few probes — the Swiss Table split of a 64-bit hash into H1 and a 7-bit H2 tag, control bytes that SIMD or a portable bitwise fallback can scan a group at a time, quadratic probing and tombstones, the 7/8 load factor used by Abseil and Go, flat versus node storage and pointer stability, how Rust's HashMap and Go 1.24's built-in map adopted the design and why Go splits a map into many tables of at most 1024 entries, and a runnable model that counts probes and key comparisons against chaining and linear probing
date: "2026-11-21T13:50:00.000Z"
---

## Goal

A hash map looks like a solved problem. You hash a key, you land in a bucket, you find the value. Programming languages have shipped one for decades: `std::unordered_map`, Java's `HashMap`, Python's `dict`, Go's built-in `map`, Rust's `HashMap`. It is tempting to treat the implementation as a finished commodity.

It is not. In 2017, Sam Benzaquen, Alkis Evlogimenos, Matt Kulukundis, and Roman Perepelitsa at Google presented a new open-addressed design, later open sourced in Abseil as the **Swiss Table** family — `absl::flat_hash_map`, `absl::flat_hash_set`, and their node-based counterparts. Rust's standard `HashMap` is a port of that design (via the [hashbrown](https://github.com/rust-lang/hashbrown) crate). Go 1.24 replaced the runtime's built-in map with a Swiss Table implementation, enabled by default.

The interesting part is not a new hash function. It is a way to keep the table dense — Abseil and Go both grow at a **7/8** load factor — without walking long probe chains and without comparing keys at every step. The trick is a parallel array of **control bytes**, a 7-bit fingerprint called **H2**, and a group-at-a-time match that SIMD hardware can do in a few instructions (and that a portable bitwise fallback can still do, more slowly, when SIMD is missing).

This article covers:

1. Why chaining and ordinary linear probing start to hurt as the table fills.
2. How Swiss Tables split a 64-bit hash into H1 and H2, and what each control byte records.
3. How a group of slots is matched at once, and why an empty slot — not a tombstone — is what stops a probe.
4. Quadratic probing, deletions, and the 7/8 load cap.
5. Flat versus node storage, and the pointer-stability trade-off.
6. What Rust and Go actually shipped, including the extra problems Go had to solve: incremental growth and iteration that allows updates.
7. When a Swiss Table is the wrong default, and how this sits next to Python and Java maps.
8. A runnable model that counts probe steps and key comparisons on chaining, linear probing, and an 8-slot Swiss Table.

## 1. Two classic ways to resolve collisions

A hash function maps a key to an integer. The table has finitely many slots, so many keys will claim the same slot. The two classic answers are **chaining** and **open addressing**.

In a chained table, each slot is the head of a list (or, in some Java `HashMap` buckets, a tree once the chain grows long). A lookup hashes the key, then walks that bucket, comparing keys until it finds a match or runs out of nodes. Inserts are straightforward, deletions shrink the list, and a pointer to a node stays valid until that entry is removed. The cost is elsewhere: every node is a separate allocation, and a lookup is a pointer chase. At a load close to 1.0 you are not scanning the whole table, but you are jumping around the heap, and the header of each node is overhead you pay even for tiny keys.

In an open-addressed table, every entry lives in a single backing array. If the preferred slot is taken, a **probe sequence** names the next slot, then the next, until an empty slot is found. The original and simplest sequence is **linear probing**: try `hash(key) mod n`, then the next slot, then the next, wrapping around. Gene Amdahl, Elaine McGraw, and Arthur Samuel used this scheme on the IBM 701 in 1954; W. Wesley Peterson formalized it in 1957. Michael Pratt's [Go blog post](https://go.dev/blog/swisstable) on the 1.24 map walks through a small linear-probing table in exactly these terms.

Linear probing is kind to the cache: the probe walks adjacent slots. It is unkind once the table is crowded. Occupied slots form contiguous runs, and a new key that hashes into a run has to walk to the end of it. This is **primary clustering**. Most implementations therefore set a maximum load factor and grow the array — commonly somewhere between 70% and 90%, as the Go blog notes — before those runs become the whole table. Deletion is the other catch. You cannot simply mark a slot empty: a later lookup might stop too early and miss a key that had probed past this slot. The usual fix is a **tombstone** ("deleted") mark, which does not stop a lookup. Tombstones keep the probe sequence correct, and they also keep it long.

Open addressing, then, wants two things that pull against each other: a high load factor, so the array is small, and a short probe, so a lookup does not scan a long run and does not call `==` on every key it passes.

## 2. Control bytes, H1 and H2

A Swiss Table is still open addressing. The backing store is still a dense array of slots. The difference is a second, equally dense array of **control bytes** — one byte of metadata per slot — and a split of the hash.

Abseil's [design notes](https://abseil.io/about/design/swisstables) start from a 64-bit hash and cut it in two:

- **H1** is the upper 57 bits. It chooses where the probe sequence begins.
- **H2** is the lower 7 bits. If the slot is full, those 7 bits are stored in its control byte.

Go's runtime uses the same split. In [`internal/runtime/maps`](https://github.com/golang/go/blob/master/src/internal/runtime/maps/group.go) the control byte has three bit patterns:

| State | Bit pattern | Meaning |
| --- | --- | --- |
| empty | `0b10000000` | no key; a lookup may stop |
| deleted | `0b11111110` | a tombstone; probing continues |
| full | `0b0hhhhhhh` | occupied; the seven low bits are H2 |

The high bit is the switch. Full slots have it clear, so H2 is a 7-bit value in the range 0–127. Empty and deleted have it set, and the remaining bits distinguish the two special states. Abseil's `raw_hash_set.h` describes the same idea, and adds a sentinel byte used by iterators to know where the table ends, plus a small cloned prefix of control bytes so a group load near the end of the array still sees valid metadata.

Those control bytes are packed together, not interleaved with the keys. A cache line of metadata describes many slots. Before the implementation touches a key, it can already answer "is this slot worth comparing?"

## 3. Matching a group at once

Slots are not probed one by one. They are grouped.

Abseil's published match path uses SSE on x86: sixteen control bytes in a 128-bit register, compared against a vector broadcast of H2, producing a 16-bit mask of candidate slots in a handful of instructions. The design notes give the idea as:

```
Mask Match(h2_t hash) const {
  auto match = _mm_set1_epi8(hash);
  return Mask(_mm_movemask_epi8(_mm_cmpeq_epi8(match, metadata)));
}
```

Go 1.24 uses **groups of eight slots** and a 64-bit control word, not sixteen. That choice keeps a portable implementation on a single integer: XOR the control word with eight copies of H2, then a subtract-and-mask trick turns each matching byte into a set bit. On amd64, the same function is an intrinsic that uses 8-byte SIMD. The [Go blog](https://go.dev/blog/swisstable) is explicit that 16-byte SIMD, and therefore 16-slot groups, is future work — most SIMD units can already do 16-byte compares, and a wider group would cut the number of groups a probe has to visit.

A lookup then looks like this:

1. Compute `hash(key)`, split out H1 and H2.
2. H1 selects the first group.
3. Compare the group's control word against H2. Only the slots whose control byte equals H2 are candidates. Everyone else is skipped — empty, deleted, or a full slot with a different tag.
4. For each candidate, compare the actual key. A 7-bit tag still collides with probability 1/128, so H2 is a filter, not a proof.
5. If the group contains an **empty** slot and no candidate matched, the key is absent: an insertion would have stopped at that empty slot, so the probe sequence would never have gone further.
6. If the group is packed with full and deleted slots, continue the probe sequence at the next group.

The gain is not that comparisons become free. It is that almost all of the slots you would have compared under linear probing are rejected by a parallel byte compare, and that one group visit is eight (or sixteen) probe steps at once. Abseil's source comments put a number on the leftover: even at high load, the number of "wrong" objects a find examines before the real one is typically under 32, so the expected number of false `==` calls is under `32/128`, less than one eighth of a comparison per successful find. The model in section 8 lands in the same neighbourhood.

A deleted slot is not an empty slot. It never matches H2 of a full key, and it does not end the probe. That is the same tombstone rule linear probing uses, now applied at group granularity.

## 4. Probing, deletions, and a 7/8 load

Inside a group, every slot is equally eligible. Between groups, Abseil uses **quadratic probing**: the probe sequence is a triangular walk over a power-of-two number of groups, `group = (H1 + i(i+1)/2) mod G` on the i-th step, which visits every group exactly once. Because the stride depends on the group count, a table that grew by doubling cannot keep using the old probe positions. That fact will matter when we get to Go.

Insertion is "find, then place". If the key is already present, the existing slot is updated. If it is not, the first **empty or deleted** slot along the probe sequence is reused, and its control byte is written with H2. Growth happens first if the table is past its load cap.

That cap is **7/8** for any table larger than one group. Abseil documents it in the [container guide](https://abseil.io/docs/cpp/guides/container) (a maximum load of 87.5%, after which the table doubles) and in `raw_hash_set.h`. Go's `maxAvgGroupLoad = 7` is the same fraction, with a comment that Abseil's 16-slot group still has two empty slots at that load, while an 8-slot group has only one. Smaller tables can be denser: Abseil allows a single group to fill completely.

Deletion writes a tombstone, unless the implementation can prove a later probe would stop in this group anyway. Abseil's documented heuristic is: if the group already contains an empty slot, the deleted slot can be marked empty rather than deleted, because a find never walks past a group that has an empty. The model uses that rule, and it is why a Swiss Table accumulates fewer tombstones than a slot-at-a-time linear table after the same deletes.

Tombstones still occupy space that counts against the load cap, and a long stretch of tombstones still forces the probe to continue. When the live keys would again fit comfortably, a rehash into a clean array is the way to drop them. Hash maps that grow by doubling get that cleanup for free on the growth path; maps that sit at a stable size and churn deletes may need an explicit rehash or a shrink.

## 5. Flat tables, node tables, and pointer stability

Control bytes are only half of the storage story. The other half is where the keys and values live.

**Flat** tables — `absl::flat_hash_map`, Rust's `HashMap`, the slots of a Go map group — store the `value_type` inline in the slot array. A lookup that has already picked a candidate from the control word can compare the key in the same cache-friendly array. There is no per-entry heap allocation. The cost is movement: a rehash copies every entry, and Abseil's flat tables invalidate iterators, references, and pointers to elements when that happens. If you have taken the address of a value and stashed it, the next insert that grows the table has just given you a dangling pointer.

**Node** tables — `absl::node_hash_map`, and the usual implementation of `std::unordered_map` — allocate each entry in its own node and keep a pointer in the table. Addresses of keys and values stay stable. Empty slots are cheap (a pointer plus a control byte). Large or non-movable objects also fit more naturally. The cost is the indirection you just reintroduced, and a heap allocation per insert.

Abseil's guidance is to default to `absl::flat_hash_map`, and to get value pointer stability, when you really need it, with `absl::flat_hash_map<Key, std::unique_ptr<T>>` rather than switching to a node map by habit. The node forms exist for migrations from `std::unordered_map` and for the rarer case where both key and value addresses must not move.

Two other API differences show up the moment you replace a chained table with a Swiss Table. Iteration order is not insertion order, and it is not a stable function of the keys: Abseil's container guide warns that a conversion from `std::unordered_map` can expose latent order dependencies. And heterogeneous lookup — `find` with a `string_view` into a map whose keys are `std::string`, for example — is a first-class feature of the Abseil tables and of Rust's `HashMap`, so a lookup does not have to construct a temporary key.

## 6. What Rust shipped, and what Go had to add

Rust's [`std::collections::HashMap`](https://doc.rust-lang.org/std/collections/struct.HashMap.html) is documented as a hash map "implemented with quadratic probing and SIMD lookup", and as a Rust port of Google's Swiss Table. The default hasher is currently SipHash 1-3, randomly seeded, chosen to resist HashDoS; it can be replaced per map when the keys are already trusted and the hash is the hot path. Keys must have a consistent `Eq` and `Hash`. A rehash still moves entries, so the same pointer-stability warning applies as for a flat Abseil table.

Go's problem was larger than "port the C++ table". The language already had a built-in `map` with two properties Abseil does not offer.

The first is **incremental growth**. A single Swiss Table, like Abseil's, grows all at once: the probe sequence depends on the group count, so every entry is copied into a new array when the table doubles. For a map that holds a gigabyte of entries, one insertion would copy a gigabyte. Go is used for latency-sensitive servers, and the old map already grew incrementally so that no single insert had an unbounded pause. The 1.24 map keeps that bound by making each Go map a collection of independent Swiss Tables, selected by upper hash bits — a form of extendible hashing. An individual table holds at most 1024 entries. When that table is full it splits in two, copying at most 1024 entries, and the other tables are left alone.

The second is **modification during iteration**. The [Go language spec](https://go.dev/ref/spec#For_statements) allows a program to update or delete entries while ranging over a map, with defined semantics: a deleted entry that has not yet been produced is skipped, an updated entry that has not yet been produced yields the new value, and a newly inserted entry may or may not appear. Abseil forbids modifying the table during iteration. Go's iterator keeps a reference to the table it is walking so a growth does not reshuffle the iteration order mid-range; it then consults the grown table for the current value, or for whether the key still exists, before yielding. Pratt's blog post calls iteration the most complex part of the implementation, and it is the part that exists only because of those language rules.

Go 1.24 enabled the new map by default. `GOEXPERIMENT=noswissmap` at build time restores the previous implementation. In microbenchmarks, the blog reports map operations up to 60% faster than in Go 1.23, with some edge cases slower; in full application benchmarks the geometric mean CPU improvement was around 1.5%. The [Go 1.24 release notes](https://go.dev/doc/go1.24) quote a 2–3% average runtime CPU reduction across a suite of representative benchmarks, from the new map together with a tighter small-object allocator and a new runtime mutex — not from the map alone.

## 7. Trade-offs

A Swiss Table is a strong default for an in-memory hash map. It is not the only shape worth using.

- **Chaining still has a place when pointer stability is the contract.** If callers hold pointers into the map, or if entries must not move, a node-based table (or a flat map of pointers) is the honest choice. Java's `HashMap` remains a chained table (with treeified buckets for long collision lists) and a default load factor of 0.75; that is a different point on the same axis, not a failed Swiss Table.
- **Python's `dict` is open addressing too, but it is not a Swiss Table.** Since Python 3.7, insertion order is a language guarantee. CPython keeps a compact array of entries in insertion order and a separate compact index of hash slots, so iteration is cheap and the hash table can stay sparse without scattering the entries. The metadata is not an H2 control word scanned with SIMD, and the design is solving a different problem — ordered, compact iteration — as much as raw lookup speed.
- **Hash quality is not optional.** H1 chooses the starting group; H2 is only 7 bits. A hash that does not avalanche across the whole word clusters probes and raises false H2 hits. Abseil ships `absl::Hash` for this reason; Rust defaults to a DoS-resistant hasher; Go randomizes seed and iteration order. If you plug in a trivial identity hash for integer keys, you own the clustering.
- **Iteration order is not a hidden sort.** Code that "happened to work" with one vendor's `std::unordered_map` will break when the table becomes a Swiss Table. If you need a stable order, sort, or use an explicitly ordered structure.
- **A huge flat entry is a huge slot.** Inline storage is a win for small keys and values. A slot that holds a multi-kilobyte object makes every probe more expensive, and a rehash copies all of that data. Store a pointer, or use a node table, when the payload dwarfs a control byte plus a key.
- **Tombstones and a table that never grows.** A set that inserts and deletes at a roughly constant size can fill with deleted control bytes and lose the "empty slot stops the probe" property. Rehash, or shrink, when the live load is low but missed lookups stay expensive.
- **Concurrency is still your problem.** None of these designs is a concurrent hash map. Go's map remains not safe for concurrent writes; Rust's `HashMap` is not synchronized; Abseil's tables are not internally locked. The Swiss Table changes the probe, not the memory model.

## 8. A runnable model

The script below is the model that produced every figure in this section. It is not a wall-clock comparison of Abseil, Go, or hashbrown. It counts probe steps and key equality checks under a fixed SplitMix64 mix, with Swiss groups of 8 slots, triangular quadratic probing, and the official empty / deleted / H2 control-byte encoding. Growth is disabled in these runs so a chosen load factor stays put. "Probes" for the Swiss Table are groups visited; for linear probing and chaining they are slots or chain nodes visited.

Three tables share a 1024-slot capacity (128 Swiss groups). The same keys are inserted at loads 0.50, 0.75, and 0.875 — the last being the 7/8 cap — and then looked up, both for keys that are present and for an equal number of keys that were never inserted.

| Load | Table | Hit probes | Hit comparisons | Miss probes | Miss comparisons | Max miss probes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0.500 (512 live) | chaining | 1.248 | 1.248 | 1.121 | 0.508 | 4 |
| 0.500 | linear | 1.439 | 1.439 | 2.568 | 1.568 | 21 |
| 0.500 | swiss-8 | 1.000 | 1.012 | 1.051 | 0.037 | 2 |
| 0.750 (768 live) | chaining | 1.384 | 1.384 | 1.238 | 0.742 | 5 |
| 0.750 | linear | 2.439 | 2.439 | 8.005 | 7.005 | 46 |
| 0.750 | swiss-8 | 1.094 | 1.021 | 1.673 | 0.078 | 7 |
| 0.875 (896 live) | chaining | 1.470 | 1.470 | 1.304 | 0.849 | 5 |
| 0.875 | linear | 4.020 | 4.020 | 32.252 | 31.252 | 166 |
| 0.875 | swiss-8 | 1.278 | 1.040 | 2.607 | 0.150 | 13 |

Three things stand out.

First, **linear probing falls off a cliff for misses as the load approaches 7/8**. A successful lookup at that load already averages four key comparisons; a miss averages 32 slots and, in this run, walked 166 slots in the worst case. That is primary clustering in a single number: a miss has to walk to the end of a run.

Second, **the Swiss Table's key-comparison count barely moves**. At 7/8, a hit still averages 1.040 equality checks (at most 2 in this run) and a miss averages 0.150 (at most 3). Groups visited grow — 1.000 to 1.278 for hits, 1.051 to 2.607 for misses — because a full group with no empty slot cannot stop the probe. The H2 filter is doing the work the linear table does with `==`.

Third, **chaining's comparison counts stay modest**, even at 7/8. That is expected: a load of 0.875 on 1024 buckets means short lists, and this model does not charge a pointer chase or a per-node allocation. Chaining "wins" the comparison column and loses the thing Swiss Tables were built to fix, which is density plus sequential access to keys.

The second run fills the same 1024 slots to load 0.75, then deletes 40% of the live keys (308 of 768) without rehashing, leaving a live load of 0.449.

| After 40% deletes | Remaining hits, probes / comparisons | Never-inserted misses | Deleted-key misses |
| --- | --- | --- | --- |
| chaining | 1.237 / 1.237 | 1.104 / 0.460 | 1.081 / 0.429 |
| linear | 2.511 / 1.904 | 8.005 / 4.214 | 11.938 / 5.854 |
| swiss-8 | 1.076 / 1.013 | 1.673 / 0.051 | 1.922 / 0.042 |

The linear table holds 308 tombstones. Its miss probe length for keys that were never inserted is still 8.005 — exactly the miss length at load 0.75 before the deletes — because a tombstone does not end a probe. Comparisons drop (4.214 instead of 7.005) only because some of the slots that used to hold keys are now skipped without an `==`. Lookups of the keys that were just removed are worse: 11.938 probes, because those keys still hash into the clusters they used to occupy.

The Swiss Table writes only 144 deleted control bytes. The other deletions become empty, using the "this group already has an empty slot" heuristic. Miss comparisons stay near zero (0.051 and 0.042). Groups visited for a never-inserted key remain 1.673, the same as at load 0.75, because a tombstone still cannot stop the walk; the filter, not a shorter probe, is what keeps `==` rare.

```python
#!/usr/bin/env python3
"""A compact model of chaining, linear probing, and Swiss-table lookup.

This is an algorithmic model, not a timing benchmark of Abseil, Go, or
hashbrown. It counts probe steps and key equality checks under a fixed
64-bit mix, so the figures in the article are reproducible.

Control-byte encoding follows Go's internal/runtime/maps and Abseil's
raw_hash_set: empty = 0b10000000, deleted = 0b11111110, full = 7-bit H2.
Swiss groups have 8 slots, as in Go 1.24+. Quadratic probing walks
groups with the triangular step used by Abseil: group += i on the i-th
step, modulo a power-of-two group count. Growth uses a 7/8 load cap.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


def mix64(x: int) -> int:
    """SplitMix64 finalizer, used as a deterministic 64-bit hash."""
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9
    x = (x ^ (x >> 27)) * 0x94D049BB133111EB
    x = x ^ (x >> 31)
    return x & 0xFFFFFFFFFFFFFFFF


def h1(h: int) -> int:
    return h >> 7


def h2(h: int) -> int:
    return h & 0x7F


CTRL_EMPTY = 0b10000000
CTRL_DELETED = 0b11111110
GROUP_SLOTS = 8
MAX_GROUP_LOAD = 7  # 7/8, same cap Abseil and Go document


@dataclass
class Stats:
    probes: int = 0
    comparisons: int = 0
    found: bool = False


@dataclass
class ChainTable:
    n_buckets: int
    buckets: list[list[tuple[int, int, int]]] = field(init=False)
    size: int = 0

    def __post_init__(self) -> None:
        self.buckets = [[] for _ in range(self.n_buckets)]

    def insert(self, key: int, value: int) -> None:
        h = mix64(key)
        b = self.buckets[h % self.n_buckets]
        for i, (_, k, _) in enumerate(b):
            if k == key:
                b[i] = (h, key, value)
                return
        b.append((h, key, value))
        self.size += 1

    def lookup(self, key: int) -> Stats:
        h = mix64(key)
        chain = self.buckets[h % self.n_buckets]
        s = Stats()
        for _, k, _ in chain:
            s.probes += 1
            s.comparisons += 1
            if k == key:
                s.found = True
                return s
        if s.probes == 0:
            s.probes = 1  # inspected an empty bucket
        return s

    def delete(self, key: int) -> bool:
        h = mix64(key)
        b = self.buckets[h % self.n_buckets]
        for i, (_, k, _) in enumerate(b):
            if k == key:
                b.pop(i)
                self.size -= 1
                return True
        return False


@dataclass
class LinearTable:
    capacity: int
    keys: list[Optional[int]] = field(init=False)
    values: list[Optional[int]] = field(init=False)
    state: list[str] = field(init=False)  # empty / full / deleted
    size: int = 0

    def __post_init__(self) -> None:
        self.keys = [None] * self.capacity
        self.values = [None] * self.capacity
        self.state = ["empty"] * self.capacity

    def _slot(self, h: int, i: int) -> int:
        return (h + i) % self.capacity

    def insert(self, key: int, value: int) -> None:
        h = mix64(key)
        first_deleted: Optional[int] = None
        for i in range(self.capacity):
            idx = self._slot(h, i)
            st = self.state[idx]
            if st == "full":
                if self.keys[idx] == key:
                    self.values[idx] = value
                    return
            elif st == "deleted":
                if first_deleted is None:
                    first_deleted = idx
            else:
                dest = first_deleted if first_deleted is not None else idx
                self.keys[dest] = key
                self.values[dest] = value
                self.state[dest] = "full"
                self.size += 1
                return
        raise RuntimeError("linear table is full")

    def lookup(self, key: int) -> Stats:
        h = mix64(key)
        s = Stats()
        for i in range(self.capacity):
            idx = self._slot(h, i)
            s.probes += 1
            st = self.state[idx]
            if st == "full":
                s.comparisons += 1
                if self.keys[idx] == key:
                    s.found = True
                    return s
            elif st == "empty":
                return s
        return s

    def delete(self, key: int) -> bool:
        h = mix64(key)
        for i in range(self.capacity):
            idx = self._slot(h, i)
            st = self.state[idx]
            if st == "full":
                if self.keys[idx] == key:
                    self.keys[idx] = None
                    self.values[idx] = None
                    self.state[idx] = "deleted"
                    self.size -= 1
                    return True
            elif st == "empty":
                return False
        return False


@dataclass
class SwissTable:
    capacity: int  # power of two, multiple of GROUP_SLOTS
    ctrl: list[int] = field(init=False)
    keys: list[Optional[int]] = field(init=False)
    values: list[Optional[int]] = field(init=False)
    size: int = 0
    grow_on_load: bool = True

    def __post_init__(self) -> None:
        if self.capacity < GROUP_SLOTS or self.capacity & (self.capacity - 1):
            raise ValueError("capacity must be a power of two, at least one group")
        self.ctrl = [CTRL_EMPTY] * self.capacity
        self.keys = [None] * self.capacity
        self.values = [None] * self.capacity
        self._n_groups = self.capacity // GROUP_SLOTS

    def _groups(self, start_h1: int):
        group = start_h1 % self._n_groups
        step = 0
        seen = 0
        while seen < self._n_groups:
            yield group
            step += 1
            group = (group + step) % self._n_groups
            seen += 1

    def _maybe_grow(self) -> None:
        if not self.grow_on_load:
            return
        # 7 occupied slots per 8-slot group, matching maxAvgGroupLoad.
        if self.size + 1 > self._n_groups * MAX_GROUP_LOAD:
            self._rehash(self.capacity * 2)

    def _rehash(self, new_cap: int) -> None:
        old = [(self.keys[i], self.values[i]) for i in range(self.capacity) if self.ctrl[i] < 0x80]
        self.capacity = new_cap
        self.__post_init__()
        self.size = 0
        for k, v in old:
            assert k is not None and v is not None
            self._insert_new(k, v)

    def insert(self, key: int, value: int) -> None:
        if self.lookup(key).found:
            self._update(key, value)
            return
        self._maybe_grow()
        self._insert_new(key, value)

    def _update(self, key: int, value: int) -> None:
        h = mix64(key)
        target = h2(h)
        for g in self._groups(h1(h)):
            base = g * GROUP_SLOTS
            for off in range(GROUP_SLOTS):
                idx = base + off
                if self.ctrl[idx] == target and self.keys[idx] == key:
                    self.values[idx] = value
                    return
            if any(self.ctrl[base + off] == CTRL_EMPTY for off in range(GROUP_SLOTS)):
                raise RuntimeError("update missed a present key")
        raise RuntimeError("update missed a present key")

    def _insert_new(self, key: int, value: int) -> None:
        h = mix64(key)
        target = h2(h)
        first_open: Optional[int] = None
        for g in self._groups(h1(h)):
            base = g * GROUP_SLOTS
            for off in range(GROUP_SLOTS):
                idx = base + off
                c = self.ctrl[idx]
                if c == target and self.keys[idx] == key:
                    self.values[idx] = value
                    return
                if first_open is None and c >= 0x80:  # empty or deleted
                    first_open = idx
            if any(self.ctrl[base + off] == CTRL_EMPTY for off in range(GROUP_SLOTS)):
                break
        if first_open is None:
            raise RuntimeError("swiss table has no open slot")
        self.ctrl[first_open] = target
        self.keys[first_open] = key
        self.values[first_open] = value
        self.size += 1

    def lookup(self, key: int) -> Stats:
        h = mix64(key)
        target = h2(h)
        s = Stats()
        for g in self._groups(h1(h)):
            s.probes += 1
            base = g * GROUP_SLOTS
            saw_empty = False
            for off in range(GROUP_SLOTS):
                idx = base + off
                c = self.ctrl[idx]
                if c == target:
                    s.comparisons += 1
                    if self.keys[idx] == key:
                        s.found = True
                        return s
                elif c == CTRL_EMPTY:
                    saw_empty = True
            if saw_empty:
                return s
        return s

    def delete(self, key: int) -> bool:
        h = mix64(key)
        target = h2(h)
        for g in self._groups(h1(h)):
            base = g * GROUP_SLOTS
            saw_empty = False
            for off in range(GROUP_SLOTS):
                idx = base + off
                c = self.ctrl[idx]
                if c == target and self.keys[idx] == key:
                    # If the group already has an empty slot, a later lookup
                    # would stop here anyway, so the slot can be empty rather
                    # than a tombstone. Abseil documents this heuristic.
                    group_has_empty = any(
                        self.ctrl[base + j] == CTRL_EMPTY for j in range(GROUP_SLOTS) if j != off
                    )
                    self.ctrl[idx] = CTRL_EMPTY if group_has_empty else CTRL_DELETED
                    self.keys[idx] = None
                    self.values[idx] = None
                    self.size -= 1
                    return True
                if c == CTRL_EMPTY:
                    saw_empty = True
            if saw_empty:
                return False
        return False


def mean(xs: list[int]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def summarize(name: str, stats: list[Stats]) -> str:
    hits = [s for s in stats if s.found]
    misses = [s for s in stats if not s.found]
    def part(label: str, group: list[Stats]) -> str:
        if not group:
            return f"{label}: n=0"
        return (
            f"{label}: n={len(group)} "
            f"avg_probes={mean([s.probes for s in group]):.3f} "
            f"avg_comparisons={mean([s.comparisons for s in group]):.3f} "
            f"max_probes={max(s.probes for s in group)} "
            f"max_comparisons={max(s.comparisons for s in group)}"
        )
    return f"{name}\n  {part('hit', hits)}\n  {part('miss', misses)}"


def keys_for(n: int) -> list[int]:
    # Well-spread integer keys; mix64(key) is the hash, so the identity
    # of the key only matters for equality.
    return [i * 0x9E3779B97F4A7C15 & 0xFFFFFFFFFFFFFFFF for i in range(n)]


def absent_keys(n: int) -> list[int]:
    return [~k & 0xFFFFFFFFFFFFFFFF for k in keys_for(n)]


def run_load_factors() -> None:
    print("=" * 72)
    print("Load-factor comparison, capacity fixed at 1024 slots (128 Swiss groups)")
    capacity = 1024
    for load in (0.50, 0.75, 0.875):
        n = int(capacity * load)
        present = keys_for(n)
        missing = absent_keys(n)
        chain = ChainTable(capacity)
        linear = LinearTable(capacity)
        swiss = SwissTable(capacity, grow_on_load=False)
        for i, k in enumerate(present):
            chain.insert(k, i)
            linear.insert(k, i)
            swiss.insert(k, i)
        print(f"\n--- load={load:.3f}  live={n}/{capacity} ---")
        for label, table in (("chaining", chain), ("linear", linear), ("swiss-8", swiss)):
            hit = [table.lookup(k) for k in present]
            miss = [table.lookup(k) for k in missing]
            print(summarize(label, hit + miss))


def run_tombstones() -> None:
    print("\n" + "=" * 72)
    print("Tombstones: fill to 0.75, delete 40% of live keys, no rehash")
    capacity = 1024
    n = int(capacity * 0.75)
    present = keys_for(n)
    # Delete every key whose insertion index is 0 or 1 mod 5 -> 40%.
    doomed = [present[i] for i in range(n) if i % 5 in (0, 1)]
    remained = [k for i, k in enumerate(present) if i % 5 not in (0, 1)]
    missing = absent_keys(n)
    chain = ChainTable(capacity)
    linear = LinearTable(capacity)
    swiss = SwissTable(capacity, grow_on_load=False)
    for i, k in enumerate(present):
        chain.insert(k, i)
        linear.insert(k, i)
        swiss.insert(k, i)
    for k in doomed:
        assert chain.delete(k)
        assert linear.delete(k)
        assert swiss.delete(k)
    n_tomb = sum(1 for st in linear.state if st == "deleted")
    n_swiss_del = sum(1 for c in swiss.ctrl if c == CTRL_DELETED)
    n_swiss_empty = sum(1 for c in swiss.ctrl if c == CTRL_EMPTY)
    print(f"live after deletes: {len(remained)}")
    print(f"linear tombstones: {n_tomb}")
    print(f"swiss deleted ctrl bytes: {n_swiss_del}, empty: {n_swiss_empty}, live: {swiss.size}")
    print("before-delete baseline was load 0.75; after, live load "
          f"{len(remained)/capacity:.3f}")
    for label, table in (("chaining", chain), ("linear", linear), ("swiss-8", swiss)):
        hit = [table.lookup(k) for k in remained]
        miss = [table.lookup(k) for k in missing]
        gone = [table.lookup(k) for k in doomed]
        print(summarize(label + " (remaining keys)", hit))
        print(summarize(label + " (never inserted)", miss))
        print(summarize(label + " (deleted keys)", gone))


def run_walkthrough() -> None:
    print("\n" + "=" * 72)
    print("Small walkthrough: 16 slots, two Swiss groups, a handful of keys")
    table = SwissTable(16, grow_on_load=False)
    inserted = [10, 25, 32, 56, 78, 98]
    for k in inserted:
        h = mix64(k)
        table.insert(k, k)
        print(
            f"insert {k:3d}  hash=0x{h:016x}  h1={h1(h)}  h2={h2(h):3d}  "
            f"start_group={h1(h) % 2}"
        )
    print("ctrl bytes (d=deleted, .=empty, number=h2):")
    def fmt(c: int) -> str:
        if c == CTRL_EMPTY:
            return "  ."
        if c == CTRL_DELETED:
            return "  d"
        return f"{c:3d}"
    print(" group0:", " ".join(fmt(c) for c in table.ctrl[:8]))
    print(" group1:", " ".join(fmt(c) for c in table.ctrl[8:]))
    for k in inserted + [99, 21]:
        s = table.lookup(k)
        print(f"lookup {k:3d}  found={str(s.found):5s}  groups={s.probes}  comparisons={s.comparisons}")
    table.delete(32)
    print("after deleting 32:")
    print(" group0:", " ".join(fmt(c) for c in table.ctrl[:8]))
    print(" group1:", " ".join(fmt(c) for c in table.ctrl[8:]))
    s = table.lookup(32)
    print(f"lookup  32  found={s.found}  groups={s.probes}  comparisons={s.comparisons}")


def main() -> None:
    run_walkthrough()
    run_load_factors()
    run_tombstones()


if __name__ == "__main__":
    main()

```

## Summary

- A Swiss Table is an open-addressed hash map whose metadata lives in a densely packed array of control bytes. A 64-bit hash splits into H1, which selects the first group, and a 7-bit H2, which is stored in the control byte of a full slot.
- A lookup matches a whole group of control bytes at once — 16 slots with SSE in Abseil, 8 slots in Go 1.24, with a portable bitwise fallback when SIMD is not available. Only H2 hits become key comparisons. An empty slot in the group ends the probe; a tombstone does not.
- Abseil and Go both cap large tables at a 7/8 load. Quadratic probing walks groups, not individual slots. Deletion prefers to write an empty control byte when the group already has an empty slot, and a tombstone otherwise.
- Flat storage keeps keys and values inline and invalidates pointers on rehash. Node storage buys pointer stability at the cost of an allocation and an indirection. Abseil recommends flat maps by default.
- Rust's `HashMap` is a Swiss Table with quadratic probing, SIMD lookup, and a DoS-resistant default hasher. Go 1.24's built-in map is a Swiss Table that additionally splits into independent tables of at most 1024 entries so growth stays incremental, and that consults the grown table during iteration so the language's modification-during-range rules still hold.
- The model in this post is an operation count, not a CPU benchmark. At a 7/8 load, linear probing averaged 32 slots on a miss (up to 166); the 8-slot Swiss Table averaged 2.607 groups and 0.150 key comparisons. After a 40% delete without rehash, linear miss probes did not shrink, because tombstones do not stop a walk.

## References

- Abseil, [Swiss Tables Design Notes](https://abseil.io/about/design/swisstables)
- Sam Benzaquen, Alkis Evlogimenos, Matt Kulukundis, and Roman Perepelitsa, [Swiss Tables and `absl::Hash`](https://abseil.io/blog/20180927-swisstables), 27 September 2018
- Abseil, [C++ Container Guide](https://abseil.io/docs/cpp/guides/container) (flat versus node tables, 87.5% maximum load)
- Abseil, [`absl/container/internal/raw_hash_set.h`](https://github.com/abseil/abseil-cpp/blob/master/absl/container/internal/raw_hash_set.h) (quadratic probing, control-byte layout, 7/8 growth, tombstone heuristic)
- Michael Pratt, [Faster Go maps with Swiss Tables](https://go.dev/blog/swisstable), 26 February 2025
- The Go Programming Language, [Go 1.24 Release Notes](https://go.dev/doc/go1.24) (runtime map, `GOEXPERIMENT=noswissmap`)
- Go source, [`internal/runtime/maps`](https://github.com/golang/go/blob/master/src/internal/runtime/maps/group.go) (8-slot groups, control-byte encoding, `maxAvgGroupLoad = 7`)
- The Go Programming Language Specification, [For statements](https://go.dev/ref/spec#For_statements) (map iteration and concurrent modification by the same goroutine)
- Rust documentation, [`std::collections::HashMap`](https://doc.rust-lang.org/std/collections/struct.HashMap.html)
- [hashbrown](https://github.com/rust-lang/hashbrown), the Swiss Table implementation behind Rust's standard `HashMap`
