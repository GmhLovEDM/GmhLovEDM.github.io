---
title: "Distributed Locks in Depth: Leases, Fencing Tokens and Why a Lock Is Not Enough"
tag: architecture
description: How a distributed lock is really a lease, why a paused holder or a delayed write can still mutate a resource after expiry, how a monotonic fencing token — Chubby sequencers, ZooKeeper zxids, etcd CreateRevision — lets the resource reject stale writers, why Redlock is a poor fit when the lock is for correctness, and a runnable model that measures lost updates with and without fencing
date: "2026-11-23T10:28:00.000Z"
---

## Goal

A lock is one of the first tools people reach for when two processes might step on the same piece of state. In one process, a mutex is almost boring: the holder is paused only while the kernel schedules it, and a crash tears the mutex down with the process. Across machines, none of that is true. The holder can pause for seconds in a garbage-collection stop, a packet can sit in a buffer for far longer than the lock was supposed to last, and the lock service itself will *want* the lock to expire — otherwise a crashed client holds it forever.

That expired lock is now a **lease**. The moment you add a time bound, you also add a new failure mode: a client that still believes it is the holder, and a second client that legally just became one. If both of them can write the resource, the lock did not do the job you thought it did.

This is not a theoretical curiosity. Martin Kleppmann's 2016 analysis of Redis's Redlock algorithm is built around it, and he notes that HBase used to be vulnerable to exactly this stale-holder write. Google's Chubby paper had already given the issue a name and a mechanism a decade earlier: a **sequencer**, a monotonic token the holder attaches to every request, which the resource is expected to check. ZooKeeper's zxid and etcd's `CreateRevision` are the same idea under different APIs. The lock service, however good, is not enough. The *resource* has to refuse a write whose token has gone backwards.

This article covers:

1. What a lock is for, and why that split between efficiency and correctness matters.
2. Why a distributed lock has to be a lease.
3. The stale-holder problem — pauses, delayed packets, and why a last-second ownership check does not close the race.
4. Fencing tokens, and what the resource actually has to do.
5. Chubby's sequencers, and the lock-delay you get when a server cannot check them.
6. How ZooKeeper and etcd issue an ordered token, and what Kubernetes leader election does and does not give you.
7. Redis `SET NX`, Redlock, and the 2016 debate.
8. When a lock is the wrong tool.
9. Trade-offs.
10. A runnable model that measures lost updates on a leased lock, with and without fencing, and a simplified Redlock-style majority under a clock jump.

## 1. What a lock is for

Kleppmann draws a line that is easy to skip and expensive to skip. Ask what happens if the lock fails and two clients both run.

If the answer is "we paid for the same computation twice" or "a user got the same mail twice," the lock is an **efficiency** hint. A single Redis instance with `SET key value NX PX ttl` is usually enough. If that node reboots and a lock is lost, the cost is a duplicate, not a corrupt file. Adding a five-node majority protocol to this case buys you very little.

If the answer is "the file is now a mix of two writes," "a unique constraint is broken," or "the wrong dose went out," the lock is for **correctness**. The rest of this article is about that case. The bar is that two clients must not both be able to commit a write that the resource accepts. A protocol that only makes that *unlikely*, or that makes it true only as long as every clock and every process pause stays inside a bound you cannot actually enforce, is not good enough.

This blog has already looked at other ways systems try to get a single winner — Raft in [an earlier post](/blog/131-raft-consensus-deep-dive/en), and the opposite bet, leaderless quorums, in [another](/blog/163-leaderless-replication-quorums-hinted-handoff/en). A distributed lock sits in between: it *looks* like a mutex, but the thing it protects is usually not in the lock service at all. That is the whole problem.

## 2. Why a distributed lock has to be a lease

An ordinary mutex has no timeout because the failure domain is one process. A distributed lock that never expires is a landmine: the client that holds it can lose the network, freeze, or die, and every other client waits forever. So almost every serious lock service attaches a **time to live** and asks the holder to renew it.

That idea is older than Chubby or ZooKeeper. Cary G. Gray and David R. Cheriton's 1989 SOSP paper, *Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency*, introduced leases as a time-bounded grant of a right — in their case, a cache consistency guarantee — so a crashed holder could not pin the system down. When the lease expires, the grantor is free to give the right to someone else.

The same bound appears in every production lock service:

