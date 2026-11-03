---
title: "深入限流：令牌桶、GCRA、滑动窗口、分布式限流与自适应并发控制"
tag: architecture
description: 经典限流算法到底如何工作——固定窗口、滑动日志、滑动窗口计数、漏桶、令牌桶与 GCRA，附经过运行验证的 Go 实现和原子化的 Redis Lua 限流脚本，本地限流与全局限流的取舍，Nginx、Envoy、Stripe、Cloudflare 的做法，以及为什么成熟系统要在请求速率之上再叠加并发限制、自适应节流和负载削减
date: "2026-11-03T11:20:00.000Z"
---

## 目标

每个公开 API、网关和共享后端，迟早都要学会说"不"。限流保护服务免受恶意客户端的冲击，防止单个租户饿死其他人，阻止重试风暴，也避免下游依赖被压垮。它看起来很简单——"每分钟最多 100 个请求"——但细节决定了限流器是否公平、是否廉价、在多台服务器之间是否准确，以及在过载时是否真的有用。

本文内容：

1. 我们到底在限什么、在哪里限。
2. 基于窗口的算法：固定窗口、滑动日志、滑动窗口计数。
3. 基于桶的算法：漏桶、令牌桶和 GCRA。
4. 其中最实用的三种算法的 Go 实现。
5. 分布式限流：Redis、原子性、时钟问题、本地与全局。
6. 真实系统的做法：Nginx、Envoy、Stripe、Cloudflare，以及 Go 和 Guava 的库。
7. 超越请求速率：并发限制、自适应节流与负载削减。
8. API 约定：429、`Retry-After` 和限流响应头。

## 1. 限什么，在哪里限？

选算法之前，先回答三个问题。

**键（key）。** 限制总是"按某个维度"：按 API Key、按用户、按 IP、按租户、按接口，或者组合，如 `(tenant, endpoint)`。选键是产品决策。按 IP 限流会误伤 NAT 或公司代理后面的用户；按用户限流挡不住注册大量账号的攻击者。生产系统通常会叠加多层限制：边缘按 IP 的宽松限制、网关按 API Key 的限制，以及昂贵接口上按租户的限制。

**成本（cost）。** 请求并不等价。一次扇出到 50 个分片的搜索和一次健康检查完全不同。因此很多限流器支持*加权*请求（"这次调用消耗 5 个令牌"），或者干脆限制别的资源，比如字节数、扫描行数，或者每分钟的 LLM token 数。

**位置（place）。** 限流可以在客户端（主动退避）、边缘/CDN、API 网关或 sidecar、服务内部，或者某个具体依赖之前（比如数据库连接池）执行。越靠前越便宜——被拒绝的流量消耗的资源更少；越靠后则越清楚请求的真实成本和系统当前的健康状况。

## 2. 基于窗口的算法

### 固定窗口

把时间切成窗口（例如每个自然分钟），每个键每个窗口一个计数器，超过上限就拒绝。

```
key = "rl:{user}:{floor(now/60)}"
count = INCR key; EXPIRE key 60
allow = count <= 100
```

这是最便宜的算法——一个计数器、一次原子自增——所以在简单网关中很常见。它的缺陷是**边界突发**：客户端可以在 12:00:59 发 100 个请求，在 12:01:00 再发 100 个，也就是两秒内 200 个请求，却从未违反"每分钟 100 个"的规则。而且所有客户端的窗口是对齐的，大量客户端在同一秒重置配额，会造成惊群效应。

### 滑动日志

记录每个被接受请求的时间戳（比如放在 Redis 有序集合里），丢弃窗口之外的时间戳，剩余数量小于上限就放行。它是精确的——没有边界效应——但每个键的内存是 O(limit)，每次检查都要触碰很多条目。对"15 分钟内最多 5 次密码尝试"这种低上限很合适，对数百万个键上的"每分钟 10,000 次"就太贵了。

### 滑动窗口计数

这是务实的折中方案，Cloudflare 在介绍其大规模限流的文章中推广了这种做法：只保留当前窗口和上一个固定窗口的计数，并假设上一个窗口的请求是均匀分布的，以此估算最近一个完整窗口内的请求数：

```
estimate = prev_count × (1 − 当前窗口已过去的比例) + cur_count
```

如果当前分钟已经过了 15 秒，上一分钟有 100 个请求，那么估算值会计入其中的 75 个。每个键只需要两个计数器，边界突发几乎消失，误差只来自均匀分布的假设。对大多数 API 限制而言，这个近似已经足够好。

## 3. 基于桶的算法

窗口算法回答的是"过去 T 秒有多少请求？"。桶算法则建模为一个**速率**加一个**突发量**，这通常更符合运维真正想要的语义："持续每秒 10 个请求，但能容忍 20 个的短时突发"。

### 漏桶

