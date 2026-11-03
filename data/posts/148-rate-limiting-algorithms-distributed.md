---
title: "Rate Limiting in Depth: Token Bucket, GCRA, Sliding Windows, Distributed Limiters and Adaptive Concurrency"
tag: architecture
description: How the classic rate limiting algorithms really work — fixed window, sliding log, sliding window counter, leaky bucket, token bucket and GCRA — with verified Go implementations, an atomic Redis Lua limiter, the trade-offs of local versus global limiting, how Nginx, Envoy, Stripe and Cloudflare do it, and why mature systems add concurrency limits, adaptive throttling and load shedding on top of request rates
date: "2026-11-03T11:20:00.000Z"
---

## Goal

Every public API, gateway and shared backend eventually needs to say "no". Rate limiting protects a service from abusive clients, from a single tenant starving everyone else, from retry storms, and from its own downstream dependencies collapsing. It looks simple — "at most 100 requests per minute" — but the details decide whether the limiter is fair, cheap, accurate across many servers, and actually helpful under overload.

This article covers:

1. What exactly we are limiting, and where.
2. Window-based algorithms: fixed window, sliding log, sliding window counter.
3. Bucket-based algorithms: leaky bucket, token bucket, and GCRA.
4. Working Go implementations of the three most useful ones.
5. Distributed rate limiting: Redis, atomicity, clock issues, local vs global.
6. How real systems do it: Nginx, Envoy, Stripe, Cloudflare, Go and Guava libraries.
7. Beyond request rates: concurrency limits, adaptive throttling and load shedding.
8. API contract: 429, `Retry-After` and rate limit headers.

## 1. What are we limiting, and where?

Before picking an algorithm, answer three questions.

**The key.** A limit is always "per something": per API key, per user, per IP, per tenant, per endpoint, or combinations such as `(tenant, endpoint)`. Picking the key is a product decision. Per-IP limits punish users behind NAT or corporate proxies; per-user limits do nothing against an attacker who registers many accounts. Production systems usually stack several limits: a generous per-IP limit at the edge, a per-API-key limit at the gateway, and a per-tenant limit on expensive endpoints.

**The cost.** Not all requests are equal. A search that fans out to 50 shards is not the same as a health check. Many limiters therefore support *weighted* requests ("this call costs 5 tokens"), or limit a different resource entirely, such as bytes, rows scanned, or LLM tokens per minute.

**The place.** Limits can be enforced at the client (cooperative backoff), at the edge/CDN, at an API gateway or sidecar, inside the service, or in front of a specific dependency (for example, a database connection pool). Earlier is cheaper — rejected traffic consumes fewer resources — but later knows more about the real cost and the current health of the system.

## 2. Window-based algorithms

### Fixed window

Divide time into windows (e.g. each calendar minute), keep a counter per key per window, and reject when the counter exceeds the limit.

```
key = "rl:{user}:{floor(now/60)}"
count = INCR key; EXPIRE key 60
allow = count <= 100
```

It is the cheapest possible algorithm — one counter, one atomic increment — which is why it is common in simple gateways. Its flaw is the **boundary burst**: a client can send 100 requests at 12:00:59 and another 100 at 12:01:00, i.e. 200 requests in two seconds while never violating a "100 per minute" rule. Windows are also synchronized across all clients, so many clients whose quota resets at the same second create thundering herds.

### Sliding log

Store the timestamp of every accepted request (e.g. in a Redis sorted set), drop timestamps older than the window, and allow if fewer than `limit` remain. It is exact — there is no boundary effect — but memory is O(limit) per key and each check touches many entries. It is fine for low limits such as "5 password attempts per 15 minutes", and too expensive for "10,000 requests per minute" across millions of keys.

### Sliding window counter

The pragmatic middle ground, popularized by Cloudflare's write-up on rate limiting at scale: keep only the counts for the current and previous fixed windows, and estimate the number of requests in the last full window by assuming the previous window's requests were evenly spread:

```
estimate = prev_count × (1 − elapsed_fraction_of_current_window) + cur_count
```

If we are 15 seconds into the current minute and the previous minute saw 100 requests, the estimate counts 75 of them. Memory is two counters per key, the boundary burst is almost gone, and the error comes only from the even-distribution assumption. For most API limits that approximation is more than good enough.