- Chubby's session is kept alive by **KeepAlive** RPCs. The master extends the session lease; the default extension is **12 seconds**, and an overloaded master may raise that to around **60 seconds** so it has fewer KeepAlives to process. The client keeps a *conservative* local view of that deadline. If the local view expires, the client enters **jeopardy**, flushes its cache, and waits a **grace period** of **45 seconds** by default before declaring the session dead.
- ZooKeeper and etcd bind the lock to a **session** or a **lease**. If the session expires, ZooKeeper deletes the ephemeral znode; if the etcd lease expires, the key attached to it is deleted. In both cases another client can then become the owner.
- Kubernetes' client-go leader election, which is built on a `Lease` object, defaults to `LeaseDuration = 15s`, `RenewDeadline = 10s`, and `RetryPeriod = 2s`.

A lease solves liveness. It does not, by itself, solve safety of a write that is already in flight, or of a holder that has not yet noticed it was evicted. Time is part of the contract, and time is not a reliable source of truth — this blog walked through that in [the post on distributed clocks](/blog/155-distributed-clocks-lamport-vector-hlc-truetime/en). Process pauses and network delay are the same family of problem: the lock service's clock moved, the client's did not, or the packet did not.

## 3. The stale-holder problem

The unsafe sequence is short.

1. Client A acquires the lease and starts work — say a read-modify-write of a file in shared storage.
2. A pauses. A stop-the-world garbage collection is the usual classroom example; a VM stall, a lost CPU throttling window, or a delayed packet is just as good. Kleppmann records that stop-the-world pauses have been known to last several minutes, and cites a GitHub incident in which packets were delayed in the network for about **90 seconds**.
3. The lease expires. Client B acquires it, reads the file, writes a new version, and continues.
4. A wakes, or A's write finally arrives, and overwrites B's version. B's update is gone. The lock was "correct" at every instant on the lock service, and the resource is still wrong.

You cannot close this race by checking "do I still hold the lease?" immediately before the write. The pause can happen *after* that check and *before* the write is applied. In the model at the end of this article, client A confirms it still holds the lease at `t = 2` (the lease lasts 10 time units) and then pauses for 12. B acquires at `t = 10` and writes. A's write arrives at `t = 14` and, without fencing, is accepted. The check was honest and useless.

A delay in the network has the same shape with a nastier timing. In the model, with a lease of 10 and **no** extra pause beyond the expiry itself, a write that is delayed by 5 time units already loses: A paused only for 6, still inside the lease when it *sent* the write, but the write arrives at 11, after B has already written at 10. The client's local "I am still the holder" is not the arrival time the resource sees.

## 4. Fencing tokens

The fix is to give each acquisition a number that only goes up, and to make the resource reject any write whose number is not strictly newer than the newest one it has already accepted.

Kleppmann calls this a **fencing token**. The lock service issues the token when the lease is granted. A carries token 33, pauses, expires. B is granted token 34 and writes. A wakes and writes with 33. The store, which has already seen 34, refuses 33.

Two properties are doing the work:

- The tokens are **strictly monotonic** across acquisitions. A unique random string is not enough, because the store has no way to decide which of two unique strings is newer.
- The **resource** enforces the rule, atomically, on every mutating path. A check in the client is the same race as the lease check. If some admin endpoint, some compaction job, or some "just this once" repair tool writes without the token, the guarantee is gone.

A typical shape against a SQL table is a single conditional update: accept the payload only if the incoming token is greater than (or, if one acquisition may send several writes, greater than or equal to) the stored token, and store the new token in the same statement. No row returned means a newer owner has already fenced this writer out. Treat that as a failed write.

Fencing has a precise limit, and it is worth saying out loud. The token does not retract a write that has not yet been superseded. If A writes with 33 *before* B's write with 34 arrives, the store accepts 33, then accepts 34. That is the correct order of ownership, not a bug. Fencing stops the *stale* write, not every write from a holder whose lease later expires. If you need "this in-flight request must be cancelled the instant the lease dies," you need a protocol on the resource itself, not a lease on a different machine.

## 5. Chubby sequencers, and a lock-delay when you cannot fence

Chubby is the system that made this mechanism mundane at Google. Mike Burrows's OSDI 2006 paper describes a coarse-grained lock service: a typical cell is **five** replicas, a master elected by consensus, and an interface that looks like a small file system. Locks are **advisory**. Holding the lock on file F neither is required to read F, nor prevents someone else from reading F. The lock often protects a resource that does *not* live in Chubby — a GFS master, a primary in some other service — and Chubby cannot make that other service mandatory.

