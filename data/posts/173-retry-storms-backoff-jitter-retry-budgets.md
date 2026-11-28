---
title: "Retry Storms: Timeouts, Exponential Backoff, Jitter, Retry Budgets, and Why Retries Turn Blips into Outages"
tag: architecture
description: Why every retry is a load decision — how client timeouts and late execution create wasted work, what capped exponential backoff does and does not fix, full, equal and decorrelated jitter, the multiplicative amplification of layered retries, metastable failures and the role retries play in them, the retry budgets used by Google SRE, Finagle, Envoy, gRPC and the AWS SDKs (including the November 2026 default change), client-side adaptive throttling, server pushback, deadline propagation, idempotency and hedging, and a runnable model that shows a 30-tick capacity dip turning into a permanent outage unless retries are budgeted
date: "2026-11-28T11:50:00.000Z"
---

## Goal

A retry is the cheapest reliability feature you can add. A connection resets, a node restarts, a packet gets lost, and one more attempt turns a user-visible error into a slightly slower success. Almost every RPC library, service mesh and cloud SDK ships with retries switched on.

A retry is also a decision to send more load to a system that has just told you, by failing, that something is wrong. When the failure is a random blip, that decision is right: the second attempt lands on a healthy path and the extra load is negligible. When the failure is caused by overload, the same decision multiplies the load on the very component that is short of capacity. The retry policy that hides one bad host on a Tuesday is the one that keeps a whole region down after a brief capacity dip.

This is not a theoretical concern. In a study of 22 metastable failures from 11 organizations, Huang et al. found that the retry policy was the most common sustaining effect, involved in more than half of the incidents. Marc Brooker's widely cited AWS article on backoff and jitter, Google's SRE book chapter on overload, gRPC's retry design, Envoy's retry budgets and the AWS SDK retry quota are all, in different words, answers to the same question: **how do you keep the benefit of retries for blips without paying for them during overload?**

This article covers:

1. Why a retry is a load decision, and what "selfish" means here.
2. Timeouts: where retries come from, and why a timed-out request is often still executed.
3. Capped exponential backoff, and what it does not fix.
4. Jitter: full, equal and decorrelated, and what real libraries ship.
5. Layered retries and multiplicative amplification.
6. Metastable failures: trigger, vulnerable state and sustaining effect.
7. Retry budgets in Google SRE, Finagle, Envoy, gRPC and the AWS SDKs.
8. Client-side adaptive throttling.
9. Server cooperation: pushback, `Retry-After`, deadline propagation and load shedding.
10. What is safe to retry: idempotency, status codes and hedged requests.
11. Trade-offs.
12. A runnable model, with its actual output.

## 1. A retry is a load decision

Brooker's Builders' Library article puts it in one word: retries are **selfish**. A client that retries spends more of the server's time to raise its own chance of success. When failures are rare and independent, the extra time is small and the trade is excellent. When failures are correlated with load — because the server is slow, its queue is long, or its dependency is saturated — every retry adds load to the very resource that is failing.

It helps to write the arithmetic down. If each attempt fails with probability `p` and a client makes up to `n` attempts, the expected number of attempts per logical request is

```
E[attempts] = 1 + p + p^2 + ... + p^(n-1) = (1 - p^n) / (1 - p)
```

At `p = 0.01` and `n = 3`, that is 1.0101: about 1% extra load, in exchange for turning a 1% failure rate into roughly one in a million. At `p = 0.9` — an overloaded server rejecting most requests — it is 2.71: the server that is already failing now receives 2.71 times its normal traffic, and the clients still see a 73% failure rate (`0.9^3`). At `p = 1` it is exactly `n`.

The same policy therefore has two opposite effects depending on why the attempt failed. The rest of this article is about telling those cases apart, or at least capping the damage when you cannot.

## 2. Timeouts come first

Most retries are not triggered by an explicit error. They are triggered by a **timeout**: the client gave up waiting. Two properties of timeouts make them dangerous.

**A timeout says nothing about whether the work happened.** The request may never have arrived, may be sitting in a queue, may be executing right now, or may have finished with a response that was lost. Brooker's article stresses this for side effects: a timeout or failure does not mean the side effect did not happen, which is why non-idempotent APIs are not safe to retry blindly.

**The server usually does not know the client has left.** Unless deadlines are propagated, a request that times out on the client is still queued on the server, and the server will spend real CPU on it later and send a response no one reads. During overload this is the core of the problem: the queue fills with attempts whose clients have already given up and sent a fresh copy. The server is busy, its throughput is fine, and its **goodput** — work that finishes in time to be useful — is zero.

Choosing the timeout is its own trade-off. Amazon's guidance is to start from an acceptable rate of false timeouts (for example 0.1%) and set the timeout at the matching downstream latency percentile (p99.9 in that example), with extra allowance for clients on the public internet. Too short a timeout turns a small latency increase into a wave of retries; Huang et al. cite an AWS incident in which a small handshake timeout was a contributing factor both in starting and sustaining the overload. Too long a timeout ties up client resources and hides real failures.

The practical rules:

