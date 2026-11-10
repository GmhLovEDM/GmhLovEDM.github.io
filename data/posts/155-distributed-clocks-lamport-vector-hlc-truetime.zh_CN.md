---
title: "分布式系统中的时间：Lamport 时钟、向量时钟、混合逻辑时钟与 TrueTime"
tag: architecture
description: 为什么墙上时钟无法在多台机器之间给事件排序，真实系统又用什么替代——物理时钟漂移、NTP 与 PTP、单调时钟与墙上时钟、Lamport 的 happens-before 关系与逻辑时钟、用于发现并发写入的向量时钟与版本向量、CockroachDB 和 YugabyteDB 使用的混合逻辑时钟、Spanner 的 TrueTime 与 commit wait，以及租约、fencing token、闰秒和按时间有序的 ID，附经过实际运行验证的 Go 实现
date: "2026-11-10T13:25:00.000Z"
---

## 目标

"哪个写入先发生？"看起来用时间戳就能回答。在单机上大体如此，跨机器就不行了：每台服务器的时钟都会漂移，同步只能做到近似，按接收方的时钟看，一条消息甚至可能在发出"之前"就到达了。数据库、缓存、复制协议、分布式锁和日志管道都需要某种顺序，而如何得到这个顺序，是分布式系统里最重要的设计决策之一。

本文包括：

1. 为什么物理时钟不可靠，NTP、PTP 和单调时钟到底能提供什么。
2. Lamport 的 happens-before 关系与逻辑时钟。
3. 向量时钟与版本向量：发现并发更新。
4. 混合逻辑时钟（HLC）：既有逻辑时钟的保证，时间戳又贴近真实时间。
5. Spanner 的 TrueTime：把时钟不确定性显式暴露出来，然后等它过去。
6. 实践中的坑：租约、fencing token、最后写入者胜出、闰秒和按时间有序的 ID。

下文所有 Go 代码都经过编译运行，展示的输出是真实结果。

## 1. 物理时钟会说谎，有时差一点，有时差很多

服务器的时钟是一个石英振荡器加上软件。石英会随温度和老化漂移，几十 ppm（百万分之一）的漂移很常见，仅 10 ppm 一天就差将近一秒。时钟同步协议会持续纠正它：

- **NTP** 走公网时通常精度在毫秒到几十毫秒级；在管理良好的局域网里可以做到亚毫秒。非对称网络路径、过载的服务器和错误配置都会让精度变差。
- **PTP（IEEE 1588）** 配合网卡和交换机的硬件时间戳可以达到亚微秒精度，这也是交易系统和电信行业使用它的原因。云厂商现在也提供类似精度：Amazon Time Sync Service 宣称在受支持的 EC2 实例上可达微秒级，AWS 还开源了 `ClockBound`，这个守护进程和库在返回当前时间的同时**附带误差上界**。

即使同步良好，操作系统在纠正较大偏差时也可能把时钟往回拨，虚拟机在热迁移时可能暂停数秒，一次 GC 停顿也可能让你拿到的"现在"在使用时已经过时。所以系统要区分两种时钟：

- **墙上时钟**（Linux 上的 `CLOCK_REALTIME`）：可以跨机器比较，但可能向前或向后跳变。
- **单调时钟**（`CLOCK_MONOTONIC`）：永不倒退，但跨机器或跨重启没有意义。

时长和超时用单调时钟，墙上时钟只用于展示和粗粒度的跨机器推理。Go 把这一点做进了标准库：从 Go 1.9 起，`time.Now()` 会携带单调时钟读数，`t2.Sub(t1)` 会使用它，所以即使墙上时钟被调整，测量耗时也是安全的。

关键结论是：**只靠物理时间戳，当两个事件的间隔小于时钟误差时，你无法可靠判断服务器 1 上的事件 A 是否发生在服务器 2 上的事件 B 之前。** 假装可以的系统会丢写入。

## 2. Happens-before 与 Lamport 时钟

