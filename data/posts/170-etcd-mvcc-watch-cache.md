---
title: "Inside etcd and kube-apiserver: MVCC Revisions, Watches, Compaction and the Watch Cache"
tag: devops
description: How Kubernetes actually stores cluster state — etcd's MVCC revisions and key generations, the watch guarantees and what happens after compaction, the 1.5 MiB request and 2 GiB / 8 GiB quota limits, how kube-apiserver maps objects under /registry and keeps about five minutes of history, how the watch cache serves reads after a progress check, and a runnable model of compact, stale watches and a cache that only serves a consistent list once it has caught up
date: "2026-11-25T12:40:00.000Z"
---

## Goal

Kubernetes looks like a collection of objects: Pods, Nodes, Leases, Custom Resources. Underneath, almost every change is a write to etcd, a small, strongly consistent key-value store. etcd is not a general-purpose database. It is built to hold cluster metadata that is written infrequently, read often, and watched continuously, and to keep a short window of history so a client that disconnected can catch up.

This article starts after Raft has committed an entry — elections, log replication, and the commit rule are a separate problem — and follows the write into the MVCC store, out through the watch API, into kube-apiserver's watch cache, and back to a client that has to deal with compaction. It covers:

1. Why the control plane uses a small versioned store.
2. The data model: a flat key space, a cluster-wide revision, per-key versions and generations.
3. Range, Put, Txn, Watch, and Lease, and the guarantees etcd actually makes.
4. Compaction, defragmentation, and the storage quota.
5. Disk and memory, and why a slow fsync becomes a control-plane outage.
6. How kube-apiserver maps objects into etcd and compacts history.
7. `resourceVersion`, `410 Gone`, and the five-minute window.
8. The watch cache: consistent lists, streaming lists, snapshots, and startup behavior.
9. Trade-offs.
10. A runnable model that measures generations, compare-and-swap, compacted watches, quota recovery, and a cache that refuses a consistent list until it has caught up.

## 1. Why a small, versioned key-value store

etcd's own documentation describes the fit: it is designed to reliably store infrequently updated data and to provide reliable watch queries. Previous versions of a key stay around so that point-in-time reads and watch history ("time travel queries") are cheap, and so a watcher can resume from a revision it already observed.

That is the Kubernetes control-plane workload. A Pod object is typically a few kilobytes. Controllers do not scan a relational table; they list once and then watch. When a watch breaks, they want to resume at a revision, not rebuild the world, unless the history they need has already been compacted away.

The constraints follow from that design. etcd is a metadata store. By default, the maximum size of any request is 1.5 MiB, configurable with `--max-request-bytes`. The default backend quota is 2 GiB, configurable with `--quota-backend-bytes`, and 8 GiB is a suggested maximum for normal environments — etcd warns at startup if the configured quota exceeds that. Those figures are the published system limits, not folklore. A large object or an unbounded history is not merely "slow etcd". It is a store being asked to be something else.

## 2. The data model: revisions, versions, and generations

### A flat key space

The logical view is a flat binary key space with a lexically sorted index, so a range query over `[a, b)` is inexpensive. etcd does not organize keys into directories. A prefix lookup is just a range: everything that starts with `/registry/pods/` is the half-open interval from that prefix to the first key that does not.

### A cluster-wide revision

etcd maintains a 64-bit cluster-wide counter, the store revision, incremented each time the key space is modified. The revision is a global logical clock: it totally orders mutations. A transaction that touches several keys still receives a single revision. The official data-model document says the initial revision is 1, and that revisions increase monotonically over the lifetime of the cluster.

Every response carries a header with `cluster_id`, `member_id`, `revision`, and `raft_term`. The revision in the header is the store revision when the response was generated, which is what a client records in order to watch from "now".

### Per-key metadata

The unit of the key-value API is a `KeyValue`:

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

- `create_revision` is the revision at which the current generation was created.
- `mod_revision` is the revision of the last modification, including a delete.
- `version` counts modifications inside the current generation, starting at 1 on create. A delete resets it to 0.
- `lease` is the attached lease identifier, or 0.

