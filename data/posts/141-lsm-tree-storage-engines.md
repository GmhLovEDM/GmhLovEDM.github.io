---
title: "LSM-Tree Storage Engines in Depth: Memtables, SSTables, Compaction and Bloom Filters"
tag: architecture
description: How log-structured merge trees power RocksDB, LevelDB, Cassandra, ScyllaDB, TiKV and CockroachDB's Pebble — the write path through WAL and memtable, SSTable layout, the read path with bloom filters and block cache, leveled vs tiered compaction and the write/read/space amplification triangle, tombstones and range deletes, write stalls, key-value separation (WiscKey, BlobDB), and when an LSM beats a B+tree in practice
date: "2026-10-27T14:25:00.000Z"
---

## Goal

A large share of modern storage engines are built on one idea: **never update data in place on disk; append it, then merge it in the background.** That idea is the Log-Structured Merge tree (LSM tree), introduced by O'Neil et al. in 1996 and popularized by Google's Bigtable and LevelDB. Today it sits under RocksDB (and therefore MyRocks, TiKV, Kafka Streams state stores and many others), Apache Cassandra, ScyllaDB, HBase, and CockroachDB's Pebble.

This article walks through how an LSM engine works end to end, with a small runnable model of the core ideas, then digs into the part that dominates real-world behavior: compaction, and the trade-off between write, read and space amplification. Option names and defaults are RocksDB's unless noted; defaults change between releases, so check the version you run.

## Why Not Just Use a B+Tree?

A B+tree (InnoDB, PostgreSQL indexes, most classic databases) keeps keys sorted in fixed-size pages and updates pages **in place**. That gives excellent point and range reads — usually a few page reads, most of them cached — but writes have costs:

- Each small update dirties a whole page (often 4–16 KB) that must eventually be written back, plus write-ahead log records. Writing a 100-byte row can mean writing kilobytes.
- Random inserts cause random I/O and page splits, and pages end up partially full (fragmentation).
- Compression works per page, so compressed pages must still align to block boundaries, wasting space.

An LSM tree converts random writes into **sequential** writes of large, immutable, densely packed, compressible files. The price is paid on reads (data for one key may live in several places) and in background work (merging those files). Whether that trade is good depends on the workload — which is the real subject of this post.

## The Write Path

A write (`Put(key, value)` or `Delete(key)`) in RocksDB/LevelDB does three things:

1. **Append to the write-ahead log (WAL).** This is the durability point. Depending on settings the log is fsync'd per write, per group commit, or left to the OS.
2. **Insert into the memtable**, an in-memory sorted structure — a concurrent skiplist by default in RocksDB.
3. Return. No disk page is read or modified.

When the memtable reaches `write_buffer_size` (64 MB by default in RocksDB), it becomes **immutable**, a fresh memtable takes new writes, and a background thread **flushes** the immutable one to disk as a sorted file: an SSTable (Sorted String Table). Once flushed, the corresponding WAL segment can be discarded.

Deletes are writes too: a `Delete` inserts a **tombstone**, a marker that says "this key is gone as of sequence number S". Every entry carries a monotonically increasing sequence number, which is also how snapshots and MVCC reads work: a snapshot at sequence S simply ignores entries newer than S.

## SSTable Layout

An SSTable is immutable once written. RocksDB's default block-based table format contains:

- **Data blocks** (default ~4 KB uncompressed) of sorted key/value entries, with prefix compression of keys between restart points, and per-block compression (LZ4, Zstd, etc.).
- An **index block** mapping the last key of each data block to its offset, so a lookup does a binary search over the index and reads one data block.
- A **filter block** — a Bloom (or Ribbon) filter over the file's keys — so most lookups for absent keys skip the file without touching a data block.
- Metadata and a footer locating everything else.

Because files are sorted and immutable, they compress well, can be cached by block, can be shared by snapshots and checkpoints with hard links, and never need locking for reads.

## The Read Path

A point lookup `Get(key)` must find the **newest** version of the key, so it searches from newest to oldest and stops at the first hit:

1. The active memtable, then immutable memtables.
2. Level 0 files, newest first. L0 files are direct memtable flushes, so their key ranges **overlap**; each one may need checking.
3. Levels L1…Ln. Within each of these levels files have **non-overlapping** key ranges, so at most one file per level can contain the key (found by binary search over file boundaries).

