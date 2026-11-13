---
title: "CRDTs in Depth: Conflict-Free Replicated Data Types from Counters to Collaborative Text"
tag: architecture
description: How CRDTs let replicas accept writes independently and still converge without coordination — strong eventual consistency, the join-semilattice math behind state-based CRDTs, operation-based and delta-state variants, counters, registers, OR-Sets and maps, sequence CRDTs (RGA, YATA, Fugue) for collaborative editing, tombstones and garbage collection, how Riak, Redis Active-Active, Automerge and Yjs use them, where CRDTs are the wrong tool, and a runnable model that checks convergence over random gossip schedules
date: "2026-11-13T14:30:00.000Z"
---

## Goal

Most replication schemes fight conflicts by preventing them: a single leader orders all writes (Raft, Paxos, primary/replica databases), or a lock makes writers take turns. That works until the network does not cooperate — a phone goes offline on a train, a datacenter is cut off, or two people type into the same document at the same moment. Then you must either refuse writes (lose availability) or accept them and reconcile later.

Conflict-free Replicated Data Types (CRDTs) take the second road but remove the "reconcile" headache: they are data structures designed so that **any two replicas that have seen the same set of updates are in the same state, no matter the order those updates arrived in**. No leader, no consensus round, no manual merge.

This article covers:

1. Strong eventual consistency and why it is different from "eventual consistency".
2. State-based CRDTs and the join-semilattice rules (commutative, associative, idempotent merge).
3. Operation-based and delta-state CRDTs, and what each demands from the network.
4. The core catalogue: G-Counter, PN-Counter, LWW-Register, MV-Register, OR-Set, maps.
5. Sequence CRDTs for collaborative text: RGA, YATA (Yjs), Fugue and the interleaving problem.
6. Metadata growth, tombstones and garbage collection.
7. Real systems: Riak, Redis Active-Active, Automerge, Yjs, and Figma's "CRDT-inspired" design.
8. When not to use a CRDT.

## 1. Strong eventual consistency

Plain *eventual consistency* promises only that if writes stop, replicas will eventually agree. It says nothing about *how* they agree, so in practice systems bolt on conflict resolution — often "last writer wins" by wall clock, which silently drops data (see the earlier article on distributed clocks for why wall clocks are untrustworthy).

Shapiro, Preguiça, Baquero and Zawirski formalized a stronger guarantee in their 2011 paper *Conflict-free Replicated Data Types*: **Strong Eventual Consistency (SEC)**.

- **Eventual delivery**: every update applied at one correct replica is eventually applied at all correct replicas.
- **Convergence**: replicas that have applied the same *set* of updates are in equivalent states — immediately, not "eventually".
- **Termination**: every method call finishes locally.

The key word is *set*. Order and duplication do not matter. That is what lets a CRDT replica accept a write while partitioned, gossip it later, and still converge deterministically.

SEC is still weaker than linearizability. A CRDT cannot enforce "the balance never goes below zero" or "this username is unique", because those invariants require replicas to agree *before* accepting a write. CAP still applies; CRDTs choose AP and make the merge principled.

## 2. State-based CRDTs (CvRDTs)

A state-based CRDT replica keeps a local state and periodically ships its *whole state* to peers, which merge it into their own. Convergence follows if the states form a **join-semilattice** and merge computes the least upper bound (join, written ⊔):

| Property | Law | Why it matters |
| --- | --- | --- |
| Commutative | a ⊔ b = b ⊔ a | Order of gossip does not matter |
| Associative | (a ⊔ b) ⊔ c = a ⊔ (b ⊔ c) | Grouping / relaying does not matter |
| Idempotent | a ⊔ a = a | Duplicate delivery is harmless |

And every local update must be **inflationary**: it only moves the state "upward" in the partial order. Under these rules the network can reorder, duplicate and delay messages freely — it only needs to deliver eventually. That is why state-based CRDTs fit gossip protocols and unreliable links so well.

