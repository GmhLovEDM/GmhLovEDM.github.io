---
title: "深入重试风暴：超时、指数退避、抖动、重试预算，以及重试为何把小故障放大成宕机"
tag: architecture
description: 为什么每一次重试都是一个负载决策——客户端超时与延迟执行如何制造无用功，带上限的指数退避能解决什么、不能解决什么，全抖动、等抖动与去相关抖动，多层重试的乘法放大，亚稳态故障以及重试在其中扮演的角色，Google SRE、Finagle、Envoy、gRPC 与 AWS SDK（包括 2026 年 11 月的默认行为变更）所用的重试预算，客户端自适应限流，服务端回压、截止时间传递、幂等与对冲请求，再加上一个可运行模型：一次 30 个时间片的容量下跌，如果重试没有预算，就会变成永久宕机
date: "2026-11-28T11:50:00.000Z"
---

## 目标

重试是你能加上的最便宜的可靠性特性。连接被重置、节点重启、丢了一个包，再试一次，用户看到的错误就变成了一次稍慢的成功。几乎每个 RPC 库、服务网格和云 SDK 都默认打开了重试。

重试同时也是一个决定：向一个刚刚用失败告诉你"出事了"的系统发送更多负载。如果失败只是随机的小抖动，这个决定是对的：第二次尝试落在健康的路径上，额外负载可以忽略不计。如果失败是过载造成的，同一个决定就会把负载成倍地压到那个本就缺容量的组件上。周二帮你挡掉一台坏主机的重试策略，恰恰也是让整个区域在一次短暂容量下跌之后一直起不来的那个策略。

这不是纸上谈兵。Huang 等人研究了 11 个组织的 22 次亚稳态故障，发现重试策略是最常见的维持效应，出现在一半以上的事故中。Marc Brooker 那篇被广泛引用的 AWS 退避与抖动文章、Google SRE 书中关于过载的章节、gRPC 的重试设计、Envoy 的重试预算、AWS SDK 的重试配额，用不同的话回答的是同一个问题：**怎样在小故障时保住重试的好处，又不在过载时为它买单？**

本文会讲到：

1. 为什么重试是一个负载决策，以及这里说的"自私"是什么意思。
2. 超时：重试从哪里来，为什么一个已经超时的请求往往仍然会被执行。
3. 带上限的指数退避，以及它解决不了的问题。
4. 抖动：全抖动、等抖动和去相关抖动，以及真实的库默认用什么。
5. 多层重试与乘法放大。
6. 亚稳态故障：触发因素、脆弱状态与维持效应。
7. Google SRE、Finagle、Envoy、gRPC 和 AWS SDK 中的重试预算。
8. 客户端自适应限流。
9. 服务端配合：回压、`Retry-After`、截止时间传递与负载卸除。
10. 什么可以安全地重试：幂等、状态码与对冲请求。
11. 权衡。
12. 一个可运行模型，以及它的真实输出。

## 1. 重试是一个负载决策

Brooker 在 Builders' Library 的文章里用一个词概括：重试是**自私的**。一个重试的客户端，花费服务器更多的时间来提高自己成功的机会。当失败罕见且相互独立时，额外的时间很少，这笔交易非常划算。当失败与负载相关——因为服务器变慢了、队列变长了、它的依赖饱和了——每一次重试都在给正在失败的那个资源加压。

把算术写下来会更清楚。如果每次尝试的失败概率为 `p`，客户端最多尝试 `n` 次，那么每个逻辑请求的期望尝试次数是

```
E[attempts] = 1 + p + p^2 + ... + p^(n-1) = (1 - p^n) / (1 - p)
```

当 `p = 0.01`、`n = 3` 时，结果是 1.0101：大约 1% 的额外负载，换来把 1% 的失败率压到大约百万分之一。当 `p = 0.9`——一台过载的服务器拒绝了大多数请求——结果是 2.71：本已在失败的服务器现在收到正常流量的 2.71 倍，而客户端看到的失败率仍有 73%（`0.9^3`）。当 `p = 1` 时，结果正好是 `n`。

