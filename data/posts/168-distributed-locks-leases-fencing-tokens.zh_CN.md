---
title: "深入分布式锁：租约、围栏令牌，以及为什么有锁还不够"
tag: architecture
description: 分布式锁本质上是租约；持有者停顿或延迟到达的写入如何在租约过期之后仍改掉资源；单调递增的围栏令牌（Chubby sequencer、ZooKeeper zxid、etcd CreateRevision）如何让资源拒绝过期写入；在锁用于正确性时为什么不宜依赖 Redlock；以及一个可运行模型，用来衡量有无围栏时的丢失更新
date: "2026-11-23T10:28:00.000Z"
---

## 目标

两个进程可能改到同一份状态时，锁往往是人们最先伸手去拿的工具。在同一个进程里，互斥量几乎乏味：持有者只会在内核调度时被挂起，进程崩溃，互斥量也一起消失。跨过机器，这些都不成立。持有者可能在一次垃圾回收停顿里卡住好几秒，一个数据包可能在缓冲区里待得比锁“应该”活的时间还长，而锁服务本身也**希望**这把锁会过期——否则一个崩溃的客户端会永远占着它。

这把会过期的锁，现在是**租约（lease）**。一旦加上时间上限，也就加上了一种新的失败方式：一个客户端仍然相信自己是持有者，另一个客户端却已经合法地成为了新的持有者。如果他们都能写入那份资源，这把锁并没有完成你以为它完成的工作。

这不是纸面上的好奇。Martin Kleppmann 在 2016 年对 Redis Redlock 算法的分析，正是围绕这件事展开的；他还指出，HBase 曾经就对这种过期持有者写入没有设防。十年前，Google 的 Chubby 论文已经给这个问题起了名字，也给出了机制：**sequencer**，持有者附在每个请求上的单调令牌，资源应当检查它。ZooKeeper 的 zxid 和 etcd 的 `CreateRevision`，是同一想法在不同 API 下的实现。锁服务再好，也还不够。**资源**必须拒绝令牌已经后退的写入。

本文会讲到：

1. 锁是用来做什么的，以及效率与正确性这条分界为什么重要。
2. 为什么分布式锁必须是租约。
3. 过期持有者问题——停顿、延迟的数据包，以及为什么临写入前再看一次所有权并不能堵上这个竞态。
4. 围栏令牌（fencing token），以及资源真正必须做的事。
5. Chubby 的 sequencer，以及服务器无法校验它时退而求其次的 lock-delay。
6. ZooKeeper 和 etcd 如何签发有序令牌，以及 Kubernetes 的领导者选举给了什么、没给什么。
7. Redis 的 `SET NX`、Redlock，以及 2016 年的那场争论。
8. 什么时候不该用锁。
9. 取舍。
10. 一个可运行的模型，用来衡量带租约的锁在有无围栏时的丢失更新，以及一次时钟前跳之下、简化的 Redlock 式多数派。

## 1. 锁是用来做什么的

Kleppmann 划过一条很容易被跳过、跳过后又很贵的线。问自己：如果锁失效了，两个客户端都跑起来，会发生什么。

若答案是“同一段计算付了两次钱”或“用户收到了两封相同的邮件”，这把锁是**效率**上的提示。一个 Redis 实例上的 `SET key value NX PX ttl` 通常就够了。节点重启、锁丢了，代价是一次重复，不是一份损坏的文件。为这种场景再上一个五节点多数派协议，几乎买不到什么。

若答案是“文件变成了两次写入的混合物”、“唯一约束被打破”，或“发错了剂量”，这把锁就是为了**正确性**。本文剩下的部分都在讨论这种情况。标准是：两个客户端不能都提交一次被资源接受的写入。一种只让这件事变得**不太可能**的协议，或只有在每座时钟、每一次进程停顿都待在你实际上无法强制的界限之内才成立的协议，都不够格。

本博客已经写过系统用其他办法选出唯一赢家的路径——[更早的一篇](/blog/131-raft-consensus-deep-dive/zh_CN)里的 Raft，以及[另一篇](/blog/163-leaderless-replication-quorums-hinted-handoff/zh_CN)里相反的赌注：无主法定人数。分布式锁夹在中间：它**看起来**像互斥量，但它保护的东西通常根本不在锁服务里。这正是全部问题所在。

## 2. 为什么分布式锁必须是租约