That is exactly the stale-holder setup. Chubby's answer is the **sequencer**: an opaque byte-string a holder can request after acquisition. It contains the lock's name, the mode (exclusive or shared), and the **lock generation number**, which increases every time that node's lock goes from free to held. The client puts the sequencer on requests to the file server or whatever it is protecting. The server is expected to check that the sequencer is still valid and in the right mode, either against its Chubby cache or against the most recent sequencer it has already seen. That second option is the fencing rule: you do not even have to call Chubby on the write path if you remember the newest sequencer.

The paper is frank that not every protocol can be changed. For servers that cannot check sequencers, Chubby offers a weaker backup called the **lock-delay**. If a holder releases a lock in the normal way, the lock is free immediately. If the lock becomes free because the holder failed or became unreachable, Chubby refuses to grant it to anyone else for a delay the client may set, up to a bound of **one minute**. The idea is to give delayed packets and restarting processes a window in which they are less likely to land after a new holder has started work. The paper calls this imperfect, which it is: a packet delayed longer than the lock-delay still wins, and the bound exists precisely so a faulty client cannot make a resource unavailable forever.

Chubby also tells you what the lock is *for*. The expected use is coarse-grained: elect a primary, then let that primary do the fine-grained work itself. Fine-grained locking on the service would couple the lock-acquire rate to the transaction rate and make a brief Chubby outage much more painful. That bias — lock to appoint a leader, then use something tighter (a log, a compare-and-swap, a generation number) on the data path — shows up again in ZooKeeper, etcd, and Kubernetes.

## 6. ZooKeeper, etcd, and Kubernetes leases

**ZooKeeper**'s lock recipe is a directory of ephemeral sequential znodes. Each client creates a child; the owner is the child with the lowest sequence number; everyone else watches the predecessor, not the whole directory. The node is ephemeral, so a session expiry deletes it and the next waiter is promoted. The recipe is in the official ZooKeeper documentation; Apache Curator's `InterProcessMutex` is the version most production Java clients actually call.

The fencing token is sitting in the znode metadata. The **zxid** of the create (`czxid`), or the sequential suffix itself, is monotonic in the order ZooKeeper assigned ownership. A client that has become the owner should read that identifier and send it with every write to the protected resource. Reconnecting after a session expiry is not a continuation of the old ownership: the ephemeral node is gone, and a new session has to start over.

**etcd** uses a lease and a revision. A `Session` keeps a lease alive. `concurrency.Mutex` creates a key under the lock prefix, attached to that lease, and the owner is the key with the smallest `CreateRevision`. The mutex exposes `IsOwner()` as a compare: `CreateRevision(myKey) == myRev`. If the resource you are protecting also lives in etcd, you put that compare in the same transaction as the write, and a stale holder cannot mutate the key. If the resource lives somewhere else — a database, an object store, a device — you still have to carry `CreateRevision` over and enforce it there. The lease TTL is a physical-time interval, measured by both sides' clocks; etcd's own documentation and code are explicit that *owning a lease is not, by itself, mutual exclusion* for an external resource.

**Kubernetes** leader election, as implemented in client-go, writes a `coordination.k8s.io/v1` `Lease`. The defaults, already quoted, are a 15-second lease, a 10-second renew deadline, and a 2-second retry. That is enough to decide who should run a controller's reconcile loop. It is not automatically a fence for anything the old leader might still call — the Kubernetes API, a cloud provider, an external database — after its lease has been taken over. If that matters, the new leader's `leaseTransitions`, the lease's resourceVersion, or some other monotonic number has to be checked on those paths, the same way an etcd `CreateRevision` would be. A lot of controllers do not do this, and they live with the (usually short) overlap instead. That is an efficiency choice. It is not a correctness proof.

## 7. Redis, Redlock, and the 2016 debate

The single-instance Redis pattern is clear and honest: `SET name unique_value NX PX ttl`, and a release script that deletes the key only if the value still matches, so you cannot drop someone else's lock. The unique value stops a late unlock from being dangerous. It is **not** a fencing token: the next holder has a different random string, but a store sitting in front of a file cannot tell which string is newer. Used as an efficiency hint, this is fine. Used as the only guard in front of a correctness-critical write, it has the stale-holder hole of every other lease.

**Redlock**, documented by Redis as a way to build a majority lock across N (typically five) independent Redis instances, tries to make that hole smaller. The client timestamps the start, does `SET NX PX` on each instance in turn with the same random value, and treats the lock as acquired only if it got a majority and the elapsed time is still less than the TTL. The remaining validity is the TTL minus elapsed time minus a clock-drift allowance. Unlock is the same compare-and-delete, on every instance.