请求进入一个队列（桶），以恒定速率流出；队列满了，新请求就被丢弃。输出完全平滑，适合保护那些讨厌突发的东西。代价是额外延迟——请求要在队列里等待——以及每个键一个有界队列。Nginx 的 `limit_req` 就被描述为漏桶：在 `burst` 以内的超额请求会被延迟，使其按配置速率离开；`nodelay` 则让它立即接受这批突发，同时仍然把它们计入额度。

### 令牌桶

桶里最多有 `b` 个令牌，以每秒 `r` 个的速度补充。每个请求拿走一个令牌（加权请求拿 `n` 个）；令牌不够就拒绝（或等待）。在任意长度为 `t` 的时间段内，被接受的请求数至多为 `b + r·t`：突发最多 `b`，长期速率为 `r`。

实现中从不会真的跑一个定时器去加令牌，而是保存 `(tokens, last_refill_time)`，在每次请求时惰性补充：

```
tokens = min(b, tokens + (now − last) × r)
```

`golang.org/x/time/rate`、Guava 的 `RateLimiter`、Envoy 的本地限流过滤器以及大多数云 API 配额用的都是令牌桶，因为"速率 + 突发"容易解释，计算也便宜。

### GCRA：只需一个时间戳的令牌桶

**通用信元速率算法（Generic Cell Rate Algorithm）** 源自 ATM 网络（ITU-T I.371）。它在数学上等价于令牌桶（一种"虚拟调度"的表述），但每个键只存一个值：**理论到达时间**（TAT，theoretical arrival time）——即在不再有新请求的情况下，桶被完全补满的时刻。

设发射间隔 `T = 1/r`，突发容忍度 `τ = (b − 1) × T`：

```
tat = max(stored_tat, now)
if now < tat − τ:  拒绝，(tat − τ − now) 之后重试
else:              stored_tat = tat + T；放行
```

它特别适合分布式限流的原因：

- 每个键只有一个数而不是两个，状态天然可以放进一个带过期时间的 Redis 字符串。
- 没有浮点数的令牌计数。
- 拒绝时顺便就得到了精确的 `Retry-After`。

`redis-cell` 模块把 GCRA 实现为一个 `CL.THROTTLE` 命令，许多基于 Redis 的限流器也用 Lua 实现同样的思路。

### 对比

| 算法 | 每键状态 | 突发行为 | 准确度 | 典型场景 |
|---|---|---|---|---|
| 固定窗口 | 1 个计数器 | 边界处最多 2 倍 | 粗糙 | 简单配额、每日上限 |
| 滑动日志 | O(limit) 个时间戳 | 精确 | 精确 | 低上限（登录尝试） |
| 滑动窗口计数 | 2 个计数器 | 平滑 | 近似 | 大规模 API 限流 |
| 漏桶（队列） | 队列 | 输出平滑、增加延迟 | 速率精确 | 流量整形 |
| 令牌桶 | 令牌数 + 时间戳 | 突发至多 `b` | 精确 | 通用 API/网关限流 |
| GCRA | 1 个时间戳 | 突发至多 `b` | 精确 | Redis 中的分布式限流 |

## 4. Go 实现

下面三个实现都用模拟时间运行过以验证行为。把 `now` 作为参数传入，使它们结果确定、便于验证。

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

用模拟时间运行的结果：

- `TokenBucket(rate=10/s, burst=5)`：同一时刻 8 个请求，接受 5 个。250 ms 后桶里有 2.5 个令牌，所以一个消耗 2 个令牌的请求成功，紧接着消耗 1 个令牌的请求失败。
- `GCRA(rate=10/s, burst=5)`：同一时刻 8 个请求同样接受 5 个，拒绝时报告"100 ms 后重试"；+100 ms 时的请求被接受。行为与令牌桶一致，但状态只有一个时间戳。
- `SlidingWindowCounter(limit=100/min)`：在某一分钟的第 50 秒发出的 100 个请求全部接受；到下一分钟的第 15 秒只能再放进 25 个，因为上一个窗口仍有 75% 被计入。

实际代码里很少需要自己写这些。Go 里 `golang.org/x/time/rate.Limiter` 提供了 `Allow`、`Wait(ctx)` 和 `Reserve`；Java 里 Guava 的 `RateLimiter` 和 Resilience4j 的 `RateLimiter` 覆盖了进程内场景。理解算法的价值在于选参数，以及构建分布式版本。

## 5. 分布式限流

如果你跑了 20 个网关副本，每个都放行 100 个，那"每个 API Key 每分钟 100 个"就毫无意义。大致有三种策略。

### 策略 A：本地均分