普通互斥量没有超时，是因为故障域就是这一个进程。一把永不过期的分布式锁是地雷：持有它的客户端可能丢掉网络、冻结或死亡，其他客户端会永远等下去。因此几乎每一个认真的锁服务都会附上**存活时间**，并要求持有者续约。

这个想法比 Chubby 或 ZooKeeper 更老。Cary G. Gray 和 David R. Cheriton 1989 年的 SOSP 论文 *Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency*，把租约写成一种有时限的权利授予——在他们的场景里，是缓存一致性保证——这样一个崩溃的持有者就不能把系统钉死。租约一过期，授予方就可以把权利交给别人。

同一条界限出现在每一个生产级锁服务里：

- Chubby 的会话靠 **KeepAlive** RPC 维持。主节点延长会话租约；默认一次延长 **12 秒**，负载很高时主节点可以把这个值提到大约 **60 秒**，好少处理一些 KeepAlive。客户端对这个截止时间保持一个**保守**的本地视图。本地视图一过期，客户端进入 **jeopardy（危险期）**，清空缓存，并默认再等 **45 秒** 的**宽限期（grace period）**，才宣布会话死亡。
- ZooKeeper 和 etcd 把锁绑在**会话**或**租约**上。会话过期时，ZooKeeper 删除 ephemeral 节点；etcd 租约过期时，挂在它上面的键被删除。两种情况下，另一个客户端都可以成为新的所有者。
- Kubernetes 的 client-go 领导者选举建立在 `Lease` 对象上，默认是 `LeaseDuration = 15s`、`RenewDeadline = 10s`、`RetryPeriod = 2s`。

租约解决的是活性。它本身并不解决一次已经在路上的写入的安全性，也不解决一个还没发现自己被赶下台的持有者。时间是合约的一部分，而时间并不是可靠的真相来源——本博客在[讨论分布式时钟的那一篇](/blog/155-distributed-clocks-lamport-vector-hlc-truetime/zh_CN)里走过这件事。进程停顿和网络延迟是同一类问题：锁服务的时钟走了，客户端的没走，或者数据包没到。

## 3. 过期持有者问题

那段不安全的序列很短。

1. 客户端 A 拿到租约并开始工作——比如对共享存储里的一个文件做一次读改写。
2. A 停顿了。停顿全世界的垃圾回收是课堂上的常见例子；虚拟机卡住、CPU 被限速的窗口，或一个被延迟的数据包，同样有效。Kleppmann 记录过停顿全世界的回收有时会持续数分钟，并引用了一次 GitHub 事故：数据包在网络里被延迟了大约 **90 秒**。
3. 租约过期。客户端 B 拿到它，读文件，写出新版本，然后继续。
4. A 醒过来，或 A 的写入终于到达，覆盖了 B 的版本。B 的更新没了。锁服务在每一个瞬间都是“正确”的，资源仍然是错的。

你不能靠在写入前立刻问一句“我还持有租约吗”来堵上这个竞态。停顿可以发生在**那次检查之后**、**写入被应用之前**。在本文末尾的模型里，客户端 A 在 `t = 2` 确认自己仍持有租约（租约长 10 个时间单位），然后停顿 12 个单位。B 在 `t = 10` 获得锁并写入。A 的写入在 `t = 14` 到达，没有围栏的话会被接受。那次检查是诚实的，也是没用的。

网络里的延迟形状相同，时序却更恼人。在模型里，租约仍是 10，即便没有超出过期本身的额外停顿，一次被延迟 5 个时间单位的写入已经会丢：A 只停顿了 6，**发出**写入时还在租约之内，但写入在 11 才到达，而 B 已经在 10 写过了。客户端本地的“我仍是持有者”，并不是资源看到的到达时间。

## 4. 围栏令牌

修复办法是：每次获得锁都发给一个只会增加的数字，并让资源拒绝任何不比它已经接受过的最新数字更新的写入。

Kleppmann 称之为**围栏令牌（fencing token）**。锁服务在授予租约时签发这个令牌。A 拿到 33，停顿，过期。B 拿到 34 并写入。A 醒来，带着 33 去写。存储已经见过 34，于是拒绝 33。

起作用的是两条性质：

- 令牌在各次获得之间**严格单调**。一个唯一的随机字符串不够，因为存储没有办法判断两个唯一字符串谁更新。
- **资源**在每一条会改状态的路径上，原子地执行这条规则。放在客户端里的检查，和租约检查是同一场竞态。若某个管理接口、某个压缩任务、或某个“就这一次”的修复工具不带令牌就写，保证就消失了。