## 3. Bucket-based algorithms

Window algorithms answer "how many requests in the last T seconds?". Bucket algorithms instead model a **rate** plus a **burst**, which usually matches what operators actually want: "sustained 10 requests per second, but tolerate short bursts of 20".

### Leaky bucket

Requests enter a queue (the bucket) and are drained at a constant rate; if the queue is full, new requests are dropped. The output is perfectly smooth, which is useful when protecting something that hates bursts. The cost is added latency — requests wait in the queue — and a bounded queue per key. Nginx's `limit_req` is described as a leaky bucket: excess requests up to `burst` are delayed so that they leave at the configured rate, and `nodelay` makes it accept the burst immediately while still accounting for it.

### Token bucket

A bucket holds up to `b` tokens and is refilled at `r` tokens per second. Each request takes one token (or `n` for weighted requests); if there are not enough tokens it is rejected (or waits). Over any interval of length `t`, the number of accepted requests is at most `b + r·t`: bursts up to `b`, long-run rate `r`.

Implementations never run a timer to add tokens. They store `(tokens, last_refill_time)` and refill lazily on each request:

```
tokens = min(b, tokens + (now − last) × r)
```

Token bucket is what `golang.org/x/time/rate`, Guava's `RateLimiter`, Envoy's local rate limit filter and most cloud API quotas use, because rate-plus-burst is easy to explain and cheap to compute.

### GCRA: token bucket with a single timestamp

The **Generic Cell Rate Algorithm** comes from ATM networks (ITU-T I.371). It is mathematically equivalent to a token bucket (a "virtual scheduling" formulation), but stores only one value per key: the **theoretical arrival time** (TAT) — the time at which the bucket would be completely refilled if no more requests arrived.

With emission interval `T = 1/r` and burst tolerance `τ = (b − 1) × T`:

```
tat = max(stored_tat, now)
if now < tat − τ:  reject, retry after (tat − τ − now)
else:              stored_tat = tat + T; allow
```

Why it is attractive for distributed limiting:

- One number per key instead of two, so the state fits naturally in a single Redis string with an expiry.
- No floating point token counts.
- Rejections come with an exact `Retry-After` value for free.

The `redis-cell` module implements GCRA as a single `CL.THROTTLE` command, and many Redis-based limiters use the same idea in Lua.

### Comparison

| Algorithm | State per key | Burst behavior | Accuracy | Typical use |
|---|---|---|---|---|
| Fixed window | 1 counter | up to 2× at boundaries | coarse | simple quotas, daily limits |
| Sliding log | O(limit) timestamps | exact | exact | low limits (login attempts) |
| Sliding window counter | 2 counters | smoothed | approximate | API limits at scale |
| Leaky bucket (queue) | queue | smoothed output, adds latency | exact rate | traffic shaping |
| Token bucket | tokens + timestamp | burst up to `b` | exact | general API/gateway limits |
| GCRA | 1 timestamp | burst up to `b` | exact | distributed limits in Redis |

## 4. Implementations in Go

These three implementations were run with simulated time to check their behavior. Taking `now` as a parameter keeps them deterministic and easy to verify.