In February 2016 Kleppmann published *How to do distributed locking*, and argued that Redlock is not appropriate when the lock is for correctness. The two loads of the argument are the ones in this article. First, Redlock does not give you a fencing token; the random value cannot be ordered. Second, the algorithm's safety depends on timing bounds — process pauses, network delay, and the clocks of the Redis nodes, which govern `PEXPIRE` — that a system under the usual asynchronous model does not actually provide. A forward clock jump on a majority of the instances that currently hold the keys expires those keys in true time. Another client can then get a majority, while the original client still believes, on *its* clock, that the validity window is open.

The model at the end of this article makes that split concrete. Five nodes, TTL 10, A acquires 5/5 at `t = 0` and will believe the lock is valid until `t = 10`. At `t = 3`, three of the holder nodes jump their clocks forward by 20. A's actual votes drop to 2. B acquires a majority of 3. A still believes it holds the lock. With no clock jump, B cannot acquire until `t = 10`.

Salvatore Sanfilippo (antirez) replied the next day in *Is Redlock safe?* He treats fencing as a separate, general problem of any auto-releasing lock — a point that is true, and that is why this article started with leases rather than with Redis — and he disagrees that the timing assumptions are disqualifying in practice. The debate is useful because it forces the distinction: if you already have a store that will enforce a monotonic token, you can issue that token from almost anywhere, and you did not need Redlock to do it. If you do *not* have such a store, Redlock does not add one. For a correctness-critical resource, the usual advice, which this article shares, is to take the lock from a consensus system that already has a monotonic order — Chubby, ZooKeeper, etcd, a Raft-backed metadata service — and to put that order on the write.

## 8. When a lock is the wrong tool

A lock is a good way to appoint a leader, and a poor way to implement the data path of that leader.

If the invariant is "this row is only updated by the current owner," a compare-and-swap on a generation number, or a single-writer log, is a tighter tool than a lease around an unchecked write. If the invariant is "this message is processed once," idempotency keys and an outbox are tighter than hoping two consumers will not both hold a lock. If the invariant is "these two records stay in sync," a transaction in one system, or a consensus log, is tighter than two locked updates.

A lock also fails closed in ways that surprise people. The lock service is down, so no one can become the owner, so the data plane stops. That is the correct behaviour for a correctness lock, and it is why Chubby aimed at coarse-grained use: a short outage delays primary election, not every user write. If your acquire rate is your request rate, you have put the lock service on the critical path of the product.

Finally, "I checked that I am still the leader" is not a fence. It is the check-then-write race from section 3, wearing a different name.

## 9. Trade-offs

- **A single Redis `SET NX PX`.** Cheap, honest, and enough when a duplicate is acceptable. No monotonic token, one failure domain, no safety story for a stale write.
- **Redlock.** A majority of independent expirations, still no fencing token, still a timing assumption. It is a more elaborate efficiency lock, not a consensus lock.
- **A consensus lock (Chubby, ZooKeeper, etcd) plus a fencing token on the resource.** This is the combination that actually closes the stale-holder hole. The cost is a consensus round for acquisition, a lease renewal path, and a one-line compare on every mutating path of the resource. If you cannot change the resource, you do not have this option — only weaker backups such as Chubby's lock-delay.
- **A consensus lock without fencing.** You have a reasonably trustworthy *appointment*, and you still have the pause-and-late-write hole against any resource that will accept the old leader's request.
- **No lock at all, just compare-and-swap or a log.** Often the right design. The generation number *is* the fencing token, and there is no separate lease to go stale. The cost is that every writer has to speak that protocol.

## 10. A runnable model

The script below is the model that produced every count in this article. Time is discrete. A lock service grants a lease of **10** time units and a strictly increasing token. Two clients compete for a single register. Client A acquires at `t = 0`, pauses for `P` units, and sends a write that arrives `D` units later. Client B retries every tick from `t = 1` and writes as soon as it acquires. Writes are applied in arrival order; on the same tick, an earlier send and then a lower token go first.

With **no fencing** and `D = 0`, B acquires at `t = 10`. A's write at pause 8, 9 or 10 lands on or before that tick, B's write follows, and the final value is `B`. From pause **11** through **25**, A's write arrives later and overwrites B — **15** lost updates out of the 26 pauses. With fencing, those same 15 writes are rejected and the final value stays `B`. Lost updates with fencing: **0 / 26**.

