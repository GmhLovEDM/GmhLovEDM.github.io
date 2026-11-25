---
title: "深入 etcd 与 kube-apiserver：MVCC 修订版本、Watch、压缩与 Watch Cache"
tag: devops
description: Kubernetes 如何真正存储集群状态：etcd 的 MVCC 修订版本与键的世代、Watch 的保证以及压缩之后会发生什么、1.5 MiB 请求限制与 2 GiB / 8 GiB 配额、kube-apiserver 如何把对象映射到 /registry 并大约保留五分钟历史、Watch Cache 如何在进度检查之后提供一致读取，以及一个可运行模型，用来衡量压缩、过期 Watch，以及只有追上进度才提供一致列表的缓存
date: "2026-11-25T12:40:00.000Z"
---

## 目标

Kubernetes 看起来是一组对象的集合：Pod、Node、Lease、自定义资源。在这下面，几乎每一次变更都是对 etcd 的一次写入。etcd 是一个小而强一致的键值存储，不是通用数据库。它被设计用来保存写入不频繁、读取很多、并且会被持续 Watch 的集群元数据，同时保留一段不长的历史，好让断开过的客户端还能接上。

本文从 Raft 已经提交一条日志之后开始——选举、日志复制和提交规则是另一个问题——跟着这次写入进入 MVCC 存储，再从 Watch API 出来，进入 kube-apiserver 的 Watch Cache，最后回到必须面对压缩的客户端。内容包括：

1. 控制面为什么使用一个小型的多版本存储。
2. 数据模型：扁平的键空间、集群范围的修订版本、每个键的 version 与世代。
3. Range、Put、Txn、Watch 和 Lease，以及 etcd 真正给出的保证。
4. 压缩、碎片整理和存储配额。
5. 磁盘与内存，以及一次缓慢的 fsync 如何变成控制面故障。
6. kube-apiserver 如何把对象映射进 etcd，以及如何压缩历史。
7. `resourceVersion`、`410 Gone`，以及那五分钟的窗口。
8. Watch Cache：一致列表、流式列表、快照，以及启动时的行为。
9. 取舍。
10. 一个可运行的模型，用来衡量世代、比较并交换、被压缩掉的 Watch、配额恢复，以及在追上之前拒绝提供一致列表的缓存。

## 1. 为什么是一个小型的多版本键值存储

etcd 自己的文档把定位写得很清楚：它被设计用来可靠地存储更新不频繁的数据，并提供可靠的 Watch 查询。键的旧版本会留下来，这样某个时间点的读取和 Watch 历史（"时间旅行查询"）才便宜，断开的 Watch 也能从已经见过的修订版本继续。

这正是 Kubernetes 控制面的负载。一个 Pod 对象通常只有几 KB。控制器不会去扫一张关系表；它们先 List 一次，然后 Watch。Watch 断开时，它们希望从某个修订版本继续，而不是重建整个世界——除非需要的那段历史已经被压缩掉了。

约束也由此而来。etcd 是元数据存储。默认情况下，任何请求的最大大小是 1.5 MiB，可用 `--max-request-bytes` 配置。默认的后端配额是 2 GiB，可用 `--quota-backend-bytes` 配置，对通常环境建议的最大值是 8 GiB——如果配置的配额超过这个值，etcd 会在启动时发出警告。这些数字是公开的系统限制，不是口口相传的经验。一个过大的对象，或一段不加限制的历史，并不只是 "etcd 变慢了"，而是这个存储被当成了另一种东西来用。

## 2. 数据模型：修订版本、version 与世代

### 扁平的键空间

逻辑视图是一片扁平的二进制键空间，带有按字典序排序的索引，因此对 `[a, b)` 的范围查询很便宜。etcd 并不把键组织成目录。前缀查找只是一次范围查询：所有以 `/registry/pods/` 开头的键，就是从该前缀到第一个不匹配键的半开区间。

### 集群范围的修订版本

etcd 维护一个 64 位的集群范围计数器，也就是存储的修订版本（revision），每次键空间被修改时加一。修订版本是全局的逻辑时钟：它给所有变更排好全序。一笔触及多个键的事务仍然只得到一个修订版本。官方数据模型文档写明：初始修订版本是 1，并且在集群的生命周期里单调递增。

每个响应都带有包含 `cluster_id`、`member_id`、`revision` 和 `raft_term` 的头部。头部里的修订版本是生成该响应时的存储修订版本，也就是客户端为了从"现在"开始 Watch 而需要记下的值。

### 每个键上的元数据

键值 API 的基本单位是 `KeyValue`：

```protobuf
message KeyValue {
  bytes key = 1;
  int64 create_revision = 2;
  int64 mod_revision = 3;
  int64 version = 4;
  bytes value = 5;
  int64 lease = 6;
}
```

- `create_revision` 是当前世代被创建时的修订版本。
- `mod_revision` 是最近一次修改（包括删除）的修订版本。
- `version` 统计当前世代内的修改次数，创建时从 1 开始。删除会把它重置为 0。
- `lease` 是挂在这个键上的租约 ID，没有则为 0。

一个键的生命是一个世代，从创建到删除。删除一个键会写入墓碑并结束这个世代。再次写入同一个键会开启新的世代：`version` 回到 1，`create_revision` 变成新的修订版本。之后的压缩会丢掉在压缩修订版本之前已经结束的世代，以及比该修订版本更旧的被取代的值，但会保留仍然有效的最新值。

### 物理上的两棵树

在磁盘上，etcd 把增量存放在一棵持久的 B+ 树里。后端键是一个元组 `(major, sub, type)`，其中 `major` 是存储修订版本，`sub` 用来区分同一修订版本里的不同键，`type` 可以标记墓碑。另一棵内存里的 B 树按用户键建立索引，并指向持久树，这让按键的范围查询变得便宜。压缩会删除过时的后端键值对和失效的索引指针。这个存储在效果上是不可变的：一次变更会生成新的结构，而不是原地改旧的结构。

## 3. API，以及 etcd 真正给出的保证

### 键值操作

KV 服务提供 `Range`、`Put`、`Delete` 和 `Txn`。etcd 声明：已完成的 KV 操作是持久的——一次读取永远不会返回尚未持久化的数据——并且 KV API 是严格可串行化的：操作是原子的，并以与真实时间一致的全序发生，这个全序由修订版本给出。

线性一致性是默认行为，并且要走 Raft。想要更便宜读取的客户端可以请求 `serializable` 一致性，这时可以从 follower 提供服务，并且相对于法定人数可能是旧的。

一笔事务是一组 `Compare` 谓词，加上成功列表和失败列表。比较的目标可以是 `version`、`create_revision`、`mod_revision`、`value` 或 `lease`。这就是乐观并发的底层原语。kube-apiserver 更新一个对象时，会检查该键的 `mod_revision` 是否仍与客户端发送的 `resourceVersion` 一致；如果另一个写入者已经把它推向前了，比较就会失败，客户端收到冲突。

### Watch