所以同一个策略，会因为尝试失败的原因不同而产生截然相反的效果。本文余下部分讲的就是如何区分这两种情况，或者在无法区分时至少把伤害封顶。

## 2. 先说超时

大多数重试不是由明确的错误触发的，而是由**超时**触发：客户端等不下去了。超时有两个性质让它变得危险。

**超时不能说明工作有没有发生。** 请求可能根本没到，可能在队列里排着，可能此刻正在执行，也可能已经完成但响应丢了。Brooker 的文章就副作用强调了这一点：超时或失败并不意味着副作用没有发生，所以不幂等的 API 不能盲目重试。

**服务器通常不知道客户端已经走了。** 除非传递了截止时间，否则一个在客户端已经超时的请求仍然排在服务器的队列里，服务器稍后还会在它身上花真实的 CPU，然后发出一个没人读的响应。在过载期间，这正是问题的核心：队列里塞满了客户端早已放弃、并且已经重新发送了一份的尝试。服务器很忙，吞吐量看起来没问题，可它的**有效吞吐（goodput）**——及时完成、真正有用的工作——是零。

超时怎么选，本身就是权衡。Amazon 的做法是先确定可接受的误超时率（例如 0.1%），再把超时设在下游延迟的对应分位（这个例子里是 p99.9），对公网上的客户端再额外留出余量。超时太短，会把一次小的延迟上升变成一波重试；Huang 等人引用了一次 AWS 事故，其中过小的握手超时既是引发过载的原因之一，也是维持过载的原因之一。超时太长，又会占住客户端资源、掩盖真实的故障。

实践中的规则：

- 与其在每一跳设置相互独立的超时，不如让一个端到端的**截止时间（deadline）**随请求一起传递（gRPC deadline，或者各服务约定的一个请求头）。重试必须塞进剩余的截止时间里，而不是重置它。gRPC 的设计明确规定，调用的截止时间适用于整条重试或对冲尝试链。
- 让服务器在做昂贵的工作之前**检查截止时间**，丢弃已经过期的请求。一次廉价的检查把过期请求扔掉，决定了队列是能排空，还是会吃掉自己的容量。

## 3. 带上限的指数退避

每个人首先想到的修复是：重试之前先等一等，而且每次等得更久：

```
sleep = min(cap, base * 2 ** attempt)
```

退避把单个客户端的尝试在时间上摊开，给瞬时问题——正在重启的进程、一次故障切换、满了的连接池——留出恢复的时间。它是必要的，但并不充分，原因有两个。

**退避推迟了重试，而不是取消了重试。** 最多三次尝试时，每个失败的逻辑请求总共仍然会发出三次尝试。等得更久只是把额外负载挪到后面；只有当故障在重试发出之前结束，或者客户端因为整体截止时间先放弃了，它才会真正减少负载。在本文末尾的模型里，三次尝试加上普通指数退避，和立即重试一样陷入卡死状态：每个时间片约 235 次的提交负载，对着 100 的容量。

**同步的退避会产生同步的重试。** 如果很多客户端在同一时刻失败——因为同一台服务器重启了——它们都等 `base`，然后 `2*base`，然后 `4*base`，又都在同一时刻回来。Brooker 对高竞争乐观并发控制的模拟正好展示了这一点：只有退避时，调用会聚成一簇一簇，中间是静默，总工作量几乎没有减少。

## 4. 抖动

解决同步问题的办法是随机性。Brooker 2015 年的文章把三种变体与普通退避做了对比：

```
# Full Jitter（全抖动）
sleep = random_between(0, min(cap, base * 2 ** attempt))

# Equal Jitter（等抖动）
temp  = min(cap, base * 2 ** attempt)
sleep = temp / 2 + random_between(0, temp / 2)

# Decorrelated Jitter（去相关抖动）
sleep = min(cap, random_between(base, sleep * 3))
```