A delay of **5** moves the unsafe window forward. A only paused for **6**, which is still inside the lease, but the write arrives at 11. Without fencing, pauses **6** through **25** lose — **20 / 26**. With fencing, those 20 are rejected and nothing is lost.

The check-then-write case is the same mechanism. A confirms it still holds the lease at `t = 2`, then pauses. After a pause of 5 or even 8, the write still lands on or before B's and the successor wins. After a pause of **12**, the write arrives at 14: without fencing the final value is `A` and the update is lost; with fencing it is rejected and the final value is `B`.

A longer workload makes the cost of a rare long pause visible. Three clients attempt a read-modify-write on a shared counter: they read the current value when they acquire, pause, then write `base + 1`. Pauses are drawn from a long-tailed mix — in 2000 successful acquires with seed **168**, **1777** pauses were 0–2, **207** were 3–9, and **16** were at least 14 (the long tail ran 14, 16, 18, 19, 20, 20, 20, 22, 26, 28, 28, 28, 31, 34, 36, 39). The lease is still 10, so those 16 acquisitions outlive it.

Without fencing, all 2000 writes are accepted, but 16 of them arrive with a token older than one the store has already seen, and the final counter is **1972**. A stale write does not only drop its own increment: eight of those inversions stepped the counter backward and wiped **12** increments that later owners had already stored, and the remaining gaps are lost updates that overwrote a newer value with an equal or stale one. With fencing, those **16** writes are rejected, **1984** writes are accepted, the counter is **1984**, and there are no inversions. The 16 rejected clients failed visibly instead of corrupting the register.

The Redlock-style fragment uses five independent nodes and a majority of three. A acquires 5/5 at `t = 0` and will believe, on its own clock, that the lock is valid until `t = 10`. At `t = 3`, three holder nodes jump their clocks forward by 20; A's actual votes fall to **2**, B acquires **3**, and A still believes it holds the lock. In a control run with no jump, B cannot acquire at `t = 3` and first succeeds at `t = 10`.