```go
package ratelimit

import (
	"math"
	"sync"
	"time"
)

// TokenBucket: capacity b, refill rate r tokens/sec, refilled lazily.
type TokenBucket struct {
	mu       sync.Mutex
	capacity float64
	rate     float64
	tokens   float64
	last     time.Time
}

func NewTokenBucket(rate, capacity float64, now time.Time) *TokenBucket {
	return &TokenBucket{capacity: capacity, rate: rate, tokens: capacity, last: now}
}

func (b *TokenBucket) AllowAt(now time.Time, n float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(b.capacity, b.tokens+elapsed*b.rate)
		b.last = now
	}
	if b.tokens >= n {
		b.tokens -= n
		return true
	}
	return false
}

// GCRA stores only the theoretical arrival time (TAT).
type GCRA struct {
	mu       sync.Mutex
	interval time.Duration // T = 1/rate
	burst    time.Duration // tau = (burst-1) * T
	tat      time.Time
}

func NewGCRA(rate float64, burst int) *GCRA {
	t := time.Duration(float64(time.Second) / rate)
	return &GCRA{interval: t, burst: time.Duration(burst-1) * t}
}

// AllowAt reports whether the request is allowed and, if not, how long to wait.
func (g *GCRA) AllowAt(now time.Time) (bool, time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	tat := g.tat
	if tat.Before(now) {
		tat = now
	}
	allowAt := tat.Add(-g.burst)
	if now.Before(allowAt) {
		return false, allowAt.Sub(now)
	}
	g.tat = tat.Add(g.interval)
	return true, 0
}

// SlidingWindowCounter weights the previous window by how much of it still overlaps.
type SlidingWindowCounter struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	curStart  time.Time
	cur, prev int
}

func (s *SlidingWindowCounter) AllowAt(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	start := now.Truncate(s.window)
	if !start.Equal(s.curStart) {
		if start.Sub(s.curStart) == s.window {
			s.prev = s.cur // the old current window becomes "previous"
		} else {
			s.prev = 0 // more than one window passed
		}
		s.cur, s.curStart = 0, start
	}
	elapsed := float64(now.Sub(start)) / float64(s.window)
	if float64(s.prev)*(1-elapsed)+float64(s.cur)+1 > float64(s.limit) {
		return false
	}
	s.cur++
	return true
}
```

With simulated time, the results are:

- `TokenBucket(rate=10/s, burst=5)`: 8 requests at the same instant yield 5 accepted. 250 ms later the bucket holds 2.5 tokens, so a 2-token request succeeds and the following 1-token request fails.
- `GCRA(rate=10/s, burst=5)`: also 5 of 8 accepted at the same instant, and the rejection reports "retry after 100 ms"; a request at +100 ms is accepted. The behavior matches the token bucket, but the state is a single timestamp.
- `SlidingWindowCounter(limit=100/min)`: 100 requests at second 50 of one minute are accepted; at second 15 of the next minute only 25 more fit, because 75% of the previous window still counts.

In real code you rarely write these yourself. In Go, `golang.org/x/time/rate.Limiter` provides `Allow`, `Wait(ctx)` and `Reserve`; in Java, Guava's `RateLimiter` and Resilience4j's `RateLimiter` cover the in-process case. The value of knowing the algorithms is in choosing parameters and in building the distributed version.

## 5. Distributed rate limiting

A limit of "100 per minute per API key" means nothing if you run 20 gateway replicas that each allow 100. There are three broad strategies.

### Strategy A: divide the limit locally

Give each of `N` instances `limit / N`. No network calls, no shared state, no extra latency. It works when the load balancer spreads each key's traffic evenly, and breaks when it does not: with sticky sessions or few connections per client, a client may hit a single instance and get only `1/N` of its quota. Autoscaling also changes `N` at runtime, so the per-instance share must be recomputed.

### Strategy B: central store (usually Redis)

Every check reads and updates shared state. The key requirement is **atomicity**: a naïve `GET` then `SET` lets two instances read the same value and both allow. Use a single atomic command (`INCR` for fixed windows) or a Lua script, which Redis executes atomically. A GCRA limiter in Lua:

```lua
-- KEYS[1]: limiter key
-- ARGV[1]: emission interval T in ms (1000 / rate)
-- ARGV[2]: burst tolerance tau in ms ((burst - 1) * T)
local interval  = tonumber(ARGV[1])
local tolerance = tonumber(ARGV[2])

local t   = redis.call('TIME')                       -- use the server clock
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local tat = tonumber(redis.call('GET', KEYS[1])) or now
if tat < now then tat = now end

local allow_at = tat - tolerance
if now < allow_at then
  return {0, allow_at - now}                         -- rejected, retry after ms
end

local new_tat = tat + interval
redis.call('SET', KEYS[1], new_tat, 'PX', new_tat - now)
return {1, 0}
```

Design notes:

- **Clock.** Reading time with `redis.call('TIME')` inside the script makes all instances agree on "now", avoiding skew between application servers. If you pass the client time as an argument instead, skewed clocks quietly shift quotas.
- **Expiry.** The key expires exactly when its TAT is in the past, at which point a missing key is equivalent to a full bucket, so idle keys cost no memory.
- **Cluster.** A script must only touch keys in one hash slot. Keep each limiter's state in one key, or use hash tags such as `rl:{tenant42}:search`.
- **Latency and availability.** Every request now costs a round trip to Redis, and Redis becomes a dependency on the hot path. Decide explicitly whether a Redis outage means **fail open** (allow everything; protects availability) or **fail closed** (reject; protects the backend). Most public APIs fail open with a local fallback limiter.

### Strategy C: hybrid — local enforcement, periodic sync

To avoid one network call per request, instances enforce locally and periodically synchronize counts with a central store or with each other, accepting a small overshoot between syncs. Variants include fetching a "lease" of tokens in batches from the central store, or gossiping counters. This is how many large edge and CDN limiters trade exactness for latency: being slightly over a limit for a second is usually acceptable, adding milliseconds to every request is not.

### Local and global together

Envoy makes the split explicit. Its **local rate limit filter** is a per-instance token bucket with no external calls; its **global rate limiting** calls an external gRPC rate limit service (the reference implementation, `envoyproxy/ratelimit`, uses Redis counters) with descriptors such as `(remote_address)` or `(api_key, path)`. The recommended pattern is to use both: local limits absorb large bursts cheaply and protect the global service itself, while global limits enforce per-customer quotas accurately.

## 6. How production systems approach it

- **Nginx** `limit_req_zone` / `limit_req` keep state in shared memory per worker set, keyed by any variable (`$binary_remote_addr`, an API key header). `burst` sets the queue size, `nodelay` serves the burst immediately, and `delay` allows a two-stage mode where part of the burst is immediate and the rest is delayed. `limit_conn` limits concurrent connections, which is a different and often complementary control.
- **Stripe** described running four kinds of limiters in production: a per-user request rate limiter (token bucket in Redis), a concurrent requests limiter, a fleet-wide usage load shedder that reserves capacity for critical traffic, and a worker utilization load shedder that sheds lower-priority traffic first when workers are saturated. The important lesson is that a request rate limit alone was not enough.
- **Cloudflare** described counting requests at the edge with the sliding window counter approximation, choosing two counters per key over exact logs because the memory and CPU savings at their scale outweigh the small estimation error.
- **Cloud APIs** commonly publish token-bucket-style quotas (a sustained rate plus a burst), and **LLM APIs** typically enforce several limits at once, such as requests per minute and tokens per minute, which is just weighted rate limiting with a different cost function.

## 7. Beyond request rates: concurrency and overload

A fixed requests-per-second limit has a fundamental weakness: the right number depends on how expensive requests are and how healthy the system is right now. 1,000 rps may be fine when the database is warm and fatal when a slow query makes every request take ten times longer. Mature systems add controls that respond to the system's actual state.

### Concurrency limits

Little's Law says `in-flight = throughput × latency`. Limiting **in-flight requests** instead of rate automatically adapts: when latency rises, the same concurrency limit admits fewer requests per second. A semaphore around a handler or a bounded connection pool is the simplest version. Concurrency limits also protect against slow clients and slow dependencies, which rate limits do not see.

### Adaptive concurrency limits

Netflix's `concurrency-limits` library applies TCP congestion-control ideas to services: it measures latency, and grows or shrinks the concurrency limit automatically. Its algorithms include AIMD (additive increase, multiplicative decrease on drops/timeouts), and Vegas- and gradient-based variants that compare current latency with a no-load baseline. Envoy has a similar **adaptive concurrency** filter based on a gradient controller. A minimal AIMD controller looks like:

```go
type AIMD struct {
	mu       sync.Mutex
	limit    float64
	inflight int
	min, max float64
}

func (a *AIMD) Acquire() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if float64(a.inflight) >= a.limit {
		return false // shed instead of queueing
	}
	a.inflight++
	return true
}

func (a *AIMD) Release(overloaded bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.inflight--
	if overloaded { // timeout, 503 from downstream, or latency over target
		a.limit = math.Max(a.min, a.limit*0.9)
	} else {
		a.limit = math.Min(a.max, a.limit+1/a.limit) // ~+1 per "window" of requests
	}
}
```