在他的模拟里，三种带抖动的变体相比不带抖动的退避都大幅减少了调用次数——在 100 个客户端竞争时减少了一半以上——不带抖动的版本在工作量和完成时间上都明显落败。在带抖动的变体之间，全抖动和等抖动的工作量相近，等抖动耗时更长，全抖动与去相关抖动之间的取舍则不那么分明。他也指出，这些方法都没有改变 N 个客户端竞争同一行时 `N^2` 的工作量本质；抖动减小的是常数，而不是形状。

生产中的库实际是怎么做的：

| 库 | 默认值 | 抖动 |
|---|---|---|
| gRPC 重试策略（gRFC A6） | `initialBackoff`、`maxBackoff`、`backoffMultiplier` 在 service config 中设置；`maxAttempts` 默认上限为 5 | `min(initialBackoff * multiplier^(n-1), maxBackoff) * random(0.8, 1.2)` |
| Envoy router | 基础间隔 25 ms，最大间隔为基础的 10 倍（250 ms）；默认重试 1 次 | "完全抖动"：第 N 次重试在 `[0, (2^N - 1) * base)` 内等待，即 0–24 ms、0–74 ms、0–174 ms |
| AWS SDK（standard 模式，2026 行为） | 3 次尝试；瞬时错误基础延迟 50 ms，限流错误 1,000 ms；上限 20 s | 全抖动：`random(0, 1) * min(20 s, base * 2^retry)` |

注意 gRPC 的 ±20% 抖动和全抖动之间的区别。±20% 能让一起失败的客户端错开，但每个客户端都仍贴近名义上的时间表；全抖动则把它们撒到整个区间里，包括非常短的等待。Envoy 和 AWS SDK 用的是全抖动。不过，对本文最关心的过载场景而言，抖动选*多少*远不如重试*有没有预算*重要。

## 5. 多层重试会相乘

真实的请求要穿过好几个服务。如果每一层都独立重试，尝试次数就会相乘。Brooker 举的例子是一个五层深、最底下是数据库的调用栈，每层尝试三次：当数据库在负载下开始失败时，它收到的流量最多可以放大 `3^5 = 243` 倍。

```
depth 1:   3
depth 2:   9
depth 3:  27
depth 4:  81
depth 5: 243
```

Amazon 和 Google 得出了同样的规则。Amazon 对低成本控制面和数据面操作的最佳实践，是只在调用栈的一个位置重试。Google 的 SRE 书说，请求只应该在拒绝它的那一层的紧邻上一层重试；一旦这一层放弃，就返回"overloaded; don't retry"（过载，不要重试）的错误，免得再上面的各层再各自开始一轮。因此重试策略是**调用图**的属性，而不是某一个客户端库的属性——这也是服务网格适合承载它的原因之一，因为网格能看到每一跳。

## 6. 亚稳态故障

Bronson、Aghayev、Charapko 和 Zhu（HotOS 2021）给这种危险的情形起了名字。**亚稳态故障（metastable failure）**发生在负载来源不受控的开放系统中：一个**触发因素**把系统推入坏状态，而这个状态**在触发因素消失之后依然持续**，因为一种**维持效应**——往往是工作放大——让有效吞吐一直低到不可用。要离开这个状态，需要一次强有力的纠正，比如大幅降低负载或重启系统。

他们的框架里有三种状态：

- **稳定**：触发因素造成一次暂时的下跌，系统自己能恢复。
- **脆弱**：系统是健康的——常常一健康就是几个月——但足够大的触发因素会把它推倒。很多生产系统有意运行在这里，因为这样效率更高。
- **亚稳态**：反馈回路在没有任何额外推动的情况下维持着过载。

重试是教科书式的维持效应。容量下跌让队列变长；排队延迟超过客户端超时；客户端放弃并重发；服务器继续执行被放弃的尝试；额外的尝试让队列更长；回路就此闭合。触发因素可能早已消失一个小时，系统依然起不来。论文还指出，这类宕机一开始常常被归咎于触发因素，而真正的根因是维持效应。