Leslie Lamport 1978 年的论文《Time, Clocks, and the Ordering of Events in a Distributed System》重新定义了这个问题。不再问事件发生在什么时刻，而是问哪些事件*可能影响了*哪些事件。**happens-before** 关系（→）由三条规则定义：

1. 若 a 和 b 在同一进程中且 a 在前，则 a → b。
2. 若 a 是发送一条消息，b 是接收这条消息，则 a → b。
3. 传递性：若 a → b 且 b → c，则 a → c。

若 a → b 和 b → a 都不成立，这两个事件就是**并发**的：它们之间不可能有信息流动，任何观察者都无法从因果上判断谁"先"。

**Lamport 时钟**是每个进程一个计数器：

- 每次本地事件或发送前，计数器加一。
- 每条消息都带上计数器值。
- 接收时，令 `counter = max(counter, received) + 1`。

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

这个保证是单向的：**若 a → b，则 L(a) < L(b)**。反过来不成立，L(a) < L(b) 不能说明任何因果关系。用进程 ID 打破平局，就得到一个与因果一致的**全序**，这对很多算法已经足够：Lamport 自己的互斥算法、全序组播，以及 Raft 等共识协议里的 term/index 组合，都是这个思想的近亲。

Lamport 时钟做不到的是告诉你两个事件是并发的。要检测冲突，需要更多信息。

## 3. 向量时钟与版本向量

**向量时钟**为每个进程保存一个计数器。进程 i 在每个事件上递增自己的分量；接收时先与传入向量逐分量取最大值，再递增自己的分量。两个向量的比较规则：

- V(a) 逐分量 ≤ V(b) 且不相等：a → b。
- 有的分量大、有的分量小：a 与 b 并发。

与 Lamport 时钟不同，这个关系是双向的：**a → b 当且仅当 V(a) < V(b)**。它由 Fidge（1988）和 Mattern（1989）分别独立提出。

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

一个场景：A 写入 `w1`；B 读到它后写入 `w2`；与此同时 A 在没看到 B 的写入的情况下写入 `w3`。

```text
w1 vs w2: Before | w2 vs w3: Concurrent | w1 vs w3: Before
```

`w2` 和 `w3` 确实是并发的。只保留"最新时间戳"的系统会悄悄丢掉其中一个；使用向量时钟的系统可以把两者都作为**兄弟版本（siblings）**保留，交给应用（或 CRDT）合并。

存储系统里通常使用的变体是**版本向量**：每个接受写入的*副本*一个分量，附在 key 的每个存储版本上，而不是附在每个事件上。Amazon 的 Dynamo 论文（2007）就这样使用向量时钟，把冲突版本返回给客户端去调和（购物车按并集合并）。Riak 后来采用了**带点版本向量（dotted version vectors）**，以避免大量客户端经由同一副本写入时兄弟版本爆炸。

代价是体积：每个参与者一个分量。系统会通过以下方式控制它：跟踪副本而非客户端、裁剪旧分量（可能丢失因果信息），或在成员动态变化时使用 interval tree clock 之类的结构。而且向量时钟依然与真实时间无关：它无法告诉你某次写入是否发生在"最近五秒内"。

## 4. 混合逻辑时钟

很多数据库两种性质都想要：既要尊重因果的顺序，*又*要时间戳贴近墙上时间，这样"按 10:00:00 时的快照读"或"一小时后过期"才有意义。**混合逻辑时钟**（Kulkarni、Demirbas 等，《Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases》，2014）用固定大小的时间戳 `(l, c)` 做到了这一点：

- `l` 是该节点见过的最大物理时间，可能来自自己的时钟，也可能来自任何消息。
- `c` 是计数器，用来给 `l` 相同的事件排序。

本地或发送事件、以及接收时间戳为 `(l_m, c_m)` 的消息时的规则：

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

模拟节点 B 的物理时钟比节点 A 慢 100 ns：

