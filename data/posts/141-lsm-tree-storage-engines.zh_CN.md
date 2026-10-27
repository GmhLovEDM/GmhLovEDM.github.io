---
title: "深入 LSM-Tree 存储引擎：Memtable、SSTable、Compaction 与布隆过滤器"
tag: architecture
description: 日志结构合并树如何支撑 RocksDB、LevelDB、Cassandra、ScyllaDB、TiKV 以及 CockroachDB 的 Pebble——经过 WAL 与 memtable 的写路径、SSTable 文件结构、借助布隆过滤器和 block cache 的读路径、分层（leveled）与分级（tiered）合并以及写/读/空间放大三角、墓碑与范围删除、写停顿、键值分离（WiscKey、BlobDB），以及在真实场景中 LSM 何时胜过 B+ 树
date: "2026-10-27T14:25:00.000Z"
---

## 目标

现代存储引擎中有相当大一部分建立在同一个思想之上：**磁盘上的数据永不原地更新，只追加写入，再在后台合并。** 这就是日志结构合并树（Log-Structured Merge tree，LSM 树），由 O'Neil 等人在 1996 年提出，并经由 Google 的 Bigtable 和 LevelDB 广为流行。今天它运行在 RocksDB（进而是 MyRocks、TiKV、Kafka Streams 状态存储等众多系统）、Apache Cassandra、ScyllaDB、HBase 以及 CockroachDB 的 Pebble 之下。

本文端到端地拆解 LSM 引擎的工作方式，配一个可以运行的核心思想小模型，然后深入真正决定线上表现的部分：compaction（合并压缩），以及写放大、读放大、空间放大之间的取舍。除特别说明外，参数名和默认值均以 RocksDB 为准；默认值会随版本变化，请以你实际使用的版本为准。

## 为什么不直接用 B+ 树？

B+ 树（InnoDB、PostgreSQL 索引以及大多数经典数据库）把键有序地存放在固定大小的页中，并且**原地**更新页。这带来了出色的点查和范围读——通常只需几次页读取，而且大多命中缓存——但写入有代价：

- 每次小更新都会弄脏一整页（通常 4–16 KB），最终必须写回，外加预写日志记录。写一行 100 字节的数据可能意味着写入数 KB。
- 随机插入导致随机 I/O 和页分裂，页最终只是部分填满（碎片化）。
- 压缩以页为单位，压缩后的页仍需按块边界对齐，浪费空间。

LSM 树把随机写转换为大块、不可变、紧凑、易压缩文件的**顺序**写。代价体现在读（同一个键的数据可能分布在多个地方）和后台工作（合并这些文件）上。这笔交易是否划算取决于工作负载——这正是本文真正要讨论的主题。

## 写路径

在 RocksDB/LevelDB 中，一次写入（`Put(key, value)` 或 `Delete(key)`）做三件事：

1. **追加到预写日志（WAL）。** 这是持久化点。根据配置，日志可以每次写都 fsync、按组提交（group commit）fsync，或者交给操作系统。
2. **插入 memtable**，一个内存中的有序结构——RocksDB 默认是并发跳表。
3. 返回。不读取也不修改任何磁盘页。

当 memtable 达到 `write_buffer_size`（RocksDB 默认 64 MB）时，它变为**不可变**，新的 memtable 接收后续写入，后台线程把不可变 memtable **flush** 到磁盘，形成一个有序文件：SSTable（Sorted String Table）。flush 完成后，对应的 WAL 段即可丢弃。

删除也是写入：`Delete` 会插入一个**墓碑（tombstone）**，表示"该键自序列号 S 起已被删除"。每个条目都带有单调递增的序列号，快照和 MVCC 读也依赖它：序列号为 S 的快照只需忽略比 S 新的条目即可。

## SSTable 结构

SSTable 一旦写成就不可变。RocksDB 默认的 block-based table 格式包含：

