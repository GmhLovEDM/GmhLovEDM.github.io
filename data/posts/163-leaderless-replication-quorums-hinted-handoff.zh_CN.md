---
title: "深入无主复制：法定人数、宽松法定人数、Hinted Handoff 与反熵"
tag: architecture
description: 无主复制如何在节点故障时仍保持可写——偏好列表与协调者、R + W > N 真正保证的和保证不了的、向量时钟与兄弟版本调和、宽松法定人数与 Hinted Handoff、读修复、Merkle 树反熵、Cassandra / Riak / DynamoDB 与 Dynamo 论文的分叉，以及一个可运行模型，用来衡量可用性、陈旧读和修复流量
date: "2026-11-18T12:45:00.000Z"
---

## 目标

大多数人第一次接触复制，看到的是一个主节点加一组从节点。写请求进主节点，从节点回放日志；主节点挂了，再选出一个新的。若你想要单一的写入顺序，这是很好的模型。但若产品要求是“就算本该存放这份数据的几台机器此刻连不上，这次写入也必须被接受”，它就没那么合适。

Amazon 2007 年的 Dynamo 论文，正是为第二种要求写的。购物车必须在磁盘故障、路由抖动或机房故障时仍能接受加购；论文开头举的就是这个例子。Dynamo，以及受它启发的那一类系统，并不等待领导者。偏好列表里任何一台健康的节点都可以协调一次写入。可用性靠三个整数来调：**N**、**W** 和 **R**。副本之间出现分歧被当成常态，再用后续机制收口：查询路径上的 **读修复（read repair）**，节点恢复后的 **Hinted Handoff**，以及后台的 **Merkle 树反熵**。

本文会讲到：

1. 为什么要做无主复制，它和 Raft 一类的复制有何不同。
2. 偏好列表、虚拟节点，以及协调者。
3. 法定人数，以及 `R + W > N` 真正保证的——和保证不了的。
4. 并发写入、向量时钟，以及应用层调和。
5. 宽松法定人数与 Hinted Handoff，以及它们打开的一致性缺口。
6. 读修复，以及它为什么只取决于这次读真正看到的那些副本。
7. 用 Merkle 树做反熵。
8. Cassandra、Riak 和 DynamoDB 各自如何从 2007 年的设计里分出去。
9. 什么时候不该用无主复制。
10. 一个可运行的模型，在 8 节点环上衡量写入可用性、陈旧读和修复流量。

## 1. 为什么要做无主复制

Raft 这类共识协议给你一份单一、可线性化的日志。对元数据、配置，以及对“绝不能被应用两次”的更新来说，这是舒服且正确的默认选择。代价写在协议里：一次写入只有在**当前投票集合的多数派**接受后才算成功；领导者丢失之后，客户端要等新的选举完成。少数派分区无法推进。这些是安全性质，不是意外副作用。

无主复制做的是相反的赌注。一个键没有预先指定的主副本。协调者——常常只是偏好列表里第一个健康的节点——把写入发给若干副本，并等待其中 **W** 个持久化成功。若列表里本该排在第二、第三的那两台机器挂了，**宽松（sloppy）** 配置允许改用再往下的健康机器，并记住这份副本只是“替别人代管”。在会让有主法定人数停摆的故障模式下，系统仍然可写。

代价是一致性。两个协调者可以同时接受对同一键的写入。随后的一次读可能看到其中之一、两者都看到，或在一段时间里什么都看不到，这取决于它联系了哪些副本，以及修复有没有跑完。设计的其余部分，就是用来**限制**这扇窗口，并在系统无法独自裁决时，把合并版本的权利交给应用。

## 2. 偏好列表、虚拟节点和协调者

2007 年的 Dynamo 论文建立在一致性哈希之上，本博客在[更早的一篇](/blog/144-consistent-hashing-data-partitioning/zh_CN)里已经走过这条环。键和节点落在同一个环上。Dynamo 并不把每台机器映射成环上的一个点：它使用**虚拟节点**，每台物理主机拥有许多 token。主机加入或退出时，负载会摊到许多邻居上，而不是全部砸给顺时针方向的下一个节点。

对任意一个键，沿环顺时针走，收集互不相同的**物理**节点。其中前 **N** 个是该键的预定副本；论文把这条更长的列表叫做**偏好列表（preference list）**。列表有意长于 N，这样协调者就可以跳过已经宕机的节点。虚拟节点在这里很关键：环上前 N 个位置可能属于不足 N 台不同的机器，所以必须继续往前走，直到凑齐 N 台真实主机。

**N** 是按 Dynamo 实例配置的。一个键的协调者通常是 top N 里的第一个。客户端有两种到达方式：经通用负载均衡——可能先落到一台随机节点，若它不在 top N 里再**转发**；或用感知分区的客户端库，直接和协调者通信。协调者先把新版本写到本地，再发给其他副本，直到有 **W** 个节点（当它自己也是副本之一时，包括自己）完成持久化。因此一次写入的延迟是这 W 个回复里最慢的那个，这也是 W 通常小于 N 的原因；读路径上的 **R** 也是同样的道理。

## 3. 法定人数，以及 R + W > N 真正保证什么

经典规则很短。若每次写入都等待固定 N 副本里的 W 个，每次读取都等待同一集合里的 R 个，并且 `R + W > N`，那么这两个集合至少重叠一个节点。若再比较版本并留下最新的，一次读就应当看到最近一次已完成的写。

这句话里藏着若干假设，生产系统出事也往往出在这些地方：

