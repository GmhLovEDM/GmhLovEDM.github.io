---
title: "一致性哈希与数据分片：哈希环、Rendezvous、Jump Hash、Maglev 与有界负载"
tag: architecture
description: 分布式系统如何决定哪个节点负责哪个 key——为什么 hash 取模在扩缩容时会崩，一致性哈希环与虚拟节点，Rendezvous（HRW）哈希，Google 的 Jump Consistent Hash，Maglev 查找表，有界负载一致性哈希，以及 Dynamo、Cassandra、Redis Cluster、Kafka、CockroachDB 和 Envoy 在实际中如何对数据和流量做分片
date: "2026-10-30T10:30:00.000Z"
---

## 目标

只要系统把数据或请求分散到不止一台机器上，就要反复回答同一个问题：**给定一个 key，它归哪个节点？** 缓存、分库分表、消息队列、负载均衡器、对象存储都需要一个 `owner(key) -> node` 函数，要求它快、均衡，而且最重要的是——在节点集合变化时表现良好。

本文内容：

1. 为什么 `hash(key) % N` 是个坑。
2. 一致性哈希环与虚拟节点。
3. Rendezvous（最高随机权重）哈希。
4. Jump Consistent Hash。
5. 面向负载均衡器的 Maglev 哈希。
6. 有界负载的一致性哈希。
7. 哈希分片与范围分片，以及真实系统如何选择。
8. 工程上的坑：热点 key、再平衡、副本与成员管理。

## 1. `hash % N` 的问题

最直观的写法是：

```go
func owner(key string, nodes []string) string {
    return nodes[hash(key)%uint64(len(nodes))]
}
```

只要哈希函数够好，它就完全均衡，而且是 O(1)。问题出在 `N` 变化的那一刻。从 `N` 个节点变成 `N+1` 个，只有满足 `h % N == h % (N+1)` 的 key 才能保持原归属，这大约只占 `1/(N+1)`。给一个 9 节点的缓存集群加第 10 台机器，大约 **90%** 的 key 会被重新映射。对缓存来说，这意味着几乎全量未命中，流量全部压到数据库上；对数据库来说，这意味着几乎所有数据都要搬家。

我们想要的性质是**最小扰动**：加入一个节点时，只应有大约 `K/N` 个 key（它应得的那一份）发生迁移，而且全部迁到新节点上；移除一个节点时，只有它自己的 key 需要迁移。下面每种算法都能做到这一点，只是在内存、查找开销、均衡性和灵活性上各有取舍。

## 2. 一致性哈希环

Karger 等人在 1997 年为构建分布式 Web 缓存提出了一致性哈希。思路是：

1. 把节点和 key 都哈希到同一个环形空间上，比如 `[0, 2^64)`。
2. 一个 key 归属于从它的位置出发、顺时针遇到的第一个节点。

加入节点 `X` 时，只会从 `X` 与它前驱之间的那段弧上"抢"走 key，其他 key 都不动；移除一个节点时，它的那段弧交给它的后继。

### 虚拟节点

如果每个节点在环上只有一个点，各段弧的长度会差别很大。`n` 个节点随机放置时，最长的那段弧大约是整个环的 `(log n)/n`，也就是说某个节点可能承担好几倍于平均值的负载。标准解法是**虚拟节点**：每个物理节点在环上放很多个点（`node#0`、`node#1`……）。每个节点的点足够多时，单个物理节点的负载会集中在 `1/n` 附近。

虚拟节点还带来两个实际好处：

- **异构容量**：内存大一倍的机器分配多一倍的虚拟节点。
- **故障恢复更分散**：一个节点挂掉时，它的许多小段弧由许多不同的后继接手，而不是由一个邻居独自吃下全部负载。

代价是内存和查找时间：要维护一个长度为 `n × v` 的有序数组，每次查找做一次二分。