### The G-Counter

The simplest useful example is a grow-only counter. Each replica owns one slot in a map and only increments its own slot. Merge takes the element-wise maximum; the value is the sum.

```python
class GCounter:
    def __init__(self, rid):
        self.rid, self.p = rid, {}           # replica id -> count

    def inc(self, n=1):
        self.p[self.rid] = self.p.get(self.rid, 0) + n

    def value(self):
        return sum(self.p.values())

    def merge(self, other):
        for k, v in other.p.items():
            self.p[k] = max(self.p.get(k, 0), v)
```

`max` is commutative, associative and idempotent, and increments only raise a slot, so the laws hold. Contrast with the tempting alternative of storing one integer and resolving conflicts by timestamp: two replicas both read 0, both write 1, and last-writer-wins keeps 1 — one increment is lost. In the runnable model at the end of this article, the LWW version yields 1 after two increments while the G-Counter yields 2.

### PN-Counter

To support decrements, keep two G-Counters, P for increments and N for decrements; value = sum(P) − sum(N). You cannot just let a slot go down, because a smaller value would lose against `max` during merge.

## 3. Operation-based and delta-state CRDTs

Shipping full state gets expensive as it grows. Two alternatives exist.

**Operation-based (CmRDT)**: replicas broadcast *operations* ("increment by 3", "insert 'x' after id 42"). Concurrent operations must commute, but the network contract is stricter: every operation must be delivered **exactly once** and usually in **causal order** (an op is applied only after the ops it depends on). That typically means a reliable causal broadcast layer with vector clocks or explicit dependency tracking. Messages are small; delivery is harder.

**Delta-state CRDTs** (Almeida, Shoker and Baquero, 2018) are the pragmatic middle: an update produces a small *delta state* — itself an element of the lattice — that can be merged with the same join function. Deltas can be batched, duplicated and reordered like full states, yet they are as small as operations. Most production CRDT libraries and databases use this style or a close relative.

| Style | Message size | Network requirement | Typical use |
| --- | --- | --- | --- |
| State-based | Whole state | Eventual delivery only | Gossip, small objects |
| Op-based | One operation | Exactly-once, causal | Collaborative editors with a relay server |
| Delta-state | Small delta | Eventual delivery (causal for some types) | Databases, sync engines |

## 4. The core catalogue

### Registers: LWW vs multi-value

A **LWW-Register** stores (value, timestamp) and keeps the larger timestamp, breaking ties by replica id. It is a valid CRDT — `max` on a total order is a join — but it *chooses* to discard concurrent writes. That is fine for a "last seen at" field and wrong for a shopping cart. Use hybrid logical clocks rather than raw wall clocks for the timestamps.

A **Multi-Value Register (MV-Register)** keeps *all* concurrent values, tagged with version vectors, and returns a set. When one write causally follows another, the older one is dropped; when they are concurrent, both survive and the application (or user) decides. Amazon's Dynamo shopping cart worked this way, surfacing "siblings" to the application, and Riak exposed the same idea.

### Sets: why "remove" is hard

A **G-Set** (grow-only, merge = union) is trivial. Removal is the problem: if A removes `x` while B concurrently adds `x`, what should the merged set contain? A naive **2P-Set** keeps an add-set and a remove-set (tombstones) and never lets a removed element come back — surprising for users.

The **Observed-Remove Set (OR-Set)** gives the intuitive behaviour. Every add creates a unique tag; a remove deletes only the tags the remover has *observed*. A concurrent add carries a fresh tag the remover never saw, so it survives: **add wins**.

```python
class ORSet:
    def __init__(self, rid):
        self.rid, self.n = rid, 0
        self.adds, self.tombs = set(), set()   # sets of (element, tag)

    def add(self, e):
        self.n += 1
        self.adds.add((e, (self.rid, self.n)))  # globally unique tag

    def remove(self, e):
        self.tombs |= {t for t in self.adds if t[0] == e}  # only observed tags

    def value(self):
        return {e for (e, _) in self.adds - self.tombs}

    def merge(self, other):
        self.adds |= other.adds
        self.tombs |= other.tombs
```