`Watch` 是一条双向的 gRPC 流。客户端可以在一条流上复用许多 Watch。`start_revision` 是包含该修订版本本身的；如果省略，Watch 从创建响应里的修订版本之后开始。如果 `start_revision` 已经被压缩掉，Watch 会被取消，响应里带上 `compact_revision`。客户端应当从已经见过的修订版本恢复，前提是它还在历史窗口里。

etcd 为 Watch 提供这些保证：

- **有序。** 事件按修订版本顺序出现。Watch 不会发出一个早于它已经发出的事件。
- **唯一。** 一个事件最多出现一次。
- **可靠。** 在仍被保留的历史窗口里，一个序列不会丢掉其中的子序列。如果 Watch 收到了 `a` 和 `c`，它也收到了 `b`，只要 `b` 还在窗口里。
- **原子。** 同一修订版本里的事件，即使跨越多个键，也不会被拆到不同的 Watch 响应里。
- **可恢复。** 断开之后，只要最后收到的修订版本仍被保留，就可以从它之后开始一条新的 Watch。
- **可标记进度。** 一条进度通知保证：直到该修订版本为止的所有事件都已经送达。

etcd **并不** 为 Watch 提供线性一致性保证。客户端应当查看事件上的修订版本。官方文档说，在健康的集群里应当预期大约 10 ms 内看到事件；它也写明这没有上界，不健康的集群可能永远送不到。

### 租约

租约通过 TTL 授予，可以挂到一个或多个键上，可以保活，也可以撤销。租约过期或被撤销时，挂在上面的键会被删除。这是 etcd 为分布式协调提供的原语。它和 Kubernetes 的 `Lease` API 不是一回事：后者只是存储在 `/registry` 下的普通对象。

## 4. 压缩、碎片整理和配额

因为每次变更都会留下新的修订版本，存储若不加管理就会无限增长。压缩用来丢掉历史。官方规则是：压缩修订版本之前的修订版本会被移除；在该修订版本之前已经结束的世代会被移除；在该修订版本之前写入的值，除了最新的那个，也会被移除。当前仍然有效的值会留下来，即使它写得更早。一次指向更旧修订版本的 `Range`，或从压缩修订版本之前开始的 Watch，都会失败。

etcd 也可以自己压缩。在按时间的模式下，`--auto-compaction-retention=10h` 会先等待十小时再做第一次压缩，之后每小时压缩一次，并始终保留十小时的窗口——这个 10 小时是文档里的通用默认建议。在按修订版本的模式下，etcd 每五分钟检查一次，并压缩到 `最新修订版本 - N`。

Kubernetes 通常不会把这件事完全交给 etcd 自己的定时器。kube-apiserver 会自己发起压缩，下一节会讲。

压缩释放的是后端内部的逻辑空间。它不会把这些字节还给文件系统。后端会留下碎片：etcd 可以再利用这些空间，但 `du` 仍然把它们算在内。碎片整理会重建该成员的后端，并把文件空间释放出去。它按成员执行，不会通过 Raft 复制，而且——这在生产里很重要——在运行期间会阻塞该成员的读写。官方建议一次只整理一个成员。`etcdctl defrag` 面向仍在运行的成员；`etcdutl defrag --data-dir ...` 则操作一个没有被打开的数据目录。

配额是最后的闸门。如果任一成员的后端超过 `--quota-backend-bytes`，etcd 会拉起集群范围的 `NOSPACE` 告警，此后集群只接受键的读取和删除。恢复路径是：压缩多余的历史，对每个成员做碎片整理，然后执行 `etcdctl alarm disarm`。在告警被清除、物理大小回到配额以下之前，Put 会被拒绝。需要盯住的两个指标是 `etcd_mvcc_db_total_size_in_use_in_bytes`（压缩之后仍然在用的数据）和 `etcd_mvcc_db_total_size_in_bytes`（文件大小，包括等待碎片整理的空闲页）。两者都靠近配额时，该压缩了；在用大小已经下降而文件还没有，该做碎片整理了。

## 5. 磁盘、内存，以及为什么 fsync 延迟会变成集群故障

一次变更只有在多数派成员已经把它写入预写日志之后才算完成。增量快照随后让 etcd 截断这段日志。如果这些写入耗时过长，心跳会超时，新的选举会开始，集群在争抢领导权期间无法写入。etcd 的硬件文档说得很直接：磁盘写延迟是最关键的资源。它要求在典型部署里大约 50 的顺序 IOPS，在高负载下大约 500 的顺序 IOPS，并指出云厂商公布的"并发 IOPS"往往比顺序 IOPS 高一个数量级。默认建议使用 SSD；8 GB 内存通常足够，当有成千上万的 Watch 和数百万个键时建议 16–64 GB；典型情况是 2 到 4 个核心，高负载则是 8 到 16 个。

同一份硬件指南给了示例规模。"小型" etcd 面向少于 100 个客户端、每秒少于 200 次请求、不超过 100 MB 数据，对应的例子是一个 50 节点的 Kubernetes 集群。"中型" 例子是 250 个节点（最多 500 个客户端、每秒 1,000 次请求、500 MB）。"大型" 例子是 1,000 个节点（最多 1,500 个客户端、每秒 10,000 次请求、1 GB）。这些是 etcd 公布的起点，不是保证；文档也明确写了，机器上如果还跑着别的进程，集群可能变得不稳定。

Kubernetes 文档又加了两条运维约束。把 etcd 跑在专用机器或其他被隔离的资源上；在生产里，为了持久性和可用性，要跑多成员集群并定期备份。同一页文档建议生产环境使用五成员集群。五个成员可以丢掉两个仍然拥有多数派；代价是每次写入要等三次磁盘 fsync，而不是两次。

`--snapshot-count`（从 etcd v3.2 起默认是 100,000）是一个成员在做快照并截断之前保留的已应用 Raft 条目数。更大的值让缓慢的 follower 有更多日志可以追赶，也占用更多内存；更小的值则让快照更频繁。

## 6. kube-apiserver 如何写入、读取和压缩

kube-apiserver 是 etcd 最重要的客户端，它把键值 API 藏在 Kubernetes API 后面。

默认的 `--etcd-prefix` 是 `/registry`。一个命名空间里的内置对象存放在类似 `/registry/secrets/default/db-credentials` 这样的路径下。默认的 `--storage-media-type` 是 `application/vnd.kubernetes.protobuf`；也支持 JSON 和 YAML，但有些资源或后端会忽略这个标志。如果设置了 `--encryption-provider-config`，写入 etcd 之前会对值做变换，静态加密就是这样作用到 Secret 和其他被选中的资源上的。

在默认集群里，kube-apiserver 自己也会压缩 etcd。`--etcd-compaction-interval` 默认为 `5m0s`；设为 `0` 则关闭由 apiserver 发起的压缩。实现位于 `k8s.io/apiserver/pkg/storage/etcd3/compact.go`。文件里的注释写明了意图：保留最近五分钟的数据，压缩比这更旧的版本，"对缓慢的 Watch 以及容忍突发应该足够了"。