- 这 N 个节点是**固定成员**。一旦写入被允许使用“更长列表里前 N 个健康节点”，一次写入法定人数和之后的一次读取法定人数就可能完全不相交。这就是第 5 节里的宽松法定人数缺口。
- 存在**唯一的最新写入**。并发写入产生的是兄弟版本，不是一个独一无二的最新值。Last-write-wins 可以挑一个、丢掉另一个；它并不能让“重叠”这个论证变得诚实。
- 副本真的**给出了应答**。W 个节点确认成功、随后磁盘又丢了，这并不算一次 W 持久的写入。
- 读者会做**调和**。若你在 R 个回复里直接返回第一个、不看版本，重叠帮不上忙。

Dynamo 论文报告的常见生产配置是 `(N, R, W) = (3, 2, 2)`。若应用希望只要有一台节点能把数据持久化下来就接受写入，可以把 W 设为 1；论文写得很清楚，生产环境里大多数 Amazon 服务为了耐久性会选择更高的 W。论文引用的、使用 Dynamo 的服务的典型 SLA，是 99.9% 的读写在 300 ms 内完成。

本文末尾的可运行模型使用 8 节点环，N = 3，240 个键。在健康集群上，每个键先写一次再读一次，得到下面这张表。“陈旧”表示被联系的那 R 个副本调和之后，并不包含刚刚已经成功的那次写入：

```
(W,R)     fresh    stale
(1,1)        81      159
(2,1)       155       85
(1,2)       159       81
(2,2)       240        0
(3,1)       240        0
(1,3)       240        0
(2,3)       240        0
(3,3)       240        0
```

`(1, 1)` 在 240 个键里有 159 个陈旧，大约三分之二——读选中的那一个副本，恰好不是写选中的那一个。`(2, 1)` 和 `(1, 2)` 大约错过三分之一，也就是 R 与 W 中较小的那边没有覆盖到的那一个副本。所有满足 `R + W > 3` 的配置，240 个键全部新鲜。规则是有效的，只要它的假设成立。

同一个模型——除非打开宽松模式，W 仍然从*预定的* N 个副本里收集——也给出了权衡里可用性的那一侧。故障按键施加（写入时该键的 k 个预定副本宕机，随后恢复），因此数字不会被相互重叠的环干扰：

```
pattern                W=2 strict   W=2 sloppy   W=1 strict   W=1 sloppy
all healthy               240/240      240/240      240/240      240/240
1 intended down           240/240      240/240      240/240      240/240
2 intended down             0/240      240/240      240/240      240/240
all 3 intended down         0/240      240/240        0/240      240/240
```

一旦两台预定副本宕机，严格的 W = 2 写入就凑不齐两个确认。宽松的 W = 2 写入仍然可以，只要再沿环往下走。这正是宽松法定人数的意义，也是一致性问题的起点。

## 4. 并发写入、向量时钟和兄弟版本

Dynamo 在每个版本上保存一个**向量时钟**：一份 `(node, counter)` 对的列表。客户端更新一个键时，必须把先前一次读返回的 **context** 带回来，好让协调者递增自己的计数，并记录本次写入覆盖的是哪个版本。若时钟 A 在每个节点上都不大于时钟 B，并且至少在一个节点上严格更大，A 就是 B 的祖先，可以丢弃——论文称之为**语法调和（syntactic reconciliation）**。若谁也支配不了谁，这两个版本就是**并发的**。系统会同时保留它们，并交给客户端做**语义调和（semantic reconciliation）**。

论文里反复使用的例子是购物车。合并两份购物车是已加商品的并集，所以一次加购不会丢。同一种合并也可能让已经删除的商品重新出现。这是认真权衡过的取舍，不是论文忘了提的缺陷。

论文中对购物车服务做的 24 小时统计显示：99.94% 的请求只看到一个版本，0.00057% 看到两个，0.00047% 看到三个，0.00009% 看到四个。冲突很少见，但仍然是一等公民。Dynamo 也支持一种更简单的模式，用于会话状态：并发版本按物理时间戳做 **last write wins**。

若许多不同节点都来协调对同一键的写入，向量时钟会变长——失败把协调者推出 top N 时就会发生。Dynamo 会截断：每一对带一个时间戳，当对数达到某个阈值（论文的说法是“譬如 10”），就删掉最旧的一对。作者指出，这可能让后代关系无法再被准确重建，并且在撰写论文时，这个问题尚未在生产中出现。

模型里包含一个小的、确定的情形。某个键的预定副本是节点 0、1、2：先把 0 隔离，以 W = 1 写入 `"from-A"`；再让 0 宕机，由节点 1 和 2 以 W = 2 写入 `"from-BC"`。分区恢复后，一次 R = 3 的读会返回两个版本，时钟分别是 `((0, 1),)` 和 `((1, 1),)`，二者并发。用时间戳决胜会丢掉其中一次写入；用合并函数则可以两者都留。

本博客在[讨论分布式时间的那一篇](/blog/155-distributed-clocks-lamport-vector-hlc-truetime/zh_CN)里已经讲过向量时钟的代数。这里真正重要的是建立在它之上的策略：保留兄弟版本，还是把它们折叠掉，以及对你愿意丢失的更新保持诚实。

## 5. 宽松法定人数与 Hinted Handoff

若 Dynamo 使用严格法定人数，一两个预定副本的临时故障要么导致写入被拒绝，要么降低耐久性。对购物车这一类负载，论文认为这不可接受。于是它采用**宽松法定人数（sloppy quorum）**：每次读和写都发给偏好列表里前 N 个*健康*节点，而这些节点“未必总是沿一致性哈希环走到的前 N 个节点”。

