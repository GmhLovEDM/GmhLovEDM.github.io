---
title: "深入理解 CRDT：从计数器到协同文本的无冲突复制数据类型"
tag: architecture
description: CRDT 如何让各副本独立接受写入、无需协调也能收敛——强最终一致性、状态型 CRDT 背后的 join 半格数学、操作型与增量状态（delta-state）变体、计数器、寄存器、OR-Set 与 Map、用于协同编辑的序列 CRDT（RGA、YATA、Fugue）、墓碑与垃圾回收、Riak、Redis Active-Active、Automerge 与 Yjs 的实际用法、CRDT 不适用的场景，以及一个在随机 gossip 调度下验证收敛性的可运行模型
date: "2026-11-13T14:30:00.000Z"
---

## 目标

大多数复制方案处理冲突的方式是"不让冲突发生"：由单一 leader 给所有写入排序（Raft、Paxos、主从数据库），或者用锁让写入者轮流来。这在网络配合时没问题，可一旦网络不配合——手机在地铁里断网、某个数据中心被隔离、两个人同时在同一篇文档里打字——你就只能二选一：拒绝写入（牺牲可用性），或者先接受、事后再合并。

无冲突复制数据类型（Conflict-free Replicated Data Types，CRDT）走的是第二条路，但去掉了"事后合并"的麻烦：它们被设计成**只要两个副本看到了同一组更新，它们的状态就一定相同，与更新到达的顺序无关**。没有 leader，没有共识轮次，也不需要人工合并。

本文包括：

1. 强最终一致性，以及它与"最终一致性"的区别。
2. 状态型 CRDT 与 join 半格规则（合并满足交换律、结合律、幂等性）。
3. 操作型与增量状态型 CRDT，以及它们各自对网络的要求。
4. 核心类型：G-Counter、PN-Counter、LWW-Register、MV-Register、OR-Set、Map。
5. 用于协同文本的序列 CRDT：RGA、YATA（Yjs）、Fugue 与交错问题。
6. 元数据膨胀、墓碑与垃圾回收。
7. 真实系统：Riak、Redis Active-Active、Automerge、Yjs，以及 Figma"受 CRDT 启发"的设计。
8. 什么时候不该用 CRDT。

## 1. 强最终一致性

普通的*最终一致性*只承诺：如果写入停止，副本最终会达成一致。它不说明*怎么*达成一致，所以实际系统往往会外挂一个冲突解决策略——常见的是按墙上时钟"最后写入者胜出"（LWW），这会悄无声息地丢数据（墙上时钟为什么不可信，可以参考前面关于分布式时钟的文章）。

Shapiro、Preguiça、Baquero 和 Zawirski 在 2011 年的论文 *Conflict-free Replicated Data Types* 中形式化了一个更强的保证：**强最终一致性（Strong Eventual Consistency，SEC）**。

- **最终送达**：在一个正确副本上应用的更新，最终会在所有正确副本上应用。
- **收敛**：应用了同一*集合*更新的副本，状态立即等价，而不是"最终"等价。
- **终止**：每个方法调用都在本地完成。

关键词是*集合*。顺序和重复都无所谓。这正是 CRDT 副本能在分区期间接受写入、之后再 gossip 出去、依然确定性收敛的原因。

SEC 仍然比线性一致性弱。CRDT 无法保证"余额永不为负"或"用户名唯一"，因为这类不变量要求副本在接受写入*之前*就达成一致。CAP 依然成立：CRDT 选择了 AP，只是让合并变得有章可循。

## 2. 状态型 CRDT（CvRDT）

状态型 CRDT 的副本维护本地状态，并定期把*整个状态*发给对端，对端将其合并进自己的状态。只要状态构成一个 **join 半格**，并且合并计算的是最小上界（join，记作 ⊔），收敛就有保证：

| 性质 | 定律 | 意义 |
| --- | --- | --- |
| 交换律 | a ⊔ b = b ⊔ a | gossip 的顺序无关紧要 |
| 结合律 | (a ⊔ b) ⊔ c = a ⊔ (b ⊔ c) | 分组、转发方式无关紧要 |
| 幂等性 | a ⊔ a = a | 重复投递无害 |