```python
#!/usr/bin/env python3
"""Distributed lock model: leases, stale holders, and fencing tokens."""

from __future__ import annotations

from dataclasses import dataclass, field
from random import Random


LEASE_TTL = 10
N_REDIS = 5
MAJORITY = N_REDIS // 2 + 1


@dataclass
class Store:
    value: str = "init"
    writes: int = 0
    accepted: list[tuple[int, int, str]] = field(default_factory=list)
    rejected: list[tuple[int, int, str]] = field(default_factory=list)
    fence: bool = False
    highest: int = 0

    def write(self, arrive: int, token: int, value: str) -> bool:
        if self.fence and token <= self.highest:
            self.rejected.append((arrive, token, value))
            return False
        if self.fence:
            self.highest = token
        self.value = value
        self.writes += 1
        self.accepted.append((arrive, token, value))
        return True


@dataclass
class LockService:
    ttl: int = LEASE_TTL
    next_token: int = 1
    holder: int | None = None
    token: int | None = None
    expires_at: int | None = None

    def acquire(self, now: int, client: int) -> int | None:
        if self.holder is not None and self.expires_at is not None and now < self.expires_at:
            return None
        tok = self.next_token
        self.next_token += 1
        self.holder = client
        self.token = tok
        self.expires_at = now + self.ttl
        return tok


def apply_events(store: Store, events: list[tuple[int, int, int, str]]) -> None:
    """events are (arrive, sent, token, value). Earlier arrival first; same tick keeps send order."""
    events.sort(key=lambda e: (e[0], e[1], e[2]))
    for arrive, _sent, token, value in events:
        store.write(arrive, token, value)


def stale_holder_scenario(pause: int, delay: int, fence: bool) -> dict[str, object]:
    lock = LockService()
    store = Store(fence=fence)
    tok_a = lock.acquire(0, client=1)
    assert tok_a is not None
    sent_a = pause
    arrive_a = pause + delay
    tok_b: int | None = None
    t_b: int | None = None
    # B retries every tick from t=1 up to after A's arrival and the original expiry.
    for t in range(1, max(arrive_a, lock.ttl) + 2):
        got = lock.acquire(t, client=2)
        if got is not None:
            tok_b = got
            t_b = t
            break
    events: list[tuple[int, int, int, str]] = [(arrive_a, sent_a, tok_a, "A")]
    if tok_b is not None and t_b is not None:
        events.append((t_b, t_b, tok_b, "B"))
    apply_events(store, events)
    accepted_a = any(tok == tok_a for _ar, tok, _v in store.accepted)
    b_wrote = tok_b is not None and any(tok == tok_b for _ar, tok, _v in store.accepted)
    a_after_b = (
        tok_b is not None
        and t_b is not None
        and (arrive_a, sent_a) >= (t_b, t_b)
    )
    lost_update = (not fence) and b_wrote and accepted_a and a_after_b and store.value == "A"
    stale_rejected = fence and tok_b is not None and a_after_b and (not accepted_a)
    return {
        "pause": pause,
        "delay": delay,
        "fence": fence,
        "token_a": tok_a,
        "token_b": tok_b,
        "t_b": t_b,
        "arrive_a": arrive_a,
        "accepted_a": accepted_a,
        "final": store.value,
        "lost_update": lost_update,
        "stale_rejected": stale_rejected,
    }


def check_then_write(pause_after_check: int, fence: bool) -> dict[str, object]:
    lock = LockService()
    store = Store(fence=fence)
    tok_a = lock.acquire(0, client=1)
    assert tok_a is not None
    t_check = 2
    sent_a = t_check + pause_after_check
    arrive_a = sent_a
    tok_b: int | None = None
    t_b: int | None = None
    for t in range(1, arrive_a + lock.ttl + 2):
        got = lock.acquire(t, client=2)
        if got is not None:
            tok_b = got
            t_b = t
            break
    events: list[tuple[int, int, int, str]] = [(arrive_a, sent_a, tok_a, "A")]
    if tok_b is not None and t_b is not None:
        events.append((t_b, t_b, tok_b, "B"))
    apply_events(store, events)
    accepted_a = any(tok == tok_a for _ar, tok, _v in store.accepted)
    a_after_b = tok_b is not None and t_b is not None and arrive_a >= t_b
    lost_update = (not fence) and a_after_b and accepted_a and store.value == "A"
    return {
        "fence": fence,
        "t_check": t_check,
        "t_b": t_b,
        "arrive_a": arrive_a,
        "accepted_a": accepted_a,
        "final": store.value,
        "lost_update": lost_update,
        "still_held_at_check": t_check < LEASE_TTL,
    }


def random_pause(rng: Random, ttl: int) -> int:
    u = rng.random()
    if u < 0.90:
        return rng.randint(0, 2)
    if u < 0.99:
        return rng.randint(3, ttl - 1)
    return rng.randint(ttl + 1, ttl * 4)


def workload(n_clients: int, n_ok: int, fence: bool, seed: int) -> dict[str, int]:
    """Successful acquires each do a read-modify-write of a shared counter after a pause."""
    rng = Random(seed)
    lock = LockService()
    store = Store(value="0", fence=fence)
    pending: list[tuple[int, int, int, int]] = []  # arrive, token, base, sent
    t = 0
    acquired = 0
    next_client = 0
    while acquired < n_ok or pending:
        due = [p for p in pending if p[0] <= t]
        due.sort(key=lambda p: (p[0], p[3], p[1]))
        pending = [p for p in pending if p[0] > t]
        for arrive, token, base, _sent in due:
            store.write(arrive, token, str(base + 1))
        if acquired < n_ok:
            tok = lock.acquire(t, next_client)
            next_client = (next_client + 1) % n_clients
            if tok is not None:
                acquired += 1
                base = int(store.value)
                pause = random_pause(rng, lock.ttl)
                pending.append((t + pause, tok, base, t + pause))
        t += 1
        if t > 2_000_000:
            raise RuntimeError("time ran away")
    max_tok = 0
    inversions = 0
    for _arrive, tok, _val in store.accepted:
        if tok < max_tok:
            inversions += 1
        if tok > max_tok:
            max_tok = tok
    return {
        "acquired": acquired,
        "accepted": store.writes,
        "rejected": len(store.rejected),
        "final": int(store.value),
        "inversions": inversions,
        "time": t,
    }


@dataclass
class RedisNode:
    offset: int = 0
    value: str | None = None
    set_local: int | None = None
    ttl: int = 0

    def local_now(self, true_t: int) -> int:
        return true_t + self.offset

    def held(self, true_t: int) -> bool:
        if self.value is None or self.set_local is None:
            return False
        return self.local_now(true_t) < self.set_local + self.ttl

    def set_nx(self, true_t: int, value: str, ttl: int) -> bool:
        if self.held(true_t):
            return False
        self.value = value
        self.set_local = self.local_now(true_t)
        self.ttl = ttl
        return True

    def jump(self, delta: int) -> None:
        self.offset += delta


def votes_for(nodes: list[RedisNode], true_t: int, client: str) -> int:
    return sum(1 for n in nodes if n.held(true_t) and n.value == client)


def redlock_acquire(nodes: list[RedisNode], true_t: int, client: str, ttl: int) -> tuple[bool, int]:
    got = 0
    for n in nodes:
        if n.set_nx(true_t, client, ttl):
            got += 1
    return got >= MAJORITY, got


def redlock_clock_jump() -> None:
    print("=== Redlock-style majority (N=5, TTL=10) and a forward clock jump ===")
    nodes = [RedisNode() for _ in range(N_REDIS)]
    ok, got = redlock_acquire(nodes, 0, "A", LEASE_TTL)
    # Client A measures validity on its own clock (offset 0): TTL - elapsed.
    a_valid_until = 0 + LEASE_TTL
    print(f"t=0  A acquire={ok} actual_votes={got} A_believes_until={a_valid_until}")
    holders = [n for n in nodes if n.held(3) and n.value == "A"]
    for n in holders[:MAJORITY]:
        n.jump(20)
    a_votes = votes_for(nodes, 3, "A")
    print(f"t=3  jumped +20 on {MAJORITY} holder nodes; A actual_votes={a_votes}")
    ok_b, got_b = redlock_acquire(nodes, 3, "B", LEASE_TTL)
    b_votes = votes_for(nodes, 3, "B")
    a_votes2 = votes_for(nodes, 3, "A")
    a_believes = 3 < a_valid_until
    print(
        f"t=3  B acquire={ok_b} B_votes={b_votes} A_votes={a_votes2} "
        f"A_still_believes={a_believes}"
    )
    print(
        f"split: A believes it holds the lock ({a_believes}) while B actually "
        f"holds a majority ({b_votes >= MAJORITY}) and A does not ({a_votes2 >= MAJORITY})"
    )

    nodes2 = [RedisNode() for _ in range(N_REDIS)]
    redlock_acquire(nodes2, 0, "A", LEASE_TTL)
    early, early_votes = redlock_acquire(nodes2, 3, "B", LEASE_TTL)
    t_late = None
    for t in range(0, LEASE_TTL + 3):
        # Fresh nodes for a scan would be wrong; probe remaining TTL on a clone path:
        pass
    # Independent control cluster
    t_ok = None
    for t in range(0, LEASE_TTL + 3):
        cluster = [RedisNode() for _ in range(N_REDIS)]
        redlock_acquire(cluster, 0, "A", LEASE_TTL)
        ok_c, _ = redlock_acquire(cluster, t, "B", LEASE_TTL)
        if ok_c:
            t_ok = t
            break
    print(f"control (no jump): B at t=3 acquire={early} votes={early_votes}; first B success t={t_ok}")


def compact(delay: int, fence: bool) -> None:
    kind = "fencing" if fence else "no fencing"
    print(f"\n=== delay={delay}, {kind} ===")
    header = "pause  B_at  A_arrives  final  lost  rejected"
    print(header)
    lost_n = 0
    rej_n = 0
    n = 0
    for pause in range(0, 26):
        r = stale_holder_scenario(pause, delay, fence)
        n += 1
        lost_n += int(bool(r["lost_update"]))
        rej_n += int(bool(r["stale_rejected"]))
        print(
            f"{pause:5d}  {str(r['t_b']):>3}  {r['arrive_a']:9d}  {r['final']:>5}  "
            f"{int(bool(r['lost_update'])):4d}  {int(bool(r['stale_rejected'])):8d}"
        )
    print(f"lost={lost_n}/{n} rejected={rej_n}/{n}")


def thresholds() -> None:
    print("\n=== Thresholds, TTL=10, pause in 0..25 ===")
    for delay in (0, 5):
        lost_pauses = [
            p for p in range(0, 26) if stale_holder_scenario(p, delay, False)["lost_update"]
        ]
        rej_pauses = [
            p for p in range(0, 26) if stale_holder_scenario(p, delay, True)["stale_rejected"]
        ]
        lost_fenced = [
            p for p in range(0, 26) if stale_holder_scenario(p, delay, True)["lost_update"]
        ]
        print(
            f"delay={delay}: lost without fence at pause {lost_pauses[0]}..{lost_pauses[-1]} "
            f"({len(lost_pauses)}/26); reject with fence at pause "
            f"{rej_pauses[0]}..{rej_pauses[-1]} ({len(rej_pauses)}/26); "
            f"lost with fence: {len(lost_fenced)}/26"
        )


def main() -> None:
    compact(0, False)
    compact(0, True)
    compact(5, False)
    compact(5, True)
    thresholds()
    print("\n=== Check-then-write (confirm still held at t=2, then pause) ===")
    for pause in (5, 8, 12):
        for fence in (False, True):
            r = check_then_write(pause, fence)
            print(
                f"pause_after_check={pause} fence={fence} t_B={r['t_b']} "
                f"arrive_A={r['arrive_a']} accepted_A={r['accepted_a']} "
                f"final={r['final']} lost={r['lost_update']}"
            )
    print("\n=== Workload: 3 clients, 2000 successful acquires, seed=168 ===")
    for fence in (False, True):
        r = workload(3, 2000, fence, seed=168)
        print(f"fence={fence}: {r}")
    redlock_clock_jump()


if __name__ == "__main__":
    main()

```