```go
package ring

import (
    "hash/fnv"
    "sort"
    "strconv"
)

type Ring struct {
    points []uint64          // 有序
    owner  map[uint64]string // 环上的点 -> 物理节点
}

func h(s string) uint64 {
    f := fnv.New64a()
    f.Write([]byte(s))
    return f.Sum64()
}

func New(nodes []string, vnodes int) *Ring {
    r := &Ring{owner: make(map[uint64]string)}
    for _, n := range nodes {
        for i := 0; i < vnodes; i++ {
            p := h(n + "#" + strconv.Itoa(i))
            r.points = append(r.points, p)
            r.owner[p] = n
        }
    }
    sort.Slice(r.points, func(i, j int) bool { return r.points[i] < r.points[j] })
    return r
}

func (r *Ring) Get(key string) string {
    k := h(key)
    i := sort.Search(len(r.points), func(i int) bool { return r.points[i] >= k })
    if i == len(r.points) {
        i = 0 // 绕回环首
    }
    return r.owner[r.points[i]]
}
```

生产环境里会换成更强更快的哈希（xxHash、Murmur3），并处理点冲突，但结构是一样的。memcached 客户端常用的 libketama 让这种设计流行开来。

### 环上的副本

Amazon 的 Dynamo（DeCandia 等，SOSP 2007）把哈希环扩展到了副本场景：一个 key 存在顺时针方向前 `N` 个**不同的物理**节点上，这就是**偏好列表（preference list）**。跳过映射到已选物理节点的虚拟节点非常关键，否则两个副本可能落在同一台机器上。Cassandra 和 Riak 继承了这个模型，Cassandra 在使用 `NetworkTopologyStrategy` 时还会跳过同一机架或可用区的节点。

## 3. Rendezvous（HRW）哈希

Thaler 和 Ravishankar 提出的**最高随机权重（Highest Random Weight）**哈希比很多人以为的要早（上世纪 90 年代中期），而且比哈希环更简单：

> 对一个 key，为每个节点计算 `score = hash(key, node)`，选分数最高的节点。

```go
func Rendezvous(key string, nodes []string) string {
    var best string
    var bestScore uint64
    for _, n := range nodes {
        if s := h(n + "\x00" + key); best == "" || s > bestScore {
            best, bestScore = n, s
        }
    }
    return best
}
```

它的性质：

- **天然最小扰动**：移除一个节点，只影响它原本胜出的那些 key，这些 key 会落到各自分数第二高的节点。
- **没有额外状态**：没有环，没有虚拟节点，期望上完全均衡。
- **副本天然支持**：取分数前 `k` 名就得到 `k` 个不同的副本，而且已经排好序。
- **支持权重**：用对数方法 `score = -w / ln(u)`，其中 `u` 是映射到 `(0,1)` 的哈希值，加权后依然保持最小扰动。

代价是每次查找 **O(n)**。对几十到几百个节点来说这点开销可以忽略，实际上往往比在几千个虚拟点上做缓存不友好的二分查找还快。对超大集群，可以用分层的 "skeleton" 变体把节点组织成树，做到 O(log n)。

## 4. Jump Consistent Hash

Lamping 和 Veach（Google，2014）发表了一个只有几行、完全不占内存的算法，把 64 位 key 映射到 `num_buckets` 个桶之一：

```c
int32_t JumpConsistentHash(uint64_t key, int32_t num_buckets) {
    int64_t b = -1, j = 0;
    while (j < num_buckets) {
        b = j;
        key = key * 2862933555777941757ULL + 1;
        j = (b + 1) * (double(1LL << 31) / double((key >> 33) + 1));
    }
    return b;
}
```

直觉是：桶数从 1 增长到 `n` 的过程中，每新增第 `j` 个桶，key 应该以 `1/j` 的概率跳到这个新桶。算法没有逐步检查，而是用以 key 为种子的伪随机数直接算出**下一次跳跃发生在哪里**，所以期望迭代次数是 O(log n)。

优点：零内存、近乎完美的均衡、非常快。最大的限制是：桶的编号是 **0..n-1，只能在末尾增减**，不能从 10 个桶里删掉第 3 个。所以 Jump Hash 很适合把 key 映射到**分片**（逻辑上的、稳定的、有编号的），而不是映射到**服务器**（会随机故障）。常见做法是两层：用 Jump Hash 做 `key -> 分片`，再用单独维护的放置表做 `分片 -> 副本组`。

## 5. Maglev 哈希

Google 的 Maglev（Eisenbud 等，NSDI 2016）是一个软件网络负载均衡器。它需要把数据包（五元组）映射到后端，并满足：