给 `N` 个实例每个分 `limit / N`。没有网络调用、没有共享状态、没有额外延迟。当负载均衡把每个键的流量均匀打散时它是可行的；不均匀时就会出问题：在会话粘滞或者客户端连接很少的情况下，一个客户端可能只打到一个实例，只能拿到配额的 `1/N`。自动扩缩容还会在运行时改变 `N`，每实例的份额必须重新计算。

### 策略 B：中心存储（通常是 Redis）

每次检查都读写共享状态。核心要求是**原子性**：先 `GET` 再 `SET` 的朴素写法会让两个实例读到同一个值并都放行。要用单条原子命令（固定窗口用 `INCR`）或者 Lua 脚本，Redis 会原子地执行脚本。一个用 Lua 实现的 GCRA 限流器：

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

设计要点：

- **时钟。** 在脚本里用 `redis.call('TIME')` 读时间，所有实例对"现在"达成一致，避免应用服务器之间的时钟偏差。如果改成把客户端时间作为参数传入，时钟偏差会悄悄地改变配额。
- **过期。** 键恰好在其 TAT 成为过去时过期，而此时键不存在就等价于满桶，所以空闲的键不占内存。
- **集群。** 一个脚本只能访问同一个哈希槽中的键。让每个限流器的状态只占一个键，或者使用 hash tag，如 `rl:{tenant42}:search`。
- **延迟与可用性。** 现在每个请求都要多一次到 Redis 的往返，Redis 也成了热路径上的依赖。要明确决定 Redis 故障时是**失败放行**（全部放行，保可用性）还是**失败拒绝**（全部拒绝，保后端）。大多数公开 API 选择失败放行，并配一个本地兜底限流器。

### 策略 C：混合——本地执行、定期同步

为了避免每个请求都走一次网络，各实例在本地执行限流，并定期与中心存储或彼此同步计数，接受同步间隔内的少量超额。变体包括从中心存储批量"租用"一批令牌，或者通过 gossip 传播计数。许多大型边缘和 CDN 限流器就是这样用精确度换延迟的：超额一秒钟通常可以接受，给每个请求增加几毫秒则不行。

### 本地与全局结合

Envoy 把这种拆分做得很明确。它的**本地限流过滤器**是每实例一个令牌桶，没有外部调用；**全局限流**则调用外部的 gRPC 限流服务（参考实现 `envoyproxy/ratelimit` 使用 Redis 计数），描述符可以是 `(remote_address)` 或 `(api_key, path)` 等。推荐的模式是两者并用：本地限流廉价地吸收大规模突发，同时保护全局限流服务本身；全局限流则准确地执行每个客户的配额。

## 6. 生产系统怎么做

- **Nginx** 的 `limit_req_zone` / `limit_req` 把状态放在 worker 共享内存里，键可以是任意变量（`$binary_remote_addr`、某个 API Key 请求头）。`burst` 设置队列大小，`nodelay` 立即处理突发，`delay` 则支持两段式：一部分突发立即处理，其余延迟。`limit_conn` 限制并发连接数，这是另一种、且常常互补的控制手段。
- **Stripe** 介绍过他们在生产中运行的四类限流器：按用户的请求速率限流器（Redis 中的令牌桶）、并发请求限流器、为关键流量预留容量的全局用量负载削减器，以及在 worker 饱和时优先削减低优先级流量的 worker 利用率负载削减器。重要的教训是：仅靠请求速率限流是不够的。
- **Cloudflare** 介绍过在边缘使用滑动窗口计数近似来统计请求，宁可每个键用两个计数器而不是精确日志，因为在他们的规模下，节省的内存和 CPU 远比那一点估算误差重要。
- **云 API** 通常公布令牌桶式的配额（持续速率加突发量），**LLM API** 则通常同时执行多个限制，比如每分钟请求数和每分钟 token 数，这本质上就是换了成本函数的加权限流。

## 7. 超越请求速率：并发与过载

固定的每秒请求数限制有一个根本弱点：合适的数值取决于请求有多贵，以及系统此刻有多健康。数据库热的时候 1,000 rps 也许没问题；一条慢查询让每个请求都慢十倍时，同样的 1,000 rps 就是致命的。成熟系统会增加能响应系统真实状态的控制手段。

### 并发限制

Little 定律告诉我们：`在途请求数 = 吞吐量 × 延迟`。限制**在途请求数**而不是速率，就能自动适应：延迟上升时，同样的并发上限每秒放进的请求更少。在处理函数外套一个信号量，或者使用有界连接池，就是最简单的形式。并发限制还能防住慢客户端和慢依赖，而这些是速率限制看不到的。

### 自适应并发限制

Netflix 的 `concurrency-limits` 库把 TCP 拥塞控制的思想用到了服务上：它测量延迟，自动增大或缩小并发上限。算法包括 AIMD（加性增、在丢弃/超时时乘性减），以及基于 Vegas 和梯度的变体——把当前延迟与空载基线比较。Envoy 也有类似的**自适应并发**过滤器，基于梯度控制器。一个最小的 AIMD 控制器如下：

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

