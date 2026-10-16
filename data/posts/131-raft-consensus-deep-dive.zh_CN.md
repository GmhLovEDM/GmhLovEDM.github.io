---
title: "深入 Raft 共识算法：选举、日志复制与生产级集群背后的工程实践"
tag: architecture
description: 深入剖析 Raft 共识算法——领导者选举、日志复制、提交规则、成员变更、线性一致读，以及 etcd 等真实系统依赖的 PreVote、CheckQuorum、ReadIndex 等扩展
date: "2026-10-16T10:00:00.000Z"
---

## 目标

几乎所有需要"唯一可信数据源"的现代基础设施——Kubernetes 背后的 etcd、Consul、CockroachDB 与 TiKV 的数据分片、Kafka 的 KRaft 控制器仲裁——都构建在共识协议之上，而其中大多数选择了 Raft。本文讲清楚 Raft 到底如何工作、每条规则为什么存在、生产环境中哪些边界情况会出问题，以及真实实现在原始论文之上加了哪些扩展。

## 背景

### 共识要解决的问题

我们希望一组服务器表现得像一个单一、可靠的状态机：客户端发送命令，每台服务器以相同顺序执行相同命令，只要多数派服务器存活并能互相通信，系统就能持续工作。

这被称为**状态机复制（State Machine Replication）**。难点不在于执行命令，而在于消息可能延迟、重复、丢失，服务器可能崩溃重启时，如何就命令的*顺序*达成一致。

Raft 的假设：

- **崩溃-恢复故障**，而非拜占庭故障。节点可能停机后恢复，但不会撒谎。
- **异步网络**：消息可以任意延迟或乱序。安全性从不依赖时序，只有活性（能否推进）依赖时序。
- **稳定存储**：某些状态必须在响应 RPC 之前持久化到磁盘。

### 为什么是 Raft 而不是 Paxos

Diego Ongaro 和 John Ousterhout 于 2014 年发表了 Raft（《In Search of an Understandable Consensus Algorithm》，USENIX ATC）。Multi-Paxos 与 Raft 在容错和性能上相当，但 Raft 以可理解性为设计目标：它把共识拆分为**领导者选举**、**日志复制**和**安全性**三部分，并且只允许领导者接受新条目，从而缩小了状态空间。

## 核心状态

每个 Raft 节点维护：

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
	// 持久化状态 —— 回复任何 RPC 之前必须 fsync
	currentTerm uint64
	votedFor    string // 当前任期投票给的候选人 ID，未投票则为 ""
	log         []LogEntry

	// 所有节点上的易失状态
	commitIndex uint64 // 已知已提交的最大索引
	lastApplied uint64 // 已应用到状态机的最大索引

	// 领导者上的易失状态，每次选举后重新初始化
	nextIndex  map[string]uint64 // 发送给每个节点的下一个日志索引
	matchIndex map[string]uint64 // 已知在每个节点上复制成功的最大索引

	role Role
}
```

**任期（Term）**是 Raft 的逻辑时钟。每个任期以一次选举开始，最多只有一个领导者。每个 RPC 都携带发送方的任期，并且有一条通用规则：

> 节点一旦看到比自己更大的任期，就更新 `currentTerm`、清空 `votedFor`，并转为跟随者。

一个过期的领导者只要收到任何更高任期的消息，就会立刻退位。这一条规则就解决了大量"双主"场景。

## 领导者选举

### 超时与随机化

跟随者期望周期性地收到领导者的心跳（空的 `AppendEntries`）。如果在一个**选举超时**内没有收到任何消息，跟随者就成为候选人：

1. `currentTerm` 加一
2. 给自己投票（并持久化）
3. 向所有节点发送 `RequestVote`
4. 等待以下之一：获得多数票（成为领导者）、收到合法领导者的 `AppendEntries`（转为跟随者）、再次超时（发起新一轮选举）

当两个跟随者同时超时，就可能出现选票瓜分。Raft 通过**随机化**超时时间来避免反复瓜分，论文建议的范围类似 150–300 ms。关键的时序要求是：

```
broadcastTime  <<  electionTimeout  <<  MTBF
```

选举超时必须远大于一次典型的往返时间（包括 fsync），否则跟随者会不断对一个健康的领导者发起选举。

### 选举限制

选票不是随便给的。如果候选人的日志不如自己新，投票者会拒绝：

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
		n.becomeFollower(req.Term) // 清空 votedFor
	}
	canVote := n.votedFor == "" || n.votedFor == req.CandidateID
	if canVote && n.candidateLogIsUpToDate(req.LastLogTerm, req.LastLogIndex) {
		n.votedFor = req.CandidateID
		n.persist() // 回复前必须落盘
		n.resetElectionTimer()
		return RequestVoteResp{Term: n.currentTerm, Granted: true}
	}
	return RequestVoteResp{Term: n.currentTerm, Granted: false}
}
```