- Prefer an end-to-end **deadline** that travels with the request (gRPC deadlines, or a header your services agree on) over independent per-hop timeouts. A retry must fit inside the remaining deadline, not reset it. gRPC's design is explicit that the call deadline applies to the entire chain of retried or hedged attempts.
- Let the server **check the deadline** before doing expensive work, and drop requests that have already expired. A cheap check that discards an expired request is the difference between a queue that drains and one that eats its own capacity.

## 3. Capped exponential backoff

The first fix everyone reaches for is to wait before retrying, and to wait longer each time:

```
sleep = min(cap, base * 2 ** attempt)
```

Backoff spreads one client's attempts over time and gives a transient problem — a restarting process, a failover, a full connection pool — time to clear. It is necessary, and it is not sufficient, for two reasons.

**Backoff delays retries; it does not cancel them.** With three attempts, every logical request that fails still sends three attempts in total. A longer wait moves the extra load later; it only reduces load if the outage ends before the retries are sent, or if the client gives up first because of its overall deadline. In the model at the end of this article, plain exponential backoff with three attempts reaches the same stuck state as immediate retries: offered load around 235 per tick against a capacity of 100.

**Synchronized backoff produces synchronized retries.** If many clients failed at the same moment — because the same server restarted — they all wait `base`, then `2*base`, then `4*base`, and they all come back at the same moment. Brooker's simulation of contended optimistic concurrency shows exactly this: backoff alone produces clusters of calls separated by silence, and barely reduces total work.

## 4. Jitter

The fix for synchronization is randomness. Brooker's 2015 article compares three variants against plain backoff:

```
# Full Jitter
sleep = random_between(0, min(cap, base * 2 ** attempt))

# Equal Jitter
temp  = min(cap, base * 2 ** attempt)
sleep = temp / 2 + random_between(0, temp / 2)

# Decorrelated Jitter
sleep = min(cap, random_between(base, sleep * 3))
```

In his simulation all three jittered variants cut the number of calls substantially compared with un-jittered backoff — with 100 contending clients, by more than half — and the un-jittered version is the clear loser on both work and completion time. Among the jittered variants, Full and Equal did similar work, Equal took longer, and the choice between Full and Decorrelated was close. He also notes that none of these approaches change the fundamental `N^2` work of N clients contending on one row; jitter reduces the constant, not the shape.

What production libraries actually do:

| Library | Defaults | Jitter |
|---|---|---|
| gRPC retry policy (gRFC A6) | `initialBackoff`, `maxBackoff`, `backoffMultiplier` set in service config; `maxAttempts` capped at 5 by default | `min(initialBackoff * multiplier^(n-1), maxBackoff) * random(0.8, 1.2)` |
| Envoy router | base interval 25 ms, max interval 10x base (250 ms); default retry count 1 | "fully jittered": retry N waits in `[0, (2^N - 1) * base)`, i.e. 0–24 ms, 0–74 ms, 0–174 ms |
| AWS SDKs (standard mode, 2026 behavior) | 3 attempts; base 50 ms for transient errors, 1,000 ms for throttling; 20 s cap | full jitter: `random(0, 1) * min(20 s, base * 2^retry)` |

Note the difference between gRPC's ±20% jitter and full jitter. ±20% de-synchronizes clients that failed together but keeps every client close to the nominal schedule; full jitter spreads them over the whole interval, including very short waits. Envoy and the AWS SDKs use full jitter; for the overload case that matters most in this article, *how much* jitter you choose matters much less than *whether retries are budgeted at all*.

## 5. Layered retries multiply

Real requests cross several services. If every layer retries independently, the attempts multiply. Brooker's example is a five-deep stack ending in a database, with three tries at each layer: when the database starts failing under load, its traffic can grow by `3^5 = 243` times.

```
depth 1:   3
depth 2:   9
depth 3:  27
depth 4:  81
depth 5: 243
```

Both Amazon and Google arrive at the same rule. Amazon's best practice for low-cost control-plane and data-plane operations is to retry at a single point in the stack. Google's SRE book says requests should only be retried at the layer immediately above the layer that is rejecting them; once that layer gives up, it returns an "overloaded; don't retry" error so that the layers above do not start their own round. A retry policy is therefore a property of the **call graph**, not of a single client library — which is one reason service meshes, which see every hop, are a natural place to put it.

## 6. Metastable failures

Bronson, Aghayev, Charapko and Zhu (HotOS 2021) gave the dangerous case a name. A **metastable failure** happens in an open system with an uncontrolled source of load: a **trigger** pushes the system into a bad state, and that state **persists after the trigger is removed**, because a **sustaining effect** — often work amplification — keeps goodput unusably low. Leaving the state needs a strong corrective push, such as dramatically reducing load or restarting the system.

Their framework has three states:

- **Stable**: a trigger causes a temporary dip and the system recovers on its own.
- **Vulnerable**: the system is healthy — often for months — but a large enough trigger will tip it over. Many production systems run here deliberately, because it is more efficient.
- **Metastable**: the feedback loop sustains the overload with no further push.