在论文的图里，N = 3，节点 A 暂时不可达。本该落在 A 上的那份副本被送到节点 D，并在元数据里标明 A 才是预定接收者。D 把这些带提示的副本放在一个**独立的本地数据库**里，并定期扫描。A 恢复后，D 把副本交给 A，再删除本地那一份，这样副本总数不会悄悄膨胀。这个交付步骤就是 **Hinted Handoff**。

一致性缺口在“两个预定副本都宕机”时最容易看清。设偏好列表以 `A, B, C, D, …` 开头。一次宽松的 W = 2 写入落在 C，以及 D（D 为 A 持有 hint）。然后 A 和 B 在 D 还没来得及交付之前恢复了。一次严格的 R = 2 读现在从 `{A, B, C}` 里任选两个。子集 `{A, B}` 与写入集合 `{C, D}` 完全不相交。两个副本的组合里，有三分之一是陈旧的。

模型度量了这个缺口，并且刻意不交付 hint：

```
mode                            W,R  down  wrote  fresh  stale
sloppy write, strict read       2,2     2    240    163     77
sloppy write, strict read       2,3     2    240    240      0
sloppy write, strict read       2,1     2    240     78    162
sloppy write, strict read       2,2     3    240      0    240
sloppy write, strict read       2,3     3    240      0    240
```

两个预定副本故障并恢复之后，R = 2 时 240 个键里有 77 个陈旧（32%），与三分之一的论证相符。把 R 提高到 3，总会打到真正接受了写入的预定副本 C，陈旧数降为零。若三台预定副本当时都宕机，宽松写入就*只*活在替补节点上；它们恢复之后，对预定集合的每一次读都是陈旧的，即使 R = 3 也一样。成员关系一旦滑出原来的 N，`R + W > N` 并不是一句可以反复念的咒语。

还有一个细节，后面讲修复时还会再遇到：一次宽松的 W = 2 写入、在两个预定节点宕机时，只会留下*一个* hint（在 D 上，替 A 代管）。B 永远不会得到副本，C 是唯一持有数据的预定副本。Handoff 能修好 A，修不好 B。之后的 R = 2 读仍然可以全部新鲜，因为 `{A, B, C}` 的每一个二元子集现在都包含 A 或 C——但在读修复或反熵把数据拷到 B 之前，B 依然是空的。

## 6. 读修复

Dynamo 的 get 里，协调者把请求发给相关副本，等待 R 个回复并调和版本。它也可以在后台继续等更慢的回复。若其中有陈旧版本，就把最新版本写回那些错过更新的节点。论文称之为 **read repair**，并指出这能减轻反熵协议的工作。

Cassandra 把这一机制做得更可见，也可配置。协调者通常向一个较快的副本发一次完整读，再向为达到一致性级别所需的其他副本发 **digest** 读。若 digest 不一致，它会取回缺失的数据，并且默认会**阻塞**客户端，直到修复写入达到该一致性级别。Cassandra 4.0 增加了表级选项 `read_repair`：`BLOCKING`（默认）用来保持**单调法定人数读**——即使一次失败的法定人数写入只落到少数副本上，第二次法定人数读也不应看到比第一次更旧的值；`NONE` 只调和协调者看到的内容，不向外推修复，当查询只读取一起写入的某个分区中的一部分时，这更能保持分区级写入的原子性（CASSANDRA-14635）。

读修复只取决于这次读联系到的副本。在模型里，宽松 W = 2 写入、两个预定副本先宕再恢复之后，带修复的严格 R = 2 读会这样收敛：

```
pass 1    fresh=151  stale=89
pass 2    fresh=208  stale=32
pass 3    fresh=229  stale=11
```

一次读若联系到 C 加上一个已恢复的空节点，就能把值拷到那个节点上。一次读若只联系到两个已恢复的空节点，它变不出缺失的值，也不会碰到 C。这些键会一直陈旧，直到之后某次读碰巧包含那份活副本。三轮之后，240 个键里仍有 11 个陈旧，和 `(1/3)^3 × 240 ≈ 9` 是同一量级。

当三台预定副本都曾宕机时，活副本只在 hint 持有者上，对预定集合的严格读根本联系不到它们。三轮修复仍然是 `fresh=0, stale=240`。读修复救不回读集合看不见的值。

## 7. 用 Merkle 树做反熵

Hinted Handoff 针对的是*临时*故障。若 A 消失得太久，D 已经丢掉了 hint，或 D 自己也丢了，预定副本集合就可能永远分叉，除非有某种机制去比较整棵数据树，而不只是最近几次写入。Dynamo 用 **Merkle 树**（哈希树）走这条**反熵**路径。每个叶子是某个键值的哈希，每个父节点是其子节点的哈希。两个副本交换根哈希，只在哈希不同的分支里递归，并只传输这些分支下的键。它们不必为了找出少量不一致，就把整份数据集都搬过去。

模型为每个预定副本范围建一棵树（在这个 8 节点、240 键的环上，每个范围 30 个键），并只遍历失配的子树。在对每个键做完一次健康的 W = 3 写入后，再从某个预定副本上删掉少数键，然后在 24 对副本之间跑反熵：

```
divergent keys    hashes exchanged    keys copied    naive key compares
             1                    60              2                 5760
             6                   240             12                 5760
            24                   376             48                 5760
            60                   664            120                 5760
```

一个分叉的键花费 60 次哈希交换和两次拷贝——之所以是两次，是因为被删的那份会分别与同组另外两个副本比较——对照 5,760 次朴素的逐键比较（24 对 × 240 个键）。树的意义就在于这笔节省。

在*预定*副本之间做 Merkle 修复是否够用，取决于活副本住在哪里：