- 同一连接的所有包都到同一个后端，即使经过不同的 Maglev 机器、彼此没有共享状态；
- 负载分布非常均匀；
- 后端变化时尽量少地打断连接；
- 查找只需一次内存访问。

Maglev 构建一个大小为质数 `M` 的查找表（论文示例用 65537）。对每个后端 `i`，生成 `[0, M)` 的一个排列：

```
offset = h1(name_i) mod M
skip   = h2(name_i) mod (M - 1) + 1
permutation_i[j] = (offset + j * skip) mod M
```

由于 `M` 是质数、`skip` 非零，每个排列都会遍历所有槽位。之后各后端轮流认领自己偏好序列中下一个未被占用的槽位，直到表填满。查找就是 `table[hash(五元组) % M]`。

结果几乎完全均匀——每个后端拥有 `M/n` 个槽位，误差不超过一个——代价是扰动比哈希环略差：后端变化时，少量槽位也可能在**存活的**后端之间移动。Maglev 用连接跟踪来弥补：已有连接通过本地连接表留在原后端，一致性查找表只对新连接、或包落到另一台 Maglev 机器时才起作用。

Envoy 同时实现了 `RING_HASH` 和 `MAGLEV` 两种负载均衡策略，Maglev 表默认 65537 项。由于 O(1) 查找和更好的均匀性，Maglev 通常是 L4/L7 负载均衡更好的默认选择；需要更精细地控制扰动时，哈希环仍然有用。

## 6. 有界负载的一致性哈希

以上算法均衡的是 **key**，而不是**负载**。如果某个 key 很热，或者 key 分布有偏斜，单个节点仍然可能被压垮。Mirrokni、Thorup 和 Zadimoghaddam（2016 年提出，发表于 SODA 2018）给了一个简单的解法：

- 选一个均衡因子 `c > 1`（比如 1.25）。
- 每个节点的容量是 `ceil(c × 平均负载)`。
- 照常在环上顺时针查找，但**跳过已满的节点**。

这保证了没有节点超过平均负载的 `c` 倍，同时保留了一致性哈希的大部分粘性。Vimeo 的工程师把它贡献给了 HAProxy，在使用一致性哈希 `balance` 的后端上用 `hash-balance-factor`（比如 `hash-balance-factor 125`）开启。

取舍是局部性下降：高负载时部分请求溢出到非首选节点，那里的缓存命中率会低一些。对于挡在昂贵后端前面的缓存层，这通常是对的选择——命中率略降，远好过一个节点被打挂。

## 7. 哈希分片与范围分片

到目前为止讲的都是**哈希分片**：key 被均匀打散。它非常适合点查和分散写入，但会破坏顺序——范围扫描 `user_id BETWEEN 1000 AND 2000` 必须访问所有分片。

**范围分片**保持 key 有序，把 key 空间切成连续的区间。Bigtable 的 tablet、HBase 的 region、CockroachDB 的 range、TiKV 的 region 都是这样：区间超过大小阈值（或变热）时分裂，再由放置服务在节点间迁移。它支持高效扫描和天然的局部性，但单调递增的 key（时间戳、自增 ID）会让所有写入集中在最后一个区间——这就是典型的**热点**。常见的缓解办法是对 key 前缀做哈希或加盐，或者在不需要顺序时使用类似 UUIDv4 的 key。

真实系统的选择：

| 系统 | 方案 | 说明 |
|---|---|---|
| Dynamo / Riak | 带虚拟节点的哈希环 | 偏好列表由 N 个不同物理节点组成 |
| Cassandra | Token 环（Murmur3 分区器） | 每节点 `num_tokens` 个虚拟节点；4.0 起默认值从 256 降到 16，并配合 token 分配算法 |
| Redis Cluster | 16384 个固定哈希槽 | `CRC16(key) mod 16384`；`{tag}` 让相关 key 落到同一个槽 |
| Kafka | `murmur2(key) % 分区数` | 增加分区数会重映射 key，跨越变更时单 key 的顺序会被打破 |
| CockroachDB / TiKV / Spanner | 范围分片 | 按大小和负载分裂、合并；由放置调度器迁移区间 |
| Envoy / Maglev | 查找表 | 每请求 O(1)；用于 L4/L7 会话亲和 |