此外，每次本地更新都必须是**膨胀的（inflationary）**：只能让状态在偏序中"向上"移动。满足这些规则后，网络可以随意重排、重复、延迟消息——只要最终送达即可。这就是状态型 CRDT 特别适合 gossip 协议和不可靠链路的原因。

### G-Counter

最简单而实用的例子是只增计数器。每个副本在一个 map 里拥有一个槽位，只递增自己的槽位。合并取逐元素最大值，值为所有槽位之和。

```python
class GCounter:
    def __init__(self, rid):
        self.rid, self.p = rid, {}           # 副本 id -> 计数

    def inc(self, n=1):
        self.p[self.rid] = self.p.get(self.rid, 0) + n

    def value(self):
        return sum(self.p.values())

    def merge(self, other):
        for k, v in other.p.items():
            self.p[k] = max(self.p.get(k, 0), v)
```

`max` 满足交换、结合、幂等，递增只会让槽位变大，所以定律成立。对比一个诱人的替代方案：只存一个整数，冲突时按时间戳取胜者。两个副本都读到 0、都写入 1，LWW 保留 1——丢了一次递增。在文末的可运行模型里，两次递增后 LWW 版本得到 1，而 G-Counter 得到 2。

### PN-Counter

要支持递减，就维护两个 G-Counter：P 记录递增，N 记录递减，值 = sum(P) − sum(N)。不能直接让某个槽位变小，因为更小的值在合并时会输给 `max`。

## 3. 操作型与增量状态型 CRDT

状态越大，传整个状态就越贵。有两种替代方案。

**操作型（CmRDT）**：副本广播*操作*（"加 3"、"在 id 42 之后插入 'x'"）。并发操作必须可交换，但对网络的要求更严格：每个操作必须**恰好送达一次**，并且通常要按**因果顺序**（一个操作只能在它依赖的操作之后应用）。这通常需要一个基于向量时钟或显式依赖追踪的可靠因果广播层。消息小，但投递难。

**增量状态 CRDT（delta-state）**（Almeida、Shoker、Baquero，2018）是务实的折中：一次更新产生一个很小的 *delta 状态*——它本身也是半格中的元素——可以用同一个 join 函数合并。delta 可以像完整状态一样被批量、重复、乱序投递，体积却和操作差不多。大多数生产级 CRDT 库和数据库用的就是这种方式或其近亲。

| 方式 | 消息大小 | 网络要求 | 典型用途 |
| --- | --- | --- | --- |
| 状态型 | 整个状态 | 仅需最终送达 | gossip、小对象 |
| 操作型 | 单个操作 | 恰好一次、因果有序 | 带中继服务器的协同编辑器 |
| 增量状态型 | 小 delta | 最终送达（部分类型需因果） | 数据库、同步引擎 |

## 4. 核心类型

### 寄存器：LWW 与多值

**LWW-Register** 存储 (值, 时间戳)，保留时间戳更大的那个，平局时按副本 id 决定。它是合法的 CRDT——全序上的 `max` 就是一个 join——但它*选择*丢弃并发写入。这对"最近在线时间"字段没问题，对购物车就是错的。时间戳应该用混合逻辑时钟（HLC），而不是原始墙上时钟。

**多值寄存器（MV-Register）** 保留*所有*并发值，用版本向量打标签，返回一个集合。当一次写入因果上晚于另一次时，旧值被丢弃；当两者并发时，都会保留，由应用（或用户）来决定。Amazon Dynamo 的购物车就是这样做的，把"兄弟值（siblings）"暴露给应用，Riak 也沿用了这一思路。

### 集合：为什么"删除"很难

**G-Set**（只增集合，合并 = 并集）很简单。问题出在删除：如果 A 删除了 `x`，而 B 同时添加了 `x`，合并后的集合里该不该有 `x`？朴素的 **2P-Set** 维护一个添加集和一个删除集（墓碑），被删过的元素永远不能再回来——这会让用户很困惑。

**观察删除集合（OR-Set）** 给出了符合直觉的行为。每次添加都生成一个唯一标签；删除只移除删除者*观察到*的那些标签。并发的添加带着一个删除者从没见过的新标签，所以它会保留下来：**添加优先（add wins）**。