OSDI 2022 的后续论文 *Metastable Failures in the Wild* 研究了公开的事故报告，在 11 个组织中找到 22 次亚稳态故障；过去十年 AWS 的 15 次重大宕机中，至少有 4 次是亚稳态故障。重试策略是最常见的维持效应（一半以上的事故），而直接的负载卸除是最常见的缓解手段（超过 55% 的案例）。这正是接下来两节的动机：**在事故发生之前**就让放大有界，这样恢复就不需要有人手动找到并排空那个回路。

## 7. 重试预算

重试预算按**流量的比例**来限制重试，而不是按单个请求。按请求的上限（"最多 3 次尝试"）在全部失败时仍然允许流量翻三倍。预算说的是：重试在总量上最多只能增加比如 10% 或 20% 的负载。失败罕见时，预算根本用不到；全面失败时，它会很快耗尽，重试随之停止。

**Google SRE。** SRE 书的 "Handling Overload" 一章描述了两层：每个请求最多三次尝试；以及每个客户端的预算——只有当该客户端的重试占请求的比例低于 10% 时才重试。只有按请求的上限时，最坏情况下流量会增长到接近 3X；再加上 10% 的比例，一般情况下就降到 1.1X。服务端还会查看请求元数据里的重试计数，当某个后端看到过多重试时，返回"overloaded; don't retry"。

**Finagle。** Twitter 的 `RetryBudget` 默认允许大约 20% 的请求被重试，外加每秒 10 次的最低保底，照顾刚启动或流量很小的客户端。存入的额度在 10 秒 TTL 后过期，因此预算反映的是最近的流量。

**Envoy。** 集群的断路器阈值里可以配置 `retry_budget`：活跃重试数被限制在活跃请求与等待请求之和的 `budget_percent`（默认 20%）以内，且永远不低于 `min_retry_concurrency`（默认 3）。这是一种并发预算——它限制的是在途的重试数，而不是在一个窗口里计数——很适合一个本就按集群跟踪活跃请求的代理。

**gRPC。** gRFC A6 为每个服务器名定义了 `retryThrottling`：`token_count` 初始为 `maxTokens`（示例用 10，合法范围最大到 1000）。每个失败的 RPC 减 1，每个成功的 RPC 加 `tokenRatio`（示例为 0.1）。当计数小于或等于 `maxTokens / 2` 时，重试和对冲都会停止，直到它重新升上去。在 `tokenRatio = 0.1` 时，一旦储备用完，大致是每十次成功才允许一次重试。只有可重试的失败（或回压）才计数，所以一连串 `INVALID_ARGUMENT` 不会关掉重试。

**AWS SDK。** SDK 的 standard 重试模式包含一个**重试配额（retry quota）**，是一个 500 令牌的令牌桶。Amazon 在 2016 年就把本地重试令牌桶加进了 AWS SDK，作为断路器的替代方案——它认为断路器引入了难以推理的模态行为。更新后的行为在 2026 年 5 月以可选开启的方式公布，并于 **2026 年 11 月 10 日**在大多数 SDK 中成为默认（Java 2.x 2.58.0、botocore 1.44.0、Go v2 v1.48.0、JavaScript v3 3.1166.0、AWS CLI 2.40.0 等；Kotlin 尚待公布），设定如下：

- 瞬时错误基础延迟 50 ms，限流错误 1,000 ms，全抖动，上限 20 s，3 次尝试；
- 每次瞬时重试消耗 **14** 个令牌（此前为 5，超时为 10），每次限流重试消耗 5 个；
- 一次成功的重试退还它自己的消耗；首次尝试即成功的请求增加 1 个令牌；
- 桶空时，SDK 直接返回错误而不再重试。

AWS 文档算过：在 3 次尝试下，当超过约 22% 的请求遭遇持续的瞬时失败（限流约为 32%）时，桶开始被耗尽；低于这个比例时，首次成功的回填比重试的消耗更快。把瞬时重试的成本从 5 提到 14，是有意让配额在持续性宕机中更早生效，同时仍让 500 个令牌的储备吸收短暂的尖峰。

这些设计形态各异——窗口内的比例、并发的比例、令牌桶——但它们都具备最关键的那个性质：**重试带来的额外总负载被一个小常数封顶，与失败率无关。**

