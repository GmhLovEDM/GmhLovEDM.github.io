---
title: "Consistent Hashing and Data Partitioning: Rings, Rendezvous, Jump Hash, Maglev and Bounded Loads"
tag: architecture
description: How distributed systems decide which node owns which key — why hash-mod-N breaks on resize, the consistent hashing ring and virtual nodes, rendezvous (HRW) hashing, Google's jump consistent hash, Maglev lookup tables, consistent hashing with bounded loads, and how Dynamo, Cassandra, Redis Cluster, Kafka, CockroachDB and Envoy actually partition data and traffic
date: "2026-10-30T10:30:00.000Z"
---

## Goal

Every system that spreads data or requests across more than one machine has to answer one question over and over: **given a key, which node owns it?** Caches, sharded databases, message brokers, load balancers and object stores all need a function `owner(key) -> node` that is fast, balanced, and — most importantly — behaves well when the set of nodes changes.

This article covers:

1. Why `hash(key) % N` is a trap.
2. The consistent hashing ring and virtual nodes.
3. Rendezvous (highest random weight) hashing.
4. Jump consistent hash.
5. Maglev hashing for load balancers.
6. Consistent hashing with bounded loads.
7. Hash vs range partitioning, and how real systems choose.
8. Engineering pitfalls: hot keys, rebalancing, replication and membership.

## 1. The problem with `hash % N`

The obvious approach is:

```go
func owner(key string, nodes []string) string {
    return nodes[hash(key)%uint64(len(nodes))]
}
```

It is perfectly balanced (for a good hash) and O(1). The problem shows up the moment `N` changes. Going from `N` to `N+1` nodes, a key keeps its owner only if `h % N == h % (N+1)`, which holds for roughly `1/(N+1)` of keys. Adding a tenth server to a nine-node cache cluster remaps about **90%** of keys. For a cache that means a near-total miss storm hitting the database; for a database it means moving almost all data.

The property we want is **minimal disruption**: when a node is added, only about `K/N` keys (its fair share) should move, and they should all move *to* the new node. When a node is removed, only its keys should move. Every algorithm below achieves that, with different trade-offs in memory, lookup cost, balance and flexibility.

## 2. The consistent hashing ring

Karger et al. introduced consistent hashing in 1997 to build distributed web caches. The idea:

1. Hash both nodes and keys onto the same circular space, e.g. `[0, 2^64)`.
2. A key belongs to the first node found walking clockwise from the key's position.

Adding a node `X` only steals keys from the arc between `X` and its predecessor; nothing else moves. Removing a node hands its arc to its successor.

### Virtual nodes

With one point per node, arcs have wildly different lengths. With `n` nodes placed randomly, the largest arc is on the order of `(log n)/n` of the ring, i.e. some node can own several times its fair share. The standard fix is **virtual nodes**: each physical node is placed at many points (`node#0`, `node#1`, ...). With enough points per node, the load per physical node concentrates around `1/n`.

Virtual nodes also give two practical benefits:

- **Heterogeneous capacity**: a machine with twice the RAM gets twice the virtual nodes.
- **Spread-out recovery**: when a node dies, its many small arcs are inherited by many different successors, rather than one neighbor absorbing everything.

The cost is memory and lookup time: a sorted array of `n × v` points and a binary search per lookup.

```go
package ring

import (
    "hash/fnv"
    "sort"
    "strconv"
)

type Ring struct {
    points []uint64          // sorted
    owner  map[uint64]string // point -> physical node
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
        i = 0 // wrap around
    }
    return r.owner[r.points[i]]
}
```

In production you would use a stronger, faster hash (xxHash, Murmur3) and handle point collisions, but the structure is the same. Libraries such as libketama (memcached clients) popularized exactly this design.

### Replication on the ring

Amazon's Dynamo (DeCandia et al., SOSP 2007) extended the ring for replication: a key is stored on the first `N` *distinct physical* nodes clockwise — the **preference list**. Skipping virtual nodes that map to an already-chosen physical node matters; otherwise two replicas could land on the same machine. Cassandra and Riak inherited this model, and Cassandra additionally skips nodes in the same rack/availability zone when using `NetworkTopologyStrategy`.

## 3. Rendezvous (HRW) hashing

Thaler and Ravishankar's **highest random weight** hashing is older than many people think (mid-1990s) and simpler than the ring:

> For a key, compute `score = hash(key, node)` for every node; pick the node with the highest score.

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

Properties:

- **Minimal disruption** for free: removing a node only affects keys for which it was the winner; those fall to their second-best node.
- **No extra state**: no ring, no virtual nodes, perfect balance in expectation.
- **Replication is natural**: the top-`k` scores give `k` distinct replicas, already ordered.
- **Weights** are supported with the logarithmic method: `score = -w / ln(u)` where `u` is the hash mapped to `(0,1)`, which keeps the minimal-disruption property for weighted nodes.