For each candidate file the engine consults the Bloom filter first; only on "maybe present" does it read the index and one data block, usually through the **block cache**. If it hits a tombstone, the key does not exist.

Range scans are harder: they must merge iterators from every memtable and every level (a k-way merge), skipping shadowed versions and tombstones. That is why many tombstones in a key range can make scans slow even though the data is "deleted".

## A Minimal LSM Model

The following Python sketch captures the essentials: a memtable, flushes to sorted runs with a Bloom filter, newest-first reads, and a merge compaction that drops shadowed versions and (at the bottom) tombstones.

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

Note the rule in `compact`: a tombstone may only be dropped when the compaction includes the **bottommost** data for that key range. Drop it earlier and an older value in a lower level "resurrects". Real engines also keep versions still visible to live snapshots.

## Compaction: Where the Real Trade-offs Live

Without compaction, every flush adds another file to check on reads, and overwritten or deleted data is never reclaimed. Compaction merges files, discards shadowed versions and eligible tombstones, and maintains the level structure. The cost is measured as three amplifications:

- **Write amplification (WA)**: bytes written to storage ÷ bytes written by the application. It eats disk bandwidth and SSD endurance.
- **Read amplification (RA)**: files or blocks touched per lookup.
- **Space amplification (SA)**: bytes on disk ÷ size of the live data.

The RUM conjecture (Athanassoulis et al., EDBT 2016) formalizes the intuition: an access method can optimize at most two of Read, Update and Memory overheads at the expense of the third. Compaction strategies are points on that triangle.

### Leveled compaction

Used by LevelDB and RocksDB by default. Each level Li (i ≥ 1) is one sorted run split into many non-overlapping files, and its target size is a multiple (fanout, `max_bytes_for_level_multiplier`, default 10) of the previous one. When a level exceeds its target, a file is picked and merged with the **overlapping** files in the next level.

- Reads: at most one file per level beyond L0, so RA is low.
- Space: since about 90% of data sits in the last level, SA is roughly 1.1 in steady state (with dynamic level sizing, `level_compaction_dynamic_level_bytes`, the default since RocksDB 8.4).
- Writes: pushing a file down one level rewrites about `fanout` bytes of the next level per byte moved, so WA is roughly proportional to fanout × number of levels in the worst case. In practice RocksDB's documentation and production reports commonly show WA in the 10–30 range for leveled compaction.

### Tiered (size-tiered / universal) compaction

Used by Cassandra's STCS and RocksDB's universal compaction. Each level (tier) holds several overlapping sorted runs; when enough runs of similar size accumulate, they are merged together into one larger run in the next tier.

- Writes: each byte is rewritten about once per tier, so WA is much lower.
- Reads: several overlapping runs per tier must be checked, so RA is higher (Bloom filters mitigate point lookups, not scans).
- Space: a merge of the largest runs temporarily needs space for both inputs and output, and duplicates linger, so SA can approach 2× in the worst case.

### Hybrids and variants

- **Lazy leveling** (Dostoevsky, SIGMOD 2018): tiering on upper levels, leveling only at the last level — most of the write savings with close-to-leveled space and point-read cost.
- **Cassandra's Unified Compaction Strategy** (Cassandra 5.0) parameterizes a continuum between tiered and leveled behavior per level.
- **FIFO compaction** simply deletes the oldest files: ideal for TTL-bounded time-series or caches.
- **Monkey** (SIGMOD 2017) showed that allocating more Bloom bits to smaller levels and fewer to the largest level minimizes total lookup cost for the same memory.

### A back-of-envelope comparison

| | Leveled | Tiered | 
|---|---|---|
| Write amplification | high (≈ fanout per level) | low (≈ 1 per tier) |
| Point-read cost | ~1 file per level | several runs per tier |
| Range-scan cost | low | higher |
| Space amplification | ~1.1 | up to ~2 |
| Typical fit | read-heavy, space-sensitive OLTP | write-heavy ingest, time-series |

## Bloom Filters, by the Numbers

A Bloom filter with `m` bits, `n` keys and `k` hash functions has false-positive rate approximately

$$
p \approx \left(1 - e^{-kn/m}\right)^k, \qquad k_{\text{opt}} = \frac{m}{n}\ln 2
$$

At 10 bits per key that gives p ≈ 0.8%, i.e. fewer than one in a hundred lookups for an absent key wastes a block read on a file. RocksDB's `bloom_bits_per_key = 10` is the classic setting. RocksDB also offers the **Ribbon filter** (Dillinger & Walzer, 2021), which its documentation describes as saving roughly 30% of filter memory at the same false-positive rate in exchange for more CPU at construction time.