对着一张 SQL 表，典型的形状是一条带条件的更新：只有当传入令牌大于（若同一次获得允许写多次，则大于或等于）已存令牌时才接受载荷，并在同一条语句里写入新令牌。没有返回行，就表示更新的所有者已经把这个写入者围出去了。应当把它当成一次失败的写入。

围栏有一条精确的界限，值得说清楚。令牌并不会撤回一篇尚未被取代的写入。若 A 带着 33 的写入**先于** B 带着 34 的写入到达，存储会先接受 33，再接受 34。这是正确的所有权顺序，不是缺陷。围栏挡住的是**过期**写入，不是持有者租约稍后过期时发出的每一笔写入。若你需要“租约一死，这次在途请求必须立刻作废”，你需要的是资源自己的协议，而不是另一台机器上的租约。

## 5. Chubby 的 sequencer，以及无法围栏时的 lock-delay

Chubby 是让这套机制在 Google 内部变得日常的系统。Mike Burrows 2006 年的 OSDI 论文描述了一个粗粒度锁服务：一个典型的 cell 有**五**个副本，用共识选出主节点，接口看起来像一个小文件系统。锁是**劝告式（advisory）**的。持有文件 F 上的锁，既不是读 F 的前提，也不能阻止别人读 F。这把锁常常保护的是**并不**住在 Chubby 里的资源——一个 GFS 主节点，或其他服务里的一个主节点——Chubby 无法让那个服务变成强制的。

这正是过期持有者的场景。Chubby 的答案是 **sequencer**：持有者在获得锁之后可以请求的一段不透明字节串。它包含锁的名字、模式（独占或共享），以及**锁世代号（lock generation number）**——每次该节点上的锁从空闲变为被持有，这个号就会增加。客户端把 sequencer 放在发给文件服务器（或它所保护的任何服务）的请求上。服务器应当检查 sequencer 仍然有效、模式也正确，既可以对照它的 Chubby 缓存，也可以对照它已经见过的最新 sequencer。第二种办法就是围栏规则：写路径上甚至不必再问 Chubby，只要记住最新的 sequencer。

论文坦率地承认，不是每一种协议都能改。对于无法校验 sequencer 的服务器，Chubby 提供了一种更弱的后备，叫做 **lock-delay**。若持有者以正常方式释放锁，锁立刻空闲。若锁是因为持有者失败或不可达才空出来的，Chubby 会在一段延迟之内拒绝把锁交给任何人，这段延迟由客户端设定，上限是**一分钟**。意图是给延迟的数据包和正在重启的进程一扇窗口，让它们不那么容易在新持有者已经开工之后才落地。论文说这并不完美，也确实不完美：延迟超过 lock-delay 的数据包仍然会赢，而上限之所以存在，正是为了不让一个有故障的客户端把资源无限期占用。

Chubby 也告诉你这把锁是**用来做什么的**。预期用法是粗粒度的：选出一个主节点，然后让这个主节点自己做细粒度的工作。在锁服务上做细粒度加锁，会把获得锁的速率和事务速率绑在一起，一次短暂的 Chubby 不可用也会疼得多。这种偏向——用锁来任命领导者，再在数据路径上用更紧的东西（日志、比较并交换、世代号）——在 ZooKeeper、etcd 和 Kubernetes 里再次出现。

## 6. ZooKeeper、etcd，以及 Kubernetes 的租约

**ZooKeeper** 的加锁配方是一个装满 ephemeral sequential 子节点的目录。每个客户端创建一个子节点；所有者是序号最小的那个；其他人监视自己的前驱，而不是整个目录。节点是 ephemeral 的，所以会话一过期它就被删除，下一位等待者被提升。配方写在 ZooKeeper 官方文档里；大多数生产环境里的 Java 客户端实际调用的，是 Apache Curator 的 `InterProcessMutex`。

围栏令牌就在 znode 的元数据里。创建时的 **zxid**（`czxid`），或序号后缀本身，按 ZooKeeper 授予所有权的顺序单调递增。已经成为所有者的客户端应当读出这个标识，并把它附在对受保护资源的每一次写入上。会话过期之后再重连，并不是旧所有权的延续：ephemeral 节点已经没了，新会话必须从头开始。

