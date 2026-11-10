---
title: "Time in Distributed Systems: Lamport Clocks, Vector Clocks, Hybrid Logical Clocks and TrueTime"
tag: architecture
description: Why wall clocks cannot order events across machines, and what real systems use instead — physical clock drift, NTP and PTP, monotonic versus wall time, Lamport's happens-before relation and logical clocks, vector clocks and version vectors for detecting concurrent writes, hybrid logical clocks as used by CockroachDB and YugabyteDB, Spanner's TrueTime and commit wait, plus leases, fencing tokens, leap seconds and time-ordered IDs, with verified Go implementations
date: "2026-11-10T13:25:00.000Z"
---

## Goal

"Which write happened first?" sounds like a question a timestamp can answer. On one machine it mostly can. Across machines it cannot: every server's clock drifts, synchronization is only approximate, and a message can arrive "before" it was sent according to the receiver's clock. Databases, caches, replication protocols, distributed locks and log pipelines all need some notion of order, and the way they get it is one of the most important design decisions in a distributed system.

This article covers:

1. Why physical clocks are unreliable, and what NTP, PTP and monotonic clocks actually give you.
2. Lamport's happens-before relation and logical clocks.
3. Vector clocks and version vectors: detecting concurrent updates.
4. Hybrid logical clocks (HLC): logical guarantees with timestamps close to real time.
5. Spanner's TrueTime: exposing clock uncertainty and waiting it out.
6. Practical pitfalls: leases, fencing tokens, last-write-wins, leap seconds, and time-ordered IDs.

All Go code below was compiled and run; the outputs shown are real.

## 1. Physical clocks lie, a little and sometimes a lot

A server's clock is a quartz oscillator plus software. Quartz drifts with temperature and age; a drift of tens of parts per million is common, and 10 ppm alone is almost a second per day. Clock synchronization protocols correct this continuously:

- **NTP** over the public internet is usually accurate to milliseconds or tens of milliseconds; on a well-run LAN it can reach sub-millisecond accuracy. Asymmetric network paths, overloaded servers and misconfiguration make it worse.
- **PTP (IEEE 1588)** with hardware timestamping in NICs and switches can reach sub-microsecond accuracy, which is why trading systems and telecom use it. Cloud providers now offer similar precision: Amazon Time Sync Service advertises microsecond-level accuracy on supported EC2 instances, and AWS publishes `ClockBound`, a daemon and library that report the current time *together with an error bound*.

Even with good sync, the operating system can step the clock backwards when it corrects a large offset, a VM can pause for seconds during live migration, and a GC pause can make "now" stale by the time you use it. That is why systems distinguish two clocks:

- **Wall clock** (`CLOCK_REALTIME` on Linux): comparable across machines, but can jump forward or backward.
- **Monotonic clock** (`CLOCK_MONOTONIC`): never goes backward, meaningless across machines or reboots.

Use the monotonic clock for durations and timeouts, the wall clock only for display and coarse cross-machine reasoning. Go builds this in: since Go 1.9, `time.Now()` carries a monotonic reading, and `t2.Sub(t1)` uses it, so measuring elapsed time is safe even if the wall clock is stepped.

The key consequence: **with physical timestamps alone, you cannot reliably decide whether event A on server 1 happened before event B on server 2 when they are closer together than the clock error.** Systems that pretend otherwise lose writes.

## 2. Happens-before and Lamport clocks

Leslie Lamport's 1978 paper "Time, Clocks, and the Ordering of Events in a Distributed System" reframed the question. Instead of asking what time an event happened, ask which events *could have influenced* which. The **happens-before** relation (→) is defined by three rules:

1. If a and b are on the same process and a comes first, a → b.
2. If a is sending a message and b is receiving that message, a → b.
3. Transitivity: if a → b and b → c, then a → c.

If neither a → b nor b → a, the events are **concurrent**: no information could have flowed between them, so no observer could tell which came "first" causally.

A **Lamport clock** is a counter per process:

- Before each local event or send, increment the counter.
- Attach the counter to each message.
- On receive, set `counter = max(counter, received) + 1`.

```go
type Lamport struct {
	mu sync.Mutex
	t  uint64
}

func (l *Lamport) Tick() uint64 { l.mu.Lock(); defer l.mu.Unlock(); l.t++; return l.t }

func (l *Lamport) Recv(remote uint64) uint64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if remote > l.t {
		l.t = remote
	}
	l.t++
	return l.t
}
```