A key's life is a generation, from create to delete. Deleting a key writes a tombstone and ends that generation. Putting the same key again starts a new generation: `version` goes back to 1, and `create_revision` becomes the new revision. Compaction later drops generations that ended before the compact revision, and drops superseded values older than that revision, while keeping the latest live value.

### The physical trees

On disk, etcd stores deltas in a persistent B+tree. The backend key is a tuple `(major, sub, type)`, where `major` is the store revision, `sub` distinguishes keys inside that revision, and `type` can mark a tombstone. A secondary in-memory B-tree indexes user keys and points at the persistent tree, which is what makes a range by key cheap. Compaction deletes outdated backend pairs and dead index pointers. The store is effectively immutable: a mutation produces a new structure rather than editing the old one in place.

## 3. The API, and the guarantees etcd actually makes

### Key-value operations

The KV service provides `Range`, `Put`, `Delete`, and `Txn`. etcd states that completed KV operations are durable — a read never returns data that has not been made durable — and that the KV API is strictly serializable: operations are atomic and occur in a total order consistent with real time, with that order implied by revision.

Linearizability is the default and goes through Raft. Clients that want cheaper reads can request `serializable` consistency, which may be served from a follower and can be stale with respect to quorum.

A transaction is a list of `Compare` predicates plus a success list and a failure list. A compare can target `version`, `create_revision`, `mod_revision`, `value`, or `lease`. This is the primitive behind optimistic concurrency. When kube-apiserver updates an object, it checks that the key's `mod_revision` still matches the `resourceVersion` the client sent; if another writer has already moved it, the compare fails and the client receives a conflict.

### Watch

`Watch` is a bidirectional gRPC stream. A client can multiplex many watches on one stream. `start_revision` is inclusive; if it is omitted, the watch starts after the revision in the creation response. If `start_revision` has already been compacted, the watch is canceled and the response carries `compact_revision`. Clients are expected to resume from a revision they have already seen, as long as it is still inside the history window.

etcd makes these watch guarantees:

- **Ordered.** Events appear in revision order. A watch will not emit an event that precedes one it has already posted.
- **Unique.** An event appears at most once.
- **Reliable.** Inside the available history window, a sequence is not missing a subsequence. If a watch received `a` and `c`, it also received `b`, provided `b` is still in the window.
- **Atomic.** Events for one revision, even across several keys, are not split across watch responses.
- **Resumable.** After a disconnect, a new watch can start after the last revision received, if that revision is still retained.
- **Bookmarkable.** A progress notification is a promise that every event up to that revision has already been delivered.

etcd does **not** make a linearizability guarantee for watch. Clients are expected to look at the revision on the events. On a healthy cluster the documentation says you should expect events within about 10 ms; it also says there is no bound, and an unhealthy cluster may never deliver them.

### Lease

A lease is granted with a TTL, attached to one or more keys, kept alive, or revoked. When the lease expires or is revoked, the attached keys are deleted. This is the primitive etcd offers for distributed coordination. It is not the same thing as the Kubernetes `Lease` API, which is an ordinary object stored under `/registry` like any other.

## 4. Compaction, defragmentation, and the quota

Because every mutation leaves a new revision, the store would grow without bound. Compaction drops history. The official rule is: revisions before the compact revision are removed; any generation that ended before that revision is removed; values set before that revision, except the latest one, are removed. A current live value stays, even if it was written earlier. A time-travel `Range` or a watch that starts before the compact revision fails.

etcd can compact on its own. In periodic mode, `--auto-compaction-retention=10h` waits ten hours for the first compaction and then compacts each hour, always retaining a ten-hour window — that 10 h figure is the documented general-purpose default. In revision mode, etcd checks every five minutes and compacts to `latest revision - N`.

Kubernetes usually does not leave this to etcd's timer alone. kube-apiserver issues compaction itself, which is the next section.

Compaction frees logical slots inside the backend. It does not return those bytes to the filesystem. The backend is left fragmented: space etcd can reuse, but that `du` still counts. Defragmentation rebuilds the member's backend and releases the file space. It is issued per member, is not Raft-replicated, and — this matters in production — blocks that member from reading and writing while it runs. Official guidance is to defrag members one at a time. `etcdctl defrag` talks to a live member; `etcdutl defrag --data-dir ...` operates on a data directory that is not open.