API server 之间的协议，是对一个特殊键 `compact_rev_key` 做比较并交换。这个键的 version 被当成逻辑时钟（"压缩时间"）；它的值保存最近一次压缩到的修订版本。每个间隔里，一个 API server 尝试 CAS 这个 version。成功后，它写入自己上次观察到的修订版本，然后对那个修订版本调用 etcd 的 `Compact`——也就是压缩到"上一个间隔时的现在"，而不是当前的头部。进程启动后第一次成功的 CAS 不会真正压缩，因为那时上次的修订版本仍是 0。如果 CAS 失败，说明另一个 API server 已经做完了；这一方会采纳远端的压缩时间，并在下一个间隔再试。注释给出了故障转移的界限：正常情况下间隔是五分钟；如果负责压缩的那一方崩溃了，下一次间隔大于五分钟、小于十分钟。Kubernetes API 文档用一句话写出了结果：使用 etcd 3 的集群默认保留最近五分钟的变更。

这个窗口是产品上的选择。它让后端保持很小。这也意味着，断开超过大约五分钟的 Watch 无法从原处继续，必须重新 List。

另外两个标志很容易被忽略。`--event-ttl` 默认为 `1h0m0s`：Event 是普通对象，在被删除之前都会占用配额。`--min-request-timeout` 默认为 1800 秒；Watch 处理程序会在这个值之上取一个随机超时，这样 Watch 不会在同一时刻一起断开。

## 7. `resourceVersion` 与 `410 Gone`

每个 Kubernetes 对象都带有 `metadata.resourceVersion`，表示该实例最后一次被修改时的资源版本。List 响应还带有集合的 `metadata.resourceVersion`，表示这份集合是在哪个修订版本上组装出来的。这些字符串对客户端是不透明的——必须原样传回——在 kube-apiserver 上，它们在同一资源类型内可以作为单调递增的整数来比较。

List 然后 Watch 的约定是：

1. List 这个集合，记下集合的 `resourceVersion`（记为 `rv`）。
2. 用 `resourceVersion=rv` 去 Watch 同一个集合。随后的流会报告发生在该修订版本之后的操作。
3. 如果 Watch 断开了，从你最后收到的 `resourceVersion` 再开一条新的 Watch。
4. 如果服务器已经没有那段历史，它会返回 `410 Gone`。客户端必须丢掉本地缓存，重新 List，再从新的 `rv` 开始 Watch。

`resourceVersion` 以及自 1.19 起的 `resourceVersionMatch` 会改变"读这份列表"的含义。重要的几种情况是：

- **最新（Most recent）。** 对当前存储的一次一致读取。历史上这是对 etcd 的法定人数读取。Kubernetes API 文档现在写明：在 etcd v3.4.31+ 和 v3.5.13+ 上，Kubernetes 1.37 会从 Watch Cache 提供"最新"读取，并用 etcd 的进度通知确保缓存至少和新的一次线性一致读取一样新。同一机制在 1.28–1.30 是 alpha，从 1.31 起默认可用，`ConsistentListFromCache` 特性门在 1.34 成为稳定。
- **任意（Any）**，包括 get 或 list 上的 `resourceVersion=0`。优先给最新可用的修订版本，但允许旧数据。这始终从 Watch Cache 提供。
- **不旧于（Not older than）。** 集合的 `resourceVersion` 不会比你请求的更旧。同样从 Watch Cache 提供。
- **精确（Exact）。** 提供那个修订版本，否则返回 `410 Gone`。在 `ListFromCacheSnapshot`（自 1.34 起为 beta 且默认开启）打开时，API server 会尝试使用一份不比请求更新的快照。它一开始没有快照，在每次 Watch 事件上拍一份，并保留到它发现 etcd 已经压缩，或缓存里充满了超过 75 秒的事件。如果快照无法满足请求，就回退到 etcd。

没有 `resourceVersion` 的 Watch 会从最新的一致修订版本开始，并先为当前状态发出合成的 `ADDED` 事件。带有 `resourceVersion=0` 的 Watch 做法相同，但可能从一个旧修订版本开始。带有具体 `resourceVersion` 的 Watch 从那个精确修订版本开始，并且不会重放状态：假定客户端已经持有它。

书签事件（`allowWatchBookmarks=true`）正是因为历史窗口很短才存在的。一条 `BOOKMARK` 是一种 Watch 事件，对象上只带有 `resourceVersion`，意思是"直到这里的所有变更你都已经看到了"。服务器并不被要求按某种固定间隔发送书签，甚至可以完全不发。

如果你请求的是 API server 还尚不认识的修订版本（一个"未来"版本，常常来自稍稍领先的另一台 API server），kube-apiserver 可能会等待，以 `504 Gateway Timeout` 超时，或返回 `Retry-After`，并把这种情况标记为 `Too large resource version`。这和 `410 Gone` 不同：后者的意思是"这个修订版本已经属于过去"。

## 8. Watch Cache

如果每个 List 和 Watch 都打到 etcd，一个装满控制器的集群是撑不住的。因此 kube-apiserver 默认（`--watch-cache=true`）为每种资源保留一份内存里的 Watch Cache。缓存是 etcd 里该类型的镜像：先用一次一致的 List 填满，再靠 Watch 保持同步。`--watch-cache-sizes` 仍然存在，但文档对非零大小的含义只是"不要关闭这种资源的缓存"；容量是自动调节的。把大小设为 0 会关闭该内置资源的缓存。

从缓存提供的一致列表，并不是换了个好听名字的旧读取。关于从缓存做一致读取的 KEP，以及随后的实现，会先确定一个新鲜的 etcd 修订版本——一次法定人数读取，或一条 Watch 进度通知（它保证直到该修订版本的事件都已送达）——然后只有在缓存达到这个修订版本之后，才提供这份列表。如果缓存追不上，请求不会从一份落后的镜像里得到答案。

启动时，API server 会推迟 `/readyz`，直到每一个已注册的 Watch Cache 完成那次初始同步。目的是避免负载均衡把流量打到缓存仍是空的进程上，否则一次启动就会变成针对 etcd 的 List 惊群。如果缓存在之后又未初始化——启动过程中、重新同步、连接断开——`WATCH` 请求以及未分页或带过滤的 `LIST` 会立刻被拒绝，状态码是 `429 Too Many Requests`，并带上 `Retry-After` 头。在这扇窗口里，只有 `GET` 以及分页且未过滤的 `LIST`（`limit > 0`，没有 label 或 field 选择器）才被允许回退到 etcd。

两条较新的路径也在试图降低初始 List 的成本。**流式列表**（`WatchList`，自 1.34 起为 beta 且默认开启；在 1.33 里默认曾被关掉过）允许客户端在 Watch 上设置 `sendInitialEvents=true` 和 `resourceVersionMatch=NotOlderThan`。流会先为每一个已有对象发出合成的 `ADDED` 事件，然后是一条到达已同步修订版本的 `BOOKMARK`，再往后才是普通 Watch 事件。客户端不必一次性在内存里堆出一份巨大的 List 响应。client-go 里的 `WatchListClient` 从 1.35 起默认开启。**流式的 etcd 范围读取**（`EtcdRangeStream`，自 1.37 起为 beta 且默认开启，需要 etcd v3.7 或更新）把 API server 自己对大型集合的读取，从分页的 `Range` RPC 改成 `RangeStream`。如果后端返回 gRPC `Unimplemented`，API server 会回退到分页读取。这条流式路径的耗时指标使用 `operation="listStream"`，而不是 `operation="list"`。