The guarantee is one-directional: **if a → b then L(a) < L(b)**. The converse does not hold; L(a) < L(b) says nothing about causality. Breaking ties with the process ID gives a **total order** consistent with causality, which is enough for many algorithms: Lamport's own mutual exclusion algorithm, totally ordered multicast, and the term/index pairs in consensus protocols such as Raft are close relatives of the idea.

What Lamport clocks cannot do is tell you that two events were concurrent. For conflict detection, you need more information.

## 3. Vector clocks and version vectors

A **vector clock** keeps one counter per process. Process i increments its own entry on each event; on receive it takes the element-wise maximum with the incoming vector and then increments its own entry. Two vectors compare as:

- V(a) ≤ V(b) element-wise, and not equal: a → b.
- Some entries larger and some smaller: a and b are concurrent.

Unlike Lamport clocks, the relationship goes both ways: **a → b if and only if V(a) < V(b)**. This was described independently by Fidge (1988) and Mattern (1989).

```go
type VC map[string]uint64

func (v VC) Tick(node string) { v[node]++ }

func (v VC) Merge(o VC, node string) {
	for k, x := range o {
		if x > v[k] {
			v[k] = x
		}
	}
	v[node]++
}

func Compare(a, b VC) Order {
	less, greater := false, false
	keys := map[string]bool{}
	for k := range a { keys[k] = true }
	for k := range b { keys[k] = true }
	for k := range keys {
		switch {
		case a[k] < b[k]:
			less = true
		case a[k] > b[k]:
			greater = true
		}
	}
	switch {
	case less && greater:
		return Concurrent
	case less:
		return Before
	case greater:
		return After
	}
	return Equal
}
```

A scenario: A writes `w1`; B reads it and writes `w2`; meanwhile A writes `w3` without seeing B's write.

```text
w1 vs w2: Before | w2 vs w3: Concurrent | w1 vs w3: Before
```

`w2` and `w3` are genuinely concurrent. A system that keeps only the "newest timestamp" would silently drop one of them; a system with vector clocks can keep both as **siblings** and let the application (or a CRDT) merge them.

In storage systems the variant usually used is the **version vector**: one entry per *replica* that accepted writes, attached to each stored version of a key rather than to every event. Amazon's Dynamo paper (2007) used vector clocks this way, returning conflicting versions to the client for reconciliation (the shopping cart that merges by union). Riak later adopted **dotted version vectors** to avoid sibling explosion when many clients write through the same replica.

The cost is size: one entry per participant. Systems bound it by tracking replicas rather than clients, pruning old entries (which can lose causality information), or using structures such as interval tree clocks for dynamic membership. And vector clocks still say nothing about real time: they cannot tell you whether a write happened "within the last five seconds".

## 4. Hybrid logical clocks

Many databases want both properties: causality-respecting ordering *and* timestamps that are close to wall-clock time, so that "read as of 10:00:00" or "expire after an hour" mean something. The **hybrid logical clock** (Kulkarni, Demirbas et al., "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases", 2014) provides that with a fixed-size timestamp `(l, c)`:

- `l` is the largest physical time the node has seen, from its own clock or from any message.
- `c` is a counter that orders events sharing the same `l`.

Rules for local or send events, and for receiving a message with timestamp `(l_m, c_m)`:

```go
type HLCTime struct {
	WallNanos int64  // l
	Logical   uint32 // c
}

func (a HLCTime) Less(b HLCTime) bool {
	return a.WallNanos < b.WallNanos || (a.WallNanos == b.WallNanos && a.Logical < b.Logical)
}

type HLC struct {
	mu   sync.Mutex
	now  func() int64 // physical clock, injectable for simulation
	last HLCTime
}

func (h *HLC) Now() HLCTime { // local or send event
	h.mu.Lock()
	defer h.mu.Unlock()
	pt := h.now()
	if pt > h.last.WallNanos {
		h.last = HLCTime{pt, 0}
	} else {
		h.last.Logical++
	}
	return h.last
}

func (h *HLC) Update(m HLCTime) HLCTime { // receive event
	h.mu.Lock()
	defer h.mu.Unlock()
	pt := h.now()
	l := max(h.last.WallNanos, m.WallNanos, pt)
	switch {
	case l == h.last.WallNanos && l == m.WallNanos:
		h.last.Logical = max(h.last.Logical, m.Logical) + 1
	case l == h.last.WallNanos:
		h.last.Logical++
	case l == m.WallNanos:
		h.last.Logical = m.Logical + 1
	default:
		h.last.Logical = 0
	}
	h.last.WallNanos = l
	return h.last
}
```