The quota is the backstop. If any member's backend exceeds `--quota-backend-bytes`, etcd raises a cluster-wide `NOSPACE` alarm and the cluster accepts only key reads and deletes. Recovery is: compact the excess history, defrag each member, then `etcdctl alarm disarm`. Until the alarm is cleared and the physical size is back under the quota, puts stay rejected. The two metrics to watch are `etcd_mvcc_db_total_size_in_use_in_bytes` (live data after compaction) and `etcd_mvcc_db_total_size_in_bytes` (file size, including free pages waiting for defrag). When both sit close to the quota, compaction is due; when in-use has dropped but the file has not, defrag is due.

## 5. Disk, memory, and why fsync latency is a cluster outage

A mutation is not finished until a majority of members have written it to the write-ahead log. Incremental snapshots then let etcd truncate that log. If those writes take too long, heartbeats time out, a new election starts, and the cluster is unavailable for writes while it argues about leadership. etcd's hardware documentation is blunt: disk write latency is the critical resource. It asks for about 50 sequential IOPS in a typical deployment, and 500 sequential IOPS for a heavily loaded one, and notes that cloud "concurrent IOPS" numbers can be an order of magnitude higher than sequential IOPS. An SSD is the default recommendation; 8 GB of RAM is typically enough, with 16–64 GB suggested when there are thousands of watchers and millions of keys; two to four cores are typical, eight to sixteen for heavy load.

The same hardware guide gives example sizes. A "small" etcd, aimed at fewer than 100 clients, fewer than 200 requests per second, and no more than 100 MB of data, is illustrated as a 50-node Kubernetes cluster. A "medium" example is a 250-node cluster (up to 500 clients, 1,000 requests per second, 500 MB). A "large" example is a 1,000-node cluster (up to 1,500 clients, 10,000 requests per second, 1 GB). Those are etcd's published starting points, not a guarantee; the page is also explicit that other processes sharing the machine can make a cluster unstable.

Kubernetes documentation adds two operational constraints. Run etcd on dedicated machines or otherwise isolated resources, and, for durability and availability in production, run a multi-member cluster and back it up. The same page recommends a five-member cluster in production. Five members can lose two and still have a majority; the cost is that every write waits for three disk fsyncs instead of two.

`--snapshot-count` (default 100,000 since etcd v3.2) is the number of applied Raft entries a member holds before it snapshots and truncates. Higher values give a slow follower more log to catch up on and consume more memory; lower values make snapshots more frequent.

## 6. How kube-apiserver writes, reads, and compacts

kube-apiserver is etcd's most important client, and it hides the key-value API behind the Kubernetes API.

The default `--etcd-prefix` is `/registry`. A namespaced built-in object is stored under a path such as `/registry/secrets/default/db-credentials`. The default `--storage-media-type` is `application/vnd.kubernetes.protobuf`; JSON and YAML are supported, but some resources or backends ignore the flag. If `--encryption-provider-config` is set, the value stored in etcd is transformed before it is written, which is how encryption at rest is applied to Secrets and other selected resources.

On a default cluster, kube-apiserver also compacts etcd. `--etcd-compaction-interval` defaults to `5m0s`; `0` disables apiserver-initiated compaction. The implementation lives in `k8s.io/apiserver/pkg/storage/etcd3/compact.go`. The file's own comment says the intent: save the most recent five minutes of data and compact versions older than that, which "should be enough for slow watchers and to tolerate burst."

The protocol among API servers is a compare-and-swap on a special key, `compact_rev_key`. The key's version is used as a logical clock ("compact time"); its value holds the revision last compacted. Each interval, an API server tries to CAS that version. On success, it writes the revision it observed last time and then calls etcd `Compact` on that revision — so it compacts to what was "now" one interval ago, not to the current head. The first successful CAS after process start does not compact, because that previous revision is still 0. If the CAS fails, another API server already did the work; this one adopts the remote compact time and tries again next interval. The comments give the failover bound: in normal operation the interval is five minutes; if the leader of compaction crashes, the next interval is greater than five minutes and less than ten. Kubernetes API documentation states the result in one sentence: clusters using etcd 3 preserve changes in the last five minutes by default.

That window is a product choice. It keeps the backend small. It also means a watcher that is disconnected for more than about five minutes cannot resume and must list again.