## Summary

- A distributed lock that can expire is a lease. The expiry is what stops a crashed holder from pinning the resource forever. It is also what creates a second, legal holder while the first one may still be about to write.
- If the lock is only an efficiency hint, a single Redis `SET NX PX` is usually enough, and a lost lock is a duplicate. If the lock is for correctness, two accepted writes from different owners are a bug, and a timing bound you cannot enforce is not a fix.
- A last-second "do I still hold the lease?" check does not close the race: the pause or the network delay can sit between the check and the apply. In the model, A checks at `t = 2`, pauses for 12, and overwrites B's write at `t = 14`.
- A fencing token is a strictly monotonic number issued at acquisition. The *resource* rejects a write whose token is not newer than the newest it has already accepted. Unique random strings cannot be ordered, so they are not fencing tokens.
- Chubby's sequencer (lock name, mode, lock generation number) is this mechanism, dated 2006. For servers that cannot check a sequencer, Chubby offers an imperfect lock-delay of up to one minute after a failed holder. ZooKeeper's `czxid` and etcd's `CreateRevision` are the same kind of number; etcd can enforce it in a transaction when the data lives in etcd, and must export it when the data does not. Kubernetes' default 15-second `Lease` elects a leader; it does not, by itself, fence the old leader's leftover calls.
- Redlock gives you a majority of independent expirations and still does not give you a fencing token. In the model, a forward clock jump of 20 on three of five nodes at `t = 3` lets B acquire a majority while A still believes, until `t = 10`, that it holds the lock. Take the lock from a consensus service and put its order on the write.
- In the model, a lease of 10 with no fencing loses 15 of 26 pauses when the write is immediate, and 20 of 26 when the write is delayed by 5 — including pauses that were still inside the lease at send time. Fencing rejects those stale writes and loses 0. On 2000 read-modify-write acquires with a 16-long pause tail, no fencing finishes at 1972 with 16 token inversions; fencing rejects the 16 stale writes and finishes at 1984.