This straightforward version keeps every tombstone forever. Optimized OR-Sets (Bieniusa et al., 2012, "An optimized conflict-free replicated set") replace tombstones with a per-replica version vector plus a "dot" per live element, so removed elements cost nothing once everyone has seen the removal. Riak's sets and maps use this dotted-version-vector approach.

Remove-wins sets exist too; choosing add-wins or remove-wins is a *semantic* decision about your domain, not a technical one.

### Maps and JSON

A map CRDT is a map from keys to nested CRDTs, with an OR-Set style key set and recursive merge. Kleppmann and Beresford's 2017 paper *A Conflict-Free Replicated JSON Datatype* generalizes this to arbitrary nested JSON with lists — the theoretical basis for Automerge. The hard question is what happens when one replica deletes a key while another edits a field inside it; JSON CRDTs typically resurrect the edited subtree (an "update wins" policy), which again is a design choice.

## 5. Sequence CRDTs: collaborative text

Text is where CRDTs became famous and where they are hardest. Positions are the problem: "insert at index 5" means different things on replicas that have seen different inserts. Operational Transformation (OT, used by Google Docs) rewrites indices against concurrent operations, usually with a central server to order them. Sequence CRDTs instead give **every character a unique, immutable identifier** and express inserts relative to identifiers, not indices.

- **RGA** (Replicated Growable Array, Roh et al., 2011): each insert names its left neighbor's id; concurrent inserts after the same neighbor are ordered by a (Lamport timestamp, replica id) pair, newest first. Deletes leave tombstones so later ops can still reference the id.
- **YATA** (Nicolaescu et al., 2016), the algorithm behind **Yjs**: each item records both its left and right origin at insert time, which gives a well-defined order for concurrent inserts and lets Yjs merge adjacent items written by the same client into compact runs.
- **Logoot / LSEQ / Treedoc**: allocate dense, sortable position identifiers (like fractional indices) so no tombstones are needed for ordering, at the cost of identifier growth.
- **Fugue** (Weidner and Kleppmann, 2023): designed to minimize **interleaving**.

Interleaving is the classic anomaly: Alice types "Hello" and Bob concurrently types "World" at the same position; a poor algorithm can produce "HWeolrllod". Kleppmann et al.'s 2019 paper *Interleaving anomalies in collaborative text editors* showed that Logoot and LSEQ can interleave forward-typed text, and RGA can interleave in some backward-typing cases. Fugue proves "maximal non-interleaving" and is now used in newer libraries; Automerge's sequence type builds on RGA.

Engineering, not math, made these practical. Early CRDT editors stored an object per character and were orders of magnitude slower than OT. Modern implementations store runs of characters in B-trees or skip lists keyed by (client, clock) ranges, encode history in compact columnar formats (Automerge 2.x), and run in Rust/WASM. Joseph Gentle's "5000x faster CRDTs" write-up (2021) and his later *eg-walker* work with Kleppmann (2024) are good accounts of how far this went.

## 6. Metadata and garbage collection

CRDTs trade coordination for metadata. Costs to plan for:

1. **Replica ids in counters and vectors.** A G-Counter has one slot per replica that ever wrote. With millions of short-lived browser sessions, ids must be reused or folded into a server-side id.
2. **Tombstones.** Deleted sequence items and observed-remove tags stay until it is safe to drop them. "Safe" means every replica has seen the delete — a *causal stability* condition that needs knowledge of the full membership, which is exactly the coordination CRDTs try to avoid. Systems compromise: compact only on a server that knows all active peers, or drop history older than a horizon and force very stale clients to resync from a snapshot.
3. **History.** Automerge keeps full history by design (it powers time travel and diffing); Yjs keeps only what it needs to merge, and can turn off garbage collection when you want snapshots.