```
situation (after sloppy W=2, then recovery)
                          fresh  stale  notes
2 intended down, no repair  151     89  R=2
then hinted handoff         240      0  240 hints；B 可能仍为空
Merkle on intended only     240      0  1912 次哈希，480 次拷贝；C 修复 A 和 B
3 intended down, no repair    0    240  值只活在替补节点上
Merkle on intended only       0    240  24 次根哈希，0 次拷贝；空树彼此相等
handoff, then Merkle        240      0  480 条 hint，再 480 次拷贝补齐 C
```

两个预定副本宕机时，C 仍然持有该值，因此即使还没做 handoff，在 `{A, B, C}` 上走一遍 Merkle 也能把集合修好。三个预定副本都宕机时，预定树上的内容是相等的，而且都是*空的*；它们之间的反熵没有东西可拷。必须先让 handoff 把带提示的副本送回家。2007 年的设计把这两种机制当成互补，而不是可以互相替代：handoff 处理短时故障，Merkle 处理 handoff 没赶上的那些情况。

## 8. Cassandra、Riak 和 DynamoDB 如何分道扬镳

Dynamo 论文是一份设计，不是一份标准。三个最常被提到的后继者，各自拿走了其中不同的部分。

**Riak KV** 在精神上最接近。它保留了无主协调、类似宽松回退的行为、在 `allow_mult` 打开时返回兄弟版本，以及建立在哈希树上的 **active anti-entropy**。因果元数据从向量时钟演进到了**带点的版本向量（dotted version vectors）**，把每次写入当作一个独特事件来追踪，从而在区分并发更新时，减少普通向量时钟可能带来的兄弟版本膨胀。

**Apache Cassandra** 在请求路径上是无主的——任何节点都可以当协调者——但它**并不**用 Dynamo 的宽松法定人数来定义 W 和 R。`ONE`、`QUORUM`（复制因子的多数）、`ALL`、`LOCAL_QUORUM`、`EACH_QUORUM` 这些一致性级别，都是对着*预定*副本计数的。若复制因子为 3 时你要求 `LOCAL_QUORUM`，必须有其中两台真正的副本确认；一条 hint 不算数。**Hint** 存放在协调者本地磁盘的 `$CASSANDRA_HOME/data/hints` 里，等目标节点回来后再重放。它们被明确写成**尽力而为**：默认的 `max_hint_window` 是 **3 小时**，超时后不再生成新的 hint；宕机更久的副本会一直不一致，直到读修复或一次完整 / 增量反熵修复。Cassandra 还选择了 **last-write-wins 时间戳**，而不是把兄弟版本交还给应用。当一次更新确实需要可线性化的 compare-and-set 时，**lightweight transactions** 会跑一轮 Paxos，而不是假装一次法定人数上的读改写就足够。

**Amazon DynamoDB** 于 2012 年发布，因为名字很容易和 2007 年的那套系统混在一起。Elhemali、Gallagher、Gordon、Idziorek 等人和同事在 USENIX ATC 2022 上的论文，是生产服务的权威描述。它的起源“来自原来的 Dynamo 系统”，但复制架构并不是一个宽松法定人数环。每个分区是一个跨不同可用区、三副本的**复制组**。这个组用 **Multi-Paxos** 做领导者选举和共识。只有领导者提供写入和强一致读；一旦**多数对等副本**把预写日志记录持久化，写入就被确认。健康的写入法定人数是来自不同可用区的**三副本中的两个**。最终一致读可以由任一副本提供。若某个存储副本不健康，领导者可以在几秒内加入一个 **log replica**——只保存最近日志、没有 B 树的 Paxos acceptor——这样写入法定人数可以先被满足，更重的 B 树拷贝再在后台继续。新选出的领导者在上一任领导者的**租约**过期之前，不会提供写入或强一致读。同一篇论文还写到，在 2021 年长达 66 小时的 Prime Day 期间，Amazon 各系统对 DynamoDB 的峰值达到每秒 **8920 万** 次请求，并保持个位数毫秒的性能。

也就是说：DynamoDB 保留了分区键值的形态，以及对可预测低延迟的要求，然后用领导者、租约和 Paxos，替换掉了宽松法定人数、向量时钟和 gossip。若你在推理“Dynamo 风格”的行为，必须先说清楚你指的是哪一个 Dynamo。

## 9. 什么时候不该用无主复制

无主复制用来让一个键在本该拥有它的机器并未全部在线时，仍然可写。若产品真正需要的是单一胜者、单一顺序，或一个绝不能被应用两次的谓词，它就是错误的工具。

对唯一约束、“恰好一个所有者”，以及丢失孪生写入就会变成正确性缺陷的更新，应该使用共识组、有主存储，或显式的 compare-and-set（Cassandra 的 lightweight transactions、etcd、ZooKeeper、以 Raft 为后盾的元数据服务、DynamoDB 的条件写入）。不要用 last-write-wins 和一个很短的 hint 窗口去遮盖这种需求。

跨多个键的事务，以及跨越分区的不变量，同样不适合。按键施加的宽松法定人数，给不了你一个跨键的一致切面。

最后，修复本身就是契约的一部分。若 Hinted Handoff 被关掉，hint 窗口经常过期，反熵修复也不跑，“最终一致”里的“最终”就没有引擎。模型把这一点写得很机械：三台预定副本都宕机时，它们之间的 Merkle 什么都不拷，对预定集合的读修复每一轮都是陈旧的，直到 hint 被送回家。

## 10. 一个可运行的模型

下面的脚本就是生成本文所有计数的模型。它是一个 8 节点环，N = 3，240 个键，包含向量时钟调和、严格与宽松放置、独立的 hint 存储、只修复一次读真正联系到的那些副本，以及在预定范围上的 Merkle 遍历。故障按键施加，这样相互重叠的偏好列表不会一次把整集群打停。