### Client-side adaptive throttling

Google's SRE book ("Handling Overload") describes a client-side technique: each client tracks `requests` and `accepts` over a recent window and rejects locally with probability

```
max(0, (requests − K × accepts) / (requests + 1))
```

With `K = 2`, clients start dropping requests themselves once the backend rejects more than about half, so overloaded backends stop wasting CPU on rejecting traffic. Combined with retry budgets and exponential backoff with jitter, this prevents the classic retry storm in which every rejection turns into three more requests.

### Load shedding and priority

When the system is saturated, the question becomes *which* requests to drop. Tag requests with a priority (critical user-facing, normal, background/batch), shed the lowest first, and reject early — before doing expensive work — with a cheap response. Rejecting requests that have already waited past the client's deadline is especially effective, because the client has given up anyway.

## 8. The API contract

Rate limiting is also part of your API design:

- Return **HTTP 429 Too Many Requests** (defined in RFC 6585) for client quota violations, and 503 for server-side overload, so clients can tell "you are sending too much" from "we are struggling".
- Include **`Retry-After`** (RFC 9110). GCRA computes it exactly; for token buckets it is `(n − tokens) / r`.
- Consider rate limit headers. Many APIs use `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; the IETF HTTPAPI working group is standardizing `RateLimit` and `RateLimit-Policy` fields in a working-group document. Whatever you use, document whether "reset" is a timestamp or a number of seconds.
- Make limits observable: emit metrics for allowed/rejected per key class and per limit, and log rejected keys with sampling. Most "the API is broken" tickets turn out to be a client hitting a limit it did not know about.

## Engineering checklist

1. Pick the key and the cost model first; algorithms are secondary.
2. Use token bucket or GCRA for rate-plus-burst limits; sliding window counter for "N per window" at scale; sliding log only for small limits.
3. In a distributed setup, make updates atomic (Lua or single commands), use one clock, set expiries, and decide fail-open versus fail-closed deliberately.
4. Combine cheap local limits with accurate global ones.
5. Add concurrency limits and load shedding; a request rate alone cannot protect a service whose latency changes.
6. Teach clients to back off: 429 with `Retry-After`, exponential backoff with jitter, retry budgets.
7. Verify limiters with simulated time, and load-check the whole path including the limiter's own dependencies.

## Summary

Fixed windows are cheap but allow double bursts at boundaries; sliding logs are exact but expensive; the sliding window counter approximates a rolling window with two counters. Token buckets express what operators usually want — a sustained rate with a bounded burst — and GCRA gives the same behavior with a single timestamp, which makes it ideal for Redis. Distributed limiting is mostly about atomicity, clocks and the latency/accuracy trade-off between local and global enforcement. And because capacity depends on latency, robust systems pair rate limits with concurrency limits, adaptive throttling and prioritized load shedding.

## References

- Cloudflare blog, "How we built rate limiting capable of scaling to millions of domains" (2017): https://blog.cloudflare.com/counting-things-a-lot-of-different-things/
- Stripe blog, "Scaling your API with rate limiters" (2017): https://stripe.com/blog/rate-limiters
- Nginx `ngx_http_limit_req_module` documentation: https://nginx.org/en/docs/http/ngx_http_limit_req_module.html
- Envoy documentation, local and global rate limiting: https://www.envoyproxy.io/docs (Rate limiting: local and global)
- `envoyproxy/ratelimit`: https://github.com/envoyproxy/ratelimit
- `golang.org/x/time/rate`: https://pkg.go.dev/golang.org/x/time/rate
- `redis-cell` (GCRA in Redis): https://github.com/brandur/redis-cell
- Netflix `concurrency-limits`: https://github.com/Netflix/concurrency-limits
- Google SRE book, "Handling Overload": https://sre.google/sre-book/handling-overload/
- RFC 6585 (429 Too Many Requests): https://www.rfc-editor.org/rfc/rfc6585
- RFC 9110 (HTTP Semantics, `Retry-After`): https://www.rfc-editor.org/rfc/rfc9110
- IETF HTTPAPI working group, "RateLimit header fields for HTTP": https://datatracker.ietf.org/wg/httpapi/documents/