**etcd** 用的是租约和修订号。一个 `Session` 负责维持租约。`concurrency.Mutex` 在锁前缀下创建一个挂在该租约上的键，所有者是 `CreateRevision` 最小的那个键。互斥量把 `IsOwner()` 暴露成一次比较：`CreateRevision(myKey) == myRev`。若你保护的资源也住在 etcd 里，就把这次比较放进和写入同一个事务，过期持有者就改不了这个键。若资源住在别处——数据库、对象存储、设备——你仍然要把 `CreateRevision` 带过去，并在那边执行。租约的 TTL 是一段物理时间，由双方的时钟各自度量；etcd 自己的文档和代码写得很清楚：**持有租约本身，并不构成对外部资源的互斥**。

**Kubernetes** 的领导者选举，在 client-go 的实现里，写入的是 `coordination.k8s.io/v1` 的 `Lease`。默认值前面已经引过：15 秒租约、10 秒续约截止、2 秒重试。这足以决定该由谁跑控制器的调和循环。它不会自动给旧领导者在租约被接手之后仍可能调用的任何东西——Kubernetes API、云厂商、外部数据库——加上围栏。若这很重要，新领导者的 `leaseTransitions`、Lease 的 resourceVersion，或某个其他单调数字，必须在那些路径上被检查，方式和 etcd 的 `CreateRevision` 一样。不少控制器并不做这件事，而是接受（通常很短的）重叠。那是效率上的选择，不是正确性证明。

## 7. Redis、Redlock，以及 2016 年的争论

单实例 Redis 的用法清楚而诚实：`SET name unique_value NX PX ttl`，释放时用脚本只在值仍然匹配时才删除键，这样一次迟到的解锁就不会丢掉别人的锁。这个唯一值能阻止迟到的解锁变得危险。它**不是**围栏令牌：下一个持有者有另一段随机字符串，但挡在文件前面的存储无法判断哪一段更新。当作效率提示，这没有问题。当作正确性关键写入前面的唯一守卫，它有着和其他每一种租约一样的过期持有者缺口。

**Redlock** 被 Redis 文档写成一种在 N 个（通常是五个）独立 Redis 实例上构造多数派锁的办法，试图把那个缺口变小。客户端先记下开始时间，再依次对每个实例用同一个随机值做 `SET NX PX`，只有拿到多数派、并且已经过去的时间仍小于 TTL 时，才把锁当成获得。剩余有效期是 TTL 减去已经过去的时间，再减去一段时钟漂移余量。解锁是在每一个实例上做同一种比较并删除。

2016 年 2 月，Kleppmann 发表了 *How to do distributed locking*，主张在锁用于正确性时，Redlock 并不合适。论点的两头，正是本文的两头。第一，Redlock 不给你围栏令牌；随机值无法排序。第二，算法的安全性依赖于时序界限——进程停顿、网络延迟，以及决定 `PEXPIRE` 的那些 Redis 节点时钟——而在通常的异步模型里，这些界限并不是系统真正提供的。当前持有这些键的多数实例若发生一次向前的时钟跳跃，这些键会在真实时间里提前过期。另一个客户端随后可以拿到多数派，而原来的客户端在**自己的**时钟上，仍然相信有效窗口是开着的。

本文末尾的模型把这种分裂写具体了。五个节点，TTL 为 10，A 在 `t = 0` 拿到 5/5，并会相信这把锁有效直到 `t = 10`。在 `t = 3`，三个持有节点的时钟向前跳了 20。A 实际的票数掉到 2。B 拿到多数派 3。A 仍然相信自己持有锁。没有时钟跳跃时，B 要到 `t = 10` 才能获得。

Salvatore Sanfilippo（antirez）次日在 *Is Redlock safe?* 里作了回应。他把围栏当成任何会自动释放的锁都有的、单独的一般问题——这一点是对的，也正是本文从租约而不是从 Redis 讲起的原因——并且他不同意那些时序假设在实践中足以取消资格。这场争论有用，是因为它逼出了那条区分：若你已经有一个会执行单调令牌的存储，令牌从几乎任何地方签发都行，你并不需要 Redlock 来做这件事。若你**没有**这样的存储，Redlock 也不会给你一个。对于正确性关键的资源，通常的建议——本文也持同样看法——是从已经具有单调顺序的共识系统里拿锁，比如 Chubby、ZooKeeper、etcd，或一个以 Raft 为后盾的元数据服务，并把那个顺序放到写入上。

## 8. 什么时候不该用锁

锁很适合用来任命一个领导者，却很不适合用来实现这个领导者的数据路径。

若不变量是“这一行只由当前所有者更新”，在世代号上做比较并交换，或写一条单写者日志，比在一次未加校验的写入外面套租约更紧。若不变量是“这条消息只被处理一次”，幂等键和 outbox 比指望两个消费者不会同时持有锁更紧。若不变量是“这两条记录保持同步”，在一个系统里做事务，或写一条共识日志，比两次加锁更新更紧。