```python
#!/usr/bin/env python3
"""Leaderless replication model: quorums, sloppy quorums, hinted handoff, read repair and Merkle anti-entropy."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import hashlib
import random


N_REPLICAS = 3
N_NODES = 8
N_KEYS = 240


@dataclass(frozen=True)
class VectorClock:
    ticks: tuple[tuple[int, int], ...]

    def inc(self, node: int) -> "VectorClock":
        d = dict(self.ticks)
        d[node] = d.get(node, 0) + 1
        return VectorClock(tuple(sorted(d.items())))

    def merge(self, other: "VectorClock") -> "VectorClock":
        d = dict(self.ticks)
        for n, c in other.ticks:
            d[n] = max(d.get(n, 0), c)
        return VectorClock(tuple(sorted(d.items())))

    def dominates(self, other: "VectorClock") -> bool:
        if not other.ticks:
            return bool(self.ticks)
        d = dict(self.ticks)
        ge_all = True
        gt_one = False
        nodes = set(d) | set(dict(other.ticks))
        for n in nodes:
            a, b = d.get(n, 0), dict(other.ticks).get(n, 0)
            if a < b:
                ge_all = False
            if a > b:
                gt_one = True
        return ge_all and gt_one

    def concurrent_with(self, other: "VectorClock") -> bool:
        return self.ticks != other.ticks and not self.dominates(other) and not other.dominates(self)


@dataclass(frozen=True)
class Version:
    value: str
    clock: VectorClock


def reconcile(versions: list[Version]) -> list[Version]:
    kept: list[Version] = []
    for v in versions:
        if any(u.clock.dominates(v.clock) or u == v for u in kept):
            continue
        kept = [u for u in kept if not v.clock.dominates(u.clock)]
        if v not in kept:
            kept.append(v)
    return kept


def merkle_leaf(key: int, versions: list[Version]) -> str:
    payload = repr(sorted((v.value, v.clock.ticks) for v in versions)).encode()
    return hashlib.sha256(payload).hexdigest()


class Cluster:
    def __init__(self, n_nodes: int = N_NODES, n: int = N_REPLICAS, seed: int = 0) -> None:
        self.n_nodes = n_nodes
        self.n = n
        self.alive = [True] * n_nodes
        self.primary: list[dict[int, list[Version]]] = [dict() for _ in range(n_nodes)]
        self.hints: list[dict[int, tuple[int, list[Version]]]] = [dict() for _ in range(n_nodes)]
        self.rng = random.Random(seed)
        self.stats: dict[str, int] = defaultdict(int)
        self.truth: dict[int, list[Version]] = {}

    def preference(self, key: int) -> list[int]:
        start = key % self.n_nodes
        return [(start + i) % self.n_nodes for i in range(self.n_nodes)]

    def intended(self, key: int) -> list[int]:
        return self.preference(key)[: self.n]

    def first_healthy(self, key: int, count: int) -> list[int]:
        out: list[int] = []
        for node in self.preference(key):
            if self.alive[node]:
                out.append(node)
                if len(out) >= count:
                    break
        return out

    def _write_versions(self, node: int, key: int, incoming: list[Version], hinted_for: int | None) -> None:
        if hinted_for is None:
            current = self.primary[node].get(key, [])
            self.primary[node][key] = reconcile(current + incoming)
        else:
            current = self.hints[node].get(key, (hinted_for, []))[1]
            self.hints[node][key] = (hinted_for, reconcile(current + incoming))

    def _versions_on(self, node: int, key: int, include_hints: bool) -> list[Version]:
        got = list(self.primary[node].get(key, []))
        if include_hints and key in self.hints[node]:
            got.extend(self.hints[node][key][1])
        return reconcile(got)

    def put(
        self,
        key: int,
        value: str,
        w: int,
        sloppy: bool,
        context: VectorClock | None = None,
        coordinator: int | None = None,
    ) -> bool:
        intended = self.intended(key)
        dests = self.first_healthy(key, self.n) if sloppy else [x for x in intended if self.alive[x]]
        if coordinator is None:
            if not dests:
                self.stats["write_fail_no_coord"] += 1
                return False
            coordinator = dests[0]
        elif not self.alive[coordinator]:
            self.stats["write_fail_no_coord"] += 1
            return False
        clock = (context or VectorClock(())).inc(coordinator)
        ver = Version(value, clock)
        acks = 0
        missing = [x for x in intended if not self.alive[x]]
        for dest in dests:
            if dest in intended:
                self._write_versions(dest, key, [ver], None)
            else:
                target = missing[0] if missing else intended[-1]
                if missing:
                    missing.pop(0)
                self._write_versions(dest, key, [ver], target)
            acks += 1
            if acks >= w:
                break
        if acks >= w:
            self.stats["write_ok"] += 1
            self.truth[key] = reconcile(self.truth.get(key, []) + [ver])
            return True
        self.stats["write_fail_quorum"] += 1
        return False

    def get(self, key: int, r: int, sloppy: bool, read_repair: bool = False) -> list[Version] | None:
        intended = self.intended(key)
        dests = self.first_healthy(key, self.n) if sloppy else [x for x in intended if self.alive[x]]
        if len(dests) < r:
            self.stats["read_fail"] += 1
            return None
        order = dests[:]
        self.rng.shuffle(order)
        contacted = order[:r]
        collected: list[Version] = []
        for node in contacted:
            collected.extend(self._versions_on(node, key, include_hints=sloppy or node not in intended))
        result = reconcile(collected)
        if read_repair:
            for node in contacted:
                if node in intended:
                    self._write_versions(node, key, result, None)
                elif key in self.hints[node] or sloppy:
                    hinted_for = self.hints[node][key][0] if key in self.hints[node] else intended[0]
                    self._write_versions(node, key, result, hinted_for)
            self.stats["read_repair"] += 1
        self.stats["read_ok"] += 1
        return result

    def is_fresh(self, key: int, got: list[Version] | None) -> bool:
        if got is None:
            return False
        truth = self.truth.get(key, [])
        if not truth:
            return not got
        # Fresh if every current truth version is present, or is dominated by a returned version
        # (a later write subsumed it). Concurrent siblings must all appear.
        for t in truth:
            if any(g == t or g.clock.dominates(t.clock) or g.clock.ticks == t.clock.ticks for g in got):
                continue
            return False
        return True

    def deliver_hints(self) -> int:
        moved = 0
        for node in range(self.n_nodes):
            pending = list(self.hints[node].items())
            for key, (target, versions) in pending:
                if self.alive[target]:
                    self._write_versions(target, key, versions, None)
                    del self.hints[node][key]
                    moved += 1
        self.stats["hints_delivered"] += moved
        return moved

    def anti_entropy(self) -> tuple[int, int, int]:
        """Pairwise Merkle comparison of intended replicas; copy only divergent keys.

        Returns (pairs_compared, leaf_hashes_exchanged, keys_copied).
        """
        pairs = 0
        hashes = 0
        copied = 0
        # Group keys by the first intended node so each pairwise tree covers one range
        ranges: dict[int, list[int]] = defaultdict(list)
        for key in sorted(self.truth):
            ranges[self.intended(key)[0]].append(key)
        for owner, keys in ranges.items():
            if not keys:
                continue
            replicas = [node for node in self.intended(keys[0]) if self.alive[node]]
            if len(replicas) < 2:
                continue
            # Build per-replica leaf hashes
            leaves = {
                node: [merkle_leaf(k, self._versions_on(node, k, include_hints=False)) for k in keys]
                for node in replicas
            }

            def tree_hash(vals: list[str]) -> str:
                if not vals:
                    return hashlib.sha256(b"empty").hexdigest()
                if len(vals) == 1:
                    return vals[0]
                mid = len(vals) // 2
                return hashlib.sha256((tree_hash(vals[:mid]) + tree_hash(vals[mid:])).encode()).hexdigest()

            # Compare each pair: if roots differ, walk leaves (binary would prune; we count
            # a complete leaf walk only on mismatch, plus the root exchange always).
            for i, a in enumerate(replicas):
                for b in replicas[i + 1 :]:
                    pairs += 1
                    hashes += 1  # root exchange
                    ha, hb = tree_hash(leaves[a]), tree_hash(leaves[b])
                    if ha == hb:
                        continue
                    # Walk internal nodes in a binary tree, exchanging a hash only when a
                    # subtree mismatches. That is the Merkle saving versus sending every key.
                    def walk(lo: int, hi: int) -> None:
                        nonlocal hashes, copied
                        hashes += 2
                        chunk_a = tree_hash(leaves[a][lo:hi])
                        chunk_b = tree_hash(leaves[b][lo:hi])
                        if chunk_a == chunk_b:
                            return
                        if hi - lo == 1:
                            key = keys[lo]
                            merged = reconcile(
                                self._versions_on(a, key, False) + self._versions_on(b, key, False)
                            )
                            self._write_versions(a, key, merged, None)
                            self._write_versions(b, key, merged, None)
                            copied += 1
                            return
                        mid = lo + (hi - lo) // 2
                        walk(lo, mid)
                        walk(mid, hi)

                    walk(0, len(keys))
        self.stats["ae_pairs"] += pairs
        self.stats["ae_hashes"] += hashes
        self.stats["ae_copied"] += copied
        return pairs, hashes, copied

    def set_alive(self, nodes: list[int], alive: bool) -> None:
        for node in nodes:
            self.alive[node] = alive


def reset_stats(c: Cluster) -> None:
    c.stats = defaultdict(int)


def with_intended_down(c: Cluster, key: int, down_k: int):
    down = c.intended(key)[:down_k]
    for node in down:
        c.alive[node] = False
    return down


def restore(c: Cluster, down: list[int]) -> None:
    c.set_alive(down, True)


def write_all(c: Cluster, keys: range, w: int, sloppy: bool, prefix: str, down_k: int = 0) -> int:
    ok = 0
    for key in keys:
        down = with_intended_down(c, key, down_k) if down_k else []
        if c.put(key, f"{prefix}-{key}", w, sloppy):
            ok += 1
        restore(c, down)
    return ok


def read_all(c: Cluster, keys: range, r: int, sloppy: bool, read_repair: bool) -> tuple[int, int, int]:
    fresh = stale = failed = 0
    for key in keys:
        got = c.get(key, r, sloppy, read_repair=read_repair)
        if got is None:
            failed += 1
        elif c.is_fresh(key, got):
            fresh += 1
        else:
            stale += 1
    return fresh, stale, failed


def write_while_down(c: Cluster, keys: range, w: int, sloppy: bool, prefix: str, down_k: int) -> int:
    """Write each key while k of its intended replicas are down; leave those replicas up afterwards."""
    ok = 0
    for key in keys:
        down = with_intended_down(c, key, down_k)
        if c.put(key, f"{prefix}-{key}", w, sloppy):
            ok += 1
        restore(c, down)
    return ok


def availability_sweep() -> None:
    print("== write availability, N=3, 240 keys, 8 nodes (failures applied per key, then restored) ==")
    print(f"{'pattern':<28} {'W=2 strict':>12} {'W=2 sloppy':>12} {'W=1 strict':>12} {'W=1 sloppy':>12}")
    patterns = [
        ("all healthy", 0),
        ("1 intended down", 1),
        ("2 intended down", 2),
        ("all 3 intended down", 3),
    ]
    for label, down_k in patterns:
        row = []
        for w, sloppy in ((2, False), (2, True), (1, False), (1, True)):
            c = Cluster(seed=1)
            ok = write_all(c, range(N_KEYS), w, sloppy, "v1", down_k=down_k)
            row.append(f"{ok}/{N_KEYS}")
        print(f"{label:<28} {row[0]:>12} {row[1]:>12} {row[2]:>12} {row[3]:>12}")
    print()


def stale_after_recovery() -> None:
    print("== stale reads after k intended replicas drop, write, then those replicas recover (hints not delivered) ==")
    print(f"{'mode / (W,R) / down':<48} {'wrote':>6} {'fresh':>8} {'stale':>8} {'failed':>8}")
    configs = [
        ("strict write+read", False, False, 2),
        ("sloppy write, strict read", True, False, 2),
        ("sloppy write+read", True, True, 2),
        ("sloppy write, strict read", True, False, 3),
        ("sloppy write+read", True, True, 3),
    ]
    for label, w_sloppy, r_sloppy, down_k in configs:
        for w, r in ((2, 2), (2, 3), (2, 1), (1, 1)):
            if not w_sloppy and down_k >= w:
                # strict writes cannot gather W acks from the intended set
                pass
            c = Cluster(seed=2)
            wrote = write_while_down(c, range(N_KEYS), w, w_sloppy, "v1", down_k)
            fresh, stale, failed = read_all(c, range(N_KEYS), r, r_sloppy, read_repair=False)
            print(f"{label} W={w} R={r} down={down_k:<1}          {wrote:>6} {fresh:>8} {stale:>8} {failed:>8}")
    print()


def handoff_and_repair() -> None:
    print("== repair paths after sloppy W=2 R=2 writes, then recovered replicas, strict reads ==")

    def setup(seed: int, down_k: int) -> Cluster:
        c = Cluster(seed=seed)
        write_while_down(c, range(N_KEYS), 2, True, "v1", down_k)
        return c

    def report(title: str, down_k: int, fn) -> None:
        c = setup(3, down_k)
        extra = fn(c)
        fresh, stale, failed = read_all(c, range(N_KEYS), 2, False, read_repair=False)
        suffix = f"  {extra}" if extra else ""
        print(f"down={down_k} {title:<34} fresh={fresh} stale={stale} failed={failed}{suffix}")

    for down_k in (2, 3):
        report("before any repair", down_k, lambda c: "")
        report("after hinted handoff", down_k, lambda c: f"hints={c.deliver_hints()}")

        c = setup(3, down_k)
        p1 = read_all(c, range(N_KEYS), 2, False, read_repair=True)
        p2 = read_all(c, range(N_KEYS), 2, False, read_repair=True)
        p3 = read_all(c, range(N_KEYS), 2, False, read_repair=True)
        print(
            f"down={down_k} read repair passes                  "
            f"p1 fresh={p1[0]} stale={p1[1]}  p2 fresh={p2[0]} stale={p2[1]}  p3 fresh={p3[0]} stale={p3[1]}"
        )

        report(
            "Merkle on intended only",
            down_k,
            lambda c: "pairs=%s hashes=%s copied=%s" % c.anti_entropy(),
        )
        def handoff_merkle(c: Cluster) -> str:
            moved = c.deliver_hints()
            pairs, hashes, copied = c.anti_entropy()
            return f"hints={moved} pairs={pairs} hashes={hashes} copied={copied}"
        report("handoff then Merkle", down_k, handoff_merkle)
        print()


def healthy_quorum_matrix() -> None:
    print("== healthy cluster, one write then one read per key ==")
    print(f"{'(W,R)':<10} {'fresh':>8} {'stale':>8} {'write_fail':>12} {'read_fail':>10}")
    for w, r in ((1, 1), (2, 1), (1, 2), (2, 2), (3, 1), (1, 3), (3, 3), (2, 3)):
        c = Cluster(seed=4)
        ok = write_all(c, range(N_KEYS), w, False, "v1")
        fresh, stale, failed = read_all(c, range(N_KEYS), r, False, read_repair=False)
        print(f"({w},{r})     {fresh:>8} {stale:>8} {N_KEYS - ok:>12} {failed:>10}")
    print()


def concurrent_siblings() -> None:
    print("== concurrent writes while the preference list is split, then a quorum read ==")
    c = Cluster(seed=5)
    key = 0
    intended = c.intended(key)
    a, b, node_c = intended
    # Partition: A isolated from B and C
    # Client 1 writes via A only (W=1, coordinator A) with A up and B,C down from A's view
    c.set_alive([b, node_c], False)
    ok_a = c.put(key, "from-A", w=1, sloppy=False, coordinator=a)
    c.set_alive([b, node_c], True)
    c.set_alive([a], False)
    ok_bc = c.put(key, "from-BC", w=2, sloppy=False, coordinator=b)
    c.set_alive([a], True)
    got = c.get(key, r=3, sloppy=False, read_repair=False)
    values = sorted(v.value for v in (got or []))
    print(f"intended={intended} write_A={ok_a} write_BC={ok_bc}")
    print(f"R=3 returns {len(got or [])} version(s): {values}")
    print(f"clocks: {[v.clock.ticks for v in (got or [])]}")
    # A syntactic winner would be wrong here: both writes are concurrent.
    print(f"concurrent? {got[0].clock.concurrent_with(got[1].clock) if got and len(got) == 2 else 'n/a'}")
    print()


def merkle_saving() -> None:
    print("== Merkle anti-entropy traffic versus copying every key, after a minority of keys diverge ==")
    for diverge in (1, 6, 24, 60):
        c = Cluster(seed=6)
        write_all(c, range(N_KEYS), 3, False, "v1")
        # Force divergence: delete the key from one intended replica
        changed = list(range(diverge))
        for key in changed:
            victim = c.intended(key)[-1]
            if key in c.primary[victim]:
                del c.primary[victim][key]
        pairs, hashes, copied = c.anti_entropy()
        naive = N_KEYS * pairs  # sending every key's payload to compare
        print(
            f"divergent keys={diverge:<3}  pairs={pairs}  "
            f"hashes_exchanged={hashes:<5}  keys_copied={copied:<3}  "
            f"naive_key_compare={naive}"
        )
    print()


def main() -> None:
    print(f"Nodes={N_NODES}  N={N_REPLICAS}  Keys={N_KEYS}")
    print()
    availability_sweep()
    healthy_quorum_matrix()
    stale_after_recovery()
    handoff_and_repair()
    concurrent_siblings()
    merkle_saving()


if __name__ == "__main__":
    main()
```