### 客户端自适应节流

Google SRE 书的"Handling Overload"一章介绍了一种客户端技术：每个客户端统计最近一段时间内的 `requests` 和 `accepts`，并以如下概率在本地直接拒绝：

```
max(0, (requests − K × accepts) / (requests + 1))
```

当 `K = 2` 时，一旦后端拒绝了大约一半以上的请求，客户端就会开始自行丢弃请求，过载的后端也就不必再把 CPU 浪费在拒绝流量上。配合重试预算和带抖动的指数退避，就能防止经典的重试风暴——每一次拒绝又变成三次新请求。

### 负载削减与优先级

系统饱和时，问题变成了丢弃*哪些*请求。给请求打上优先级（关键的用户请求、普通请求、后台/批处理），先削减最低优先级的；并且尽早拒绝——在做昂贵工作之前就用一个廉价的响应返回。拒绝那些已经等待超过客户端截止时间的请求尤其有效，因为客户端反正已经放弃了。

## 8. API 约定

限流也是 API 设计的一部分：

- 客户端超出配额时返回 **HTTP 429 Too Many Requests**（定义于 RFC 6585），服务端过载时返回 503，让客户端能区分"你发得太多"和"我们扛不住了"。
- 带上 **`Retry-After`**（RFC 9110）。GCRA 能精确算出它；对令牌桶来说它是 `(n − tokens) / r`。
- 考虑限流响应头。很多 API 使用 `X-RateLimit-Limit`、`X-RateLimit-Remaining` 和 `X-RateLimit-Reset`；IETF HTTPAPI 工作组正在一份工作组文档中标准化 `RateLimit` 和 `RateLimit-Policy` 字段。不管用哪种，都要在文档里写清楚"reset"是时间戳还是秒数。
- 让限流可观测：按键类别和限制规则输出放行/拒绝指标，对被拒绝的键做采样日志。大多数"API 坏了"的工单，最后都发现是客户端撞上了一个它不知道的限制。

## 工程清单

1. 先确定键和成本模型，算法是其次。
2. "速率 + 突发"语义用令牌桶或 GCRA；大规模的"每窗口 N 次"用滑动窗口计数；滑动日志只用于小上限。
3. 分布式环境下，保证更新原子（Lua 或单条命令）、使用同一个时钟、设置过期时间，并有意识地选择失败放行还是失败拒绝。
4. 把廉价的本地限流和准确的全局限流结合起来。
5. 增加并发限制和负载削减；对于延迟会变化的服务，单靠请求速率保护不了它。
6. 教会客户端退避：429 加 `Retry-After`、带抖动的指数退避、重试预算。
7. 用模拟时间验证限流器，并对包括限流器自身依赖在内的整条链路做压测。

## 总结

固定窗口便宜，但会在边界处放出双倍突发；滑动日志精确但昂贵；滑动窗口计数用两个计数器近似滚动窗口。令牌桶表达了运维通常想要的语义——持续速率加有界突发——而 GCRA 用一个时间戳实现了同样的行为，非常适合放在 Redis 里。分布式限流的核心在于原子性、时钟，以及本地与全局执行之间在延迟和准确度上的取舍。又因为容量取决于延迟，健壮的系统会把速率限制与并发限制、自适应节流和按优先级的负载削减结合起来。

## 参考资料

- Cloudflare 博客，"How we built rate limiting capable of scaling to millions of domains"（2017）：https://blog.cloudflare.com/counting-things-a-lot-of-different-things/
- Stripe 博客，"Scaling your API with rate limiters"（2017）：https://stripe.com/blog/rate-limiters
- Nginx `ngx_http_limit_req_module` 文档：https://nginx.org/en/docs/http/ngx_http_limit_req_module.html
- Envoy 文档，本地与全局限流：https://www.envoyproxy.io/docs (Rate limiting: local and global)
- `envoyproxy/ratelimit`：https://github.com/envoyproxy/ratelimit
- `golang.org/x/time/rate`：https://pkg.go.dev/golang.org/x/time/rate
- `redis-cell`（Redis 中的 GCRA）：https://github.com/brandur/redis-cell
- Netflix `concurrency-limits`：https://github.com/Netflix/concurrency-limits
- Google SRE 书，"Handling Overload"：https://sre.google/sre-book/handling-overload/
- RFC 6585（429 Too Many Requests）：https://www.rfc-editor.org/rfc/rfc6585
- RFC 9110（HTTP Semantics，`Retry-After`）：https://www.rfc-editor.org/rfc/rfc9110
- IETF HTTPAPI 工作组，"RateLimit header fields for HTTP"：https://datatracker.ietf.org/wg/httpapi/documents/