Two other flags are easy to miss. `--event-ttl` defaults to `1h0m0s`: Events are ordinary objects and occupy quota until they are deleted. `--min-request-timeout` defaults to 1800 seconds; the watch handler picks a randomized timeout above that value so that watches do not all drop at once.

## 7. `resourceVersion` and `410 Gone`

Every Kubernetes object carries `metadata.resourceVersion`, the resource version at which that instance was last modified. A list response carries a collection `metadata.resourceVersion`, the revision at which the collection was assembled. Those strings are opaque to clients — they must be passed back unmodified — and, on kube-apiserver, are orderable as monotonically increasing integers within a resource type.

The list-then-watch contract is:

1. List the collection, record the collection `resourceVersion` (call it `rv`).
2. Watch the same collection with `resourceVersion=rv`. The stream then reports operations that occurred after that revision.
3. If the watch disconnects, start a new watch from the last `resourceVersion` you received.
4. If the server no longer has that history, it responds `410 Gone`. The client must drop its cache, list again, and watch from the new `rv`.

`resourceVersion` and, since 1.19, `resourceVersionMatch` change what "read this list" means. The important cases:

- **Most recent.** A consistent read of the current store. Historically this was a quorum read to etcd. The Kubernetes API documentation now says that, for etcd v3.4.31+ and v3.5.13+, Kubernetes 1.37 serves "most recent" reads from the watch cache, using etcd progress notifications to make sure the cache is at least as new as a linearized read. The same mechanism existed as alpha in 1.28–1.30, became available by default in 1.31, and the `ConsistentListFromCache` feature gate went stable in 1.34.
- **Any**, including `resourceVersion=0` on a get or list. The newest available revision is preferred, but stale data is allowed. This is always served from the watch cache.
- **Not older than.** The collection's `resourceVersion` will not be older than the one you asked for. Also served from the watch cache.
- **Exact.** Serve that revision or respond `410 Gone`. With `ListFromCacheSnapshot` (beta since 1.34, enabled by default), the API server will try a snapshot taken at a revision not newer than the request. It starts with no snapshots, takes one on every watch event, and keeps them until it notices etcd compaction or the cache is full of events older than 75 seconds. If the snapshot cannot serve the request, it falls back to etcd.

A watch with no `resourceVersion` starts at the most recent consistent revision and first emits synthetic `ADDED` events for the current state. A watch with `resourceVersion=0` does the same but may start at a stale revision. A watch with a specific `resourceVersion` starts at that exact revision and does not replay state: the client is assumed to already have it.

Bookmark events (`allowWatchBookmarks=true`) exist specifically because the history window is short. A `BOOKMARK` is a watch event whose object carries only a `resourceVersion`, meaning "you have seen every change up to here." The server is not required to send bookmarks on any particular schedule, or at all.

If you ask for a revision the API server does not yet recognize (a "future" version, often from another API server that is slightly ahead), kube-apiserver may wait, time out with `504 Gateway Timeout`, or return `Retry-After`, and it labels this case `Too large resource version`. That is a different failure from `410 Gone`, which means "this revision is already in the past."

## 8. The watch cache

Serving every list and watch from etcd does not scale to a cluster full of controllers. kube-apiserver therefore keeps, by default (`--watch-cache=true`), an in-memory watch cache per resource. The cache is a mirror of etcd for that type: it is filled by an initial consistent list and then kept current by a watch. `--watch-cache-sizes` still exists, but the documented meaning of a non-zero size is only "do not disable this resource's cache"; capacity is sized automatically. Setting a size of 0 disables the cache for that built-in resource.

A consistent list from the cache is not a stale read with a hopeful name. The KEP for consistent reads from cache, and the implementation that followed, first determine a fresh etcd revision — a quorum read, or a watch progress notification, which is a promise that every event up to that revision has been delivered — and only then serve the list, once the cache has reached that revision. If the cache cannot catch up, the request is not answered from a lagging mirror.