## 小结

- 无主复制不必选出主节点，也能让一个键保持可写。偏好列表里的协调者等待 W 个副本持久化一次写入，随后的读等待 R 个并调和版本。Dynamo 的常见配置是 `(N, R, W) = (3, 2, 2)`。
- `R + W > N` 只有在副本集合*固定*、并且存在*唯一*最新写入时，才给出读写重叠。在模型里，健康集群在 `(2, 2)` 下始终新鲜，在 `(1, 1)` 下大约三分之二陈旧。
- 并发写入并不是一个最新值。Dynamo 为每个版本保存向量时钟，丢掉祖先，并把兄弟版本交给应用合并。购物车合并不会丢失加购，但可能让删除重新出现。Last-write-wins 会丢掉其中一次并发更新。
- 宽松法定人数写入前 N 个健康节点，而不一定是预定的 N 个，并在替补节点上留下 hint。这就是为什么两台预定副本宕机时 W = 2 仍然成功。这也是为什么这些副本恢复之后、在 handoff 之前，大约三分之一的 R = 2 读是陈旧的；以及为什么在三台预定副本都宕机时被接受的写入，在 hint 交付之前，对预定集合是不可见的。
- 读修复只治愈这次读看到的副本。在模型里，当还有一份预定副本是活的，它会逐渐收敛；当活副本只在 hint 持有者上，它完全不会收敛。
- Merkle 树反熵比较哈希分支，只拷贝分叉的键。若预定副本里至少还有一份值，它可以修好缺失的预定副本；它不能独自发现只活在 hint 存储里的值。
- Cassandra 对着预定副本计算一致性级别，把 hint 存放在协调者上，默认窗口 3 小时；它们是尽力而为的，并且不算进 W。Riak 更接近兄弟版本和主动反熵。DynamoDB 尽管名字相似，却用 Multi-Paxos、一个领导者和三副本中两份预写日志的法定人数来复制每个分区，并用 log replica 而不是一次宽松写入来修复缺失的同伴。
- 若你需要唯一胜者或 compare-and-set，请使用共识（或已经在运行共识的系统）。不要让一次宽松法定人数和一个时间戳去做那份工作。