```python
class ORSet:
    def __init__(self, rid):
        self.rid, self.n = rid, 0
        self.adds, self.tombs = set(), set()   # (元素, 标签) 的集合

    def add(self, e):
        self.n += 1
        self.adds.add((e, (self.rid, self.n)))  # 全局唯一标签

    def remove(self, e):
        self.tombs |= {t for t in self.adds if t[0] == e}  # 只删已观察到的标签

    def value(self):
        return {e for (e, _) in self.adds - self.tombs}

    def merge(self, other):
        self.adds |= other.adds
        self.tombs |= other.tombs
```

这个直白的版本会永久保留所有墓碑。优化版 OR-Set（Bieniusa 等，2012，"An optimized conflict-free replicated set"）用每副本一个版本向量、每个存活元素一个"dot"来代替墓碑，删除一旦被所有人看到就不再占用空间。Riak 的集合和 Map 用的就是这种 dotted version vector 方法。

也存在删除优先（remove-wins）的集合；选择 add-wins 还是 remove-wins 是关于业务*语义*的决定，而不是技术问题。

### Map 与 JSON

Map CRDT 是从键到嵌套 CRDT 的映射，键集合采用 OR-Set 风格，合并递归进行。Kleppmann 与 Beresford 2017 年的论文 *A Conflict-Free Replicated JSON Datatype* 把它推广到带列表的任意嵌套 JSON——这是 Automerge 的理论基础。难点在于：一个副本删除了某个键，另一个副本同时修改了该键下的字段，结果如何？JSON CRDT 通常会复活被修改的子树（"更新优先"策略），这同样是设计选择。

## 5. 序列 CRDT：协同文本

文本是 CRDT 出名的地方，也是最难的地方。问题在于位置："在下标 5 处插入"在看到了不同插入的副本上意思不同。操作转换（OT，Google Docs 使用）会针对并发操作改写下标，通常需要中心服务器来排序。序列 CRDT 则给**每个字符分配一个唯一且不可变的标识符**，插入操作相对于标识符而不是下标来表达。

- **RGA**（Replicated Growable Array，Roh 等，2011）：每次插入记录其左邻居的 id；在同一邻居后的并发插入按 (Lamport 时间戳, 副本 id) 排序，新的在前。删除留下墓碑，以便后续操作还能引用该 id。
- **YATA**（Nicolaescu 等，2016），**Yjs** 背后的算法：每个条目记录插入时的左、右两个 origin，从而为并发插入给出明确的顺序，并让 Yjs 把同一客户端写入的相邻条目合并成紧凑的连续块。
- **Logoot / LSEQ / Treedoc**：分配稠密、可排序的位置标识（类似分数索引），排序不需要墓碑，代价是标识符会变长。
- **Fugue**（Weidner 与 Kleppmann，2023）：专为最小化**交错**而设计。

交错是经典异常：Alice 输入 "Hello"，Bob 同时在同一位置输入 "World"，糟糕的算法可能产生 "HWeolrllod"。Kleppmann 等人 2019 年的论文 *Interleaving anomalies in collaborative text editors* 指出 Logoot 和 LSEQ 会让正向输入的文本交错，而 RGA 在某些反向输入的情况下也会交错。Fugue 证明了"最大非交错"，已被一些较新的库采用；Automerge 的序列类型构建在 RGA 之上。

让这些算法变得实用的是工程，而不是数学。早期 CRDT 编辑器每个字符一个对象，比 OT 慢几个数量级。现代实现把字符连续块存在以 (客户端, 时钟) 区间为键的 B 树或跳表里，用紧凑的列式格式编码历史（Automerge 2.x），并用 Rust/WASM 运行。Joseph Gentle 2021 年的文章 "5000x faster CRDTs"，以及他后来与 Kleppmann 合作的 *eg-walker*（2024），都很好地讲述了这段优化历程。

## 6. 元数据与垃圾回收

CRDT 用元数据换掉了协调。需要提前规划的成本：

1. **计数器和向量中的副本 id**。G-Counter 为每个写过的副本保留一个槽位。如果有数百万个短生命周期的浏览器会话，就必须复用 id，或者把它们折叠到服务端 id 下。
2. **墓碑**。被删除的序列条目和 observed-remove 标签要一直保留，直到可以安全丢弃。"安全"意味着所有副本都已看到这次删除——这是一个*因果稳定性*条件，需要知道完整的成员列表，而这恰恰是 CRDT 想避免的协调。系统通常会折中：只在知道所有活跃对端的服务器上做压缩，或者丢弃某个时间窗口之前的历史，强制非常陈旧的客户端从快照重新同步。
3. **历史**。Automerge 按设计保留完整历史（用于时间回溯和 diff）；Yjs 只保留合并所需的部分，需要快照时可以关闭垃圾回收。