- **数据块**（默认未压缩约 4 KB），存放有序的键值条目，重启点之间对键做前缀压缩，并按块压缩（LZ4、Zstd 等）。
- **索引块**，把每个数据块的最后一个键映射到其偏移量，查找时对索引二分，然后只读一个数据块。
- **过滤器块**——覆盖该文件所有键的布隆（或 Ribbon）过滤器——使大多数针对不存在键的查找无需触碰数据块就能跳过该文件。
- 元数据和定位其余部分的 footer。

由于文件有序且不可变，它们压缩效果好、可按块缓存、可通过硬链接被快照和 checkpoint 共享，读取时也无需加锁。

## 读路径

点查 `Get(key)` 必须找到该键的**最新**版本，因此按从新到旧的顺序查找，命中即停：

1. 活跃 memtable，然后是不可变 memtable。
2. Level 0 文件，从新到旧。L0 文件直接由 memtable flush 而来，键范围**相互重叠**，每个都可能需要检查。
3. L1…Ln 各层。这些层内部的文件键范围**互不重叠**，所以每层最多只有一个文件可能包含该键（对文件边界二分即可找到）。

对每个候选文件，引擎先查布隆过滤器；只有返回"可能存在"时才读取索引和一个数据块，通常经过 **block cache**。如果遇到墓碑，说明该键不存在。

范围扫描更难：它要把所有 memtable 和所有层的迭代器做多路归并（k-way merge），跳过被覆盖的旧版本和墓碑。这就是为什么一个键范围内堆积大量墓碑时，即使数据已经"删除"，扫描仍然很慢。

## 一个最小 LSM 模型

下面的 Python 代码抓住了要点：memtable、flush 成带布隆过滤器的有序 run、从新到旧的读取，以及一次合并 compaction——丢弃被覆盖的旧版本，并在最底层丢弃墓碑。

```python
import bisect, hashlib, heapq

TOMBSTONE = object()

class Bloom:
    def __init__(self, n, bits_per_key=10):
        self.m = max(64, n * bits_per_key)
        self.k = max(1, round(bits_per_key * 0.69))   # optimal k = (m/n) ln 2
        self.bits = bytearray(self.m // 8 + 1)
    def _hashes(self, key):
        h = hashlib.blake2b(key.encode(), digest_size=16).digest()
        h1, h2 = int.from_bytes(h[:8], "little"), int.from_bytes(h[8:], "little")
        return [(h1 + i * h2) % self.m for i in range(self.k)]   # double hashing
    def add(self, key):
        for b in self._hashes(key): self.bits[b // 8] |= 1 << (b % 8)
    def may_contain(self, key):
        return all(self.bits[b // 8] & (1 << (b % 8)) for b in self._hashes(key))

class SSTable:
    def __init__(self, items):                # items: sorted list of (key, seq, value)
        self.keys = [k for k, _, _ in items]
        self.items = items
        self.bloom = Bloom(len(items))
        for k in self.keys: self.bloom.add(k)
    def get(self, key):
        if not self.bloom.may_contain(key): return None
        i = bisect.bisect_left(self.keys, key)
        return self.items[i] if i < len(self.keys) and self.keys[i] == key else None

class LSM:
    def __init__(self, memtable_limit=4):
        self.mem, self.seq, self.limit = {}, 0, memtable_limit
        self.runs = []                         # newest first
    def put(self, key, value):
        self.seq += 1
        self.mem[key] = (self.seq, value)      # a real engine appends to a WAL first
        if len(self.mem) >= self.limit: self.flush()
    def delete(self, key): self.put(key, TOMBSTONE)
    def flush(self):
        items = sorted((k, s, v) for k, (s, v) in self.mem.items())
        self.runs.insert(0, SSTable(items)); self.mem = {}
    def get(self, key):
        if key in self.mem:
            v = self.mem[key][1]
            return None if v is TOMBSTONE else v
        for run in self.runs:                  # newest to oldest
            hit = run.get(key)
            if hit: return None if hit[2] is TOMBSTONE else hit[2]
        return None
    def compact(self, bottommost=True):
        merged = heapq.merge(*[r.items for r in self.runs], key=lambda e: (e[0], -e[1]))
        out, last = [], None
        for k, s, v in merged:
            if k == last: continue             # older version is shadowed: drop it
            last = k
            if v is TOMBSTONE and bottommost: continue   # nothing older can resurface
            out.append((k, s, v))
        self.runs = [SSTable(out)]

db = LSM()
for i in range(10): db.put(f"user:{i:03}", f"v{i}")
db.put("user:003", "v3-new"); db.delete("user:007")
assert db.get("user:003") == "v3-new" and db.get("user:007") is None
db.compact()
assert db.get("user:003") == "v3-new" and db.get("user:007") is None
```