## 9. 取舍

- **五分钟的历史，换来的是更小的 etcd，以及更严格的客户端约定。** 以为可以长时间断开再接上的控制器，最后还是会重新 List。这不是罕见错误，而是设计好的恢复路径，必须被处理（`410`，然后一次新的 List）。
- **压缩和碎片整理是两件不同的事。** 压缩很频繁，每五分钟做一次也足够便宜，但不会缩小文件。碎片整理会缩小文件，同时阻塞那个成员，应当少做，并且错开。只看文件大小，或只看在用大小，都会被误导。
- **建议的 8 GiB 上限，对"把配额调大就好"是一道真正的天花板。** 如果是仍然活着的对象（而不是历史）在往上顶，问题出在对象数量、过大的对象，或 Event 的量，更大的配额需要匹配的内存、磁盘和更长的恢复路径。
- **1.5 MiB 的请求限制同样是天花板。** 一个 CRD 实例、一份很大的 ConfigMap，或过大的 annotation，会让写入失败，看起来像 API server 的缺陷，直到你去量编码后的对象大小。
- **Watch Cache 是一套一致性协议，而不只是加速器。** `resourceVersion=0` 允许是旧的。默认的 List（最新）不可以，落后的缓存必须拒绝，而不是编造一个新鲜的答案。这份诚实的代价，是等待进度通知，以及缓存在未就绪时返回 `429`。
- **三个 etcd 成员还是五个。** Kubernetes 在生产里建议五个。五个可以在丢掉两个之后仍然存活；它们也要求三次 fsync 才能形成多数派。多数派越大，专用磁盘就越重要。
- **etcd 里默认用 Protobuf，比 JSON 更小、编码更快，也更难直接用眼睛看。** 这是有原因的默认值；这也是为什么 `etcdctl get /registry/...` 常常看起来不知所云，除非用 Kubernetes 的工具来解码。

## 10. 一个可运行的模型

下面的程序是一个紧凑的 MVCC 存储，包含在某个修订版本上的 `put`、`delete`、`get`，以及 `txn` 比较并交换、`watch`、`compact`、`defrag` 和字节配额，外加一个在追上法定人数修订版本之前不会提供"最新"列表的 Watch Cache。它不是 etcd，也不会说 Raft 或 gRPC。它对已公布的数据模型和 Watch 规则足够忠实，能够为历史增长、被压缩的游标、配额恢复和缓存新鲜度给出具体数字。

存储从修订版本 0 开始；第一次变更成为修订版本 1，与 etcd 的初始修订版本一致。一笔多键事务共用一个修订版本，对那个修订版本的 Watch 会一起看到两个事件。压缩丢掉严格早于压缩修订版本的历史，因此游标比它更旧的 Watch 会带上 `compact_revision` 被取消，而从压缩修订版本本身开始的 Watch 仍然能看到剩下的事件。逻辑大小在压缩时下降；物理大小只在碎片整理时下降。一旦物理大小越过配额，后续的 put 会抛出 `NoSpaceError`，直到压缩、碎片整理并解除告警。缓存在完成引导之前回答 `429`；在落后时仍会提供一份"任意"列表（而且这份列表是旧的）；只有 `catch_up` 已经应用了直到存储当前修订版本的全部事件之后，才会提供"最新"列表。