```text
hlc {1000 0} {1000 1} {1000 2} {1500 0}
causal order kept: true
skew bound: l - pt at B before catching up = 100
```

A 的消息到达时，B 采用 A 更大的墙上时间并递增计数器，因此即使 B 自己的时钟读数是 900，接收事件也排在发送事件之后。等 B 的物理时钟越过 1000，计数器归零。在三个节点、时钟推进速度不均匀的情况下随机执行 10 万次发送和接收，验证了两条关键不变量：每次接收都排在对应的发送之后；`l` 从不超过任何节点实际观察到的最大物理时间（`100k-step property check passed: true`）。

论文给出的性质：

- **若 a → b，则 hlc(a) < hlc(b)**，与 Lamport 时钟相同。
- `l` 与物理时间的差距不超过时钟同步误差 ε，因此时间戳可以当作墙上时间使用。
- `c` 在实践中有界，因此时间戳能塞进 64 位（例如 48 位毫秒加 16 位计数器），可以直接替换已有的时间戳字段。

**CockroachDB** 用 HLC 时间戳作为 MVCC 版本和事务时间戳。由于仅靠 HLC 无法阻止一个节点上的读漏掉另一个时钟更快的节点上"稍微在未来"提交的写，CockroachDB 增加了**不确定性区间**：时间戳为 t 的读，会把时间戳落在 `(t, t + max_offset]` 内的值视为可能更早发生，一旦遇到就把读提升到更高的时间戳重新执行。集群的最大时钟偏差（默认 500 ms）是正确性参数，不是调优旋钮：节点会互相监控偏差，时钟偏离其他节点过多的节点会主动关停，而不是冒破坏一致性的风险。**YugabyteDB** 采用类似的基于 HLC 的方案，**MongoDB** 从 3.6 起用混合逻辑的"cluster time"支持因果一致性会话。

取舍在于：HLC 让你在普通时钟上获得便于实现可串行化的顺序，代价是高争用下的读重启，以及你必须信任一个由监控来保证的时钟偏差上界。

## 5. TrueTime：显式暴露不确定性，然后等过去

Google Spanner（OSDI 2012）走了相反的路。**TrueTime** API 不隐藏时钟误差，而是把它暴露出来：`TT.now()` 返回一个区间，包含下界 earliest 和一个上界，保证绝对时间落在其中；`TT.after(t)` 只有在 t 确定已经过去时才为真。Google 在每个数据中心部署 GPS 接收器和原子钟作为支撑，时间守护进程轮询多个主时钟；论文报告的 ε（区间宽度的一半）通常在 1 到 7 ms 之间。

这让**外部一致性**（事务级的线性一致性）成为可能：如果 T1 在真实时间上先于 T2 开始之前提交，那么 T2 的时间戳更大。机制是 **commit wait**：

1. 取 `TT.now()` 的上界作为提交时间戳 `s`。
2. 等到 `TT.after(s)` 为真，大约需要 2ε。
3. 之后才让写入可见并确认提交。

等待结束后，全世界的所有节点都认可 `s` 已经过去，之后开始的任何事务都会拿到更大的时间戳。这段等待与 Paxos 复制重叠进行，所以开销往往能被部分掩盖。任意时间戳上的无锁快照读也随之而来。

这个设计的启示具有普遍性：**时钟误差界越紧，强一致性就越便宜。** 这也是云时间服务的进步以及 ClockBound 这类库重要的原因：它们让 Google 之外的系统也能基于显式误差界推理，而不是基于假设的误差界。

| 方案 | 体积 | 能否发现并发 | 是否贴近真实时间 | 典型用途 |
| --- | --- | --- | --- | --- |
| 墙上时钟 | 1 个值 | 否 | 是，带误差 | 日志、TTL、展示 |
| Lamport 时钟 | 1 个计数器 | 否 | 否 | 全序、共识 term |
| 向量时钟 / 版本向量 | 每个参与者 1 个分量 | 是 | 否 | 冲突检测、CRDT 元数据 |
| 混合逻辑时钟 | 1 个值（64 位） | 否 | 是，误差在 ε 内 | MVCC 数据库（CockroachDB、YugabyteDB） |
| TrueTime | 区间 | 否 | 是，有界 | 外部一致的事务（Spanner） |