Retries are the textbook sustaining effect. A capacity dip makes queues grow; queueing delay passes the client timeout; clients give up and resend; the server keeps executing the abandoned attempts; the extra attempts make the queue longer; and the loop closes. The trigger can be gone for an hour and the system will still be down. The paper also notes that an outage like this is often initially blamed on the trigger, while the root cause is the sustaining effect.

The OSDI 2022 follow-up, *Metastable Failures in the Wild*, studied public incident reports and found 22 metastable failures across 11 organizations; at least 4 of 15 major AWS outages in the previous decade were metastable failures. Retry policy was the most common sustaining effect (more than half of the incidents), and direct load shedding was the most common mitigation (over 55% of cases). That is the motivation for the next two sections: make the amplification bounded **before** the incident, so that recovery does not require someone to find and drain the loop by hand.

## 7. Retry budgets

A retry budget caps retries as a **fraction of traffic** rather than per request. Per-request limits ("at most 3 attempts") still allow traffic to triple when everything fails. A budget says: retries may add at most, say, 10% or 20% load in aggregate. When failures are rare the budget is never touched; when everything fails it runs out quickly and retries stop.

**Google SRE.** The SRE book's "Handling Overload" chapter describes two layers: a per-request limit of up to three attempts, and a per-client budget where a request is retried only while retries are under 10% of that client's requests. With only the per-request limit, the worst case grows to just below 3X; adding the 10% ratio brings it to 1.1X in the general case. Servers also look at a retry-count field in request metadata and return "overloaded; don't retry" when a backend sees too many retries.

**Finagle.** Twitter's `RetryBudget` defaults to allowing about 20% of requests to be retried, plus a minimum reserve of 10 retries per second for clients that have just started or send little traffic. Deposits expire after a TTL of 10 seconds, so the budget reflects recent traffic.

**Envoy.** A cluster's circuit-breaker thresholds can carry a `retry_budget`: active retries are limited to `budget_percent` (default 20%) of active plus pending requests, never below `min_retry_concurrency` (default 3). This is a concurrency budget — it limits retries in flight rather than counting them over a window — which fits a proxy that already tracks active requests per cluster.

**gRPC.** gRFC A6 defines `retryThrottling` per server name: a `token_count` starts at `maxTokens` (the example uses 10, valid range up to 1000). Every failed RPC subtracts 1, every successful RPC adds `tokenRatio` (0.1 in the example). When the count is at or below `maxTokens / 2`, retries and hedges stop until it rises again. With `tokenRatio = 0.1`, that is roughly one retry allowed per ten successes once the reserve is gone. Only retryable failures (or pushback) count, so a stream of `INVALID_ARGUMENT` does not disable retries.

**AWS SDKs.** The SDKs' standard retry mode includes a **retry quota**, a token bucket of 500 tokens. Amazon added local retry token buckets to the AWS SDK in 2016, as an alternative to circuit breakers that it found modal and hard to reason about. The updated behavior, announced as an opt-in in May 2026 and made the default on **10 November 2026** for most SDKs (Java 2.x 2.58.0, botocore 1.44.0, Go v2 v1.48.0, JavaScript v3 3.1166.0, AWS CLI 2.40.0 and others; Kotlin is still to be announced), sets:

- base delay 50 ms for transient errors and 1,000 ms for throttling errors, full jitter, 20 s cap, 3 attempts;
- each transient retry costs **14** tokens (previously 5, or 10 for timeouts), each throttling retry costs 5;
- a successful retry refunds its own cost; a request that succeeds on the first try adds 1 token;
- when the bucket is empty, the SDK returns the error instead of retrying.

The AWS documentation works out that, with 3 attempts, the bucket starts to drain when more than about 22% of requests hit sustained transient failures (about 32% for throttling). Below that, first-try successes refill it faster than retries drain it. Raising the transient cost from 5 to 14 is a deliberate choice to make the quota engage sooner during a sustained outage, while still letting a brief spike be absorbed by the 500-token reserve.

These designs differ in shape — ratio over a window, concurrency fraction, token bucket — but they share the property that matters: **the total extra load from retries is bounded by a small constant, independent of the failure rate.**

## 8. Client-side adaptive throttling

A retry budget caps *retries*. During severe overload even first attempts can be too much, especially when rejecting a request costs the server nearly as much as serving it. Google's SRE book describes **adaptive throttling**: each client keeps, for the last two minutes, the number of `requests` its application attempted and the number of `accepts` the backend took. New requests are rejected locally, without touching the network, with probability

```
p_reject = max(0, (requests - K * accepts) / (requests + 1))
```

With `K = 2`, clients keep sending until about twice as many requests as accepts, so the backend ends up rejecting about one request for each it processes. Lowering `K` (say to 1.1) makes throttling more aggressive and wastes less backend capacity; Google generally prefers 2, because letting some extra requests through makes clients notice faster when the backend recovers. The decision uses only local information, so it adds no dependencies and no latency.