```python
"""A compact model of etcd MVCC, compaction, watches, quota, and a watch cache.

This is not a network server. It follows the published etcd data model and
watch guarantees closely enough to measure history growth, compact/defrag
behavior, stale watches, optimistic concurrency, and when a cache may serve
a consistent list.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal


class MvccError(Exception):
    pass


class CompactedError(MvccError):
    def __init__(self, compact_revision: int, requested: int):
        self.compact_revision = compact_revision
        self.requested = requested
        super().__init__(
            f"required revision {requested} has been compacted, compact_revision={compact_revision}"
        )


class NoSpaceError(MvccError):
    def __init__(self):
        super().__init__("mvcc: database space exceeded")


class CompareFailed(MvccError):
    def __init__(self):
        super().__init__("compare failed")


@dataclass(frozen=True)
class KeyValue:
    key: str
    value: bytes | None  # None marks a tombstone (delete)
    create_revision: int
    mod_revision: int
    version: int  # 0 on a tombstone
    lease: int = 0

    @property
    def is_tombstone(self) -> bool:
        return self.value is None

    def size_bytes(self) -> int:
        n = len(self.key.encode()) + 32  # revision/version/lease metadata
        if self.value is not None:
            n += len(self.value)
        return n


@dataclass
class Event:
    typ: Literal["PUT", "DELETE"]
    kv: KeyValue
    prev_kv: KeyValue | None = None


@dataclass
class WatchResult:
    compact_revision: int | None = None
    events: list[Event] = field(default_factory=list)

    @property
    def canceled(self) -> bool:
        return self.compact_revision is not None


@dataclass
class TxnCompare:
    key: str
    target: Literal["mod", "version", "create", "value"]
    result: Literal["=", "!=", ">", "<"]
    value: int | bytes


class Store:
    """In-memory MVCC store with compact, defrag, and a byte quota."""

    def __init__(self, quota_bytes: int = 2 * 1024 * 1024):
        # First mutation becomes revision 1, matching etcd's initial revision.
        self.revision = 0
        self.compact_revision = 0
        self.quota_bytes = quota_bytes
        self.alarm_nospace = False
        # key -> versions in mod_revision order (including tombstones until compacted)
        self._gens: dict[str, list[KeyValue]] = {}
        # physical backend size only shrinks on defrag
        self.physical_bytes = 0

    def in_use_bytes(self) -> int:
        return sum(kv.size_bytes() for vers in self._gens.values() for kv in vers)

    def _bump(self) -> int:
        self.revision += 1
        return self.revision

    def _check_quota_for_write(self) -> None:
        if self.alarm_nospace or self.physical_bytes >= self.quota_bytes:
            self.alarm_nospace = True
            raise NoSpaceError()

    def _apply_delta(self, kvs: list[KeyValue]) -> None:
        added = 0
        for kv in kvs:
            self._gens.setdefault(kv.key, []).append(kv)
            added += kv.size_bytes()
        self.physical_bytes += added
        if self.physical_bytes >= self.quota_bytes:
            self.alarm_nospace = True

    def put(self, key: str, value: bytes, lease: int = 0) -> KeyValue:
        self._check_quota_for_write()
        rev = self._bump()
        prev = self._latest(key)
        if prev is None or prev.is_tombstone:
            kv = KeyValue(key, value, rev, rev, 1, lease)
        else:
            kv = KeyValue(key, value, prev.create_revision, rev, prev.version + 1, lease)
        self._apply_delta([kv])
        return kv

    def delete(self, key: str) -> KeyValue | None:
        # Deletes remain allowed under NOSPACE so an operator can reclaim history.
        prev = self._latest(key)
        if prev is None or prev.is_tombstone:
            # A no-op delete still creates a revision in this model only if the key exists.
            return None
        rev = self._bump()
        tomb = KeyValue(key, None, prev.create_revision, rev, 0, 0)
        self._apply_delta([tomb])
        return tomb

    def get(self, key: str, revision: int | None = None) -> KeyValue | None:
        rev = self.revision if revision is None else revision
        if revision is not None and revision < self.compact_revision:
            raise CompactedError(self.compact_revision, revision)
        if revision is not None and revision > self.revision:
            raise MvccError(f"required revision {revision} is a future revision")
        return self._at(key, rev)

    def range_keys(
        self, start: str, end: str | None = None, revision: int | None = None
    ) -> tuple[int, list[KeyValue]]:
        rev = self.revision if revision is None else revision
        if revision is not None and revision < self.compact_revision:
            raise CompactedError(self.compact_revision, revision)
        out: list[KeyValue] = []
        for key in sorted(self._gens):
            if key < start:
                continue
            if end is not None and key >= end:
                continue
            kv = self._at(key, rev)
            if kv is not None and not kv.is_tombstone:
                out.append(kv)
        return rev, out

    def txn(
        self, compares: list[TxnCompare], success: list[tuple], failure: list[tuple]
    ) -> tuple[bool, int, list[KeyValue]]:
        ok = all(self._eval_compare(c) for c in compares)
        ops = success if ok else failure
        writes = [op for op in ops if op[0] in ("put", "delete")]
        if writes:
            # Quota is checked only for puts, matching the idea that deletes still work.
            if any(op[0] == "put" for op in writes):
                self._check_quota_for_write()
            rev = self._bump()
        else:
            rev = self.revision
        applied: list[KeyValue] = []
        if writes:
            batch: list[KeyValue] = []
            for op in ops:
                if op[0] == "put":
                    _, key, value = op
                    prev = self._latest(key)
                    # Within the same revision, see already-built batch items first.
                    for pending in reversed(batch):
                        if pending.key == key:
                            prev = pending
                            break
                    if prev is None or prev.is_tombstone:
                        kv = KeyValue(key, value, rev, rev, 1, 0)
                    else:
                        kv = KeyValue(key, value, prev.create_revision, rev, prev.version + 1, 0)
                    batch.append(kv)
                elif op[0] == "delete":
                    _, key = op
                    prev = self._latest(key)
                    for pending in reversed(batch):
                        if pending.key == key:
                            prev = pending
                            break
                    if prev is not None and not prev.is_tombstone:
                        batch.append(KeyValue(key, None, prev.create_revision, rev, 0, 0))
                elif op[0] == "get":
                    pass
            self._apply_delta(batch)
            applied = batch
        return ok, rev, applied

    def compact(self, revision: int) -> int:
        if revision > self.revision:
            raise MvccError(f"compact revision {revision} is a future revision")
        if revision < self.compact_revision:
            raise CompactedError(self.compact_revision, revision)
        # Keep the value at or after 'revision', plus the latest value if it is
        # still live, dropping finished generations and superseded values
        # strictly before the compact revision.
        new_gens: dict[str, list[KeyValue]] = {}
        for key, vers in self._gens.items():
            kept: list[KeyValue] = []
            live_latest: KeyValue | None = None
            for kv in vers:
                if kv.mod_revision >= revision:
                    kept.append(kv)
                else:
                    live_latest = kv
            # A generation that ended before the compact revision is dropped.
            if kept:
                # If the first kept event is not a new generation, the latest
                # pre-compact live value must remain as the current value at
                # the compact point when no kept PUT precedes it. The official
                # rule: values set before the compact revision except the
                # latest one are removed. The latest pre-compact version is
                # kept if it is still the current value (no later version).
                pass
            if live_latest is not None:
                has_later = any(kv.mod_revision >= revision for kv in vers)
                ended_before = live_latest.is_tombstone and live_latest.mod_revision < revision
                if ended_before and not has_later:
                    # Entire generation finished before compact: drop the key.
                    live_latest = None
                elif not has_later:
                    kept = [live_latest] + kept
                elif live_latest.is_tombstone:
                    # Generation already ended; only versions >= revision stay.
                    pass
                else:
                    # There is a later version; the superseded pre-compact value
                    # is dropped (not prepended).
                    pass
            if kept:
                new_gens[key] = kept
        self._gens = new_gens
        self.compact_revision = revision
        return revision

    def defrag(self) -> int:
        self.physical_bytes = self.in_use_bytes()
        return self.physical_bytes

    def disarm_nospace(self) -> bool:
        if self.physical_bytes < self.quota_bytes:
            self.alarm_nospace = False
            return True
        return False

    def watch(self, key: str, start_revision: int, prefix: bool = False) -> WatchResult:
        # start_revision is inclusive. History before compact_revision is gone.
        if start_revision < self.compact_revision:
            return WatchResult(compact_revision=self.compact_revision)
        events: list[Event] = []
        for k, vers in sorted(self._gens.items()):
            if prefix:
                if not k.startswith(key):
                    continue
            elif k != key:
                continue
            for i, kv in enumerate(vers):
                if kv.mod_revision < start_revision:
                    continue
                prev = vers[i - 1] if i > 0 else None
                typ: Literal["PUT", "DELETE"] = "DELETE" if kv.is_tombstone else "PUT"
                events.append(Event(typ, kv, prev))
        events.sort(key=lambda e: (e.kv.mod_revision, e.kv.key))
        return WatchResult(events=events)

    def _eval_compare(self, c: TxnCompare) -> bool:
        kv = self._latest(c.key)
        if c.target == "value":
            left: int | bytes = b"" if kv is None or kv.value is None else kv.value
        elif c.target == "mod":
            left = 0 if kv is None else kv.mod_revision
        elif c.target == "version":
            left = 0 if kv is None or kv.is_tombstone else kv.version
        else:
            left = 0 if kv is None or kv.is_tombstone else kv.create_revision
        right = c.value
        if c.result == "=":
            return left == right
        if c.result == "!=":
            return left != right
        if c.result == ">":
            return left > right  # type: ignore[operator]
        return left < right  # type: ignore[operator]

    def _latest(self, key: str) -> KeyValue | None:
        vers = self._gens.get(key)
        return vers[-1] if vers else None

    def _at(self, key: str, rev: int) -> KeyValue | None:
        vers = self._gens.get(key)
        if not vers:
            return None
        chosen: KeyValue | None = None
        for kv in vers:
            if kv.mod_revision <= rev:
                chosen = kv
            else:
                break
        return chosen


@dataclass
class WatchCache:
    """A simplified API-server watch cache in front of a Store."""

    store: Store
    revision: int = 0
    initialized: bool = False
    objects: dict[str, KeyValue] = field(default_factory=dict)

    def bootstrap(self, prefix: str = "") -> None:
        rev, items = self.store.range_keys(prefix, revision=None)
        self.objects = {kv.key: kv for kv in items}
        self.revision = rev
        self.initialized = True

    def catch_up(self, through: int | None = None) -> None:
        if not self.initialized:
            self.bootstrap()
            return
        target = self.store.revision if through is None else through
        wr = self.store.watch("", start_revision=self.revision + 1, prefix=True)
        if wr.canceled:
            # History was compacted past the cache cursor; rebuild from a list.
            self.initialized = False
            self.bootstrap()
            return
        for ev in wr.events:
            if ev.kv.mod_revision > target:
                break
            if ev.typ == "DELETE":
                self.objects.pop(ev.kv.key, None)
            else:
                self.objects[ev.kv.key] = ev.kv
            self.revision = ev.kv.mod_revision
        # Bookmarks: even with no events, the cache can advance to a known
        # store revision once it has applied everything up to that point.
        if self.revision < target and not wr.canceled:
            # Only advance the cursor when every event <= target was applied.
            applied_max = self.revision
            if all(ev.kv.mod_revision <= target for ev in wr.events) or not wr.events:
                self.revision = max(self.revision, target)

    def list_any(self) -> tuple[str, int, list[KeyValue]] | tuple[str, int, None]:
        if not self.initialized:
            return "rejected_uninitialized", 429, None
        return "any", self.revision, list(self.objects.values())

    def list_most_recent(self) -> tuple[str, int, list[KeyValue] | None]:
        """Consistent list: read the store revision, serve only if caught up."""
        if not self.initialized:
            return "rejected_uninitialized", 429, None
        quorum_rev = self.store.revision  # linearized / quorum read of the header
        if self.revision < quorum_rev:
            return "rejected_not_fresh", quorum_rev, None
        return "most_recent", self.revision, list(self.objects.values())

    def list_not_older_than(self, rv: int) -> tuple[str, int, list[KeyValue] | None]:
        if not self.initialized:
            return "rejected_uninitialized", 429, None
        if self.revision < rv:
            return "rejected_not_fresh", rv, None
        return "not_older_than", self.revision, list(self.objects.values())


def kv_line(kv: KeyValue | None) -> str:
    if kv is None:
        return "nil"
    val = "tombstone" if kv.is_tombstone else kv.value.decode()
    return (
        f"key={kv.key} value={val} create={kv.create_revision} "
        f"mod={kv.mod_revision} version={kv.version}"
    )


def main() -> None:
    print("=== 1. Revisions, versions, and generations ===")
    s = Store(quota_bytes=64 * 1024)
    s.put("pods/default/api", b"v1")
    s.put("pods/default/api", b"v2")
    s.put("pods/default/web", b"ready")
    s.delete("pods/default/api")
    s.put("pods/default/api", b"v3")
    for key in ("pods/default/api", "pods/default/web"):
        print(" current", kv_line(s.get(key)))
    print(f" store.revision={s.revision} compact_revision={s.compact_revision}")
    print(" history of pods/default/api:")
    for kv in s._gens["pods/default/api"]:
        print("  ", kv_line(kv))

    print("\n=== 2. Optimistic concurrency with a compare-and-swap txn ===")
    current = s.get("pods/default/web")
    assert current is not None
    ok, rev, applied = s.txn(
        [TxnCompare("pods/default/web", "mod", "=", current.mod_revision)],
        [("put", "pods/default/web", b"term-2")],
        [],
    )
    print(f" first cas succeeded={ok} revision={rev} -> {kv_line(applied[0])}")
    ok, rev, applied = s.txn(
        [TxnCompare("pods/default/web", "mod", "=", current.mod_revision)],
        [("put", "pods/default/web", b"stale-write")],
        [],
    )
    print(f" stale cas succeeded={ok} revision={rev} applied={len(applied)} current={kv_line(s.get('pods/default/web'))}")

    print("\n=== 3. One revision for a multi-key transaction ===")
    ok, rev, applied = s.txn(
        [],
        [
            ("put", "pods/default/api", b"v4"),
            ("put", "pods/default/web", b"term-3"),
        ],
        [],
    )
    print(f" txn ok={ok} shared revision={rev} n={len(applied)}")
    for kv in applied:
        print("  ", kv_line(kv))
    wr = s.watch("pods/default/", start_revision=rev, prefix=True)
    mods = [e.kv.mod_revision for e in wr.events]
    print(f" watch events in that revision: {len(wr.events)} mods={mods}")

    print("\n=== 4. Time-travel reads, then compact ===")
    s2 = Store(quota_bytes=64 * 1024)
    s2.put("cfg", b"A")  # rev 1
    s2.put("cfg", b"B")  # rev 2
    s2.put("cfg", b"C")  # rev 3
    print(" get(cfg, rev=1)", kv_line(s2.get("cfg", 1)))
    print(" get(cfg, rev=2)", kv_line(s2.get("cfg", 2)))
    print(" get(cfg, rev=3)", kv_line(s2.get("cfg", 3)))
    s2.compact(3)
    print(f" compacted to {s2.compact_revision}, in_use={s2.in_use_bytes()} physical={s2.physical_bytes}")
    try:
        s2.get("cfg", 1)
        print(" get(cfg, rev=1) unexpectedly succeeded")
    except CompactedError as e:
        print(f" get(cfg, rev=1) CompactedError compact_revision={e.compact_revision}")
    print(" get(cfg, rev=3) still", kv_line(s2.get("cfg", 3)))
    print(" current value after compact", kv_line(s2.get("cfg")))

    print("\n=== 5. Watch resume, then a compacted cursor ===")
    s3 = Store(quota_bytes=64 * 1024)
    s3.put("lease/leader", b"a")  # 1
    _, listed, items = ("list", *s3.range_keys("lease/"))
    list_rev = listed
    print(f" list revision={list_rev} count={len(items)}")
    s3.put("lease/leader", b"b")  # 2
    s3.put("lease/leader", b"c")  # 3
    wr = s3.watch("lease/leader", start_revision=list_rev + 1)
    print(" watch from list_rev+1:", [(e.typ, e.kv.value.decode(), e.kv.mod_revision) for e in wr.events])
    last = wr.events[-1].kv.mod_revision
    s3.put("lease/leader", b"d")  # 4
    s3.compact(4)
    wr2 = s3.watch("lease/leader", start_revision=last)
    if wr2.canceled:
        print(f" watch from last={last} canceled compact_revision={wr2.compact_revision}")
    wr3 = s3.watch("lease/leader", start_revision=4)
    print(
        " watch from compact_revision:",
        "canceled" if wr3.canceled else [(e.typ, e.kv.value.decode(), e.kv.mod_revision) for e in wr3.events],
    )

    print("\n=== 6. History growth, compact, and defrag ===")
    s4 = Store(quota_bytes=1024 * 1024)
    keys = [f"pods/default/p{i:02d}" for i in range(8)]
    for k in keys:
        s4.put(k, b"spec-0")
    for step in range(1, 51):
        for k in keys:
            s4.put(k, f"spec-{step}".encode())
    before_in_use = s4.in_use_bytes()
    before_physical = s4.physical_bytes
    n_versions = sum(len(v) for v in s4._gens.values())
    current_rev = s4.revision
    print(
        f" after 8 keys * 51 puts: revision={current_rev} versions={n_versions} "
        f"in_use={before_in_use} physical={before_physical}"
    )
    # Keep a 5-revision window, analogous to keeping a short recent history.
    keep_from = current_rev - 5
    s4.compact(keep_from)
    after_compact_in_use = s4.in_use_bytes()
    after_compact_physical = s4.physical_bytes
    n_versions_after = sum(len(v) for v in s4._gens.values())
    print(
        f" after compact({keep_from}): versions={n_versions_after} "
        f"in_use={after_compact_in_use} physical={after_compact_physical} "
        f"reclaimed_logical={before_in_use - after_compact_in_use} "
        f"reclaimed_physical={before_physical - after_compact_physical}"
    )
    s4.defrag()
    print(
        f" after defrag: in_use={s4.in_use_bytes()} physical={s4.physical_bytes} "
        f"reclaimed_physical={after_compact_physical - s4.physical_bytes}"
    )

    print("\n=== 7. Quota alarm: writes stop, compact+defrag+disarm recover ===")
    s5 = Store(quota_bytes=800)
    n_ok = 0
    tripped_at = None
    try:
        for i in range(40):
            s5.put("events/default/e", f"tick-{i:02d}".encode())
            n_ok += 1
    except NoSpaceError:
        tripped_at = s5.revision
    print(
        f" puts_accepted={n_ok} tripped_at_revision={tripped_at} "
        f"in_use={s5.in_use_bytes()} physical={s5.physical_bytes} "
        f"quota={s5.quota_bytes} alarm={s5.alarm_nospace}"
    )
    try:
        s5.put("events/default/e", b"after-alarm")
        print(" put after alarm unexpectedly succeeded")
    except NoSpaceError:
        print(" put after alarm: NoSpaceError")
    deleted = s5.delete("events/default/e")
    print(f" delete under alarm: {kv_line(deleted)} physical still {s5.physical_bytes}")
    s5.compact(s5.revision)
    print(f" compact: in_use={s5.in_use_bytes()} physical={s5.physical_bytes} alarm={s5.alarm_nospace}")
    s5.defrag()
    disarmed = s5.disarm_nospace()
    print(f" defrag+disarm: physical={s5.physical_bytes} disarmed={disarmed} alarm={s5.alarm_nospace}")
    kv = s5.put("events/default/e", b"recovered")
    print(f" put after disarm: {kv_line(kv)}")

    print("\n=== 8. Watch cache: freshness, consistent lists, uninitialized ===")
    s6 = Store(quota_bytes=64 * 1024)
    for i in range(5):
        s6.put(f"nodes/n{i}", f"ready-{i}".encode())
    cache = WatchCache(s6)
    status, code, _ = cache.list_any()
    print(f" list before bootstrap: {status} code={code}")
    cache.bootstrap()
    print(f" bootstrapped at revision={cache.revision} objects={len(cache.objects)}")
    # Mutations the cache has not applied yet.
    s6.put("nodes/n0", b"not-ready")
    s6.put("nodes/n5", b"ready-5")
    status, quorum, items = cache.list_most_recent()
    print(
        f" most_recent while lagging: {status} quorum_rev={quorum} "
        f"cache_rev={cache.revision} store_rev={s6.revision}"
    )
    status, cache_rev, items = cache.list_any()
    names = sorted(kv.key for kv in items or [])
    print(f" any while lagging: {status} cache_rev={cache_rev} keys={names}")
    cache.catch_up()
    status, cache_rev, items = cache.list_most_recent()
    names = sorted(kv.key for kv in items or [])
    print(
        f" most_recent after catch_up: {status} cache_rev={cache_rev} "
        f"store_rev={s6.revision} keys={names}"
    )
    stale = cache.list_not_older_than(cache.revision + 10)
    print(f" not_older_than future rv: {stale[0]} requested={stale[1]}")
    ok_list = cache.list_not_older_than(cache.revision)
    print(f" not_older_than current rv: {ok_list[0]} served_rev={ok_list[1]} n={len(ok_list[2] or [])}")


if __name__ == "__main__":
    main()

```