一个实用的心智模型：CRDT 的*写入*很便宜，账单以状态大小的形式到来。要在真实编辑会话之后测量文档大小，而不是在刚导入之后。

## 7. 真实系统中的 CRDT

- **Riak（2.0+）** 以服务端数据类型提供计数器、集合、Map、寄存器和标志位，基于 dotted version vector，应用代码不再需要自己写兄弟值合并逻辑。
- **Redis Enterprise Active-Active**（CRDB）跨区域复制，按数据类型采用 CRDT 语义：计数器累加合并，集合采用 add-wins 的观察删除语义，字符串采用最后写入胜出。每个区域都能以本地延迟接受写入。
- **Azure Cosmos DB** 的多区域写入默认提供最后写入胜出策略，也支持自定义合并存储过程——这提醒我们，很多产品默认就是 LWW，更丰富的语义需要主动选择。
- **Automerge 和 Yjs** 是本地优先（local-first）应用和协同编辑器的主要开源库。Yjs 为 ProseMirror、CodeMirror、Monaco、Quill 等提供了绑定；Automerge 专注于带完整历史的 JSON 文档模型。2019 年的文章 *Local-first software*（Kleppmann、Wiggins、van Hardenberg、McGranaghan）阐述了动机：应用可以离线工作、跨设备同步，并把数据保存在用户自己的机器上。
- **Figma** 把它的多人协作系统（Evan Wallace，2019）描述为*受 CRDT 启发*，但以中心服务器为权威：对象上按属性做最后写入胜出，冲突的编辑由服务器排序。有服务器就能跳过 CRDT 最难的问题（垃圾回收、序列排序）——这是"只取所需"的好例子。

## 8. 什么时候不该用 CRDT

- **跨副本不变量**。唯一性、非负余额、库存上限、类外键约束都需要协调。用共识或单写入者，或者组合使用：大多数字段用 CRDT，受约束的那个字段用协调过的"预留"（这就是 *bounded counter* 的思路，Balegas 等 2015，预先把额度分给各副本）。
- **"合并了"不等于"正确"**。CRDT 保证的是一致，而不是意图。两个人同时把同一句话改成不同意思，会收敛成*某个*结果——可能是一句废话。UI 上的辅助（在线状态、光标、评论）和算法同样重要。
- **中心服务器始终可达时**。如果每个客户端都在线、服务器反正要给写入排序，那么服务器权威模型（或 OT）更简单，元数据也更少。
- **大二进制对象**。合并没有意义；按对象做 LWW，或使用内容寻址的版本。

### 快速决策表

| 需求 | 合适的方案 |
| --- | --- |
| 离线优先应用、跨设备同步 | Automerge / Yjs |
| 多区域写入计数器或集合 | 数据库 CRDT 类型（Riak、Redis Active-Active） |
| 有中心服务器的实时编辑器 | Yjs，或服务器排序的 OT |
| 强不变量（金额、库存、唯一性） | 共识 / 单 leader，或 bounded counter |
| 状态、最近在线时间等"最近值"字段 | 配合混合逻辑时钟的 LWW-Register |

## 9. 可运行的收敛模型

下面的脚本让 4 个副本执行 400 步随机操作——本地更新与随机的部分 gossip 交替进行——然后每个副本以随机顺序合并所有其他副本，并检查所有最终状态是否完全相同。对前面的 G-Counter 和 OR-Set 各重复 200 种随机调度，同时演示 add-wins，并与朴素的 LWW 计数器对比。