The window is the catch. In the model below, adaptive throttling with a 60-tick window does break the retry loop — the queue empties — but the rejection probability stays high long after the trigger, so goodput averages only 7.5 per tick in ticks 200–299 and the system takes until tick 550 to get back to 95% of normal. With a 20-tick window it recovers by tick 212. A long memory is stable and slow; a short one reacts faster and is noisier. Adaptive throttling also needs a real accept signal; when the only feedback is a timeout, "accepted" degenerates to "finished in time", which is what the model uses.

## 9. Server cooperation

Clients can only guess. Servers know their queue length and can say more.

- **Pushback.** gRPC servers can set `grpc-retry-pushback-ms`: a non-negative value tells the client to retry after exactly that delay, a negative or unparsable value tells it not to retry at all. HTTP has `Retry-After` (RFC 9110), and Envoy can honor `Retry-After` or headers such as `X-RateLimit-Reset` through its rate-limited retry back-off. Amazon uses distinct throttling errors, and the SDKs back off from them with a much longer base delay (1,000 ms versus 50 ms).
- **"Don't retry" errors.** Google's "overloaded; don't retry" is the inter-service version: the layer that has already retried tells the layer above to stop.
- **Deadline checks and load shedding.** Dropping a request whose deadline has passed costs almost nothing and frees the capacity for requests that can still succeed. Bounded queues and shedding at admission keep queueing delay below the client timeout. In the model, letting the server drop expired requests is enough on its own: even immediate retries with three attempts recover at tick 130, exactly when the trigger ends, with zero wasted executions.
- **Queue discipline.** The HotOS paper lists LIFO scheduling and smaller queues among the ad-hoc defenses used in industry: when most queued requests are already stale, serving the newest first gives those requests a chance to finish before their deadline.

## 10. What is safe to retry

**Idempotency first.** A retry after a timeout may execute the operation twice. Reads, `PUT` of a full resource and `DELETE` are naturally idempotent; "charge this card" and "append this message" are not. The standard fix is an **idempotency key**: the client generates a unique id per logical operation, sends it on every attempt, and the server stores the result under that key and returns it for duplicates. gRPC goes further and retries transparently only when it can guarantee the request never reached the server application logic.

**Retry the right errors.** Retry transient transport failures and explicit "unavailable" or throttling responses; do not retry validation errors, authorization failures or "not found". gRPC's retry policy requires an explicit list of `retryableStatusCodes` (the examples use `UNAVAILABLE`), and its throttling counts only those failures, so a burst of client mistakes does not change retry behavior.

**Hedging is retrying for latency.** Dean and Barroso's *The Tail at Scale* describes **hedged requests**: send a second copy to another replica if the first has not answered after, say, the 95th-percentile latency, and use whichever answer arrives first. Waiting for the p95 limits extra load to about 5%. In their BigTable benchmark of 1,000 keys spread across 100 servers, hedging after 10 ms cut the 99.9th-percentile latency for retrieving all values from 1,800 ms to 74 ms while sending only 2% more requests. gRPC implements this as `hedgingPolicy` with a `hedgingDelay`, under the same `maxAttempts` cap and the same throttling tokens. Hedging is safe only for idempotent operations, and it must be budgeted like any other retry — during overload, every hedge is extra load.

## 11. Trade-offs

- **No retries.** No amplification at all, and every transient blip becomes a user-visible error. Reasonable at the lowest layer of a deep stack, wrong at the edge.
- **Per-request attempt limits.** Simple and universal. They cap the multiplier at `n`, not at something small; `n = 3` still triples traffic when everything fails.
- **Backoff without jitter.** Better than hammering, but synchronized clients produce synchronized waves. Do not ship it.
- **Backoff with jitter.** Removes synchronization and wasted collisions; does not bound aggregate retry load during overload.
- **Retry budgets (ratio, concurrency or tokens).** Bound total retry load to a small constant. The cost is a few counters per client or per cluster and a policy choice about what counts as a failure. Local budgets do not see what other clients are doing; for fleet-wide coordination you still need server signals.
- **Adaptive throttling.** Also protects against first-attempt overload, using only local information. It trades backend waste for recovery speed through `K` and the window length, and it needs a clear accept signal.
- **Circuit breakers.** Stop all calls when an error threshold is crossed. Amazon notes they introduce modal behavior that is hard to reason about and can add time to recovery; token buckets were its alternative for retries.
- **Server cooperation (deadlines, shedding, pushback).** The most effective defenses, because the server knows its own state. They require that every service participates, which is an organizational cost as much as a technical one.

## 12. A runnable model

The script below produced every number in this section, with Python 3.13 and seed 173. It has three parts.

**Part 1 — overload.** One FIFO server finishes 100 requests per tick. Forty clients send, on average, 80 new requests per tick (80% utilization). Every attempt has a 10-tick client deadline. The server does not know when a client has given up, so an attempt that has timed out is still executed later unless the server is configured to drop expired requests (at 5% of the cost of executing them). The trigger reduces capacity to 40 for ticks 100–129; then capacity returns to 100 and stays there until tick 599. Goodput counts attempts that finish before their deadline. "Recovered" is the first tick after the trigger from which the 10-tick average goodput is at least 95% of the normal load.

The results:

- **No retries** recovers on its own: the backlog drains and goodput is back to normal at tick 147.
- **Three attempts with immediate retries, plain exponential backoff or full jitter** never recover. In ticks 200–299 and 500–599 goodput is 0.0. The server is fully busy the whole time, but offered load sits at 235–240 attempts per tick, the queue ends with more than 66,000 attempts, and 47,427 executions are wasted on attempts whose clients had already left. The capacity dip lasted 30 ticks; the outage lasts for the rest of the run. Backoff and jitter make almost no difference here: backoff only moves the extra attempts later.
- **Budgets break the loop.** A 10% ratio budget over a 10-tick window recovers at tick 226, the AWS-style quota (500 tokens, 14 per retry, per client) at tick 227, and gRPC-style throttling (`maxTokens = 10`, `tokenRatio = 0.1`) at tick 155 with only 164 retries sent in total. In ticks 500–599 all three are back at normal goodput (78.9–79.7).
- **Adaptive throttling with K = 2** also escapes, but with a 60-tick window it averages only 7.5 goodput in ticks 200–299 and reaches the recovery threshold at tick 550, after rejecting 19,030 requests locally. With a 20-tick window it recovers at tick 212.
- **Dropping expired requests on the server** is the strongest single fix in this model: with or without retries, recovery is at tick 130, wasted executions fall to 0, and goodput during the trigger rises from 25.8 to 39.1 out of a possible 40.

Part 1b varies the length of the trigger. With three attempts, full jitter and no budget, the system recovers from capacity dips of 10, 15 and 20 ticks — and never recovers from 22, 24, 26 or 30. Without retries, the same dips heal by ticks 124 to 147. With the AWS-style quota they heal by ticks 196 to 227. This is the vulnerable state from Bronson et al.: nothing about the steady-state system tells you that 20 ticks is safe and 22 is not.

**Part 2 — contention.** One hundred clients do a read-modify-write on one row; an attempt that starts while another write is in flight conflicts and backs off (mean of 20 runs). Immediate retries and un-jittered exponential backoff both need 5050 calls — exactly `100 * 101 / 2`, because each round lets one client through and everyone else collides. Un-jittered backoff also takes 3,140 ms instead of 100 ms, because the clients keep returning together. All three jitter variants cut the calls to 769–824 and finish in 164–194 ms. In this model decorrelated jitter makes the fewest calls and full jitter finishes first; Brooker's simulator ranked them slightly differently, which is a reminder that the ordering among jitter variants depends on the workload, while the gap between "jitter" and "no jitter" does not.

**Part 3** is the layered arithmetic: with three tries per layer, worst-case attempts at the bottom are 3, 9, 27, 81 and 243 for depths 1 to 5.

