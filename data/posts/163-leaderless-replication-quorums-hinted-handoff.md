---
title: "Leaderless Replication in Depth: Quorums, Sloppy Quorums, Hinted Handoff and Anti-Entropy"
tag: architecture
description: How leaderless replication keeps writes available when nodes fail — preference lists and coordinators, what R + W > N actually guarantees and when it does not, vector clocks and sibling reconciliation, sloppy quorums and hinted handoff, read repair, Merkle-tree anti-entropy, how Cassandra, Riak and DynamoDB diverge from the Dynamo paper, and a runnable model that measures availability, stale reads and repair traffic
date: "2026-11-18T12:45:00.000Z"
---

## Goal

Most people first meet replication as a primary and a set of followers. The primary takes every write, the followers apply a log, and if the primary dies you elect a new one. That is a good model when you want a single order of writes. It is a poorer model when the product requirement is "this write must be accepted even if some of the machines that should hold it are unreachable."

That second requirement is what Amazon's 2007 Dynamo paper was written for. A shopping cart has to accept an add-to-cart during a disk failure, a flapping route, or a data-center outage; the paper's opening example is exactly that. Dynamo — and the family of systems it inspired — does not wait for a leader. Any healthy node in a key's **preference list** can coordinate a write. Availability is tuned with three integers, **N**, **W** and **R**. Divergence is treated as a fact of life and is repaired later: with **read repair** on the query path, with **hinted handoff** when a node returns, and with **Merkle-tree anti-entropy** in the background.

This article covers:

1. Why you would replicate without a leader, and how that differs from Raft-style replication.
2. Preference lists, virtual nodes, and the coordinator.
3. Quorums, and what `R + W > N` actually guarantees — and what it does not.
4. Concurrent writes, vector clocks, and application-level reconciliation.
5. Sloppy quorums and hinted handoff, including the consistency hole they open.
6. Read repair, and why it is only as good as the replicas a read actually saw.
7. Anti-entropy with Merkle trees.
8. How Cassandra, Riak and DynamoDB each diverged from the 2007 design.
9. When leaderless replication is the wrong tool.
10. A runnable model that measures write availability, stale reads and repair traffic on an 8-node ring.

## 1. Why replicate without a leader

A consensus protocol such as Raft gives you a single, linearizable log. That is a strong and pleasant programming model, and it is the right default for metadata, configuration, and any update that must not be applied twice. The cost is baked into the protocol: a write succeeds only if a **majority of the current voting set** accepts it, and if the leader is lost, clients wait while a new one is elected. A minority partition cannot make progress. Those are safety features, not accidents.

Leaderless replication makes the opposite bet. There is no distinguished primary for a key. A coordinator — often just the first healthy node in the preference list — sends the write to several replicas and waits for **W** of them to persist it. If the two machines that "should" have been second and third on the list are down, a **sloppy** configuration is allowed to use the next healthy machines instead, and to remember that the copy is only there on behalf of someone else. The system stays writable in failure patterns that would stall a leader-based quorum.

The price is consistency. Two coordinators can accept concurrent writes to the same key. A later read may see one of them, both of them, or, for a while, neither, depending on which replicas it contacts and whether a repair has run. The rest of the design is a set of mechanisms for *bounding* that window and for giving the application a way to merge versions when the system cannot do it alone.

## 2. Preference lists, virtual nodes and the coordinator

The 2007 Dynamo paper sits on top of consistent hashing, which this blog has already walked through in [an earlier post](/blog/144-consistent-hashing-data-partitioning/en). Keys and nodes live on a ring. Dynamo does not map each machine to a single point: it uses **virtual nodes**, so each physical host owns many tokens. When a host is added or lost, its load is spread across many neighbours rather than dumped onto the next clockwise peer.

For any key, walk the ring clockwise and collect distinct **physical** nodes. The first **N** of those are the intended replicas; the paper calls the whole longer list the **preference list**. The list is deliberately longer than N, so a coordinator can skip nodes that are down. Virtual nodes matter here: the first N positions on the ring may belong to fewer than N distinct machines, so the walk has to keep going until it has N real hosts.

**N** is configured per Dynamo instance. The coordinator for a key is typically the first of the top N. Clients have two ways to get there: a generic load balancer, which may land on a random node that then *forwards* the request if it is not in the top N, or a partition-aware client library that talks to the coordinator directly. The coordinator writes the new version locally, ships it to the other replicas, and waits until **W** nodes (including itself, when it is one of them) have persisted it. The latency of a write is therefore the slowest of those W replies, which is why W is usually less than N; the same reasoning applies to **R** on the read path.

## 3. Quorums, and what R + W > N actually guarantees

The classical rule is short. If every write waits for W of a fixed set of N replicas, and every read waits for R of that same set, and `R + W > N`, then the two sets share at least one node. If you also compare versions and keep the newest, a read should see the last completed write.

That sentence has hidden assumptions, and they are where production systems get hurt:

- The N nodes are a **fixed membership**. As soon as writes are allowed to use "the first N healthy nodes on a longer list," a write quorum and a later read quorum can be disjoint. That is the sloppy-quorum hole in section 5.
- There is a **single most recent write**. Concurrent writes produce siblings, not a unique newest value. Last-write-wins can pick one and drop the other; it does not make the overlap argument honest.
- Replicas actually **answer**. A "success" that was acknowledged by W nodes which then lose their disks is not a W-durable write.
- The reader **reconciles**. If you return the first of R replies without looking at versions, overlap does not help.