```python
import random

def run(cls, ops, replicas=4, steps=400, seed=0):
    rnd = random.Random(seed)
    rs = [cls(i) for i in range(replicas)]
    for _ in range(steps):
        r = rnd.choice(rs)
        if rnd.random() < 0.3:
            r.merge(rnd.choice(rs))       # 随机的部分 gossip
        else:
            ops(r, rnd)
    for r in rs:                          # 最后一轮反熵，随机顺序
        order = rs[:]; rnd.shuffle(order)
        for o in order:
            r.merge(o)
    return rs

def counter_ops(r, rnd): r.inc(rnd.randint(1, 3))
def set_ops(r, rnd):
    e = rnd.choice("abcde")
    (r.add if rnd.random() < 0.6 else r.remove)(e)

# state()：可哈希的快照，例如 GCounter 用 tuple(sorted(self.p.items()))
for name, cls, ops in [("GCounter", GCounter, counter_ops),
                       ("ORSet", ORSet, set_ops)]:
    ok = sum(len({r.state() for r in run(cls, ops, seed=s)}) == 1
             for s in range(200))
    print(name, "converged in", ok, "/ 200 random schedules")

a, b = ORSet("A"), ORSet("B")
a.add("x"); b.merge(a)
b.remove("x"); a.add("x")                 # 并发的删除与重新添加
a.merge(b); b.merge(a)
print("add-wins:", a.value(), b.value())

# 朴素计数器：两个副本都读到 0 并写入 1，LWW 只保留其中一次
lww = max([(1, 1), (1, 2)], key=lambda vt: vt[1])[0]
g1, g2 = GCounter("A"), GCounter("B"); g1.inc(); g2.inc(); g1.merge(g2)
print("LWW counter after two increments:", lww, " GCounter:", g1.value())
```

在 CPython 3 上的输出：

```text
GCounter converged in 200 / 200 random schedules
ORSet converged in 200 / 200 random schedules
add-wins: {'x'} {'x'}
LWW counter after two increments: 1  GCounter: 2
```

注意这个模型*不需要*什么：不需要消息有序，不需要去重，不需要 leader。把一个副本和自己合并，或者重复合并同一个对端，什么都不会改变——这就是幂等性。这种健壮性正是 CRDT 的全部价值所在。

## 总结

- CRDT 提供**强最终一致性**：看到同一组更新的副本状态相同，与顺序和重复无关。
- 状态型 CRDT 需要满足交换、结合、幂等的合并以及膨胀式更新；操作型 CRDT 需要恰好一次的因果投递；增量状态型 CRDT 兼顾了小消息和宽松的网络要求。
- 语义是设计决策：LWW 还是多值寄存器、add-wins 还是 remove-wins 集合、更新优先的 Map。
- 序列 CRDT（RGA、YATA、Fugue）让协同文本无需中心排序器；现代实现借助连续块编码和紧凑历史已经非常快。
- 代价是元数据和墓碑，而且 CRDT 无法保证跨副本不变量——那种场景请使用协调。

## 参考资料

- Shapiro, Preguiça, Baquero, Zawirski. *Conflict-free Replicated Data Types*（SSS 2011）及 *A comprehensive study of Convergent and Commutative Replicated Data Types*（INRIA RR-7506, 2011）。
- Almeida, Shoker, Baquero. *Delta State Replicated Data Types*. Journal of Parallel and Distributed Computing, 2018.
- Bieniusa et al. *An Optimized Conflict-free Replicated Set*. arXiv:1210.3368, 2012.
- Kleppmann, Beresford. *A Conflict-Free Replicated JSON Datatype*. IEEE TPDS, 2017.
- Roh, Jeon, Kim, Lee. *Replicated abstract data types: Building blocks for collaborative applications*. JPDC, 2011（RGA）。
- Nicolaescu et al. *Near Real-Time Peer-to-Peer Shared Editing on Extensible Data Types*. GROUP 2016（YATA / Yjs）。
- Kleppmann et al. *Interleaving anomalies in collaborative text editors*. PaPoC 2019.
- Weidner, Kleppmann. *The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing*. arXiv:2305.00583, 2023.
- Kleppmann, Wiggins, van Hardenberg, McGranaghan. *Local-first software: You own your data, in spite of the cloud*. Onward! 2019.
- Balegas et al. *Extending Eventually Consistent Cloud Databases for Enforcing Numeric Invariants*. SRDS 2015（bounded counter）。
- DeCandia et al. *Dynamo: Amazon's Highly Available Key-value Store*. SOSP 2007.
- Evan Wallace. *How Figma's multiplayer technology works*. Figma blog, 2019.
- 文档：automerge.org、docs.yjs.dev、Redis Active-Active 文档、Riak 数据类型文档。