```python
#!/usr/bin/env python3
"""Retry storm model: timeouts, retries, backoff, jitter, and retry budgets.

Part 1 is a tick-based overload model. 40 clients send a mean of 80 new
requests per tick to one FIFO server that finishes 100 per tick. Every attempt
has a client deadline of 10 ticks. The server does not know when a client has
given up, so a request that times out in the queue is still executed later
(wasted work) unless the server is told to drop expired requests.
A trigger cuts capacity to 40 for a while; then capacity returns to 100.
Goodput counts attempts that finish before their deadline.

Part 2 is an OCC contention race in the spirit of Brooker (2015).
"""
import math
import random
from collections import deque

CAP = 100
LOAD = 80
CLIENTS = 40
TIMEOUT = 10
HORIZON = 600
TRIGGER = (100, 130, 40)          # [start, end) and reduced capacity


def backoff(policy, retry_no, rng, prev, base=1.0, cap=32.0):
    """Delay before retry number retry_no (0-based)."""
    if policy == "immediate":
        return 0.0
    exp = min(cap, base * 2 ** retry_no)
    if policy == "expo":
        return exp
    if policy == "full_jitter":
        return rng.uniform(0, exp)
    if policy == "equal_jitter":
        return exp / 2 + rng.uniform(0, exp / 2)
    if policy == "decorrelated":
        return min(cap, rng.uniform(base, prev * 3))
    raise ValueError(policy)


class Budget:
    """Per-client retry admission."""

    def __init__(self, kind):
        self.kind = kind
        self.tokens = {"aws": 500.0, "grpc": 10.0}.get(kind, 0.0)
        self.hist = deque()           # (tick, is_retry) for the ratio budget

    def on_send(self, t, is_retry):
        if self.kind == "ratio10":
            self.hist.append((t, is_retry))
            while self.hist and self.hist[0][0] <= t - 10:
                self.hist.popleft()

    def allow_retry(self, t):
        if self.kind is None:
            return True
        if self.kind == "ratio10":   # retries must stay under 10% of recent sends
            sends = len(self.hist)
            retries = sum(1 for _, r in self.hist if r)
            return retries + 1 <= 0.10 * (sends + 1)
        if self.kind == "aws":        # 500 tokens, 14 per transient retry
            if self.tokens < 14:
                return False
            self.tokens -= 14
            return True
        if self.kind == "grpc":       # maxTokens 10, tokenRatio 0.1
            return self.tokens > 5
        raise ValueError(self.kind)

    def on_success(self, first_try):
        if self.kind == "aws":
            self.tokens = min(500.0, self.tokens + (1 if first_try else 14))
        if self.kind == "grpc":
            self.tokens = min(10.0, self.tokens + 0.1)

    def on_failure(self):
        if self.kind == "grpc":
            self.tokens = max(0.0, self.tokens - 1)


class Adaptive:
    """Google SRE client-side adaptive throttling over a sliding window of ticks."""

    def __init__(self, k, window=60):
        self.k = k
        self.window = window
        self.win = deque()            # (tick, requests, accepts)

    def reject_prob(self, t):
        while self.win and self.win[0][0] <= t - self.window:
            self.win.popleft()
        req = sum(w[1] for w in self.win)
        acc = sum(w[2] for w in self.win)
        return max(0.0, (req - self.k * acc) / (req + 1))

    def record(self, t, requests, accepts):
        self.win.append((t, requests, accepts))


def overload(name, max_attempts=1, delay="immediate", budget=None, adaptive_k=None,
             window=60, drop_expired=False, trigger=TRIGGER, seed=173):
    rng = random.Random(seed)
    budgets = [Budget(budget) for _ in range(CLIENTS)]
    adapt = [Adaptive(adaptive_k, window) for _ in range(CLIENTS)] if adaptive_k else None
    queue = deque()          # [deadline, client, first_try, attempt, prev_delay]
    by_deadline = {}         # deadline -> list of queued attempts
    pending = {}             # send tick -> list of (client, attempt, prev_delay)
    goodput, offered = [], []
    wasted = retries = local_rejects = 0
    for t in range(HORIZON):
        cap = trigger[2] if trigger[0] <= t < trigger[1] else CAP
        reqs = [0] * CLIENTS
        accs = [0] * CLIENTS
        arrivals = [(rng.randrange(CLIENTS), 1, 1.0)
                    for _ in range(max(0, round(rng.gauss(LOAD, math.sqrt(LOAD)))))]
        arrivals += pending.pop(t, [])
        sent = 0
        for c, attempt, prev in arrivals:
            reqs[c] += 1
            if adapt and rng.random() < adapt[c].reject_prob(t):
                local_rejects += 1
                continue
            item = [t + TIMEOUT, c, attempt == 1, attempt, prev, False]
            queue.append(item)
            by_deadline.setdefault(t + TIMEOUT, []).append(item)
            budgets[c].on_send(t, attempt > 1)
            retries += attempt > 1
            sent += 1
        work, ok = float(cap), 0
        while queue and work >= 1:
            item = queue[0]
            if drop_expired and item[0] <= t:
                queue.popleft()
                work -= 0.05             # a deadline check is cheap, not free
                continue
            queue.popleft()
            item[5] = True               # executed
            work -= 1
            if t < item[0]:
                ok += 1
                accs[item[1]] += 1
                budgets[item[1]].on_success(item[2])
            else:
                wasted += 1
        # attempts whose deadline is the next tick and that have not run yet time out
        for item in by_deadline.pop(t + 1, []):
            if item[5]:
                continue
            c, attempt, prev = item[1], item[3], item[4]
            budgets[c].on_failure()
            if attempt >= max_attempts or not budgets[c].allow_retry(t):
                continue
            d = backoff(delay, attempt - 1, rng, prev)
            pending.setdefault(t + 1 + math.ceil(d), []).append((c, attempt + 1, max(1.0, d)))
        if adapt:
            for c in range(CLIENTS):
                adapt[c].record(t, reqs[c], accs[c])
        goodput.append(ok)
        offered.append(sent)
    end = trigger[1]
    recovered = next((t for t in range(end, HORIZON - 10)
                      if sum(goodput[t:t + 10]) / 10 >= 0.95 * LOAD), None)
    return dict(name=name, during=sum(goodput[trigger[0]:end]) / (end - trigger[0]),
                mid=sum(goodput[200:300]) / 100,
                late=sum(goodput[500:600]) / 100, offered=sum(offered[500:600]) / 100,
                queue=len(queue), wasted=wasted, retries=retries,
                local_rejects=local_rejects, recovered=recovered)


def occ_contention(policy, n=100, seed=173, trials=20):
    """N clients do read-modify-write on one row; a write that starts while
    another is in flight (1 ms window) conflicts and the client backs off."""
    calls_sum = finish_sum = 0.0
    for k in range(trials):
        rng = random.Random(seed * 1000 + k)
        nxt = [rng.uniform(0, 1) for _ in range(n)]
        att, prev, done = [0] * n, [1.0] * n, [False] * n
        busy_until, calls, last, left = 0.0, 0, 0.0, n
        while left:
            i = min((j for j in range(n) if not done[j]), key=lambda j: nxt[j])
            t = nxt[i]
            calls += 1
            if t >= busy_until:
                busy_until = last = t + 1.0
                done[i] = True
                left -= 1
            elif policy == "immediate":
                nxt[i] = busy_until
            else:
                d = backoff(policy, att[i], rng, prev[i])
                prev[i] = max(1.0, d)
                att[i] += 1
                nxt[i] = t + 1.0 + d
        calls_sum += calls
        finish_sum += last
    return calls_sum / trials, finish_sum / trials


def main():
    print("=== Part 1: capacity 100 -> 40 for ticks 100-129; load 80; timeout 10 ===")
    cases = [
        dict(name="no retries"),
        dict(name="3 attempts, immediate", max_attempts=3),
        dict(name="3 attempts, expo no jitter", max_attempts=3, delay="expo"),
        dict(name="3 attempts, full jitter", max_attempts=3, delay="full_jitter"),
        dict(name="3 attempts, full jitter, ratio 10%", max_attempts=3,
             delay="full_jitter", budget="ratio10"),
        dict(name="3 attempts, full jitter, gRPC throttle", max_attempts=3,
             delay="full_jitter", budget="grpc"),
        dict(name="3 attempts, full jitter, AWS quota", max_attempts=3,
             delay="full_jitter", budget="aws"),
        dict(name="3 attempts, full jitter, adaptive K=2", max_attempts=3,
             delay="full_jitter", adaptive_k=2),
        dict(name="3 attempts, full jitter, adaptive K=2 w=20", max_attempts=3,
             delay="full_jitter", adaptive_k=2, window=20),
        dict(name="no retries, server drops expired", drop_expired=True),
        dict(name="3 attempts, immediate, drops expired", max_attempts=3, drop_expired=True),
    ]
    print(f"{'policy':<42}{'during':>7}{'t200-299':>9}{'t500-599':>9}{'offered':>8}{'queue':>7}"
          f"{'wasted':>8}{'retries':>8}{'rejLocal':>9}{'recov':>6}")
    for c in cases:
        r = overload(**c)
        print(f"{r['name']:<42}{r['during']:7.1f}{r['mid']:9.1f}{r['late']:9.1f}{r['offered']:8.1f}"
              f"{r['queue']:7d}{r['wasted']:8d}{r['retries']:8d}{r['local_rejects']:9d}"
              f"{str(r['recovered']):>6}")
    print("\n=== Part 1b: the cliff. 3 attempts, full jitter, no budget ===")
    for dur in (10, 15, 20, 22, 24, 26, 30):
        r = overload("x", max_attempts=3, delay="full_jitter", trigger=(100, 100 + dur, 40))
        b = overload("x", max_attempts=3, delay="full_jitter", budget="aws",
                     trigger=(100, 100 + dur, 40))
        n = overload("x", trigger=(100, 100 + dur, 40))
        print(f"trigger={dur:2d}: no budget t500-599={r['late']:5.1f} recov={r['recovered']}"
              f" | AWS quota t500-599={b['late']:5.1f} recov={b['recovered']}"
              f" | no retries recov={n['recovered']}")
    print("\n=== Part 2: OCC contention, 100 clients, one row, mean of 20 runs ===")
    for p in ("immediate", "expo", "equal_jitter", "full_jitter", "decorrelated"):
        calls, finish = occ_contention(p)
        print(f"{p:<13} calls={calls:7.1f} finish_ms={finish:7.1f}")
    print("\n=== Part 3: independent retries per layer, 3 tries each ===")
    print(" ".join(f"depth{d}={3 ** d}" for d in range(1, 6)))


if __name__ == "__main__":
    main()
```