Two practical consequences:

- Filters only help **point lookups** of whole keys. For scans over a prefix (say all keys `user:42:*`), configure a **prefix extractor** so filters are built on prefixes.
- Filters and indexes for a large database can be many gigabytes. Whether they are pinned in memory or compete with data blocks in the block cache (`cache_index_and_filter_blocks`, partitioned index/filters) is often the single biggest read-latency knob.

## Deletes, Tombstones and Range Deletes

Because a delete is a write, deletion-heavy workloads such as queues have a famous failure mode: a consumer deletes the head of a queue, tombstones pile up at the front of the key range, and every "find the first live key" scan must step over thousands of tombstones until compaction pushes them to the bottom. Mitigations:

- `DeleteRange` writes a single **range tombstone** instead of one per key.
- `SingleDelete` for keys written exactly once allows the tombstone and the value to cancel as soon as they meet in a compaction.
- Compaction triggers based on deletion density (RocksDB's `CompactOnDeletionCollector`), and periodic or TTL compaction so old tombstones do not linger.
- In Cassandra, `gc_grace_seconds` keeps tombstones long enough for repair to propagate deletes across replicas; dropping them too early resurrects data on a replica that missed the delete.

## Write Stalls and Backpressure

If writes arrive faster than flush and compaction can absorb them, L0 grows, reads slow down, and pending compaction debt rises. RocksDB protects itself by **throttling writes**:

- Too many immutable memtables waiting to flush (`max_write_buffer_number`) stops writes.
- L0 file count above `level0_slowdown_writes_trigger` (default 20) slows writes; above `level0_stop_writes_trigger` (default 36) stops them.
- Estimated pending compaction bytes above soft/hard limits slow or stop writes.

In production this shows up as periodic latency spikes on writes. The fixes are capacity (more background jobs, faster disks), less write amplification (bigger memtables, tiered/universal compaction for ingest-heavy column families), or rate limiting ingest upstream. Bulk loads can bypass the memtable entirely by building SSTables offline and ingesting them (`IngestExternalFile`).

## Key-Value Separation

With large values, leveled compaction keeps rewriting the same big payloads. **WiscKey** (FAST 2016) stores only keys and pointers in the LSM and puts values in an append-only value log, cutting write amplification dramatically on SSDs. The cost: range scans become random reads into the value log, and the log needs its own garbage collection. RocksDB's integrated **BlobDB** (`enable_blob_files`, `min_blob_size`) and TiKV's **Titan** implement this idea; it pays off when values are large (kilobytes and up) and point reads dominate.

## Tuning Starting Points

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

The pattern — cheap or no compression on hot upper levels, strong compression (Zstd) on the cold bottom level that holds most of the data — is common because the bottom level dominates space while upper levels dominate CPU spent on compaction. Then measure: RocksDB's statistics and `LOG` file report per-level write amplification, stall time and cache hit rates; tune from those, not from defaults copied between workloads.

## LSM vs B+Tree in Real Systems

- **Pick an LSM** for write-heavy or ingest-heavy workloads, when storage cost matters (better compression, no page fragmentation), on flash where write endurance matters, and for append-mostly data such as events, metrics, messages and logs. Facebook's MyRocks paper (VLDB 2020) reported migrating its main MySQL user database from InnoDB to RocksDB largely for space efficiency and lower write amplification.
- **Pick a B+tree** for read-heavy OLTP with many range scans and strict, predictable latency, where compaction's background I/O and occasional stalls are unwelcome, and for workloads whose working set fits in the buffer pool anyway.
- **Either way**, the engine is not the whole story: distributed databases (TiKV, CockroachDB, Cassandra) add replication, Raft or gossip, and MVCC layered as key versions on top of the same LSM primitives.

## Summary

An LSM engine is a write-optimized pipeline: WAL for durability, memtable for absorbing writes, immutable sorted files on disk, Bloom filters and caches to keep reads cheap, and compaction to restore order. Almost every operational question — why writes stall, why disk usage is double the data size, why a scan over "deleted" rows is slow, why SSDs wear out — comes back to compaction and the triangle of write, read and space amplification. Choose the compaction strategy for the workload, size filters and caches deliberately, and treat tombstones as data.

## References

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