A useful mental model: CRDTs are cheap to *write*, and the bill arrives as state size. Measure document size after realistic editing sessions, not after a fresh import.

## 7. CRDTs in real systems

- **Riak (2.0+)** shipped counters, sets, maps, registers and flags as server-side data types using dotted version vectors, so application code stopped writing sibling-resolution logic.
- **Redis Enterprise Active-Active** (CRDB) replicates across regions with CRDT semantics per data type: counters merge additively, sets follow add-wins observed-remove, and strings use last-write-wins. Each region accepts local writes with local latency.
- **Azure Cosmos DB** multi-region writes offer a last-writer-wins policy by default and a custom merge procedure; it is a practical reminder that LWW is the default in many products, and you must opt in to richer semantics.
- **Automerge and Yjs** are the main open-source libraries for local-first apps and collaborative editors. Yjs has bindings for ProseMirror, CodeMirror, Monaco, Quill and others; Automerge focuses on a JSON document model with full history. The 2019 essay *Local-first software* (Kleppmann, Wiggins, van Hardenberg, McGranaghan) lays out why: apps that work offline, sync across devices, and keep data on the user's machine.
- **Figma** described its multiplayer system (Evan Wallace, 2019) as *inspired by* CRDTs but using a central server as the authority: per-property last-writer-wins on objects, with the server ordering conflicting edits. Having a server lets you skip the hardest CRDT problems (garbage collection, sequence ordering) — a good example of taking only what you need.

## 8. When not to use a CRDT

- **Invariants across replicas.** Uniqueness, non-negative balances, inventory limits and foreign-key-like constraints need coordination. Use consensus or a single writer, or combine: CRDT for most fields, a coordinated "reservation" for the constrained one (the idea behind *bounded counters*, Balegas et al. 2015, which pre-split a budget between replicas).
- **When "merged" is not "correct".** A CRDT guarantees agreement, not intent. Two people concurrently editing the same sentence to different meanings converge to *something* — possibly nonsense. UI affordances (presence, cursors, comments) matter as much as the algorithm.
- **When a central server is always reachable.** If every client is online and a server orders writes anyway, a server-authoritative model (or OT) is simpler and has less metadata.
- **Large binary blobs.** Merging is meaningless; use LWW per blob or content-addressed versions.

### A quick decision table

| Need | Good fit |
| --- | --- |
| Offline-first app, sync across devices | Automerge / Yjs |
| Multi-region writes to counters or sets | Database CRDT types (Riak, Redis Active-Active) |
| Real-time editor with a central server | Yjs, or server-ordered OT |
| Strong invariants (money, stock, uniqueness) | Consensus / single leader, maybe bounded counters |
| "Most recent value" fields like status or last seen | LWW-Register with hybrid logical clocks |

## 9. A runnable convergence model

The script below runs four replicas through 400 random steps of local updates interleaved with random partial gossip, then has every replica merge every other in a random order, and checks that all final states are identical. It repeats this over 200 random schedules for both the G-Counter and the OR-Set from earlier, demonstrates add-wins, and compares against a naive LWW counter.