这次运行打印了以下内容。

```text
=== 1. Revisions, versions, and generations ===
 current key=pods/default/api value=v3 create=5 mod=5 version=1
 current key=pods/default/web value=ready create=3 mod=3 version=1
 store.revision=5 compact_revision=0
 history of pods/default/api:
   key=pods/default/api value=v1 create=1 mod=1 version=1
   key=pods/default/api value=v2 create=1 mod=2 version=2
   key=pods/default/api value=tombstone create=1 mod=4 version=0
   key=pods/default/api value=v3 create=5 mod=5 version=1

=== 2. Optimistic concurrency with a compare-and-swap txn ===
 first cas succeeded=True revision=6 -> key=pods/default/web value=term-2 create=3 mod=6 version=2
 stale cas succeeded=False revision=6 applied=0 current=key=pods/default/web value=term-2 create=3 mod=6 version=2

=== 3. One revision for a multi-key transaction ===
 txn ok=True shared revision=7 n=2
   key=pods/default/api value=v4 create=5 mod=7 version=2
   key=pods/default/web value=term-3 create=3 mod=7 version=3
 watch events in that revision: 2 mods=[7, 7]

=== 4. Time-travel reads, then compact ===
 get(cfg, rev=1) key=cfg value=A create=1 mod=1 version=1
 get(cfg, rev=2) key=cfg value=B create=1 mod=2 version=2
 get(cfg, rev=3) key=cfg value=C create=1 mod=3 version=3
 compacted to 3, in_use=36 physical=108
 get(cfg, rev=1) CompactedError compact_revision=3
 get(cfg, rev=3) still key=cfg value=C create=1 mod=3 version=3
 current value after compact key=cfg value=C create=1 mod=3 version=3

=== 5. Watch resume, then a compacted cursor ===
 list revision=1 count=1
 watch from list_rev+1: [('PUT', 'b', 2), ('PUT', 'c', 3)]
 watch from last=3 canceled compact_revision=4
 watch from compact_revision: [('PUT', 'd', 4)]

=== 6. History growth, compact, and defrag ===
 after 8 keys * 51 puts: revision=408 versions=408 in_use=22360 physical=22360
 after compact(403): versions=8 in_use=440 physical=22360 reclaimed_logical=21920 reclaimed_physical=0
 after defrag: in_use=440 physical=440 reclaimed_physical=21920

=== 7. Quota alarm: writes stop, compact+defrag+disarm recover ===
 puts_accepted=15 tripped_at_revision=15 in_use=825 physical=825 quota=800 alarm=True
 put after alarm: NoSpaceError
 delete under alarm: key=events/default/e value=tombstone create=1 mod=16 version=0 physical still 873
 compact: in_use=48 physical=873 alarm=True
 defrag+disarm: physical=48 disarmed=True alarm=False
 put after disarm: key=events/default/e value=recovered create=17 mod=17 version=1

=== 8. Watch cache: freshness, consistent lists, uninitialized ===
 list before bootstrap: rejected_uninitialized code=429
 bootstrapped at revision=5 objects=5
 most_recent while lagging: rejected_not_fresh quorum_rev=7 cache_rev=5 store_rev=7
 any while lagging: any cache_rev=5 keys=['nodes/n0', 'nodes/n1', 'nodes/n2', 'nodes/n3', 'nodes/n4']
 most_recent after catch_up: most_recent cache_rev=7 store_rev=7 keys=['nodes/n0', 'nodes/n1', 'nodes/n2', 'nodes/n3', 'nodes/n4', 'nodes/n5']
 not_older_than future rv: rejected_not_fresh requested=17
 not_older_than current rv: not_older_than served_rev=7 n=6
```