The output:

```
=== Part 1: capacity 100 -> 40 for ticks 100-129; load 80; timeout 10 ===
policy                                     during t200-299 t500-599 offered  queue  wasted retries rejLocal recov
no retries                                   25.8     81.0     78.6    78.6      0    2325       0        0   147
3 attempts, immediate                        25.8      0.0      0.0   235.1  66702   47427   75247        0  None
3 attempts, expo no jitter                   25.8      0.0      0.0   235.3  66389   47427   74934        0  None
3 attempts, full jitter                      25.8      0.0      0.0   239.9  67609   47427   75793        0  None
3 attempts, full jitter, ratio 10%           25.8     69.4     78.9    78.9      0    9771    1698        0   226
3 attempts, full jitter, gRPC throttle       25.8     79.0     78.9    78.9      0    3083     164        0   155
3 attempts, full jitter, AWS quota           25.8     65.2     79.7    79.7      0   10284    1407        0   227
3 attempts, full jitter, adaptive K=2        24.8      7.5     74.2    74.2      0    6049    2997    19030   550
3 attempts, full jitter, adaptive K=2 w=20   24.8     75.9     79.8    79.8      0    1992     589     6093   212
no retries, server drops expired             39.1     81.0     78.6    78.6      0       0       0        0   130
3 attempts, immediate, drops expired         39.1     81.0     78.6    78.6      0       0     673        0   130

=== Part 1b: the cliff. 3 attempts, full jitter, no budget ===
trigger=10: no budget t500-599= 78.6 recov=110 | AWS quota t500-599= 78.6 recov=110 | no retries recov=110
trigger=15: no budget t500-599= 78.6 recov=115 | AWS quota t500-599= 78.6 recov=115 | no retries recov=115
trigger=20: no budget t500-599= 78.9 recov=120 | AWS quota t500-599= 78.9 recov=120 | no retries recov=120
trigger=22: no budget t500-599=  0.0 recov=None | AWS quota t500-599= 79.3 recov=210 | no retries recov=124
trigger=24: no budget t500-599=  0.0 recov=None | AWS quota t500-599= 78.9 recov=196 | no retries recov=129
trigger=26: no budget t500-599=  0.0 recov=None | AWS quota t500-599= 79.0 recov=215 | no retries recov=134
trigger=30: no budget t500-599=  0.0 recov=None | AWS quota t500-599= 79.7 recov=227 | no retries recov=147

=== Part 2: OCC contention, 100 clients, one row, mean of 20 runs ===
immediate     calls= 5050.0 finish_ms=  100.0
expo          calls= 5050.0 finish_ms= 3140.0
equal_jitter  calls=  778.8 finish_ms=  194.4
full_jitter   calls=  824.4 finish_ms=  164.2
decorrelated  calls=  768.9 finish_ms=  183.9

=== Part 3: independent retries per layer, 3 tries each ===
depth1=3 depth2=9 depth3=27 depth4=81 depth5=243
```