注意 `compact` 中的规则：只有当本次 compaction 包含了该键范围的**最底层**数据时，墓碑才能被丢弃。过早丢弃的话，更低层中的旧值就会"复活"。真实引擎还必须保留仍被活跃快照引用的版本。

## Compaction：真正的取舍所在

没有 compaction，每次 flush 都会多一个读取时要检查的文件，被覆盖或删除的数据也永远无法回收。Compaction 负责合并文件、丢弃被覆盖的版本和可删除的墓碑，并维护层级结构。其代价用三种放大来衡量：

- **写放大（WA）**：写入存储的字节数 ÷ 应用写入的字节数。它消耗磁盘带宽和 SSD 寿命。
- **读放大（RA）**：每次查找触及的文件或块数。
- **空间放大（SA）**：磁盘占用 ÷ 有效数据大小。

RUM 猜想（Athanassoulis 等，EDBT 2016）把这种直觉形式化：一种访问方法最多只能在读（Read）、更新（Update）、内存/空间（Memory）三项开销中优化两项，代价是第三项。各种 compaction 策略就是这个三角形上的不同点。

### 分层合并（Leveled）

LevelDB 和 RocksDB 默认使用。每个层 Li（i ≥ 1）是一个被切分成许多互不重叠文件的有序 run，其目标大小是上一层的若干倍（扇出 `max_bytes_for_level_multiplier`，默认 10）。当某层超过目标大小时，选出一个文件，与下一层中**与之重叠**的文件合并。

- 读：L0 之外每层最多一个文件，读放大低。
- 空间：约 90% 的数据位于最后一层，稳态下空间放大约为 1.1（配合动态层大小 `level_compaction_dynamic_level_bytes`，自 RocksDB 8.4 起为默认开启）。
- 写：把一个文件下推一层，每移动 1 字节大约要重写下一层的 `扇出` 字节，因此最坏情况下写放大大致与扇出 × 层数成正比。实践中，RocksDB 文档和线上报告里分层合并的写放大常见在 10–30 之间。

### 分级合并（Size-tiered / Universal）

Cassandra 的 STCS 和 RocksDB 的 universal compaction 采用这种方式。每一级（tier）包含若干相互重叠的有序 run；当积累了足够多大小相近的 run 时，把它们合并成下一级中一个更大的 run。

- 写：每个字节大约每级只重写一次，写放大低得多。
- 读：每级都有多个重叠的 run 需要检查，读放大更高（布隆过滤器能缓解点查，但缓解不了扫描）。
- 空间：合并最大的几个 run 时需要同时容纳输入和输出，重复数据也会滞留，最坏情况下空间放大可接近 2 倍。

### 混合方案与变体

- **Lazy leveling**（Dostoevsky，SIGMOD 2018）：上层用分级合并，只在最后一层用分层合并——获得大部分写入节省，同时空间和点查开销接近分层合并。
- **Cassandra 的 Unified Compaction Strategy**（Cassandra 5.0）按层参数化，在分级与分层之间连续可调。
- **FIFO compaction** 直接删除最旧的文件：非常适合有 TTL 上限的时序数据或缓存。
- **Monkey**（SIGMOD 2017）证明，在相同内存下，给较小的层分配更多布隆位、给最大的层分配更少，能使总查找成本最小。

### 粗略对比

