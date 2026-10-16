---
title: "Raft Consensus in Depth: Elections, Log Replication, and the Engineering Behind Production Clusters"
tag: architecture
description: A deep walk through the Raft consensus algorithm — leader election, log replication, the commit rule, membership changes, linearizable reads, and the extensions (PreVote, CheckQuorum, ReadIndex) that real systems like etcd rely on
date: "2026-10-16T10:00:00.000Z"
---

## Goal

Almost every piece of modern infrastructure that needs "one source of truth" — etcd behind Kubernetes, Consul, CockroachDB and TiKV ranges, Kafka's KRaft controller quorum — sits on top of a consensus protocol, and most of them chose Raft. This article explains how Raft actually works, why each rule exists, which corner cases bite in production, and what extensions real implementations add on top of the original paper.

## Background

### The problem consensus solves

We want a group of servers to behave like a single, reliable state machine. Clients send commands; every server applies the same commands in the same order; the system keeps working as long as a majority of servers are alive and can talk to each other.

This is called **state machine replication**. The hard part is not applying commands — it is agreeing on *the order* of commands when messages can be delayed, duplicated, or lost, and when servers crash and restart.

Raft assumes:

- **Crash-recovery failures**, not Byzantine ones. Nodes may stop and come back, but they do not lie.
- **Asynchronous network**: messages can be delayed or reordered arbitrarily. Safety never depends on timing; only liveness (making progress) does.
- **Stable storage**: certain state must be persisted to disk before responding to RPCs.

### Why Raft instead of Paxos

Diego Ongaro and John Ousterhout published Raft in 2014 ("In Search of an Understandable Consensus Algorithm", USENIX ATC). Multi-Paxos and Raft are comparable in fault tolerance and performance, but Raft was designed for understandability: it decomposes consensus into **leader election**, **log replication**, and **safety**, and it reduces the state space by making the leader the only node that accepts new entries.

## Core State

Every Raft node keeps:

```go
type Role int

const (
	Follower Role = iota
	Candidate
	Leader
)

type LogEntry struct {
	Term    uint64
	Index   uint64
	Command []byte
}

type Node struct {
	// Persistent state — must be fsynced before replying to any RPC
	currentTerm uint64
	votedFor    string // candidate ID voted for in currentTerm, "" if none
	log         []LogEntry

	// Volatile state on all servers
	commitIndex uint64 // highest index known to be committed
	lastApplied uint64 // highest index applied to the state machine

	// Volatile state on leaders, reinitialized after each election
	nextIndex  map[string]uint64 // next log index to send to each peer
	matchIndex map[string]uint64 // highest index known replicated on each peer

	role Role
}
```

**Terms** are Raft's logical clock. Each term starts with an election and has at most one leader. Every RPC carries the sender's term, and there is one universal rule:

> If a node sees a term greater than its own, it updates `currentTerm`, clears `votedFor`, and becomes a follower.

A stale leader that receives any message with a higher term immediately steps down. This single rule resolves a large class of "two leaders" scenarios.

## Leader Election

### Timeouts and randomization

Followers expect periodic heartbeats (empty `AppendEntries`) from the leader. If a follower hears nothing for an **election timeout**, it becomes a candidate:

1. Increment `currentTerm`
2. Vote for itself (persisted)
3. Send `RequestVote` to all peers
4. Wait for: a majority of votes (become leader), an `AppendEntries` from a valid leader (become follower), or another timeout (start a new election)

Split votes are possible when two followers time out simultaneously. Raft avoids repeated splits by **randomizing** the timeout; the paper suggests a range like 150–300 ms. The essential timing requirement is:

```
broadcastTime  <<  electionTimeout  <<  MTBF
```

The election timeout must be much larger than a typical round trip (including fsync), or followers will keep starting elections against a healthy leader.

### The election restriction

Votes are not given freely. A voter refuses a candidate whose log is less up to date than its own:

```go
func (n *Node) candidateLogIsUpToDate(lastLogTerm, lastLogIndex uint64) bool {
	myLastTerm, myLastIndex := n.lastLogTermAndIndex()
	if lastLogTerm != myLastTerm {
		return lastLogTerm > myLastTerm
	}
	return lastLogIndex >= myLastIndex
}

func (n *Node) HandleRequestVote(req RequestVoteReq) RequestVoteResp {
	if req.Term < n.currentTerm {
		return RequestVoteResp{Term: n.currentTerm, Granted: false}
	}
	if req.Term > n.currentTerm {
		n.becomeFollower(req.Term) // clears votedFor
	}
	canVote := n.votedFor == "" || n.votedFor == req.CandidateID
	if canVote && n.candidateLogIsUpToDate(req.LastLogTerm, req.LastLogIndex) {
		n.votedFor = req.CandidateID
		n.persist() // must hit disk before replying
		n.resetElectionTimer()
		return RequestVoteResp{Term: n.currentTerm, Granted: true}
	}
	return RequestVoteResp{Term: n.currentTerm, Granted: false}
}
```

Because a committed entry exists on a majority, and a winner needs votes from a majority, the two majorities overlap in at least one node. That node will refuse any candidate missing the committed entry. This is the **Leader Completeness** property: every leader contains all entries committed in previous terms. Raft therefore never needs to transfer missing committed entries *to* a new leader — data only flows leader → follower.

## Log Replication

### AppendEntries and the consistency check

The leader appends a client command to its own log, then sends `AppendEntries` to followers containing the new entries plus `prevLogIndex` and `prevLogTerm` — the index and term of the entry immediately preceding them.

```go
func (n *Node) HandleAppendEntries(req AppendEntriesReq) AppendEntriesResp {
	if req.Term < n.currentTerm {
		return AppendEntriesResp{Term: n.currentTerm, Success: false}
	}
	n.becomeFollower(req.Term)
	n.resetElectionTimer()

	// Consistency check
	if !n.hasEntry(req.PrevLogIndex, req.PrevLogTerm) {
		return AppendEntriesResp{
			Term:          n.currentTerm,
			Success:       false,
			ConflictIndex: n.firstIndexOfConflictingTerm(req.PrevLogIndex),
		}
	}

	// Only truncate on an actual conflict; never drop entries just because
	// a (possibly reordered, older) request is shorter.
	for i, e := range req.Entries {
		idx := req.PrevLogIndex + 1 + uint64(i)
		if existing, ok := n.entryAt(idx); ok {
			if existing.Term == e.Term {
				continue
			}
			n.truncateFrom(idx)
		}
		n.log = append(n.log, req.Entries[i:]...)
		break
	}
	n.persist()

	if req.LeaderCommit > n.commitIndex {
		n.commitIndex = min(req.LeaderCommit, n.lastNewIndex(req))
	}
	return AppendEntriesResp{Term: n.currentTerm, Success: true}
}
```

The consistency check gives the **Log Matching** property by induction: if two logs contain an entry with the same index and term, the logs are identical up to that index.