已提交的条目存在于多数派上，而获胜者需要多数派的选票，两个多数派至少有一个节点重叠，这个节点会拒绝任何缺少该已提交条目的候选人。这就是**领导者完整性（Leader Completeness）**：每个领导者都包含之前任期所有已提交的条目。因此 Raft 永远不需要把缺失的已提交条目*传给*新领导者——数据只从领导者流向跟随者。

## 日志复制

### AppendEntries 与一致性检查

领导者把客户端命令追加到自己的日志中，然后向跟随者发送 `AppendEntries`，其中包含新条目以及 `prevLogIndex` 和 `prevLogTerm`——即紧邻新条目之前那条日志的索引和任期。

```go
func (n *Node) HandleAppendEntries(req AppendEntriesReq) AppendEntriesResp {
	if req.Term < n.currentTerm {
		return AppendEntriesResp{Term: n.currentTerm, Success: false}
	}
	n.becomeFollower(req.Term)
	n.resetElectionTimer()

	// 一致性检查
	if !n.hasEntry(req.PrevLogIndex, req.PrevLogTerm) {
		return AppendEntriesResp{
			Term:          n.currentTerm,
			Success:       false,
			ConflictIndex: n.firstIndexOfConflictingTerm(req.PrevLogIndex),
		}
	}

	// 只在真正冲突时截断；不能因为一个（可能乱序到达的旧）请求更短
	// 就丢弃条目。
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

一致性检查通过归纳法保证了**日志匹配（Log Matching）**性质：如果两份日志在相同索引处的条目任期相同，那么两份日志在该索引之前完全一致。

检查失败时，领导者会把该跟随者的 `nextIndex` 减一并重试。长时间分区后逐条回退非常慢，因此实现通常会返回提示信息（`ConflictIndex`/`ConflictTerm`，或 etcd 的 "reject hint"），让领导者一次跳过整个任期。

代码中关于截断的注释是真实世界中常见的 bug 来源：如果跟随者盲目地按照一个延迟到达、更短的 `AppendEntries` 截断日志，就可能丢弃已经确认过的条目，破坏领导者的提交计算。

### 提交规则与 "Figure 8" 陷阱

领导者跟踪每个跟随者的 `matchIndex`，并把 `commitIndex` 推进到多数派已复制的最大索引 `N`——**但前提是 `log[N].Term == currentTerm`**：

```go
func (n *Node) maybeAdvanceCommit() {
	matched := []uint64{n.lastIndex()}
	for _, m := range n.matchIndex {
		matched = append(matched, m)
	}
	sort.Slice(matched, func(i, j int) bool { return matched[i] > matched[j] })
	N := matched[len(matched)/2] // 多数派已复制的索引

	if N > n.commitIndex && n.termAt(N) == n.currentTerm {
		n.commitIndex = N
		n.applyCh <- N
	}
}
```

为什么要检查任期？论文 5.4.2 节（Figure 8）展示了：一个来自*旧*任期的条目即使已存储在多数派上，仍可能被一个从未拥有它的未来领导者覆盖。只有对领导者当前任期的条目计数副本才是安全的；一旦当前任期的某个条目提交，之前的所有条目都会通过日志匹配性质被间接提交。

实际影响：新当选的领导者在提交一条自己任期的条目之前，无法知道哪些条目已经提交。这就是为什么领导者当选后会立刻追加一条 **no-op 条目**——它会很快提交，并隐式提交之前的所有条目。

## 持久化与持久性

持久化字段（`currentTerm`、`votedFor`、`log`）必须在节点回复*之前*落盘。如果一个节点投票后在 fsync 之前崩溃，重启后又在同一任期投票给另一个人，那么同一任期可能选出两个领导者。

这使得 fsync 延迟成为共识关键路径的一部分。常见技术：

- **批处理**：把大量客户端提议累积起来，一次写入加一次 fsync。
- **流水线**：领导者在上一个 `AppendEntries` 被确认之前就发送下一个。
- **领导者并行写盘**：Raft 博士论文指出，领导者可以在向跟随者复制的同时并行写自己的磁盘，因为提交只需要多数派，而多数派不一定包含领导者自身。

这也是 etcd 文档强调高速磁盘的原因：`wal_fsync_duration_seconds` 指标是核心健康信号，fsync 变慢会表现为心跳丢失和领导者切换。

## 日志压缩与快照

不断增长的日志意味着无界的磁盘占用和缓慢的重启。Raft 节点会定期在索引 `i` 处对状态机做**快照**，记录 `(lastIncludedIndex, lastIncludedTerm)`，然后丢弃 `i` 及之前的日志。

如果某个跟随者落后到领导者保留的最早条目之前，领导者会发送 `InstallSnapshot` 而不是日志条目。工程上的取舍：

| 决策 | 取值较小 | 取值较大 |
|------|----------|----------|
| 快照频率 | I/O 更多，重启更快 | I/O 更少，日志更大、恢复更慢 |
| 快照后保留的条目数 | 落后的跟随者更常需要完整快照 | 占用更多磁盘，但慢节点可以通过廉价的追加追上 |

对大型状态机做快照时不应阻塞应用循环——可以使用写时复制数据结构、`fork()`（Redis 的做法），或存储引擎自带的 checkpoint 机制（例如 TiKV 中的 RocksDB checkpoint）。

## 线性一致读

一个非常常见的错误是直接从领导者的状态机读取数据。一个已经被分区隔离的领导者可能还不知道自己已被取代，从而返回过期数据。可选方案，从最强最慢到最快：

1. **走日志读**：像写一样把读请求放进日志。正确，但需要一轮复制和一次 fsync。
2. **ReadIndex**（Raft 博士论文 §6.4）：领导者把当前 `commitIndex` 记为 `readIndex`，通过获得多数派的心跳确认来证明自己仍是领导者，等待 `lastApplied >= readIndex` 后在本地读取。无需写盘。新领导者必须先提交自己的 no-op 条目。跟随者也可以向领导者请求 `readIndex` 后在本地提供读服务（"follower read"）。
3. **租约读（Lease Read）**：一轮心跳成功后，领导者假定在一个短于选举超时的租约期内不会有别人成为领导者，从而省去往返。最快，但安全性开始依赖时钟漂移有界——一次长时间的 GC 停顿或虚拟机卡顿都可能打破这个假设。

etcd 默认使用 ReadIndex 实现线性一致读，同时提供串行化读（etcdctl 中的 `--consistency=s`），直接读取本地状态而不做检查，用新鲜度换取延迟。

## 成员变更

直接从配置 `C_old` 切换到 `C_new` 是不安全的：在切换过程中，部分节点可能构成 `C_old` 的多数派，而另一些节点构成 `C_new` 的多数派，从而选出两个领导者。

Raft 提供两种方案：

- **联合共识（Joint Consensus）**（原始论文）：集群先切换到 `C_old,new`，此时决策需要*两个*配置各自的多数派同意，然后再切换到 `C_new`。
- **单节点变更**（Ongaro 博士论文）：每次只增加或删除一个节点。此时新旧配置的任意多数派必然重叠，不需要联合阶段。

原始单节点变更算法在发表后被发现存在一个 bug（2015 年在 raft-dev 邮件列表中讨论），修复方式是：领导者必须先在当前任期提交一条条目，才能应用配置变更。生产系统还引入了 **learner**（无投票权成员），让新节点在影响仲裁之前先追上日志——etcd 在 v3.4 中加入了 learner 支持。

运维经验：不要把一个 3 节点集群直接加一个磁盘还是空的投票成员扩到 4 节点——仲裁数会变成 3，一次缓慢的追赶就可能卡住写入。先以 learner 身份加入，再提升为投票成员。

## 生产级扩展

基础协议存在一些真实部署中会遇到的活性问题。常见的修复方案都已在 etcd 的 raft 库中实现：

### PreVote

一个与集群分区的节点会不断超时并增加任期。分区恢复后，它的高任期会迫使健康的领导者退位，引发一次不必要的选举。有了 **PreVote**（博士论文 §9.6），节点先在不增加任期的情况下询问"你会投票给我吗？"；最近收到过领导者消息的节点会拒绝。只有多数派同意后，它才发起真正的选举。

### CheckQuorum

一个无法联系上多数派的领导者会一直认为自己是领导者，客户端会继续向它发送永远无法提交的请求。启用 **CheckQuorum** 后，领导者如果在一个选举超时内没有收到多数派的响应就会主动退位。它也与租约读配合，使租约假设成立。

### 领导者转移

滚动升级时，运维人员让领导者主动交接：它停止接受新的提议，把目标节点的日志完全补齐，然后发送 `TimeoutNow`，让目标节点立刻发起选举。这样计划内的重启几乎无感，而不必等待一个完整的选举超时。

### 流量控制

etcd 的 raft 库限制每个跟随者在途的 `AppendEntries` 数量，并对状态未知的跟随者进行探测（`StateProbe` 与 `StateReplicate`），避免一个慢节点无限制地占用领导者内存。

## Multi-Raft：突破单个 Raft 组的规模

单个 Raft 组受限于一个领导者的吞吐，并且每个成员都要容纳完整数据集。TiKV、CockroachDB 等系统把数据切分为 range/region，每个分片有自己的 Raft 组，单个节点上可能有成千上万个组。随之而来的新问题：

- **心跳风暴**：成千上万个组各自发送心跳。缓解手段包括按节点对合并心跳、让空闲分片进入休眠。
- **领导者均衡**：领导者承担更多工作，因此需要调度组件（Placement Driver）在节点间迁移领导权。
- **共享 WAL**：多个组写入磁盘上的同一个日志/引擎，以控制 fsync 次数。
- **跨组事务**：单分片共识无法提供跨分片原子性，需要事务层（例如 TiKV 中 Percolator 风格的两阶段提交）。

## 取舍：什么时候不该用 Raft

- **延迟下限**：每次写入至少需要一次到多数派的往返加一次 fsync。跨地域部署的仲裁在每次提交时都要支付广域网延迟。
- **奇数集群规模**：3 节点容忍 1 个故障，5 节点容忍 2 个。4 节点仍然只容忍 1 个故障却需要更大的仲裁，因此偶数规模只增加成本而不增加容错。
- **领导者瓶颈**：所有写入都经过一个节点。扩展写能力要靠分片（Multi-Raft），而不是增加成员。
- **不容忍拜占庭故障**：一个有 bug 或恶意、对自身日志撒谎的节点可以破坏安全性。参与方互不信任时应使用 BFT 协议。
- **大概率不该自己实现**：正确的实现依赖许多微妙的不变量。优先使用久经考验的库（etcd-io/raft、hashicorp/raft、tikv/raft-rs），并用 Jepsen 风格的分区与崩溃故障注入工具进行验证。

## 总结

| 机制 | 保证 | 关键规则 |
|------|------|----------|
| 任期 | 每个任期最多一个领导者 | 更高任期总是胜出；见到即退位 |
| 选举限制 | 领导者完整性 | 只投票给日志足够新的候选人 |
| 一致性检查 | 日志匹配 | `prevLogIndex`/`prevLogTerm` 必须匹配 |
| 提交规则 | 已提交条目永不丢失 | 只对当前任期的条目计数副本 |
| 持久化 | 崩溃后不会重复投票 | 回复前 fsync |
| ReadIndex | 无需写盘的线性一致读 | 通过多数派确认领导权 |
| 联合 / 单节点变更 | 安全的重新配置 | 新旧多数派必须重叠 |
| PreVote / CheckQuorum | 分区下的活性 | 不打扰健康的领导者；失去仲裁就退位 |

Raft 的魅力在于每条规则都有简短而具体的理由。理解这些理由，你在看到 etcd 关于领导者切换或 fsync 变慢的告警时，就能立刻明白集群内部发生了什么。