The cost is **O(n)** per lookup. For tens or a few hundred nodes this is negligible and often faster in practice than a cache-unfriendly binary search over thousands of virtual points. For very large clusters, a "skeleton" (hierarchical) variant groups nodes into a tree to get O(log n).

## 4. Jump consistent hash

Lamping and Veach (Google, 2014) published a remarkable five-line algorithm that maps a 64-bit key to one of `num_buckets` buckets with no memory at all:

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

The intuition: as the bucket count grows from 1 to `n`, a key should jump to the newly added bucket `j` with probability `1/j`. Instead of checking every step, the loop uses a pseudo-random generator seeded by the key to compute directly *where the next jump happens*, so the expected number of iterations is O(log n).

Strengths: zero memory, near-perfect balance, very fast. The big limitation: buckets are **numbered 0..n-1 and can only be added or removed at the end**. You cannot remove bucket 3 out of 10. That makes jump hash ideal for mapping keys to **shards** (logical, stable, numbered) rather than to **servers** (which fail arbitrarily). A common pattern is two levels: `key -> shard` via jump hash, `shard -> replica set` via a separately managed placement table.

## 5. Maglev hashing

Google's Maglev (Eisenbud et al., NSDI 2016) is a software network load balancer. It needs to map packets (5-tuples) to backends such that:

- every packet of a connection reaches the same backend, even across different Maglev machines without shared state;
- load is spread very evenly;
- backend changes disrupt as few connections as possible;
- lookup is a single memory access.

Maglev builds a lookup table of prime size `M` (65537 in the paper's examples). For each backend `i`, it derives a permutation of `[0, M)`:

```
offset = h1(name_i) mod M
skip   = h2(name_i) mod (M - 1) + 1
permutation_i[j] = (offset + j * skip) mod M
```

Because `M` is prime and `skip` is non-zero, each permutation visits every slot. Backends then take turns claiming their next preferred unclaimed slot until the table is full. Lookup is `table[hash(5-tuple) % M]`.

The result is almost perfectly even — each backend owns `M/n` slots give or take one — at the cost of slightly worse disruption than a ring: a backend change can move a small number of slots between *surviving* backends too. Maglev compensates with connection tracking: existing flows stay on their backend via a local connection table, and the consistent table only matters for new flows or when a packet lands on a different Maglev machine.

Envoy implements both `RING_HASH` and `MAGLEV` load-balancing policies; its Maglev table defaults to 65537 entries. Maglev is usually the better default for L4/L7 balancing because of its O(1) lookup and evenness; ring hash remains useful when you need finer control over disruption.

## 6. Consistent hashing with bounded loads

All of the above balance *keys*, not *load*. If one key is hot, or the key distribution is skewed, one node can still be overwhelmed. Mirrokni, Thorup and Zadimoghaddam (2016, published at SODA 2018) proposed a simple fix:

- Choose a balance factor `c > 1` (e.g. 1.25).
- Each node has capacity `ceil(c × average_load)`.
- Walk the ring clockwise as usual, but **skip nodes that are at capacity**.

This guarantees no node exceeds `c` times the average, while keeping most of the stickiness of consistent hashing. Vimeo engineers contributed this to HAProxy, where it is enabled with `hash-balance-factor` (e.g. `hash-balance-factor 125`) on backends using `balance` with consistent hashing.

The trade-off is reduced locality: under load, some requests spill to non-preferred nodes, lowering cache hit rates there. For caches in front of expensive backends this is usually the right call — a slightly lower hit rate is far better than a melted node.

## 7. Hash partitioning vs range partitioning

Everything so far is **hash partitioning**: keys are scattered uniformly. It is excellent for point lookups and spreading writes, but it destroys ordering — a range scan `user_id BETWEEN 1000 AND 2000` must hit every partition.

**Range partitioning** keeps keys sorted and splits the key space into contiguous ranges. Bigtable's tablets, HBase regions, CockroachDB ranges and TiKV regions all work this way: a range splits when it grows past a size threshold (or becomes hot) and ranges are moved between nodes by a placement service. It supports efficient scans and natural locality, but monotonically increasing keys (timestamps, auto-increment IDs) concentrate all writes on the last range — the classic **hotspot**. Common mitigations are hashing or salting a key prefix, or using UUIDv4-like keys where ordering is not needed.

How real systems choose:

| System | Scheme | Notes |
|---|---|---|
| Dynamo / Riak | Ring with virtual nodes | Preference list of N distinct physical nodes |
| Cassandra | Token ring (Murmur3 partitioner) | `num_tokens` vnodes per node; default lowered from 256 to 16 in 4.0 together with a token allocation algorithm |
| Redis Cluster | 16384 fixed hash slots | `CRC16(key) mod 16384`; `{tag}` forces related keys into one slot |
| Kafka | `murmur2(key) % partitions` | Increasing partition count remaps keys — ordering per key breaks across the change |
| CockroachDB / TiKV / Spanner | Range partitioning | Split and merge by size and load; placement driver moves ranges |
| Envoy / Maglev | Lookup table | O(1) per request; used for L4/L7 session affinity |

Redis Cluster is worth highlighting: instead of hashing directly to nodes, it hashes to a **fixed number of slots** and assigns slots to nodes. This "indirection table" pattern (also used by Couchbase vBuckets and Elasticsearch shards) gives you consistent-hash-like behavior with explicit, operator-controlled rebalancing. Moving a slot is a well-defined unit of work that can be throttled, observed and resumed.

Note the trap with Kafka-style `% partitions`: it is exactly the naive scheme from section 1. That is why the usual advice is to over-provision partitions up front, since adding partitions later changes which partition each key lands on.

## 8. Engineering pitfalls

**Hot keys.** No partitioning function fixes a single key receiving 30% of traffic. Options: replicate the hot key's value to several nodes and read from any (with key suffixes like `hot:1..8`), add a local in-process cache with short TTL, or use bounded-load hashing to spill excess requests.

**Rebalancing is the real cost.** Algorithms tell you *which* keys should move; the system still has to *move* them. Copy data in the background, dual-read or forward during migration, throttle bandwidth, and only flip ownership once the new node is caught up. Fixed slots/shards make this tractable because the unit of movement is explicit.

**Membership must agree.** Consistent hashing only gives consistent answers if every client sees the same node list. Dynamo and Cassandra use gossip for this, Redis Cluster clients follow `MOVED`/`ASK` redirects, and range-based systems keep a metadata service (often itself Raft-replicated). During membership changes, clients with stale views will route to the wrong node, so the server side must detect and redirect.

**Choose the hash carefully.** You need uniformity and speed, not cryptographic strength; but the hash must be **stable across languages and versions**, because clients written in Go, Java and Python must agree. Never use a language's built-in randomized hash (Go maps, Python's `hash()` for strings) for placement.