```python
import random

def run(cls, ops, replicas=4, steps=400, seed=0):
    rnd = random.Random(seed)
    rs = [cls(i) for i in range(replicas)]
    for _ in range(steps):
        r = rnd.choice(rs)
        if rnd.random() < 0.3:
            r.merge(rnd.choice(rs))       # random partial gossip
        else:
            ops(r, rnd)
    for r in rs:                          # final anti-entropy, random order
        order = rs[:]; rnd.shuffle(order)
        for o in order:
            r.merge(o)
    return rs

def counter_ops(r, rnd): r.inc(rnd.randint(1, 3))
def set_ops(r, rnd):
    e = rnd.choice("abcde")
    (r.add if rnd.random() < 0.6 else r.remove)(e)

# state(): a hashable snapshot, e.g. tuple(sorted(self.p.items())) for GCounter
for name, cls, ops in [("GCounter", GCounter, counter_ops),
                       ("ORSet", ORSet, set_ops)]:
    ok = sum(len({r.state() for r in run(cls, ops, seed=s)}) == 1
             for s in range(200))
    print(name, "converged in", ok, "/ 200 random schedules")

a, b = ORSet("A"), ORSet("B")
a.add("x"); b.merge(a)
b.remove("x"); a.add("x")                 # concurrent remove and re-add
a.merge(b); b.merge(a)
print("add-wins:", a.value(), b.value())

# naive counter: both replicas read 0 and write 1; LWW keeps one write
lww = max([(1, 1), (1, 2)], key=lambda vt: vt[1])[0]
g1, g2 = GCounter("A"), GCounter("B"); g1.inc(); g2.inc(); g1.merge(g2)
print("LWW counter after two increments:", lww, " GCounter:", g1.value())
```

Output on CPython 3:

```text
GCounter converged in 200 / 200 random schedules
ORSet converged in 200 / 200 random schedules
add-wins: {'x'} {'x'}
LWW counter after two increments: 1  GCounter: 2
```

Notice what the model does *not* need: no message ordering, no deduplication, no leader. Merging a replica with itself or merging the same peer twice changes nothing — idempotence in action. That robustness is the entire value proposition.

## Summary

- CRDTs give **strong eventual consistency**: replicas that saw the same set of updates are in the same state, regardless of order or duplication.
- State-based CRDTs need a merge that is commutative, associative and idempotent, plus inflationary updates; op-based CRDTs need exactly-once causal delivery; delta-state CRDTs combine small messages with a forgiving network contract.
- The semantics are design decisions: LWW vs multi-value registers, add-wins vs remove-wins sets, update-wins maps.
- Sequence CRDTs (RGA, YATA, Fugue) make collaborative text possible without a central sequencer; modern implementations are fast thanks to run-length encoding and compact history.
- The cost is metadata and tombstones, and CRDTs cannot enforce cross-replica invariants — reach for coordination there.

## References

- Shapiro, Preguiça, Baquero, Zawirski. *Conflict-free Replicated Data Types* (SSS 2011) and *A comprehensive study of Convergent and Commutative Replicated Data Types* (INRIA RR-7506, 2011).
- Almeida, Shoker, Baquero. *Delta State Replicated Data Types*. Journal of Parallel and Distributed Computing, 2018.
- Bieniusa et al. *An Optimized Conflict-free Replicated Set*. arXiv:1210.3368, 2012.
- Kleppmann, Beresford. *A Conflict-Free Replicated JSON Datatype*. IEEE TPDS, 2017.
- Roh, Jeon, Kim, Lee. *Replicated abstract data types: Building blocks for collaborative applications*. JPDC, 2011 (RGA).
- Nicolaescu et al. *Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types*. GROUP 2016 (YATA / Yjs).
- Kleppmann et al. *Interleaving anomalies in collaborative text editors*. PaPoC 2019.
- Weidner, Kleppmann. *The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing*. arXiv:2305.00583, 2023.
- Kleppmann, Wiggins, van Hardenberg, McGranaghan. *Local-first software: You own your data, in spite of the cloud*. Onward! 2019.
- Balegas et al. *Extending Eventually Consistent Cloud Databases for Enforcing Numeric Invariants*. SRDS 2015 (bounded counters).
- DeCandia et al. *Dynamo: Amazon's Highly Available Key-value Store*. SOSP 2007.
- Evan Wallace. *How Figma's multiplayer technology works*. Figma blog, 2019.
- Documentation: automerge.org, docs.yjs.dev, Redis Active-Active documentation, Riak data types documentation.