## 8. 客户端自适应限流

重试预算限制的是*重试*。在严重过载时，连首次尝试都可能太多了，尤其当服务器拒绝一个请求的成本几乎和处理它一样高的时候。Google 的 SRE 书描述了**自适应限流（adaptive throttling）**：每个客户端记录过去两分钟内应用发起的 `requests` 数和后端接受的 `accepts` 数。新请求以如下概率在本地直接拒绝，根本不上网络：

```
p_reject = max(0, (requests - K * accepts) / (requests + 1))
```

当 `K = 2` 时，客户端会一直发送，直到请求数约为接受数的两倍，因此后端最终大约每处理一个请求就拒绝一个。降低 `K`（比如到 1.1）让限流更激进，浪费的后端容量更少；Google 通常更喜欢 2，因为多放一些请求过去，客户端能更快察觉后端已经恢复。这个决定只用到本地信息，不增加依赖，也不增加延迟。

问题出在窗口上。在下面的模型里，60 个时间片窗口的自适应限流确实打破了重试回路——队列被清空了——但拒绝概率在触发因素结束后很久都居高不下，第 200–299 个时间片的有效吞吐平均只有 7.5，直到第 550 个时间片才回到正常的 95%。窗口改成 20 个时间片时，第 212 个时间片就恢复了。记忆长，稳定但慢；记忆短，反应快但噪声大。自适应限流还需要一个真实的"接受"信号；当唯一的反馈是超时时，"接受"就退化成了"按时完成"，模型里用的就是这个定义。

## 9. 服务端配合

客户端只能猜。服务器知道自己的队列有多长，可以说得更多。

- **回压（pushback）。** gRPC 服务器可以设置 `grpc-retry-pushback-ms`：非负值让客户端恰好在这个延迟之后重试，负值或无法解析的值让客户端完全不要重试。HTTP 有 `Retry-After`（RFC 9110），Envoy 可以通过限流重试退避（rate-limited retry back-off）遵循 `Retry-After` 或 `X-RateLimit-Reset` 之类的响应头。Amazon 使用独立的限流错误，SDK 对它们使用长得多的基础延迟（1,000 ms 对 50 ms）。
- **"不要重试"错误。** Google 的"overloaded; don't retry"是服务间的版本：已经重试过的那一层告诉上一层停手。
- **截止时间检查与负载卸除。** 丢弃一个截止时间已过的请求几乎不花成本，却能把容量留给仍可能成功的请求。有界队列和在准入时卸载负载，能让排队延迟保持在客户端超时以下。在模型中，仅仅让服务器丢弃过期请求就已足够：即便是三次尝试的立即重试，也在第 130 个时间片——触发因素结束的那一刻——恢复，被浪费的执行次数为零。
- **队列纪律。** HotOS 论文列出的业界临时防御手段里，就有 LIFO 调度和更小的队列：当队列里大多数请求都已过期时，先服务最新的请求，能让这些请求有机会在截止时间之前完成。

## 10. 什么可以安全地重试

**先讲幂等。** 超时后的重试可能让操作执行两次。读取、对完整资源的 `PUT` 和 `DELETE` 天然幂等；"扣这张卡的钱"和"追加这条消息"则不是。标准做法是**幂等键（idempotency key）**：客户端为每个逻辑操作生成一个唯一 id，在每次尝试中都带上它，服务器用这个键保存结果，遇到重复请求时直接返回。gRPC 更进一步，只有在它能保证请求从未到达服务器应用逻辑时，才会做透明重试。

**只重试该重试的错误。** 重试瞬时的传输失败和明确的"不可用"或限流响应；不要重试校验错误、鉴权失败或"未找到"。gRPC 的重试策略要求显式列出 `retryableStatusCodes`（示例使用 `UNAVAILABLE`），其限流也只统计这些失败，所以一阵客户端自己的错误不会改变重试行为。