Simulating node B whose physical clock is 100 ns behind node A's:

```text
hlc {1000 0} {1000 1} {1000 2} {1500 0}
causal order kept: true
skew bound: l - pt at B before catching up = 100
```

When A's message arrives, B adopts A's larger wall time and bumps the counter, so the receive is ordered after the send even though B's own clock reads 900. Once B's physical clock passes 1000, the counter resets to 0. A randomized run of 100,000 sends and receives across three nodes with unevenly advancing clocks confirmed the two invariants that matter: every receive is ordered after its send, and `l` never exceeds the largest physical time any node has actually observed (`100k-step property check passed: true`).

The properties from the paper:

- **If a → b then hlc(a) < hlc(b)**, like a Lamport clock.
- `l` stays within the clock synchronization error ε of physical time, so timestamps are meaningful as wall-clock time.
- `c` stays bounded in practice, so the timestamp fits in 64 bits (for example 48 bits of milliseconds plus 16 bits of counter) and can replace an existing timestamp field.

**CockroachDB** uses HLC timestamps for MVCC versions and transactions. Because HLC alone does not stop a read on one node from missing a write that committed "slightly in the future" on a node with a faster clock, CockroachDB adds an **uncertainty interval**: a read at timestamp t treats any value with a timestamp in `(t, t + max_offset]` as possibly-earlier, and restarts the read at a higher timestamp if it finds one. The cluster's maximum clock offset (500 ms by default) is a correctness parameter, not a tuning knob: nodes monitor each other's offsets and a node whose clock is too far from the rest shuts itself down rather than risk violating consistency. **YugabyteDB** takes a similar HLC-based approach, and **MongoDB** has used a hybrid logical "cluster time" since 3.6 for causal consistency sessions.

The trade-off: HLC gives you serializability-friendly ordering on commodity clocks, but you pay with read restarts under contention and you trust an assumed clock bound that monitoring must enforce.

## 5. TrueTime: make uncertainty explicit, then wait

Google Spanner (OSDI 2012) took the opposite path. Instead of hiding clock error, the **TrueTime** API exposes it: `TT.now()` returns an interval, with an earliest and an upper bound, that is guaranteed to contain absolute time; `TT.after(t)` is true only once t has definitely passed. Google backs it with GPS receivers and atomic clocks in each datacenter, with time daemons polling several masters; the paper reported ε (half the interval width) typically between 1 and 7 ms.

That enables **external consistency** (linearizability for transactions): if T1 commits before T2 starts in real time, T2's timestamp is larger. The mechanism is **commit wait**:

1. Choose the commit timestamp `s` as the upper bound of `TT.now()`.
2. Wait until `TT.after(s)` is true, which takes about 2ε.
3. Only then make the writes visible and acknowledge the commit.

After the wait, every node in the world agrees that `s` is in the past, so any transaction that starts later will get a larger timestamp. The wait overlaps with Paxos replication, so its cost is often partly hidden. Lock-free snapshot reads at any timestamp follow directly.

The design lesson is general: **the tighter your clock bound, the cheaper strong consistency becomes.** That is why the improvement in cloud time services and libraries like ClockBound matters; they let systems outside Google reason with explicit error bounds instead of assumed ones.

| Approach | Size | Detects concurrency | Near real time | Typical use |
| --- | --- | --- | --- | --- |
| Wall clock | 1 value | No | Yes, with error | Logs, TTLs, display |
| Lamport clock | 1 counter | No | No | Total ordering, consensus terms |
| Vector clock / version vector | 1 entry per participant | Yes | No | Conflict detection, CRDT metadata |
| Hybrid logical clock | 1 value (64 bits) | No | Yes, within ε | MVCC databases (CockroachDB, YugabyteDB) |
| TrueTime | Interval | No | Yes, bounded | Externally consistent transactions (Spanner) |

## 6. Where clocks bite in everyday engineering

**Last-write-wins.** Cassandra resolves conflicting writes by timestamp (by default assigned by the coordinator, or supplied by the client). If one node's clock is ahead, its writes win even when they happened earlier, and a delete with a skewed timestamp can make data disappear or resurrect. LWW is acceptable for idempotent, overwrite-style data; for anything else, use version vectors, CRDTs, or a single leader per key.