## References

- Martin Kleppmann, [How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html), 8 February 2016
- Salvatore Sanfilippo (antirez), [Is Redlock safe?](https://antirez.com/news/101)
- Redis, [Distributed locks with Redis](https://redis.io/docs/develop/clients/patterns/distributed-locks/)
- Mike Burrows, [The Chubby lock service for loosely-coupled distributed systems](https://static.googleusercontent.com/media/research.google.com/en/us/archive/chubby-osdi06.pdf), OSDI 2006
- Cary G. Gray and David R. Cheriton, [Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency](https://dl.acm.org/doi/10.1145/74850.74870), SOSP 1989
- Patrick Hunt, Mahadev Konar, Flavio P. Junqueira, and Benjamin Reed, [ZooKeeper: Wait-free coordination for Internet-scale systems](https://www.usenix.org/legacy/event/usenix10/tech/full_papers/Hunt.pdf), USENIX ATC 2010
- Apache ZooKeeper, [ZooKeeper Recipes and Solutions](https://zookeeper.apache.org/doc/current/recipes.html) (shared lock)
- etcd, [concurrency.Mutex](https://github.com/etcd-io/etcd/blob/main/client/v3/concurrency/mutex.go) (`CreateRevision`, `IsOwner`)
- Kubernetes client-go, [leaderelection.go](https://github.com/kubernetes/client-go/blob/master/tools/leaderelection/leaderelection.go) (default `LeaseDuration`, `RenewDeadline`, `RetryPeriod`)
- Martin Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017 (distributed locking and fencing tokens)