## 参考文献

- Giuseppe DeCandia, Deniz Hastorun, Madan Jampani, Gunavardhan Kakulapati, Avinash Lakshman, Alex Pilchin, Swaminathan Sivasubramanian, Peter Vosshall, and Werner Vogels, [Dynamo: Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf), SOSP 2007
- Werner Vogels, [Eventually Consistent](https://www.allthingsdistributed.com/2008/12/eventually_consistent.html)
- Mostafa Elhemali, Niall Gallagher, Nicholas Gordon, Joseph Idziorek, Richard Krog, Colin Lazier, Erben Mo, Akhilesh Mritunjai, Somu Perianayagam, Tim Rath, Swami Sivasubramanian, James Christopher Sorenson III, Sroaj Sosothikul, Doug Terry, and Akshat Vig, [Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service](https://www.usenix.org/system/files/atc22-elhemali.pdf), USENIX ATC 2022
- Amazon Science, [Lessons learned from 10 years of DynamoDB](https://www.amazon.science/blog/lessons-learned-from-10-years-of-dynamodb)
- Apache Cassandra, [Hints](https://cassandra.apache.org/doc/4.1/cassandra/operating/hints.html)
- Apache Cassandra, [Read repair](https://cassandra.apache.org/doc/stable/cassandra/managing/operating/read_repair.html)
- Apache Cassandra, [cassandra.yaml](https://cassandra.apache.org/doc/stable/cassandra/managing/configuration/cass_yaml_file.html) (`max_hint_window`)
- Riak KV, [Active Anti-Entropy](https://docs.riak.com/riak/kv/2.2.3/learn/concepts/active-anti-entropy/index.html)
- Riak KV, [Causal Context](https://docs.riak.com/riak/kv/2.2.3/learn/concepts/causal-context/)（dotted version vectors）
- Riak KV, [Conflict Resolution](https://docs.riak.com/riak/kv/2.2.3/developing/usage/conflict-resolution/index.html)
- Ralph C. Merkle, [A Digital Signature Based on a Conventional Encryption Function](https://people.eecs.berkeley.edu/~raluca/cs261-f15/readings/merkle.pdf), CRYPTO 1987
- Martin Kleppmann, *Designing Data-Intensive Applications*, 第 5 章 “Replication”，O'Reilly，2017