| | 分层（Leveled） | 分级（Tiered） |
|---|---|---|
| 写放大 | 高（每层约为扇出） | 低（每级约 1） |
| 点查成本 | 每层约 1 个文件 | 每级多个 run |
| 范围扫描成本 | 低 | 较高 |
| 空间放大 | 约 1.1 | 最高约 2 |
| 典型场景 | 读多、对空间敏感的 OLTP | 写多的数据摄入、时序数据 |

## 用数字看布隆过滤器

一个有 `m` 位、`n` 个键、`k` 个哈希函数的布隆过滤器，误判率近似为

$$
p \approx \left(1 - e^{-kn/m}\right)^k, \qquad k_{\text{opt}} = \frac{m}{n}\ln 2
$$

每个键 10 位时 p ≈ 0.8%，也就是说对不存在键的查找，不到百分之一会在某个文件上白白读一个块。RocksDB 的 `bloom_bits_per_key = 10` 是经典配置。RocksDB 还提供 **Ribbon 过滤器**（Dillinger & Walzer，2021），其文档称在相同误判率下大约节省 30% 的过滤器内存，代价是构建时消耗更多 CPU。

两个实际影响：

- 过滤器只对完整键的**点查**有效。对于前缀扫描（比如所有 `user:42:*` 键），需要配置 **prefix extractor**，让过滤器基于前缀构建。
- 大型数据库的过滤器和索引可能有数十 GB。它们是常驻内存，还是与数据块在 block cache 中竞争（`cache_index_and_filter_blocks`、分区索引/过滤器），往往是影响读延迟最大的单个旋钮。

## 删除、墓碑与范围删除

既然删除也是写入，删除密集型负载（比如队列）有一个著名的故障模式：消费者不断删除队头，墓碑堆积在键范围的前端，每次"找第一个存活键"的扫描都要跨过成千上万个墓碑，直到 compaction 把它们推到最底层。缓解手段：

- `DeleteRange` 只写一个**范围墓碑**，而不是每个键一个。
- 对只写入一次的键使用 `SingleDelete`，墓碑与值在 compaction 中一相遇就能互相抵消。
- 基于删除密度触发 compaction（RocksDB 的 `CompactOnDeletionCollector`），以及周期性或 TTL compaction，避免旧墓碑长期滞留。
- 在 Cassandra 中，`gc_grace_seconds` 让墓碑保留足够久，以便 repair 把删除传播到所有副本；过早丢弃会让错过删除的副本上的数据复活。

## 写停顿与背压

如果写入速度超过 flush 和 compaction 的消化能力，L0 会增长、读变慢、待合并的"债务"不断累积。RocksDB 通过**限流写入**保护自己：

- 等待 flush 的不可变 memtable 过多（`max_write_buffer_number`）时停止写入。
- L0 文件数超过 `level0_slowdown_writes_trigger`（默认 20）时减速写入；超过 `level0_stop_writes_trigger`（默认 36）时停止写入。
- 估算的待合并字节数超过软/硬阈值时减速或停止写入。

线上表现为写延迟周期性尖刺。解决办法是：扩容（更多后台任务、更快的磁盘）、降低写放大（更大的 memtable，对写入密集的列族使用分级/universal compaction），或在上游对写入限流。批量导入可以完全绕过 memtable：离线构建 SSTable 再导入（`IngestExternalFile`）。

## 键值分离

值很大时，分层合并会反复重写同样的大块数据。**WiscKey**（FAST 2016）在 LSM 中只存键和指针，把值放进只追加的 value log，在 SSD 上大幅降低写放大。代价是：范围扫描变成对 value log 的随机读，而且 value log 需要自己的垃圾回收。RocksDB 集成的 **BlobDB**（`enable_blob_files`、`min_blob_size`）和 TiKV 的 **Titan** 实现了这一思路；当值较大（KB 级以上）且以点查为主时收益明显。

## 调优起点