**对冲就是为延迟而重试。** Dean 和 Barroso 的 *The Tail at Scale* 描述了**对冲请求（hedged requests）**：如果第一个请求在比如 95 分位延迟之后还没有回应，就向另一个副本发第二份，用先到的那个结果。等到 p95 再发，可以把额外负载限制在约 5%。在他们的 BigTable 基准中，1,000 个键分布在 100 台服务器上，10 ms 后发出对冲请求，把取回全部值的 99.9 分位延迟从 1,800 ms 降到 74 ms，只多发了 2% 的请求。gRPC 用 `hedgingPolicy` 和 `hedgingDelay` 实现了它，受同样的 `maxAttempts` 上限和同样的限流令牌约束。对冲只对幂等操作安全，而且必须像其他重试一样纳入预算——过载时，每一次对冲都是额外负载。

## 11. 权衡

- **不重试。** 完全没有放大，但每一次瞬时抖动都会变成用户可见的错误。在深调用栈的最底层合理，在边缘则是错的。
- **按请求限制尝试次数。** 简单、通用。它把放大倍数封顶在 `n`，而不是一个很小的数；`n = 3` 在全部失败时依然让流量翻三倍。
- **不带抖动的退避。** 比狂轰滥炸好，但同步的客户端会产生同步的浪潮。不要上线这种方案。
- **带抖动的退避。** 消除了同步和白白浪费的碰撞；但在过载期间并不能限制重试的总负载。
- **重试预算（比例、并发或令牌）。** 把重试总负载限制在一个小常数内。代价是每个客户端或每个集群几个计数器，外加一个"什么算失败"的策略选择。本地预算看不到其他客户端在做什么；要做全局协调，仍然需要服务端信号。
- **自适应限流。** 还能防住首次尝试造成的过载，只用本地信息。它通过 `K` 和窗口长度，在后端浪费与恢复速度之间做取舍，并且需要一个明确的接受信号。
- **断路器。** 超过错误阈值时停止所有调用。Amazon 指出它引入了难以推理的模态行为，还可能拉长恢复时间；对于重试，令牌桶是它的替代方案。
- **服务端配合（截止时间、负载卸除、回压）。** 最有效的防御，因为服务器了解自己的状态。它要求每个服务都参与进来，这既是技术成本，也是组织成本。

## 12. 一个可运行模型

下面的脚本在 Python 3.13、种子 173 下产生了本节的所有数字。它分为三部分。

**第一部分——过载。** 一台 FIFO 服务器每个时间片完成 100 个请求。40 个客户端平均每个时间片发送 80 个新请求（80% 利用率）。每次尝试有 10 个时间片的客户端截止时间。服务器不知道客户端何时放弃，所以一个已超时的尝试稍后仍会被执行，除非服务器被配置为丢弃过期请求（成本为执行的 5%）。触发因素在第 100–129 个时间片把容量降到 40；之后容量回到 100，并一直保持到第 599 个时间片。有效吞吐只统计在截止时间之前完成的尝试。"恢复"是触发因素结束后，10 个时间片平均有效吞吐首次达到正常负载 95% 的那个时间片。

结果：

- **不重试**能自行恢复：积压被排空，第 147 个时间片有效吞吐回到正常。
- **三次尝试，无论立即重试、普通指数退避还是全抖动**，都永远恢复不了。第 200–299 和 500–599 个时间片的有效吞吐都是 0.0。服务器始终满负荷运转，但提交负载停在每个时间片 235–240 次尝试，队列最后积压了超过 66,000 次尝试，47,427 次执行浪费在客户端早已离开的尝试上。容量下跌只持续了 30 个时间片，宕机却持续到运行结束。退避和抖动在这里几乎没有区别：退避只是把额外的尝试挪到后面。
- **预算打破了回路。** 10 个时间片窗口内 10% 比例的预算在第 226 个时间片恢复，AWS 风格的配额（每个客户端 500 令牌，每次重试 14）在第 227 个时间片恢复，gRPC 风格的限流（`maxTokens = 10`、`tokenRatio = 0.1`）在第 155 个时间片恢复，全程总共只发出了 164 次重试。在第 500–599 个时间片，三者的有效吞吐都回到正常（78.9–79.7）。
- **K = 2 的自适应限流**也逃了出来，但在 60 个时间片的窗口下，第 200–299 个时间片的有效吞吐平均只有 7.5，到第 550 个时间片才达到恢复阈值，期间在本地拒绝了 19,030 个请求。窗口为 20 个时间片时，第 212 个时间片恢复。
- **在服务端丢弃过期请求**是这个模型里最强的单项修复：不论有没有重试，都在第 130 个时间片恢复，被浪费的执行降为 0，触发期间的有效吞吐从 25.8 升到 39.1（上限 40）。