锁还会以让人吃惊的方式在失败时关闭。锁服务挂了，谁也成不了所有者，数据平面就停了。对一把正确性锁来说，这是正确行为，也是 Chubby 瞄准粗粒度用法的原因：一次短暂的不可用推迟的是主节点选举，不是每一次用户写入。若你的获得速率就是请求速率，你已经把锁服务放在了产品的关键路径上。

最后，“我检查过，我仍然是领导者”并不是围栏。它只是第 3 节里那次检查再写入的竞态，换了一个名字。

## 9. 取舍

- **单个 Redis `SET NX PX`。** 便宜、诚实，在可以接受重复时通常够用。没有单调令牌，一个故障域，对过期写入没有安全性故事。
- **Redlock。** 多数个独立的过期，仍然没有围栏令牌，仍然有时序假设。它是一把更精细的效率锁，不是一把共识锁。
- **共识锁（Chubby、ZooKeeper、etcd）再加上资源上的围栏令牌。** 这才是真正堵住过期持有者缺口的组合。代价是获得锁时的一轮共识、一条续约路径，以及资源每一条会改状态的路径上那一行比较。若你改不了资源，你就没有这个选项——只剩下 Chubby 的 lock-delay 这类更弱的后备。
- **共识锁，但没有围栏。** 你有一个相当可信的**任命**，对着任何仍会接受旧领导者请求的资源，停顿与迟到写入的缺口也还在。
- **根本不加锁，只用比较并交换或日志。** 常常才是正确的设计。世代号**就是**围栏令牌，也没有一份会变旧的单独租约。代价是每个写入者都必须会说那种协议。

## 10. 一个可运行的模型

下面这份脚本，就是产生本文每一个计数的模型。时间是离散的。锁服务授予一份 **10** 个时间单位的租约，以及一个严格递增的令牌。两个客户端争用一个寄存器。客户端 A 在 `t = 0` 获得锁，停顿 `P` 个单位，再发出一笔延迟 `D` 个单位到达的写入。客户端 B 从 `t = 1` 起每个节拍重试，一获得就写。写入按到达顺序应用；同一个节拍里，先按更早的发送时间，再按更小的令牌。

**没有围栏**且 `D = 0` 时，B 在 `t = 10` 获得锁。A 在停顿 8、9 或 10 时的写入落在那个节拍或更早，随后是 B 的写入，终值是 `B`。从停顿 **11** 到 **25**，A 的写入更晚到达并覆盖 B——26 次停顿里有 **15** 次丢失更新。加上围栏后，同样这 15 次写入被拒绝，终值保持为 `B`。有围栏时的丢失更新：**0 / 26**。

延迟 **5** 会把不安全窗口向前推。A 只停顿了 **6**，仍在租约之内，但写入在 11 才到达。没有围栏时，停顿 **6** 到 **25** 都会丢——**20 / 26**。有围栏时，这 20 次被拒绝，没有丢失。

检查再写入的情形是同一套机制。A 在 `t = 2` 确认自己仍持有租约，然后停顿。停顿 5 甚至 8 之后，写入仍然落在 B 的写入之时或之前，后任获胜。停顿 **12** 之后，写入在 14 到达：没有围栏时终值是 `A`，更新丢失；有围栏时被拒绝，终值是 `B`。

更长的工作负载让偶发的长停顿代价变得可见。三个客户端对一个共享计数器做读改写：获得锁时读出当前值，停顿，再写入 `base + 1`。停顿从一个长尾分布里抽取——在种子 **168** 的 2000 次成功获得里，**1777** 次停顿是 0–2，**207** 次是 3–9，**16** 次至少是 14（长尾是 14、16、18、19、20、20、20、22、26、28、28、28、31、34、36、39）。租约仍是 10，所以这 16 次获得活过了它。

没有围栏时，2000 次写入全部被接受，但其中 16 次带着一个比存储已经见过的令牌更旧的令牌到达，最终计数器是 **1972**。一次过期写入丢掉的不只是它自己那一次递增：这些逆序里有八次把计数器向后拨，抹掉了后任已经写入的 **12** 次递增，其余缺口则是用相等或更旧的值覆盖了更新值的丢失更新。有围栏时，这 **16** 次写入被拒绝，**1984** 次被接受，计数器是 **1984**，没有逆序。那 16 个被拒绝的客户端是显式失败的，而不是把寄存器写坏。