```cpp
rocksdb::Options opt;
opt.write_buffer_size = 128 << 20;            // larger memtables: fewer, bigger flushes
opt.max_write_buffer_number = 4;
opt.max_background_jobs = 8;                  // flush + compaction threads
opt.level_compaction_dynamic_level_bytes = true;
opt.compression_per_level = {rocksdb::kNoCompression, rocksdb::kNoCompression,
                             rocksdb::kLZ4Compression, rocksdb::kLZ4Compression,
                             rocksdb::kLZ4Compression, rocksdb::kZSTD, rocksdb::kZSTD};

rocksdb::BlockBasedTableOptions t;
t.filter_policy.reset(rocksdb::NewBloomFilterPolicy(10));
t.block_cache = rocksdb::NewLRUCache(8ULL << 30);
t.cache_index_and_filter_blocks = true;
t.pin_l0_filter_and_index_blocks_in_cache = true;
opt.table_factory.reset(rocksdb::NewBlockBasedTableFactory(t));
```

上层热数据不压缩或轻压缩、承载大部分数据的冷数据最底层用强压缩（Zstd），这种模式很常见：最底层主导空间占用，而上层主导 compaction 的 CPU 消耗。之后要靠测量：RocksDB 的 statistics 和 `LOG` 文件会报告每层写放大、停顿时间和缓存命中率；依据这些数据调优，而不是在不同负载之间照搬默认值。

## 真实系统中的 LSM 与 B+ 树

- **选 LSM**：写多或数据摄入密集的负载；在意存储成本（压缩更好、无页碎片）；在意写入寿命的闪存；以及以追加为主的数据，比如事件、指标、消息和日志。Facebook 的 MyRocks 论文（VLDB 2020）介绍了其主力 MySQL 用户数据库从 InnoDB 迁移到 RocksDB，主要动机是空间效率和更低的写放大。
- **选 B+ 树**：读多且有大量范围扫描、要求严格可预测延迟的 OLTP，不希望有 compaction 的后台 I/O 和偶发停顿；以及工作集本来就能装进 buffer pool 的负载。
- **无论哪种**，引擎都不是全部：分布式数据库（TiKV、CockroachDB、Cassandra）会在同样的 LSM 原语之上叠加复制、Raft 或 gossip，以及以键版本形式实现的 MVCC。

## 总结

LSM 引擎是一条为写入优化的流水线：WAL 负责持久化，memtable 吸收写入，磁盘上是不可变的有序文件，布隆过滤器和缓存让读保持廉价，compaction 负责恢复秩序。几乎所有运维问题——写为什么停顿、磁盘占用为什么是数据量的两倍、扫描"已删除"的行为什么很慢、SSD 为什么磨损快——最终都归结到 compaction 以及写、读、空间放大的三角关系。根据负载选择 compaction 策略，有意识地规划过滤器和缓存的大小，并把墓碑当作真实的数据来对待。

## 参考资料

- P. O'Neil, E. Cheng, D. Gawlick, E. O'Neil. *The Log-Structured Merge-Tree (LSM-Tree)*. Acta Informatica, 1996.
- F. Chang et al. *Bigtable: A Distributed Storage System for Structured Data*. OSDI 2006.
- RocksDB Wiki: *Leveled Compaction*, *Universal Compaction*, *Write Stalls*, *RocksDB Bloom Filter*, *BlobDB*, *DeleteRange*.
- M. Athanassoulis et al. *Designing Access Methods: The RUM Conjecture*. EDBT 2016.
- N. Dayan, M. Athanassoulis, S. Idreos. *Monkey: Optimal Navigable Key-Value Store*. SIGMOD 2017.
- N. Dayan, S. Idreos. *Dostoevsky: Better Space-Time Trade-Offs for LSM-Tree Based Key-Value Stores*. SIGMOD 2018.
- L. Lu et al. *WiscKey: Separating Keys from Values in SSD-conscious Storage*. FAST 2016.
- P. C. Dillinger, S. Walzer. *Ribbon filter: practically smarter than Bloom and Xor*. arXiv 2103.02515, 2021.
- Y. Matsunobu, S. Dong, H. Lee. *MyRocks: LSM-Tree Database Storage Engine Serving Facebook's Social Graph*. VLDB 2020.
- Apache Cassandra documentation: *Compaction* (STCS, LCS, TWCS, UCS) and *Tombstones*.