**Failures vs planned changes.** A node that flaps should not cause data movement each time. Distinguish temporary unavailability (hinted handoff, retry the next replica) from permanent removal (rebalance).

### Quick selection guide

- Small to medium server list, need replicas and weights, minimal code: **rendezvous hashing**.
- Mapping to numbered shards that only grow: **jump consistent hash**.
- Load balancer with per-request lookups and even spread: **Maglev**.
- Cache tier with skewed traffic: **ring + bounded loads**.
- Data store needing controlled migrations: **fixed slots/shards + placement table**.
- Range scans and ordered access: **range partitioning** with automatic split and hot-range detection.

## Summary

`hash % N` is balanced but catastrophic on resize. Consistent hashing — whether as a ring with virtual nodes, rendezvous scoring, jump hash, or a Maglev table — limits movement to roughly the fair share of keys when membership changes, each trading memory, lookup cost, evenness and flexibility differently. Bounded-load variants protect against skew, and production systems usually add a layer of indirection (slots, shards, ranges) so that rebalancing is an explicit, observable process rather than a side effect of a hash function.

## References

- Karger et al., "Consistent Hashing and Random Trees: Distributed Caching Protocols for Relieving Hot Spots on the World Wide Web" (STOC 1997)
- Thaler and Ravishankar, "Using Name-Based Mappings to Increase Hit Rates" (IEEE/ACM Transactions on Networking, 1998)
- Lamping and Veach, "A Fast, Minimal Memory, Consistent Hash Algorithm" (2014): https://arxiv.org/abs/1406.2294
- Eisenbud et al., "Maglev: A Fast and Reliable Software Network Load Balancer" (NSDI 2016): https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/
- Mirrokni, Thorup and Zadimoghaddam, "Consistent Hashing with Bounded Loads" (SODA 2018): https://arxiv.org/abs/1608.01350
- DeCandia et al., "Dynamo: Amazon's Highly Available Key-value Store" (SOSP 2007)
- Redis Cluster specification: https://redis.io/docs/ (Cluster specification)
- Envoy load balancers documentation: https://www.envoyproxy.io/docs (Upstream load balancing)
- HAProxy configuration manual, `hash-balance-factor`: https://docs.haproxy.org/
- Apache Cassandra documentation, "Dynamo" architecture: https://cassandra.apache.org/doc/ (Architecture: Dynamo)