这些数字在说什么：

- **世代。** `pods/default/api` 在修订版本 1 被创建，在 2 被更新，在 4 被删除（墓碑，`version=0`），又在 5 被重新创建。第二世代的 `create_revision=5`，`version=1`。`pods/default/web` 没有被那次删除碰到，仍然是 `create_revision=3`。
- **比较并交换。** 第一笔事务比较 `mod_revision` 3，并在修订版本 6 写入 `term-2`。第二笔事务仍使用已经过期的比较值 3，失败，不应用任何操作，而且——因为失败列表是空的——不会消耗新的修订版本。存储停在 6。
- **原子的 Watch。** 下一笔事务在共享的修订版本 7 写入两个键。从 7 开始的前缀 Watch 返回两个事件，它们的 `mod` 都是 7。
- **时间旅行与压缩。** 压缩之前，`get(cfg, rev=1)` 返回 `A`。在 `compact(3)` 之后，同一次读取会抛出 `CompactedError`，其中 `compact_revision=3`。仍然有效的值 `C` 留了下来。逻辑大小从 108 字节降到 36；物理大小仍是 108，直到做碎片整理——这个场景没有做。
- **被压缩掉的 Watch 游标。** 在修订版本 1 做完 List 之后，从 `list_rev+1` 开始的 Watch 看到了修订版本 2 和 3 上的 put。压缩到 4 之后，从 3 恢复会被取消（`compact_revision=4`）。从压缩修订版本本身开始的 Watch 仍然能看到修订版本 4 上的 `PUT d`。
- **历史与文件。** 八个键各更新 51 次，留下 408 个版本、22,360 字节。`compact(403)` 只留下八个仍然有效的值（440 字节），但收回的物理字节是 0。随后的碎片整理把文件从 22,360 降到 440，收回 21,920 字节。
- **配额恢复。** 在 800 字节的配额下，15 次 put 被接受，第 16 次在修订版本 15 触发告警，当时物理大小是 825。告警之后的 put 失败；删除仍被接受，并写入墓碑（修订版本 16，物理大小 873）。压缩把在用大小降到 48，但文件仍是 873，告警也还在。碎片整理并解除告警后，物理大小来到 48，修订版本 17 上的新 put 才会成功。
- **缓存新鲜度。** 引导之前的 list 是 `rejected_uninitialized`，代码 429。在修订版本 5 完成引导后，又有两次写入把存储推到 7。一次"最新"列表被拒绝（`quorum_rev=7`，`cache_rev=5`），而一份"任意"列表会被返回，并且缺少 `nodes/n5`。在 `catch_up` 之后，"最新"列表在修订版本 7 成功，带有六个键。对未来修订版本的 `NotOlderThan` 会被拒绝；对当前缓存修订版本的 `NotOlderThan` 会被提供。