Redis Cluster 值得单独说一下：它不直接哈希到节点，而是哈希到**固定数量的槽**，再把槽分配给节点。这种"间接表"模式（Couchbase 的 vBucket、Elasticsearch 的 shard 也是）既有类似一致性哈希的行为，又让再平衡变得显式、可由运维控制。迁移一个槽是一个明确的工作单元，可以限速、观测和断点续传。

注意 Kafka 式 `% 分区数` 的坑：它就是第 1 节里那种朴素方案。这也是为什么通常建议一开始就预留足够的分区，因为后期增加分区会改变每个 key 落到哪个分区。

## 8. 工程上的坑

**热点 key。** 任何分片函数都解决不了一个 key 吃掉 30% 流量的问题。可选方案：把热 key 的值复制到多个节点、从任意一个读取（用 `hot:1..8` 这样的后缀），加一层短 TTL 的进程内本地缓存，或者用有界负载哈希把多出的请求溢出出去。

**再平衡才是真正的成本。** 算法告诉你**哪些** key 该迁移，系统还得真的把它们**搬过去**。后台拷贝数据，迁移期间双读或转发，限制带宽，等新节点追平后再切换归属。固定槽/分片之所以好用，就是因为迁移单位是明确的。

**成员视图必须一致。** 只有所有客户端看到同一份节点列表，一致性哈希才能给出一致的答案。Dynamo 和 Cassandra 用 gossip 同步，Redis Cluster 客户端跟随 `MOVED`/`ASK` 重定向，范围分片系统则维护一个元数据服务（通常本身也用 Raft 复制）。成员变化期间，视图过期的客户端会路由到错误的节点，所以服务端必须能发现并重定向。

**认真选哈希函数。** 需要的是均匀和速度，不是密码学强度；但哈希必须**跨语言、跨版本稳定**，因为 Go、Java、Python 写的客户端必须算出同一个结果。不要用语言内置的随机化哈希（Go 的 map、Python 字符串的 `hash()`）来做放置。

**区分故障与计划内变更。** 一个反复抖动的节点不应该每次都触发数据迁移。要区分临时不可用（hinted handoff、重试下一个副本）和永久下线（再平衡）。

### 快速选型

- 中小规模服务器列表，需要副本和权重，代码要少：**Rendezvous 哈希**。
- 映射到只会增长的编号分片：**Jump Consistent Hash**。
- 每请求都要查找、要求均匀分布的负载均衡器：**Maglev**。
- 流量有偏斜的缓存层：**哈希环 + 有界负载**。
- 需要可控迁移的数据存储：**固定槽/分片 + 放置表**。
- 需要范围扫描和有序访问：**范围分片**，配合自动分裂和热点区间检测。

## 总结

`hash % N` 很均衡，但扩缩容时是灾难。一致性哈希——无论是带虚拟节点的环、Rendezvous 打分、Jump Hash 还是 Maglev 查找表——都能把成员变化时的迁移量限制在大约应得的那一份 key，只是在内存、查找开销、均匀性和灵活性上取舍不同。有界负载变体用来对抗偏斜，而生产系统通常还会加一层间接（槽、分片、区间），让再平衡成为一个显式、可观测的过程，而不是哈希函数的副作用。

## 参考资料

- Karger et al., "Consistent Hashing and Random Trees: Distributed Caching Protocols for Relieving Hot Spots on the World Wide Web" (STOC 1997)
- Thaler and Ravishankar, "Using Name-Based Mappings to Increase Hit Rates" (IEEE/ACM Transactions on Networking, 1998)
- Lamping and Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (2014): https://arxiv.org/abs/1406.2294
- Eisenbud et al., "Maglev: A Fast and Reliable Software Network Load Balancer" (NSDI 2016): https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/
- Mirrokni, Thorup and Zadimoghaddam, "Consistent Hashing with Bounded Loads" (SODA 2018): https://arxiv.org/abs/1608.01350
- DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store" (SOSP 2007)
- Redis Cluster 规范: https://redis.io/docs/ (Cluster specification)
- Envoy 负载均衡文档: https://www.envoyproxy.io/docs (Upstream load balancing)
- HAProxy 配置手册，`hash-balance-factor`: https://docs.haproxy.org/
- Apache Cassandra 文档，Dynamo 架构: https://cassandra.apache.org/doc/ (Architecture: Dynamo)