第一部分 b 改变触发因素的长度。在三次尝试、全抖动、无预算的情况下，系统能从 10、15、20 个时间片的容量下跌中恢复——却永远无法从 22、24、26 或 30 个时间片的下跌中恢复。不重试时，同样的下跌在第 124 到 147 个时间片之间愈合。有 AWS 风格配额时，在第 196 到 227 个时间片之间愈合。这就是 Bronson 等人所说的脆弱状态：稳态下的系统不会告诉你，20 个时间片是安全的，而 22 个不是。

**第二部分——竞争。** 100 个客户端对同一行做读-改-写；如果一次尝试开始时另一个写入还在进行中，就发生冲突并退避（20 次运行的平均值）。立即重试和不带抖动的指数退避都需要 5050 次调用——正好是 `100 * 101 / 2`，因为每一轮只放过一个客户端，其他人全部撞车。不带抖动的退避还要花 3,140 ms 而不是 100 ms，因为客户端总是一起回来。三种抖动变体都把调用次数降到 769–824，并在 164–194 ms 内完成。在这个模型里，去相关抖动调用最少，全抖动最早完成；Brooker 的模拟器给出的排序略有不同，这提醒我们：抖动变体之间的排序取决于负载形态，而"有抖动"和"无抖动"之间的差距则不然。

**第三部分**是分层的算术：每层尝试三次，深度 1 到 5 时最底层的最坏尝试次数分别是 3、9、27、81 和 243。

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

输出：

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

## 总结

- 每一次重试都是一个负载决策。失败率 1% 时，三次尝试大约只多花 1% 的负载；失败率 90% 时，负载变成 2.71 倍，而客户端仍有 73% 的时候失败。
- 大多数重试来自超时，而一个超时的请求往往仍会被执行。如果服务器不检查截止时间，过载会让队列塞满没人会读的工作。
- 带上限的指数退避摊开单个客户端的尝试；抖动让众多客户端错开。两者都不能在过载时限制重试的总负载——在模型中，立即重试、指数退避和全抖动重试最终都陷入同一个有效吞吐为 0 的卡死状态。
- 重试会跨层相乘：五层各尝试三次，最底层就是 243 次尝试。只在一层重试，并向上传递"不要重试"。
- 亚稳态故障由很小的事情触发，由反馈维持，而在 OSDI 2022 研究的事故中，重试是最常见的维持效应。在模型中，20 个时间片的容量下跌能愈合，22 个时间片的永远不能。
- 重试预算按流量比例限制重试：Google SRE 的每客户端 10% 比例，Finagle 的 20% 加每秒 10 次，Envoy 的活跃请求 20%、下限 3，gRPC 的 `retryThrottling` 令牌计数，以及自 2026 年 11 月 10 日起成为默认的 AWS SDK 重试配额（500 令牌，每次瞬时重试 14）。模型中的每一种预算，都把永久宕机变成了一次恢复。
- 自适应限流（`max(0, (requests - K*accepts)/(requests + 1))`，K = 2）能防住首次尝试造成的过载；它的窗口在稳定性和恢复速度之间做取舍。
- 最强的防御在服务端：丢弃过期请求、尽早卸载负载、发送回压或 `Retry-After`。在模型中，仅仅丢弃过期工作，就能在触发因素结束的那一刻恢复。
- 只重试幂等操作，或者用幂等键让它们变得幂等；只重试瞬时错误；把对冲请求当作为了延迟、同样要纳入预算的重试。

## 参考资料

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