When the check fails, the leader decrements `nextIndex` for that follower and retries. Decrementing one entry at a time is slow after long partitions, so implementations return a hint (`ConflictIndex`/`ConflictTerm`, or etcd's "reject hint") and let the leader skip a whole term at once.

The comment about truncation is a real-world bug source: a follower that blindly truncates its log to match a delayed, shorter `AppendEntries` can discard entries it already acknowledged, breaking the leader's commit math.

### The commit rule and the "Figure 8" trap

The leader tracks `matchIndex` for each follower and advances `commitIndex` to the highest index `N` replicated on a majority — **but only if `log[N].Term == currentTerm`**:

```go
func (n *Node) maybeAdvanceCommit() {
	matched := []uint64{n.lastIndex()}
	for _, m := range n.matchIndex {
		matched = append(matched, m)
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i] > matched[j] })
	N := matched[len(matched)/2] // majority-replicated index

	if N > n.commitIndex && n.termAt(N) == n.currentTerm {
		n.commitIndex = N
		n.applyCh <- N
	}
}
```

Why the term check? Section 5.4.2 of the paper (its Figure 8) shows that an entry from an *older* term can be stored on a majority and still be overwritten by a future leader that never had it. Counting replicas is only safe for entries from the leader's own term; once one of those commits, all preceding entries commit indirectly via Log Matching.

Practical consequence: a newly elected leader cannot know what is committed until it commits something in its own term. That is why leaders append a **no-op entry** right after election — it commits quickly and implicitly commits everything before it.

## Persistence and Durability

The persistent fields (`currentTerm`, `votedFor`, `log`) must be durable *before* the node replies. If a node votes, crashes before fsync, restarts, and votes again for someone else in the same term, two leaders can be elected in one term.

That makes fsync latency part of the consensus critical path. Common techniques:

- **Batching**: accumulate many client proposals and append them in one write + one fsync.
- **Pipelining**: the leader sends the next `AppendEntries` before the previous one is acknowledged.
- **Parallel disk write on the leader**: the Raft thesis notes the leader may write to its own disk in parallel with replicating to followers, since commit only requires a majority, which may or may not include the leader itself.

This is also why etcd's documentation emphasizes fast disks: the `wal_fsync_duration_seconds` metric is a primary health signal, and slow fsync shows up as missed heartbeats and leader changes.

## Log Compaction and Snapshots

An ever-growing log means unbounded disk use and slow restarts. Raft nodes periodically **snapshot** the state machine at index `i`, record `(lastIncludedIndex, lastIncludedTerm)`, and discard log entries up to `i`.

If a follower lags behind the leader's oldest retained entry, the leader sends `InstallSnapshot` instead of entries. Engineering trade-offs:

| Decision | Smaller value | Larger value |
|----------|---------------|--------------|
| Snapshot frequency | More I/O, short restarts | Less I/O, larger log and slower recovery |
| Entries retained after snapshot | Lagging followers more often need a full snapshot | More disk, but slow followers catch up with cheap appends |

Snapshots of large state machines should be taken without blocking the apply loop — via copy-on-write structures, `fork()` (Redis-style), or the storage engine's own checkpoint mechanism (e.g. RocksDB checkpoints in TiKV).

## Linearizable Reads

A surprisingly common mistake is to serve reads directly from the leader's state machine. A leader that has been partitioned away may not yet know it has been replaced, so it can return stale data. Options, from strongest-and-slowest to quickest:

1. **Log reads**: put the read through the log like a write. Correct but costs a replication round and an fsync.
2. **ReadIndex** (Raft thesis §6.4): the leader records its current `commitIndex` as `readIndex`, confirms it is still leader by getting heartbeat acks from a majority, waits until `lastApplied >= readIndex`, then serves the read locally. No disk write. A new leader must first commit its no-op entry. Followers can also serve reads by asking the leader for a `readIndex` ("follower read").
3. **Lease read**: after a successful heartbeat round, the leader assumes nobody else can become leader within a lease shorter than the election timeout, and skips the round trip. Quickest, but safety now depends on bounded clock drift — a long GC pause or a VM stall can violate the assumption.

etcd uses ReadIndex for its linearizable reads by default and offers serializable reads (`--consistency=s` in etcdctl) that read local state without the check, trading freshness for latency.

## Membership Changes

Switching directly from configuration `C_old` to `C_new` is unsafe: during the transition, some nodes may form a majority of `C_old` while others form a majority of `C_new`, electing two leaders.

Raft offers two solutions:

- **Joint consensus** (original paper): the cluster first moves to `C_old,new`, where decisions need separate majorities of *both* configurations, then moves to `C_new`.
- **Single-server changes** (Ongaro's thesis): add or remove one node at a time. Any majority of the old and new configuration then always overlaps, so no joint phase is needed.

A bug in the original single-server algorithm was found after publication (discussed on the raft-dev mailing list in 2015); the fix is that a leader must commit an entry in its current term before applying a configuration change. Production systems also add **learners** (non-voting members) so a new node can catch up on the log before it starts affecting quorum — etcd added learner support in v3.4.

Operational rule of thumb: never grow a 3-node cluster to 4 by adding a voting member whose disk is still empty — the quorum grows to 3 and one slow catch-up can stall writes. Add it as a learner first, then promote.

## Production Extensions

The basic protocol has liveness problems that real deployments hit. The common fixes, all implemented in etcd's raft library:

### PreVote

A node partitioned from the cluster keeps timing out and incrementing its term. When the partition heals, its high term forces the healthy leader to step down, causing an unnecessary election. With **PreVote** (thesis §9.6), a node first asks "would you vote for me?" without incrementing its term; peers that have recently heard from a leader say no. Only if a majority agrees does it run a real election.

### CheckQuorum

A leader that cannot reach a majority keeps believing it is leader, and clients keep sending it requests that will never commit. With **CheckQuorum**, a leader that has not heard from a majority within an election timeout steps down. It also pairs with lease reads to make the lease assumption hold.

### Leader transfer

For rolling upgrades, the operator asks the leader to hand off: it stops accepting new proposals, brings the target fully up to date, then sends `TimeoutNow` so the target starts an election immediately. This makes planned restarts nearly invisible instead of waiting a full election timeout.

### Flow control

etcd's raft library limits in-flight `AppendEntries` per follower and probes followers whose state is unknown (`StateProbe` vs. `StateReplicate`), so one slow follower does not consume unbounded leader memory.

## Multi-Raft: Scaling Beyond One Group

A single Raft group is bounded by one leader's throughput and the full data set fitting on each member. Systems like TiKV and CockroachDB split data into ranges/regions, each with its own Raft group, giving thousands of groups per node. New problems appear:

- **Heartbeat storms**: thousands of groups each sending heartbeats. Mitigations include coalescing heartbeats per node pair and quiescing idle ranges.
- **Leader balancing**: leaders do more work, so a placement driver moves leadership around.
- **Shared WAL**: many groups write to one log/engine on disk to keep fsync count manageable.
- **Cross-group transactions**: consensus per range does not give atomicity across ranges; that needs a transaction layer (e.g. Percolator-style two-phase commit in TiKV).

## Trade-offs and When Not to Use Raft

- **Latency floor**: every write costs at least one round trip to a majority plus an fsync. Geo-distributed quorums pay WAN latency on every commit.
- **Odd cluster sizes**: 3 nodes tolerate 1 failure, 5 tolerate 2. 4 nodes still tolerate only 1 but need a larger quorum, so even sizes add cost without fault tolerance.
- **Leader bottleneck**: all writes go through one node. Scaling writes means partitioning (Multi-Raft), not adding members.
- **Not Byzantine-tolerant**: a buggy or malicious node that lies about its log can break safety. Use BFT protocols when participants are mutually untrusted.
- **You probably should not write your own**: correct implementations rely on subtle invariants. Prefer battle-hardened libraries (etcd-io/raft, hashicorp/raft, tikv/raft-rs) and verify with fault-injection tooling such as Jepsen-style partition and crash scenarios.

## Summary

| Mechanism | Guarantees | Key rule |
|-----------|------------|----------|
| Terms | At most one leader per term | Higher term always wins; step down |
| Election restriction | Leader Completeness | Only vote for candidates with an up-to-date log |
| Consistency check | Log Matching | `prevLogIndex`/`prevLogTerm` must match |
| Commit rule | Committed entries are never lost | Count replicas only for current-term entries |
| Persistence | No double votes after crash | Fsync before replying |
| ReadIndex | Linearizable reads without disk writes | Confirm leadership with a majority |
| Joint / single-server change | Safe reconfiguration | Old and new majorities must overlap |
| PreVote / CheckQuorum | Liveness under partitions | Do not disrupt a healthy leader; drop a dead quorum |

Raft's appeal is that every rule has a short, concrete justification. Knowing those justifications is what lets you read an etcd alert about leader changes or slow fsync and immediately understand what is happening inside the cluster.