The common production configuration reported in the Dynamo paper is `(N, R, W) = (3, 2, 2)`. Applications that wanted to accept a write as long as a single node could persist it set W to 1; the paper is explicit that most Amazon services in production chose a higher W for durability. A typical SLA the paper quotes for services that used Dynamo is that 99.9% of reads and writes complete within 300 ms.

The runnable model at the end of this article uses an 8-node ring, N = 3, and 240 keys. On a healthy cluster, a single write followed by a single read per key produces this matrix. "Stale" means the reconciled result of the R contacted replicas did not contain the write that had just succeeded:

```
(W,R)     fresh    stale
(1,1)        81      159
(2,1)       155       85
(1,2)       159       81
(2,2)       240        0
(3,1)       240        0
(1,3)       240        0
(2,3)       240        0
(3,3)       240        0
```

`(1, 1)` is stale on 159 of 240 keys, which is about two thirds — the one replica the read chose is simply not the one the write chose. `(2, 1)` and `(1, 2)` miss on about one third, which is the one replica the smaller of R or W did not cover. Every configuration with `R + W > 3` is fresh on all 240 keys. The rule works, when its assumptions hold.

The same model, still with W collected from the *intended* N unless sloppy mode is on, shows the availability side of the trade-off. Failures are applied per key (k of that key's intended replicas are down for the write, then restored), so the numbers are not confounded by overlapping rings:

```
pattern                W=2 strict   W=2 sloppy   W=1 strict   W=1 sloppy
all healthy               240/240      240/240      240/240      240/240
1 intended down           240/240      240/240      240/240      240/240
2 intended down             0/240      240/240      240/240      240/240
all 3 intended down         0/240      240/240        0/240      240/240
```

A strict W = 2 write cannot gather two acks once two intended replicas are down. A sloppy W = 2 write still can, by stepping further around the ring. That is the point of sloppy quorums. It is also the start of the consistency problem.

## 4. Concurrent writes, vector clocks and siblings

Dynamo stores a **vector clock** with every version: a list of `(node, counter)` pairs. When a client updates a key, it must send back the **context** it received from a previous read, so the coordinator can increment its own entry and record which version is being superseded. If clock A is less-than-or-equal to clock B on every node and strictly greater on at least one, A is an ancestor of B and can be dropped — the paper calls this **syntactic reconciliation**. If neither dominates, the versions are **concurrent**. The system keeps both and returns them to the client for **semantic reconciliation**.

The running example in the paper is the shopping cart. Merging two carts is a union of added items, so an add-to-cart is not lost. The same merge can bring a deleted item back. That is a genuine trade-off, not a bug the paper forgot to mention.

A 24-hour profile of the shopping-cart service in the paper found that 99.94% of requests saw exactly one version, 0.00057% saw two, 0.00047% saw three, and 0.00009% saw four. Conflicts were rare, and still first-class. Dynamo also supported a simpler mode, used for session state, in which concurrent versions were resolved by **last write wins** on a physical timestamp.

Vector clocks can grow if many different nodes coordinate writes to the same key, which happens when failures push coordination off the top N. Dynamo truncates: each pair carries a timestamp, and when the number of pairs reaches a threshold (the paper says "say 10"), the oldest pair is removed. The authors note that this can make descendant relations impossible to reconstruct, and that the issue had not surfaced in production at the time of writing.

The model includes a small, deterministic case. For a key whose intended replicas are nodes 0, 1 and 2, node 0 is isolated and writes `"from-A"` with W = 1; then 0 is taken down and nodes 1 and 2 write `"from-BC"` with W = 2. After the partition heals, an R = 3 read returns both versions, with clocks `((0, 1),)` and `((1, 1),)`, and the two clocks are concurrent. A timestamp tie-break would have dropped one of those writes. A merge function can keep both.

This blog has already covered the algebra of vector clocks in [the post on distributed time](/blog/155-distributed-clocks-lamport-vector-hlc-truetime/en). What matters here is the policy built on top of them: keep siblings, or collapse them, and be honest about which updates you are willing to lose.

## 5. Sloppy quorums and hinted handoff

If Dynamo used a strict quorum, a temporary failure of one or two intended replicas would either reject writes or reduce durability. The paper treats that as unacceptable for the shopping-cart class of workloads. Instead it uses a **sloppy quorum**: every read and write is sent to the first N *healthy* nodes in the preference list, which "may not always be the first N nodes encountered while walking the consistent hashing ring."

In the paper's figure, N = 3 and node A is temporarily unreachable. The replica that would have lived on A is sent to node D, with metadata naming A as the intended recipient. D keeps hinted replicas in a **separate local database** that it scans periodically. When A recovers, D delivers the copy and then deletes it, so the total number of replicas does not quietly grow. That delivery step is **hinted handoff**.

The consistency hole is easiest to see with two intended replicas down. Let the preference list start `A, B, C, D, …`. A sloppy W = 2 write lands on C and on D (D holds a hint for A). Then A and B come back before D has delivered anything. A strict R = 2 read now chooses two of `{A, B, C}`. The subset `{A, B}` does not overlap the write set `{C, D}` at all. One third of the two-replica subsets are stale.

The model measures that hole, with hints deliberately left undelivered:

```
mode                            W,R  down  wrote  fresh  stale
sloppy write, strict read       2,2     2    240    163     77
sloppy write, strict read       2,3     2    240    240      0
sloppy write, strict read       2,1     2    240     78    162
sloppy write, strict read       2,2     3    240      0    240
sloppy write, strict read       2,3     3    240      0    240
```

After two intended replicas fail and recover, 77 of 240 keys (32%) are stale at R = 2, in line with the one-third argument. Raising R to 3 always hits C, the intended replica that did take the write, and the stale count drops to zero. If all three intended replicas were down, the sloppy write lived *only* on substitutes; after they recover, every read of the intended set is stale, even at R = 3. `R + W > N` is not a charm you can recite once membership has slipped.

One more subtlety, because it shows up again under repair: a sloppy W = 2 write with two intended nodes down places only *one* hint (on D, for A). B never gets a copy, and C holds the only intended replica. Handoff will fix A, not B. A later R = 2 read can still be fresh, because every two-subset of `{A, B, C}` now includes A or C — but B is still empty until read repair or anti-entropy copies onto it.

## 6. Read repair

On a Dynamo get, the coordinator sends the request to the relevant replicas, waits for R, and reconciles the versions it has. It may also wait in the background for the slower replies. If any of those replies were stale, it writes the newest version back to the nodes that missed it. The paper calls this **read repair** and notes that it spares the anti-entropy protocol from doing the same work.

Cassandra made the mechanism more visible, and more configurable. A coordinator typically issues one full read to a fast replica and **digest** reads to the others that are needed to meet the consistency level. If the digests disagree, it fetches the missing data and, by default, **blocks** the client until repair writes have reached that consistency level. Cassandra 4.0 added a table option `read_repair`: `BLOCKING` (the default) preserves **monotonic quorum reads** — a second quorum read should not see an older value than the first, even if a failed quorum write only landed on a minority — while `NONE` reconciles what the coordinator saw but does not push repairs, which better preserves partition-level write atomicity when a query reads only part of a partition that was written together (CASSANDRA-14635).

Read repair is only as good as the replicas the read contacted. In the model, after sloppy W = 2 writes with two intended replicas down and then recovered, a strict R = 2 read with repair enabled converges like this:

```
pass 1    fresh=151  stale=89
pass 2    fresh=208  stale=32
pass 3    fresh=229  stale=11
```

A read that contacts C plus a recovered empty node can copy the value onto that node. A read that contacts the two recovered empty nodes cannot invent the missing value, and it does not touch C. Those keys remain stale until a later read happens to include the live copy. After three passes, 11 of 240 keys are still stale, which is in the same range as `(1/3)^3 × 240 ≈ 9`.

When all three intended replicas were down, the live copies sit only on hint holders, which a strict read of the intended set never contacts. Three repair passes stay at `fresh=0, stale=240`. Read repair will not save a value the read set cannot see.

## 7. Anti-entropy with Merkle trees

Hinted handoff is for *temporary* failures. If A is gone long enough that D has dropped the hint, or D itself is lost, the intended replica set can remain divergent forever unless something compares the trees of data, not just the last few writes. Dynamo uses **Merkle trees** (hash trees) for this **anti-entropy** path. Each leaf is a hash of a key's value; each parent is a hash of its children. Two replicas exchange roots, recurse only into branches whose hashes differ, and transfer only the keys under those branches. They do not have to ship the entire dataset in order to discover a handful of mismatches.

The model builds one tree per intended-replica range (30 keys on this 8-node, 240-key ring) and walks mismatched subtrees. After a healthy W = 3 write of every key, a minority of keys are then removed from one intended replica, and anti-entropy runs across the 24 replica pairs:

```
divergent keys    hashes exchanged    keys copied    naive key compares
             1                    60              2                 5760
             6                   240             12                 5760
            24                   376             48                 5760
            60                   664            120                 5760
```

One divergent key costs 60 hash exchanges and two copies — two, because the victim is compared with each of the other two replicas in its group of three — against 5,760 naive key-by-key comparisons (24 pairs × 240 keys). The saving is the whole point of the tree.

Whether Merkle repair among *intended* replicas is enough depends on where the live copy lives:

```
situation (after sloppy W=2, then recovery)
                          fresh  stale  notes
2 intended down, no repair  151     89  R=2
then hinted handoff         240      0  240 hints; B may still be empty
Merkle on intended only     240      0  1912 hashes, 480 copies; C heals A and B
3 intended down, no repair    0    240  value lives only on substitutes
Merkle on intended only       0    240  24 root hashes, 0 copies; empty trees match
handoff, then Merkle        240      0  480 hints, then 480 copies to fill C
```

With two intended replicas down, C still has the value, so a Merkle walk over `{A, B, C}` heals the set even if handoff has not run. With three intended replicas down, the intended trees are equal *and empty*; anti-entropy among them has nothing to copy. Handoff has to bring the hinted copies home first. The 2007 design treats the two mechanisms as complementary, not interchangeable: handoff for short outages, Merkle for the cases handoff misses.

## 8. How Cassandra, Riak and DynamoDB diverge

The Dynamo paper is a design, not a standard. The three most cited descendants took different pieces of it.

**Riak KV** is the closest in spirit. It kept leaderless coordination, sloppy-style fallback, siblings when `allow_mult` is on, and **active anti-entropy** built on hash trees. Causal metadata evolved from vector clocks to **dotted version vectors**, which track each write as a unique event so concurrent updates can be distinguished without some of the sibling explosion that plain vector clocks allow.

**Apache Cassandra** is leaderless on the request path — any node can be the coordinator — but it does **not** use Dynamo's sloppy quorum as the definition of W and R. Consistency levels such as `ONE`, `QUORUM` (a majority of the replication factor), `ALL`, `LOCAL_QUORUM` and `EACH_QUORUM` are counted against the *intended* replicas. If you ask for `LOCAL_QUORUM` at replication factor 3, two of those three replicas must acknowledge; a hint does not count. **Hints** are stored on the coordinator's local disk, in `$CASSANDRA_HOME/data/hints`, and are replayed when the target comes back. They are explicitly **best effort**: the default `max_hint_window` is **3 hours**, after which new hints are not created, and a replica that stays down longer remains inconsistent until read repair or a full / incremental anti-entropy repair. Cassandra also chose **last-write-wins timestamps** rather than returning siblings to the application. When an update really does need a linearizable compare-and-set, **lightweight transactions** run a Paxos round instead of pretending that a quorum read-modify-write is enough.

**Amazon DynamoDB** launched in 2012 and is easy to confuse with the 2007 system because of the name. The USENIX ATC 2022 paper by Elhemali, Gallagher, Gordon, Idziorek and colleagues is the authoritative description of the production service. Its origins "derive from the original Dynamo system," but the replication architecture is not a sloppy-quorum ring. Each partition is a **replication group** of three replicas in different Availability Zones. The group uses **Multi-Paxos** for leader election and consensus. Only the leader serves writes and strongly consistent reads; a write is acknowledged once a **quorum of peers** has persisted the write-ahead log record. A healthy write quorum is **two out of the three** replicas, in different AZs. Eventually consistent reads can be served by any replica. If a storage replica is unhealthy, the leader can add a **log replica** — a Paxos acceptor that holds recent log entries but not the B-tree — in a few seconds, so the write quorum can be met while the much heavier B-tree copy continues in the background. A newly elected leader does not serve writes or strongly consistent reads until the previous leader's **lease** expires. The same paper reports that during the 66-hour Prime Day event in 2021, Amazon systems peaked at **89.2 million requests per second** against DynamoDB, with single-digit millisecond performance.

In other words: DynamoDB kept the partitioned key-value shape and the demand for predictable low latency, and then replaced sloppy quorums, vector clocks and gossip with a leader, a lease, and Paxos. If you are reasoning about "Dynamo-style" behaviour, you have to say which Dynamo you mean.

## 9. When leaderless replication is the wrong tool

Leaderless replication is a way to keep a key writable when the machines that should own it are not all there. It is the wrong tool when the product actually needs a single winner, a single order, or a predicate that must not be applied twice.

Use a consensus group, a leader-based store, or an explicit compare-and-set (Cassandra's lightweight transactions, etcd, ZooKeeper, a Raft-backed metadata service, DynamoDB conditional writes) for unique constraints, "exactly one owner," and any update whose lost twin would be a correctness bug. Do not paper over that need with last-write-wins and a short hint window.

Multi-key transactions and invariants that span partitions are also a poor fit. A per-key sloppy quorum does not give you a consistent cut across keys.

Finally, the repair story is part of the contract. If hinted handoff is disabled, hint windows expire as a matter of routine, and anti-entropy repair is not run, the "eventual" in eventual consistency has no engine. The model makes that mechanical: with three intended replicas down, Merkle among those replicas copies nothing, and read repair of the intended set stays stale on every pass, until the hints come home.

## 10. A runnable model

The script below is the model that produced every count in this article. It is a ring of eight nodes, N = 3, 240 keys, with vector-clock reconciliation, strict and sloppy placement, a separate hint store, read repair of the replicas a read actually contacted, and a Merkle walk over intended ranges. Failures are applied per key so overlapping preference lists do not take the whole cluster down at once.

```python
#!/usr/bin/env python3
"""Leaderless replication model: quorums, sloppy quorums, hinted handoff, read repair and Merkle anti-entropy."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import hashlib
import random


N_REPLICAS = 3
N_NODES = 8
N_KEYS = 240


@dataclass(frozen=True)
class VectorClock:
    ticks: tuple[tuple[int, int], ...]

    def inc(self, node: int) -> "VectorClock":
        d = dict(self.ticks)
        d[node] = d.get(node, 0) + 1
        return VectorClock(tuple(sorted(d.items())))

    def merge(self, other: "VectorClock") -> "VectorClock":
        d = dict(self.ticks)
        for n, c in other.ticks:
            d[n] = max(d.get(n, 0), c)
        return VectorClock(tuple(sorted(d.items())))

    def dominates(self, other: "VectorClock") -> bool:
        if not other.ticks:
            return bool(self.ticks)
        d = dict(self.ticks)
        ge_all = True
        gt_one = False
        nodes = set(d) | set(dict(other.ticks))
        for n in nodes:
            a, b = d.get(n, 0), dict(other.ticks).get(n, 0)
            if a < b:
                ge_all = False
            if a > b:
                gt_one = True
        return ge_all and gt_one

    def concurrent_with(self, other: "VectorClock") -> bool:
        return self.ticks != other.ticks and not self.dominates(other) and not other.dominates(self)


@dataclass(frozen=True)
class Version:
    value: str
    clock: VectorClock


def reconcile(versions: list[Version]) -> list[Version]:
    kept: list[Version] = []
    for v in versions:
        if any(u.clock.dominates(v.clock) or u == v for u in kept):
            continue
        kept = [u for u in kept if not v.clock.dominates(u.clock)]
        if v not in kept:
            kept.append(v)
    return kept


def merkle_leaf(key: int, versions: list[Version]) -> str:
    payload = repr(sorted((v.value, v.clock.ticks) for v in versions)).encode()
    return hashlib.sha256(payload).hexdigest()


class Cluster:
    def __init__(self, n_nodes: int = N_NODES, n: int = N_REPLICAS, seed: int = 0) -> None:
        self.n_nodes = n_nodes
        self.n = n
        self.alive = [True] * n_nodes
        self.primary: list[dict[int, list[Version]]] = [dict() for _ in range(n_nodes)]
        self.hints: list[dict[int, tuple[int, list[Version]]]] = [dict() for _ in range(n_nodes)]
        self.rng = random.Random(seed)
        self.stats: dict[str, int] = defaultdict(int)
        self.truth: dict[int, list[Version]] = {}

    def preference(self, key: int) -> list[int]:
        start = key % self.n_nodes
        return [(start + i) % self.n_nodes for i in range(self.n_nodes)]

    def intended(self, key: int) -> list[int]:
        return self.preference(key)[: self.n]

    def first_healthy(self, key: int, count: int) -> list[int]:
        out: list[int] = []
        for node in self.preference(key):
            if self.alive[node]:
                out.append(node)
                if len(out) >= count:
                    break
        return out

    def _write_versions(self, node: int, key: int, incoming: list[Version], hinted_for: int | None) -> None:
        if hinted_for is None:
            current = self.primary[node].get(key, [])
            self.primary[node][key] = reconcile(current + incoming)
        else:
            current = self.hints[node].get(key, (hinted_for, []))[1]
            self.hints[node][key] = (hinted_for, reconcile(current + incoming))

    def _versions_on(self, node: int, key: int, include_hints: bool) -> list[Version]:
        got = list(self.primary[node].get(key, []))
        if include_hints and key in self.hints[node]:
            got.extend(self.hints[node][key][1])
        return reconcile(got)

    def put(
        self,
        key: int,
        value: str,
        w: int,
        sloppy: bool,
        context: VectorClock | None = None,
        coordinator: int | None = None,
    ) -> bool:
        intended = self.intended(key)
        dests = self.first_healthy(key, self.n) if sloppy else [x for x in intended if self.alive[x]]
        if coordinator is None:
            if not dests:
                self.stats["write_fail_no_coord"] += 1
                return False
            coordinator = dests[0]
        elif not self.alive[coordinator]:
            self.stats["write_fail_no_coord"] += 1
            return False
        clock = (context or VectorClock(())).inc(coordinator)
        ver = Version(value, clock)
        acks = 0
        missing = [x for x in intended if not self.alive[x]]
        for dest in dests:
            if dest in intended:
                self._write_versions(dest, key, [ver], None)
            else:
                target = missing[0] if missing else intended[-1]
                if missing:
                    missing.pop(0)
                self._write_versions(dest, key, [ver], target)
            acks += 1
            if acks >= w:
                break
        if acks >= w:
            self.stats["write_ok"] += 1
            self.truth[key] = reconcile(self.truth.get(key, []) + [ver])
            return True
        self.stats["write_fail_quorum"] += 1
        return False

    def get(self, key: int, r: int, sloppy: bool, read_repair: bool = False) -> list[Version] | None:
        intended = self.intended(key)
        dests = self.first_healthy(key, self.n) if sloppy else [x for x in intended if self.alive[x]]
        if len(dests) < r:
            self.stats["read_fail"] += 1
            return None
        order = dests[:]
        self.rng.shuffle(order)
        contacted = order[:r]
        collected: list[Version] = []
        for node in contacted:
            collected.extend(self._versions_on(node, key, include_hints=sloppy or node not in intended))
        result = reconcile(collected)
        if read_repair:
            for node in contacted:
                if node in intended:
                    self._write_versions(node, key, result, None)
                elif key in self.hints[node] or sloppy:
                    hinted_for = self.hints[node][key][0] if key in self.hints[node] else intended[0]
                    self._write_versions(node, key, result, hinted_for)
            self.stats["read_repair"] += 1
        self.stats["read_ok"] += 1
        return result

    def is_fresh(self, key: int, got: list[Version] | None) -> bool:
        if got is None:
            return False
        truth = self.truth.get(key, [])
        if not truth:
            return not got
        # Fresh if every current truth version is present, or is dominated by a returned version
        # (a later write subsumed it). Concurrent siblings must all appear.
        for t in truth:
            if any(g == t or g.clock.dominates(t.clock) or g.clock.ticks == t.clock.ticks for g in got):
                continue
            return False
        return True

    def deliver_hints(self) -> int:
        moved = 0
        for node in range(self.n_nodes):
            pending = list(self.hints[node].items())
            for key, (target, versions) in pending:
                if self.alive[target]:
                    self._write_versions(target, key, versions, None)
                    del self.hints[node][key]
                    moved += 1
        self.stats["hints_delivered"] += moved
        return moved

    def anti_entropy(self) -> tuple[int, int, int]:
        """Pairwise Merkle comparison of intended replicas; copy only divergent keys.

        Returns (pairs_compared, leaf_hashes_exchanged, keys_copied).
        """
        pairs = 0
        hashes = 0
        copied = 0
        # Group keys by the first intended node so each pairwise tree covers one range
        ranges: dict[int, list[int]] = defaultdict(list)
        for key in sorted(self.truth):
            ranges[self.intended(key)[0]].append(key)
        for owner, keys in ranges.items():
            if not keys:
                continue
            replicas = [node for node in self.intended(keys[0]) if self.alive[node]]
            if len(replicas) < 2:
                continue
            # Build per-replica leaf hashes
            leaves = {
                node: [merkle_leaf(k, self._versions_on(node, k, include_hints=False)) for k in keys]
                for node in replicas
            }

            def tree_hash(vals: list[str]) -> str:
                if not vals:
                    return hashlib.sha256(b"empty").hexdigest()
                if len(vals) == 1:
                    return vals[0]
                mid = len(vals) // 2
                return hashlib.sha256((tree_hash(vals[:mid]) + tree_hash(vals[mid:])).encode()).hexdigest()

            # Compare each pair: if roots differ, walk leaves (binary would prune; we count
            # a complete leaf walk only on mismatch, plus the root exchange always).
            for i, a in enumerate(replicas):
                for b in replicas[i + 1 :]:
                    pairs += 1
                    hashes += 1  # root exchange
                    ha, hb = tree_hash(leaves[a]), tree_hash(leaves[b])
                    if ha == hb:
                        continue
                    # Walk internal nodes in a binary tree, exchanging a hash only when a
                    # subtree mismatches. That is the Merkle saving versus sending every key.
                    def walk(lo: int, hi: int) -> None:
                        nonlocal hashes, copied
                        hashes += 2
                        chunk_a = tree_hash(leaves[a][lo:hi])
                        chunk_b = tree_hash(leaves[b][lo:hi])
                        if chunk_a == chunk_b:
                            return
                        if hi - lo == 1:
                            key = keys[lo]
                            merged = reconcile(
                                self._versions_on(a, key, False) + self._versions_on(b, key, False)
                            )
                            self._write_versions(a, key, merged, None)
                            self._write_versions(b, key, merged, None)
                            copied += 1
                            return
                        mid = lo + (hi - lo) // 2
                        walk(lo, mid)
                        walk(mid, hi)

                    walk(0, len(keys))
        self.stats["ae_pairs"] += pairs
        self.stats["ae_hashes"] += hashes
        self.stats["ae_copied"] += copied
        return pairs, hashes, copied

    def set_alive(self, nodes: list[int], alive: bool) -> None:
        for node in nodes:
            self.alive[node] = alive


def reset_stats(c: Cluster) -> None:
    c.stats = defaultdict(int)


def with_intended_down(c: Cluster, key: int, down_k: int):
    down = c.intended(key)[:down_k]
    for node in down:
        c.alive[node] = False
    return down


def restore(c: Cluster, down: list[int]) -> None:
    c.set_alive(down, True)


def write_all(c: Cluster, keys: range, w: int, sloppy: bool, prefix: str, down_k: int = 0) -> int:
    ok = 0
    for key in keys:
        down = with_intended_down(c, key, down_k) if down_k else []
        if c.put(key, f"{prefix}-{key}", w, sloppy):
            ok += 1
        restore(c, down)
    return ok


def read_all(c: Cluster, keys: range, r: int, sloppy: bool, read_repair: bool) -> tuple[int, int, int]:
    fresh = stale = failed = 0
    for key in keys:
        got = c.get(key, r, sloppy, read_repair=read_repair)
        if got is None:
            failed += 1
        elif c.is_fresh(key, got):
            fresh += 1
        else:
            stale += 1
    return fresh, stale, failed


def write_while_down(c: Cluster, keys: range, w: int, sloppy: bool, prefix: str, down_k: int) -> int:
    """Write each key while k of its intended replicas are down; leave those replicas up afterwards."""
    ok = 0
    for key in keys:
        down = with_intended_down(c, key, down_k)
        if c.put(key, f"{prefix}-{key}", w, sloppy):
            ok += 1
        restore(c, down)
    return ok


def availability_sweep() -> None:
    print("== write availability, N=3, 240 keys, 8 nodes (failures applied per key, then restored) ==")
    print(f"{'pattern':<28} {'W=2 strict':>12} {'W=2 sloppy':>12} {'W=1 strict':>12} {'W=1 sloppy':>12}")
    patterns = [
        ("all healthy", 0),
        ("1 intended down", 1),
        ("2 intended down", 2),
        ("all 3 intended down", 3),
    ]
    for label, down_k in patterns:
        row = []
        for w, sloppy in ((2, False), (2, True), (1, False), (1, True)):
            c = Cluster(seed=1)
            ok = write_all(c, range(N_KEYS), w, sloppy, "v1", down_k=down_k)
            row.append(f"{ok}/{N_KEYS}")
        print(f"{label:<28} {row[0]:>12} {row[1]:>12} {row[2]:>12} {row[3]:>12}")
    print()


def stale_after_recovery() -> None:
    print("== stale reads after k intended replicas drop, write, then those replicas recover (hints not delivered) ==")
    print(f"{'mode / (W,R) / down':<48} {'wrote':>6} {'fresh':>8} {'stale':>8} {'failed':>8}")
    configs = [
        ("strict write+read", False, False, 2),
        ("sloppy write, strict read", True, False, 2),
        ("sloppy write+read", True, True, 2),
        ("sloppy write, strict read", True, False, 3),
        ("sloppy write+read", True, True, 3),
    ]
    for label, w_sloppy, r_sloppy, down_k in configs:
        for w, r in ((2, 2), (2, 3), (2, 1), (1, 1)):
            if not w_sloppy and down_k >= w:
                # strict writes cannot gather W acks from the intended set
                pass
            c = Cluster(seed=2)
            wrote = write_while_down(c, range(N_KEYS), w, w_sloppy, "v1", down_k)
            fresh, stale, failed = read_all(c, range(N_KEYS), r, r_sloppy, read_repair=False)
            print(f"{label} W={w} R={r} down={down_k:<1}          {wrote:>6} {fresh:>8} {stale:>8} {failed:>8}")
    print()


def handoff_and_repair() -> None:
    print("== repair paths after sloppy W=2 R=2 writes, then recovered replicas, strict reads ==")

    def setup(seed: int, down_k: int) -> Cluster:
        c = Cluster(seed=seed)
        write_while_down(c, range(N_KEYS), 2, True, "v1", down_k)
        return c

    def report(title: str, down_k: int, fn) -> None:
        c = setup(3, down_k)
        extra = fn(c)
        fresh, stale, failed = read_all(c, range(N_KEYS), 2, False, read_repair=False)
        suffix = f"  {extra}" if extra else ""
        print(f"down={down_k} {title:<34} fresh={fresh} stale={stale} failed={failed}{suffix}")

    for down_k in (2, 3):
        report("before any repair", down_k, lambda c: "")
        report("after hinted handoff", down_k, lambda c: f"hints={c.deliver_hints()}")

        c = setup(3, down_k)
        p1 = read_all(c, range(N_KEYS), 2, False, read_repair=True)
        p2 = read_all(c, range(N_KEYS), 2, False, read_repair=True)
        p3 = read_all(c, range(N_KEYS), 2, False, read_repair=True)
        print(
            f"down={down_k} read repair passes                  "
            f"p1 fresh={p1[0]} stale={p1[1]}  p2 fresh={p2[0]} stale={p2[1]}  p3 fresh={p3[0]} stale={p3[1]}"
        )

        report(
            "Merkle on intended only",
            down_k,
            lambda c: "pairs=%s hashes=%s copied=%s" % c.anti_entropy(),
        )
        def handoff_merkle(c: Cluster) -> str:
            moved = c.deliver_hints()
            pairs, hashes, copied = c.anti_entropy()
            return f"hints={moved} pairs={pairs} hashes={hashes} copied={copied}"
        report("handoff then Merkle", down_k, handoff_merkle)
        print()


def healthy_quorum_matrix() -> None:
    print("== healthy cluster, one write then one read per key ==")
    print(f"{'(W,R)':<10} {'fresh':>8} {'stale':>8} {'write_fail':>12} {'read_fail':>10}")
    for w, r in ((1, 1), (2, 1), (1, 2), (2, 2), (3, 1), (1, 3), (3, 3), (2, 3)):
        c = Cluster(seed=4)
        ok = write_all(c, range(N_KEYS), w, False, "v1")
        fresh, stale, failed = read_all(c, range(N_KEYS), r, False, read_repair=False)
        print(f"({w},{r})     {fresh:>8} {stale:>8} {N_KEYS - ok:>12} {failed:>10}")
    print()


def concurrent_siblings() -> None:
    print("== concurrent writes while the preference list is split, then a quorum read ==")
    c = Cluster(seed=5)
    key = 0
    intended = c.intended(key)
    a, b, node_c = intended
    # Partition: A isolated from B and C
    # Client 1 writes via A only (W=1, coordinator A) with A up and B,C down from A's view
    c.set_alive([b, node_c], False)
    ok_a = c.put(key, "from-A", w=1, sloppy=False, coordinator=a)
    c.set_alive([b, node_c], True)
    c.set_alive([a], False)
    ok_bc = c.put(key, "from-BC", w=2, sloppy=False, coordinator=b)
    c.set_alive([a], True)
    got = c.get(key, r=3, sloppy=False, read_repair=False)
    values = sorted(v.value for v in (got or []))
    print(f"intended={intended} write_A={ok_a} write_BC={ok_bc}")
    print(f"R=3 returns {len(got or [])} version(s): {values}")
    print(f"clocks: {[v.clock.ticks for v in (got or [])]}")
    # A syntactic winner would be wrong here: both writes are concurrent.
    print(f"concurrent? {got[0].clock.concurrent_with(got[1].clock) if got and len(got) == 2 else 'n/a'}")
    print()


def merkle_saving() -> None:
    print("== Merkle anti-entropy traffic versus copying every key, after a minority of keys diverge ==")
    for diverge in (1, 6, 24, 60):
        c = Cluster(seed=6)
        write_all(c, range(N_KEYS), 3, False, "v1")
        # Force divergence: delete the key from one intended replica
        changed = list(range(diverge))
        for key in changed:
            victim = c.intended(key)[-1]
            if key in c.primary[victim]:
                del c.primary[victim][key]
        pairs, hashes, copied = c.anti_entropy()
        naive = N_KEYS * pairs  # sending every key's payload to compare
        print(
            f"divergent keys={diverge:<3}  pairs={pairs}  "
            f"hashes_exchanged={hashes:<5}  keys_copied={copied:<3}  "
            f"naive_key_compare={naive}"
        )
    print()


def main() -> None:
    print(f"Nodes={N_NODES}  N={N_REPLICAS}  Keys={N_KEYS}")
    print()
    availability_sweep()
    healthy_quorum_matrix()
    stale_after_recovery()
    handoff_and_repair()
    concurrent_siblings()
    merkle_saving()


if __name__ == "__main__":
    main()
```

## Summary

- Leaderless replication keeps a key writable without electing a primary. A coordinator in the preference list waits for W replicas to persist a write, and a later read waits for R and reconciles versions. The common Dynamo configuration was `(N, R, W) = (3, 2, 2)`.
- `R + W > N` gives a read/write overlap only for a *fixed* replica set and a *single* most recent write. In the model, a healthy cluster is always fresh at `(2, 2)` and always about two-thirds stale at `(1, 1)`.
- Concurrent writes are not a single newest value. Dynamo keeps a vector clock per version, drops ancestors, and returns siblings for the application to merge. A shopping-cart merge does not lose an add; it can resurrect a delete. Last-write-wins drops one of the concurrent updates.
- A sloppy quorum writes to the first N healthy nodes, not necessarily the intended N, and leaves a hint on the substitute. That is why W = 2 still succeeds with two intended replicas down. It is also why, after those replicas recover and before handoff, about one third of R = 2 reads are stale, and why a write accepted while all three intended replicas were down is invisible to the intended set until hints are delivered.
- Read repair only heals replicas the read saw. In the model it converges gradually when one intended copy is live, and does not converge at all when the live copies are only on hint holders.
- Merkle-tree anti-entropy compares hash branches and copies only divergent keys. It can heal missing intended replicas if at least one of them still has the value; it cannot, by itself, discover a value that lives only in the hint store.
- Cassandra counts consistency levels against intended replicas and stores hints on the coordinator for a default 3-hour window; they are best effort, and they do not count toward W. Riak stayed closer to siblings and active anti-entropy. DynamoDB, despite the name, replicates each partition with Multi-Paxos, a leader, and a two-of-three WAL quorum, and heals a missing peer with a log replica rather than a sloppy write.
- If you need a unique winner or a compare-and-set, use consensus (or a system that already runs it). Do not ask a sloppy quorum and a timestamp to do that job.

## References

- Giuseppe DeCandia, Deniz Hastorun, Madan Jampani, Gunavardhan Kakulapati, Avinash Lakshman, Alex Pilchin, Swaminathan Sivasubramanian, Peter Vosshall, and Werner Vogels, [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), SOSP 2007
- Werner Vogels, [Eventually Consistent](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html)
- Mostafa Elhemali, Niall Gallagher, Nicholas Gordon, Joseph Idziorek, Richard Krog, Colin Lazier, Erben Mo, Akhilesh Mritunjai, Somu Perianayagam, Tim Rath, Swami Sivasubramanian, James Christopher Sorenson III, Sroaj Sosothikul, Doug Terry, and Akshat Vig, [Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service](https://www.usenix.org/system/files/atc22-elhemali.pdf), USENIX ATC 2022
- Amazon Science, [Lessons learned from 10 years of DynamoDB](https://www.amazon.science/blog/lessons-learned-from-10-years-of-dynamodb)
- Apache Cassandra, [Hints](https://cassandra.apache.org/doc/4.1/cassandra/operating/hints.html)
- Apache Cassandra, [Read repair](https://cassandra.apache.org/doc/stable/cassandra/managing/operating/read_repair.html)
- Apache Cassandra, [cassandra.yaml](https://cassandra.apache.org/doc/stable/cassandra/managing/configuration/cass_yaml_file.html) (`max_hint_window`)
- Riak KV, [Active Anti-Entropy](https://docs.riak.com/riak/kv/2.2.3/learn/concepts/active-anti-entropy/index.html)
- Riak KV, [Causal Context](https://docs.riak.com/riak/kv/2.2.3/learn/concepts/causal-context/) (dotted version vectors)
- Riak KV, [Conflict Resolution](https://docs.riak.com/riak/kv/2.2.3/developing/usage/conflict-resolution/index.html)
- Ralph C. Merkle, [A Digital Signature Based on a Conventional Encryption Function](https://people.eecs.berkeley.edu/~raluca/cs261-f15/readings/merkle.pdf), CRYPTO 1987
- Martin Kleppmann, *Designing Data-Intensive Applications*, Chapter 5, "Replication," O'Reilly, 2017