## Summary

- Every retry is a load decision. At a 1% failure rate, three attempts cost about 1% extra load; at 90% they cost 2.71 times the load and the clients still fail 73% of the time.
- Most retries come from timeouts, and a timed-out request is often still executed. Without deadline checks on the server, overload fills the queue with work nobody will read.
- Capped exponential backoff spreads one client's attempts; jitter de-synchronizes many clients. Neither bounds the aggregate retry load during overload — in the model, immediate, exponential and fully jittered retries all end in the same stuck state with goodput 0.
- Retries multiply across layers: three tries at each of five layers is 243 attempts at the bottom. Retry at one layer and propagate "don't retry".
- Metastable failures are triggered by something small and sustained by feedback, and retries are the most common sustaining effect in the incidents studied at OSDI 2022. In the model, a 20-tick capacity dip heals and a 22-tick dip never does.
- Retry budgets cap retries as a fraction of traffic: Google SRE's 10% per-client ratio, Finagle's 20% plus 10 per second, Envoy's 20% of active requests with a floor of 3, gRPC's `retryThrottling` token count, and the AWS SDK retry quota of 500 tokens with 14 per transient retry, the default since 10 November 2026. Every budget in the model turns the permanent outage into a recovery.
- Adaptive throttling (`max(0, (requests - K*accepts)/(requests + 1))`, K = 2) protects against first-attempt overload; its window trades stability for recovery speed.
- The strongest defenses are on the server: drop expired requests, shed load early, send pushback or `Retry-After`. In the model, dropping expired work alone recovers exactly when the trigger ends.
- Retry only idempotent operations, or make them idempotent with keys; retry only transient errors; and treat hedged requests as budgeted retries for latency.

## References

- Marc Brooker, [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), AWS Architecture Blog, 4 March 2015
- Marc Brooker, [Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/), Amazon Builders' Library
- Google, *Site Reliability Engineering*, [Chapter 21: Handling Overload](https://sre.google/sre-book/handling-overload/) and [Chapter 22: Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/)
- Nathan Bronson, Abutalib Aghayev, Aleksey Charapko, and Timothy Zhu, [Metastable Failures in Distributed Systems](https://www.sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf), HotOS 2021
- Lexiang Huang, Matthew Magnusson, Abishek Bangalore Muralikrishna, Salman Estyak, Rebecca Isaacs, Abutalib Aghayev, Timothy Zhu, and Aleksey Charapko, [Metastable Failures in the Wild](https://www.usenix.org/conference/osdi22/presentation/huang-lexiang), OSDI 2022, and the [;login: summary](https://www.usenix.org/publications/loginonline/metastable-failures-wild)
- gRPC, [gRFC A6: gRPC Retry Design](https://github.com/grpc/proposal/blob/master/A6-client-retries.md) (retry policy, hedging policy, `retryThrottling`, pushback)
- Envoy, [router filter documentation source](https://github.com/envoyproxy/envoy/blob/main/docs/root/configuration/http/http_filters/router_filter.rst) (default back-off) and [circuit_breaker.proto](https://github.com/envoyproxy/envoy/blob/main/api/envoy/config/cluster/v3/circuit_breaker.proto) (`RetryBudget`)
- Twitter Finagle, [RetryBudget.scala](https://github.com/twitter/finagle/blob/develop/finagle-core/src/main/scala/com/twitter/finagle/service/RetryBudget.scala)
- AWS SDKs and Tools Reference Guide, *Retry behavior* (retry quota and backoff formula), and the AWS SDK for Go v2 [retry package](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/aws/retry)
- AWS Developer Tools Blog, [Updated default retry behavior for AWS SDKs and tools](https://aws.amazon.com/blogs/developer/updated-default-retry-behavior-for-aws-sdks-and-tools/), November 2026
- Jeffrey Dean and Luiz André Barroso, [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf), Communications of the ACM, February 2013
- IETF, [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) (`Retry-After`)