Redlock 风格的那段用五个独立节点和三票多数。A 在 `t = 0` 拿到 5/5，并会在自己的时钟上相信这把锁有效直到 `t = 10`。在 `t = 3`，三个持有节点的时钟向前跳 20；A 的实际票数掉到 **2**，B 拿到 **3**，而 A 仍然相信自己持有锁。对照运行没有跳跃时，B 在 `t = 3` 拿不到，第一次成功是在 `t = 10`。

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

## 小结

- 一把会过期的分布式锁就是租约。过期是为了不让一个崩溃的持有者把资源永远钉住。它同时也造出了第二个合法的持有者，而第一个可能还正要写入。
- 若锁只是效率上的提示，单个 Redis `SET NX PX` 通常就够了，丢掉锁不过是一次重复。若锁是为了正确性，两个不同所有者都被接受的写入就是缺陷，一条你无法强制的时序界限也不是修复。
- 临写入前再问一句“我还持有租约吗”堵不上这个竞态：停顿或网络延迟可以夹在检查和应用之间。在模型里，A 在 `t = 2` 检查，停顿 12，并在 `t = 14` 覆盖 B 的写入。
- 围栏令牌是获得锁时签发的、严格单调的数字。**资源**拒绝令牌不比它已经接受过的最新令牌更新的写入。唯一的随机字符串无法排序，所以它们不是围栏令牌。
- Chubby 的 sequencer（锁名、模式、锁世代号）就是这套机制，时间是 2006 年。对于无法校验 sequencer 的服务器，Chubby 在失败的持有者之后提供最长一分钟、并不完美的 lock-delay。ZooKeeper 的 `czxid` 和 etcd 的 `CreateRevision` 是同一类数字；数据住在 etcd 里时，etcd 可以在事务里执行它，数据不住在那里时就必须把它带出去。Kubernetes 默认 15 秒的 `Lease` 选出一个领导者；它本身并不会给旧领导者剩下的调用加上围栏。
- Redlock 给你的是多数个独立的过期，仍然不给你围栏令牌。在模型里，五个节点里的三个在 `t = 3` 向前跳 20，就能让 B 拿到多数派，而 A 仍然相信自己持有锁直到 `t = 10`。从共识服务拿锁，并把它的顺序放到写入上。
- 在模型里，租约为 10、没有围栏时，写入立即到达会在 26 次停顿里丢失 15 次；写入延迟 5 时丢失 20 次——其中包括发出时仍在租约之内的停顿。围栏拒绝这些过期写入，丢失为 0。在带有 16 次长停顿尾巴的 2000 次读改写获得里，没有围栏的终值是 1972，并有 16 次令牌逆序；围栏拒绝这 16 次过期写入，终值是 1984。

## 参考资料

- Martin Kleppmann，[How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)，2016 年 2 月 8 日
- Salvatore Sanfilippo（antirez），[Is Redlock safe?](https://antirez.com/news/101)
- Redis，[Distributed locks with Redis](https://redis.io/docs/develop/clients/patterns/distributed-locks/)
- Mike Burrows，[The Chubby lock service for loosely-coupled distributed systems](https://static.googleusercontent.com/media/research.google.com/en/us/archive/chubby-osdi06.pdf)，OSDI 2006
- Cary G. Gray 与 David R. Cheriton，[Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency](https://dl.acm.org/doi/10.1145/74850.74870)，SOSP 1989
- Patrick Hunt、Mahadev Konar、Flavio P. Junqueira 与 Benjamin Reed，[ZooKeeper: Wait-free coordination for Internet-scale systems](https://www.usenix.org/legacy/event/usenix10/tech/full_papers/Hunt.pdf)，USENIX ATC 2010
- Apache ZooKeeper，[ZooKeeper Recipes and Solutions](https://zookeeper.apache.org/doc/current/recipes.html)（共享锁）
- etcd，[concurrency.Mutex](https://github.com/etcd-io/etcd/blob/main/client/v3/concurrency/mutex.go)（`CreateRevision`、`IsOwner`）
- Kubernetes client-go，[leaderelection.go](https://github.com/kubernetes/client-go/blob/master/tools/leaderelection/leaderelection.go)（默认的 `LeaseDuration`、`RenewDeadline`、`RetryPeriod`）
- Martin Kleppmann，*Designing Data-Intensive Applications*，O'Reilly，2017（分布式锁与围栏令牌）