**Leases and locks.** A lease says "you own this until time T". If the holder pauses (GC, VM migration) past T, it may keep acting as owner while another node acquires the lease. Martin Kleppmann's 2016 analysis of Redis Redlock made the point that time-based locks need **fencing tokens**: a monotonically increasing number issued with each lease, which the storage layer checks and rejects if it has already seen a larger one. Etcd and ZooKeeper give you this naturally via revision numbers and zxids. Use the monotonic clock to measure lease duration locally, and keep a safety margin for drift.

**Leap seconds.** A UTC leap second can make the wall clock repeat or stall, which has crashed software in the past (the 2012 leap second caused widespread Linux and Java issues). Google, AWS and others **smear** the leap second, slowing clocks slightly over a window so time never repeats. Do not mix smeared and non-smeared time sources in one cluster. The CGPM voted in 2022 to stop inserting leap seconds by 2035, but until then the mitigation still matters.

**Time-ordered IDs.** Twitter's Snowflake IDs and **UUIDv7** (standardized in RFC 9562, 2024) put a millisecond timestamp in the high bits, which keeps B-tree inserts mostly sequential. They are *roughly* time-ordered across machines, never causally ordered. Implementations should guard against the clock moving backwards (for example by keeping the last timestamp and incrementing a counter, the same trick as HLC).

**Measuring durations.** Timeouts, retries, rate limiters and latency metrics must use monotonic time. A wall-clock step backwards turns `elapsed := now - start` into a negative number, and a step forward fires every timeout at once.

## Engineering checklist

1. Decide what you need: total order, causal order, conflict detection, or real-time bounds. Each implies a different clock.
2. Use monotonic clocks for durations; never compute timeouts from wall-clock differences.
3. Never resolve conflicts by wall-clock timestamp unless losing an occasional write is acceptable.
4. Use version vectors or CRDTs where concurrent writes must be preserved.
5. If you use HLC, treat the maximum clock offset as a correctness assumption: monitor offsets and fail nodes that exceed it.
6. Pair every time-based lease or lock with a fencing token checked by the resource.
7. Run good time sync (chrony, PTP, or your cloud's time service), keep leap-second handling consistent, and alert on offset.
8. Make simulated time injectable, as in the code above, so ordering logic can be checked deterministically.

## Summary

Physical clocks are approximate, so distributed systems order events with logic rather than trust. Lamport clocks give a cheap total order consistent with causality; vector clocks and version vectors detect concurrency at the cost of size; hybrid logical clocks combine Lamport-style guarantees with timestamps that stay within the clock error of real time, which is why modern MVCC databases use them; and TrueTime shows that if you can bound clock uncertainty tightly, you can buy external consistency simply by waiting it out. In day-to-day engineering, the same ideas show up as monotonic timers, fencing tokens, careful conflict resolution and time-ordered IDs.

## References

- Leslie Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System", Communications of the ACM (1978): https://lamport.azurewebsites.net/pubs/time-clocks.pdf
- Colin Fidge, "Timestamps in Message-Passing Systems That Preserve the Partial Ordering" (1988), and Friedemann Mattern, "Virtual Time and Global States of Distributed Systems" (1989)
- Kulkarni, Demirbas, Madappa, Avva, Leone, "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases" (2014): https://cse.buffalo.edu/tech-reports/2014-04.pdf
- Corbett et al., "Spanner: Google's Globally-Distributed Database", OSDI 2012: https://research.google/pubs/spanner-googles-globally-distributed-database-2/
- DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store", SOSP 2007: https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf
- CockroachDB blog, "Living without atomic clocks": https://www.cockroachlabs.com/blog/living-without-atomic-clocks/
- CockroachDB documentation, transaction layer and clock offsets: https://www.cockroachlabs.com/docs/stable/architecture/transaction-layer
- Martin Kleppmann, "How to do distributed locking" (2016): https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- AWS ClockBound: https://github.com/aws/clock-bound
- Google Public NTP, leap smear: https://developers.google.com/time/smear
- RFC 9562, Universally Unique IDentifiers (UUIDv7): https://www.rfc-editor.org/rfc/rfc9562
- Go `time` package, monotonic clocks: https://pkg.go.dev/time#hdr-Monotonic_Clocks