On startup, the API server delays `/readyz` until every registered watch cache has finished that initial synchronization. The point is to stop a load balancer from sending traffic to a process whose caches are still empty, which would turn a boot into a thundering herd of lists against etcd. If a cache is uninitialized later — boot, a resync, a disconnection — `WATCH` requests and unpaginated or filtered `LIST` requests are rejected immediately with `429 Too Many Requests` and a `Retry-After` header. Only `GET` and paginated, unfiltered `LIST` requests (`limit > 0`, no label or field selector) are allowed to fall back to etcd in that window.

Two newer paths try to make the initial list cheaper as well. **Streaming lists** (`WatchList`, beta and enabled by default since 1.34, after a release in 1.33 where the default flipped off) let a client set `sendInitialEvents=true` and `resourceVersionMatch=NotOlderThan` on a watch. The stream begins with synthetic `ADDED` events for every existing object, then a `BOOKMARK` at the synced revision, then ordinary watch events. The client never materializes a giant list response in one shot. `WatchListClient` in client-go has been enabled by default since 1.35. **Streamed etcd range reads** (`EtcdRangeStream`, beta and enabled by default since 1.37, requiring etcd v3.7 or later) change the API server's own read of a large collection from paged `Range` RPCs into a `RangeStream`. If the backend returns gRPC `Unimplemented`, the API server falls back to paged reads. The duration metric for the streaming path uses `operation="listStream"`, not `operation="list"`.

## 9. Trade-offs

- **A five-minute history is a small etcd and a strict client contract.** Controllers that assume they can disconnect for a long time and resume will relist. That is not a rare error; it is the designed recovery path, and it must be handled (`410`, then a fresh list).
- **Compaction and defragmentation are different operations.** Compaction is frequent, cheap enough to run every five minutes, and does not shrink the file. Defrag shrinks the file, blocks that member, and should be infrequent and staggered. Watching only the file size, or only the in-use size, will mislead you.
- **The 8 GiB suggested maximum is a real ceiling for "just raise the quota."** If live objects (not history) are pushing past it, the problem is object count, oversized objects, or Event volume, and a larger quota needs RAM, disk, and a longer recovery path to match.
- **The 1.5 MiB request limit is also a real ceiling.** A CRD instance, a large ConfigMap, or an oversized annotation will fail writes in a way that looks like an API-server bug until you measure the encoded object.
- **The watch cache is a consistency protocol, not just a speedup.** `resourceVersion=0` is allowed to be stale. A default list (most recent) is not, and a lagging cache must refuse it rather than invent a fresh answer. The cost of that honesty is the wait for a progress notification, and `429` when the cache is not ready.
- **Three etcd members versus five.** Kubernetes recommends five in production. Five survive two failures; they also require a majority of three to fsync each write. Dedicated disks matter more as the majority grows.
- **Protobuf in etcd is smaller and faster to encode than JSON, and harder to inspect by hand.** That is the default for a reason; it is also why `etcdctl get /registry/...` often looks opaque unless you decode with Kubernetes tools.

## 10. A runnable model

The program below is a compact MVCC store with `put`, `delete`, `get` at a revision, `txn` compare-and-swap, `watch`, `compact`, `defrag`, and a byte quota, plus a watch cache that will not serve a most-recent list until it has caught up to a quorum revision. It is not etcd, and it does not speak Raft or gRPC. It is faithful enough to the published data model and watch rules to produce concrete numbers for history growth, compacted cursors, quota recovery, and cache freshness.

The store starts at revision 0; the first mutation becomes revision 1, matching etcd's initial revision. A multi-key transaction shares one revision, and a watch of that revision sees both events together. Compaction drops history strictly before the compact revision, so a watch whose cursor is older than that revision is canceled with `compact_revision`, while a watch that starts at the compact revision itself still sees the remaining event. Logical size falls at compact; physical size falls only at defrag. Once the physical size crosses the quota, further puts raise `NoSpaceError` until compact, defrag, and a disarm. The cache answers `429` before it is bootstrapped, will serve an "any" list while it lags (and that list is stale), and refuses a most-recent list until `catch_up` has applied every event through the store's current revision.

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


The run printed the following.

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

What those numbers are saying:

- **Generations.** `pods/default/api` is created at revision 1, updated at 2, deleted at 4 (tombstone, `version=0`), and created again at 5. The second generation has `create_revision=5` and `version=1`. `pods/default/web` is untouched by that delete and still has `create_revision=3`.
- **Compare-and-swap.** The first transaction compares `mod_revision` 3 and writes `term-2` at revision 6. The second transaction uses the stale compare value 3, fails, applies nothing, and — because the failure list is empty — does not consume a new revision. The store stays at 6.
- **Atomic watches.** The next transaction writes two keys at a shared revision 7. A prefix watch starting at 7 returns two events, both with `mod=7`.
- **Time travel and compact.** Before compact, `get(cfg, rev=1)` returns `A`. After `compact(3)`, the same read raises `CompactedError` with `compact_revision=3`. The live value `C` remains. Logical size drops from 108 bytes to 36; physical size stays 108 until a defrag, which this scenario does not run.
- **A compacted watch cursor.** After a list at revision 1, a watch from `list_rev+1` sees puts at 2 and 3. Compacting to 4 then cancels a resume from 3 (`compact_revision=4`). A watch that starts at the compact revision itself still sees `PUT d` at 4.
- **History versus the file.** Eight keys updated 51 times each leave 408 versions and 22,360 bytes. `compact(403)` keeps only the eight live values (440 bytes) but reclaims 0 physical bytes. Defrag then drops the file from 22,360 to 440, reclaiming 21,920 bytes.
- **Quota recovery.** With an 800-byte quota, 15 puts are accepted and the 16th trips the alarm at revision 15, when physical size is 825. A put after the alarm fails; a delete is still accepted and writes a tombstone (revision 16, physical size 873). Compact lowers in-use to 48 but leaves the file at 873 and the alarm set. Defrag plus disarm brings physical size to 48 and allows a new put at revision 17.
- **Cache freshness.** A list before bootstrap is `rejected_uninitialized` with code 429. After bootstrap at revision 5, two further writes move the store to 7. A most-recent list is rejected (`quorum_rev=7`, `cache_rev=5`), while an "any" list is served and is missing `nodes/n5`. After `catch_up`, the most-recent list succeeds at revision 7 with six keys. `NotOlderThan` of a future revision is rejected; `NotOlderThan` of the current cache revision is served.

## Summary

- etcd is a small, strictly serializable MVCC store. A cluster-wide revision totally orders mutations; a key also carries `create_revision`, `mod_revision`, and a per-generation `version`. Deleting ends a generation with a tombstone; putting the key again starts a new one.
- Watches are ordered, unique, reliable, atomic, resumable, and bookmarkable inside the retained history window. They are not linearizable. If `start_revision` has been compacted, the watch is canceled with `compact_revision`.
- The published limits are 1.5 MiB per request, a 2 GiB default quota, and 8 GiB as a suggested maximum. `NOSPACE` turns the cluster read-and-delete only until you compact, defrag, and disarm the alarm. Compaction drops history; defragmentation, which blocks that member, is what returns bytes to the filesystem.
- Disk fsync latency is the availability budget. etcd asks for about 50 sequential IOPS typically and 500 when loaded, and Kubernetes recommends dedicated machines and a five-member production cluster.
- kube-apiserver stores objects under `/registry` as protobuf by default, and compact etcd every five minutes by compare-and-swapping `compact_rev_key` so that about five minutes of history remain. A watcher that lags beyond that window must handle `410 Gone`, list again, and resume.
- The watch cache is the read path. `resourceVersion=0` may be stale; a most-recent list is consistent, and on Kubernetes 1.37 (with etcd v3.4.31+ or v3.5.13+) it is served from the cache after a progress check. `ConsistentListFromCache` has been stable since 1.34. An uninitialized cache holds `/readyz` and answers `429` for watches and unpaginated or filtered lists. Streaming lists (`WatchList`, beta since 1.34) and streamed etcd ranges (`EtcdRangeStream`, beta since 1.37) exist to keep large initial reads off the hot path.
- In the model, 408 versions occupy 22,360 bytes; compact keeps eight live keys (440 bytes) and reclaims no file space until defrag frees 21,920 bytes. An 800-byte quota trips after 15 puts; compact plus defrag plus disarm is what makes the next put succeed. A cache at revision 5 refuses a most-recent list against a store at revision 7, serves a stale "any" list, and serves a consistent list only after catch-up.

## References

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