## 总结

- etcd 是一个小型的、严格可串行化的 MVCC 存储。集群范围的修订版本给变更排好全序；每个键还带有 `create_revision`、`mod_revision`，以及一个世代内的 `version`。删除用墓碑结束一个世代；再次写入同一个键会开启新的世代。
- 在仍被保留的历史窗口里，Watch 是有序、唯一、可靠、原子、可恢复、并且可标记进度的。它们不是线性一致的。如果 `start_revision` 已经被压缩，Watch 会带上 `compact_revision` 被取消。
- 已经公布的限制是：每个请求 1.5 MiB，默认配额 2 GiB，建议的最大值 8 GiB。`NOSPACE` 会让集群只接受读取和删除，直到你压缩、做碎片整理并解除告警。压缩丢掉历史；会阻塞该成员的碎片整理，才是把字节还给文件系统的步骤。
- 磁盘 fsync 延迟就是可用性预算。etcd 在典型情况下要求大约 50 的顺序 IOPS，高负载时大约 500。Kubernetes 建议使用专用机器，并在生产里使用五成员集群。
- kube-apiserver 默认把对象以 protobuf 存在 `/registry` 下，并且每五分钟通过对 `compact_rev_key` 做比较并交换来压缩 etcd，从而大约保留五分钟历史。滞后超过这个窗口的 Watch 必须处理 `410 Gone`，重新 List，再继续。
- Watch Cache 就是读路径。`resourceVersion=0` 可以是旧的；"最新"列表是一致的，并且在 Kubernetes 1.37（配合 etcd v3.4.31+ 或 v3.5.13+）上，会在一次进度检查之后从缓存提供。`ConsistentListFromCache` 从 1.34 起已经稳定。尚未初始化的缓存会拖住 `/readyz`，并对 Watch 以及未分页或带过滤的 List 返回 `429`。流式列表（`WatchList`，自 1.34 起为 beta）和流式 etcd 范围读取（`EtcdRangeStream`，自 1.37 起为 beta）的存在，是为了让大型的初始读取离开热点路径。
- 在模型里，408 个版本占用 22,360 字节；压缩留下八个仍然有效的键（440 字节），在碎片整理收回 21,920 字节之前，不会释放文件空间。800 字节的配额在 15 次 put 之后被触发；下一次 put 能够成功，靠的是压缩、碎片整理再解除告警。停留在修订版本 5 的缓存会拒绝针对修订版本 7 的"最新"列表，会提供一份旧的"任意"列表，并且只有在追上之后才提供一致的列表。

## 参考资料

- etcd, [Data model](https://etcd.io/docs/v3.7/learning/data_model/)
- etcd, [etcd API](https://etcd.io/docs/v3.7/learning/api/)
- etcd, [etcd API guarantees](https://etcd.io/docs/v3.7/learning/api_guarantees/)
- etcd, [System limits](https://etcd.io/docs/v3.7/dev-guide/limit/)
- etcd, [Maintenance](https://etcd.io/docs/v3.7/op-guide/maintenance/)
- etcd, [Hardware recommendations](https://etcd.io/docs/v3.7/op-guide/hardware/)
- Kubernetes, [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- Kubernetes, [kube-apiserver reference](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- Kubernetes, [API concepts: efficient detection of changes, resource versions, streaming lists, and watch cache initialization](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- Kubernetes, [Feature Gates](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/) (`ConsistentListFromCache`, `ListFromCacheSnapshot`, `WatchList`, `WatchListClient`, `EtcdRangeStream`)
- Kubernetes, [pkg/storage/etcd3/compact.go](https://github.com/kubernetes/apiserver/blob/master/pkg/storage/etcd3/compact.go)
- Kubernetes Enhancement Proposal, [KEP-2340: Consistent Reads from Cache](https://www.kubernetes.dev/resources/keps/2340/)
- Kubernetes Enhancement Proposal, [KEP-3157: Allow informers to get a stream of data instead of chunking](https://www.kubernetes.dev/resources/keps/3157/)
- Kubernetes Enhancement Proposal, [KEP-4988: Snapshottable API server cache](https://www.kubernetes.dev/resources/keps/4988/)