## 6. 日常工程中时钟带来的坑

**最后写入者胜出（LWW）。** Cassandra 按时间戳解决写冲突（默认由协调节点分配，也可由客户端提供）。如果某个节点时钟偏快，它的写入就会胜出，即使实际发生得更早；带偏差时间戳的删除可能让数据凭空消失或"复活"。LWW 适用于幂等、整体覆盖式的数据；其他情况请用版本向量、CRDT，或每个 key 单一 leader。

**租约与锁。** 租约的含义是"在时间 T 之前归你所有"。如果持有者暂停（GC、虚拟机迁移）超过了 T，它可能仍以所有者身份行事，而另一个节点已经拿到了租约。Martin Kleppmann 2016 年对 Redis Redlock 的分析指出，基于时间的锁需要 **fencing token**：每次发放租约时附带一个单调递增的编号，由存储层校验，若已见过更大的编号就拒绝。etcd 和 ZooKeeper 通过 revision 号和 zxid 天然提供这一点。本地测量租约时长要用单调时钟，并为漂移留出安全余量。

**闰秒。** UTC 闰秒会让墙上时钟重复或停顿，过去曾导致软件崩溃（2012 年的闰秒引发了大范围的 Linux 和 Java 问题）。Google、AWS 等会对闰秒做**平滑（smear）**，在一个时间窗口内让时钟略微变慢，使时间永不重复。不要在同一个集群里混用平滑和不平滑的时间源。国际计量大会（CGPM）在 2022 年投票决定最迟于 2035 年停止插入闰秒，但在那之前，这些缓解措施仍然重要。

**按时间有序的 ID。** Twitter 的 Snowflake ID 和 **UUIDv7**（2024 年在 RFC 9562 中标准化）把毫秒时间戳放在高位，使 B 树插入基本保持顺序。它们跨机器只是*大致*按时间有序，从来不是因果有序。实现时要防范时钟倒退（例如记住上一个时间戳并递增计数器，与 HLC 用的是同一招）。

**测量时长。** 超时、重试、限流器和延迟指标都必须用单调时间。墙上时钟向后跳一下，`elapsed := now - start` 就变成负数；向前跳一下，所有超时会同时触发。

## 工程清单

1. 先想清楚你需要什么：全序、因果序、冲突检测，还是真实时间上的界。每一种对应不同的时钟。
2. 时长用单调时钟；绝不要用墙上时钟的差值计算超时。
3. 除非偶尔丢一次写入可以接受，否则不要用墙上时间戳解决冲突。
4. 需要保留并发写入的地方，用版本向量或 CRDT。
5. 如果使用 HLC，把最大时钟偏差当作正确性假设：监控偏差，让超出上界的节点下线。
6. 每个基于时间的租约或锁，都配一个由资源方校验的 fencing token。
7. 运行可靠的时间同步（chrony、PTP 或云厂商的时间服务），保持闰秒处理方式一致，并对偏差设置告警。
8. 像上面的代码一样让时间可注入，以便确定性地校验排序逻辑。

## 总结

物理时钟只是近似的，所以分布式系统靠逻辑而不是信任来给事件排序。Lamport 时钟以很低的成本给出与因果一致的全序；向量时钟和版本向量以体积为代价发现并发；混合逻辑时钟把 Lamport 式的保证与始终在时钟误差范围内贴近真实时间的时间戳结合起来，这正是现代 MVCC 数据库采用它的原因；TrueTime 则说明，只要能把时钟不确定性限制得足够紧，就可以简单地通过等待换来外部一致性。在日常工程里，同样的思想体现为单调计时器、fencing token、谨慎的冲突解决和按时间有序的 ID。

## 参考资料

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
