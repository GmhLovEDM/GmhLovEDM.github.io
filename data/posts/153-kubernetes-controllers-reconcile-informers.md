---
title: "Inside Kubernetes Controllers: Reconcile Loops, Informers, Work Queues, Optimistic Concurrency and Leader Election"
tag: devops
description: How Kubernetes controllers actually work — level-triggered reconciliation, the client-go informer stack (Reflector, ListAndWatch, DeltaFIFO, Indexer), resourceVersion and 410 Gone relists, the work queue's dedup and rate-limiting guarantees, optimistic concurrency and 409 Conflict, generation/observedGeneration, finalizers and owner references, leader election with Leases, and how controller-runtime packages it all for operators
date: "2026-11-08T13:20:00.000Z"
---

## Goal

Almost everything in Kubernetes is a controller. The Deployment controller creates ReplicaSets, the ReplicaSet controller creates Pods, the scheduler binds Pods to Nodes, the kubelet makes containers match the Pod spec, and every operator you install (cert-manager, Argo CD, a database operator) is one more controller running the same pattern.

Writing a controller with Kubebuilder takes an afternoon. Writing one that behaves under load, during API server restarts, with stale caches and concurrent writers, takes understanding what is underneath. This article covers:

1. Why controllers are **level-triggered** and what that buys you.
2. The client-go **informer** stack: Reflector, ListAndWatch, DeltaFIFO, Indexer, shared informers.
3. `resourceVersion`, watch bookmarks, and the **410 Gone** relist.
4. The **work queue**: deduplication, the "never processed by two workers" rule, and rate-limited retries — with a runnable Go model.
5. Writing back safely: **optimistic concurrency**, `409 Conflict`, the status subresource, `generation` / `observedGeneration`, and server-side apply.
6. Lifecycle: **owner references**, garbage collection, and **finalizers**.
7. Stale caches and the **expectations** pattern.
8. **Leader election** with Lease objects.
9. How **controller-runtime** wraps all of this, and the operational trade-offs.

## 1. The control loop: desired vs. observed state

The Kubernetes docs describe a controller as a non-terminating loop that watches the shared state of the cluster through the API server and makes changes trying to move the current state toward the desired state ([Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)). The key design choice is that the controller does not react to *what changed*; it reacts to *what is*.

- **Edge-triggered**: "a Pod was deleted, so create one." If you miss the event (network blip, crash, restart), the system is wrong forever.
- **Level-triggered**: "the ReplicaSet wants 3 Pods, I see 2, so create 1." Missed events do not matter as long as you eventually look again, because each pass recomputes the diff from scratch.

In practice the event is only a *hint* that a given object key (`namespace/name`) is worth looking at. The reconcile function receives just the key, reads current state, and converges:

```go
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var rs appsv1.ReplicaSet
    if err := r.Get(ctx, req.NamespacedName, &rs); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err) // gone: nothing to converge
    }
    pods, err := r.listOwnedPods(ctx, &rs)
    if err != nil {
        return ctrl.Result{}, err // retried with backoff
    }
    want := int(*rs.Spec.Replicas)
    switch diff := want - len(pods); {
    case diff > 0:
        return ctrl.Result{}, r.createPods(ctx, &rs, diff)
    case diff < 0:
        return ctrl.Result{}, r.deletePods(ctx, pods[:-diff])
    }
    return ctrl.Result{}, r.syncStatus(ctx, &rs, len(pods))
}
```

Three properties follow, and they are the rules for writing any controller:

1. **Idempotent**: running Reconcile twice with the same world produces no extra side effects.
2. **Stateless between calls**: anything you need must be derivable from the API (or from external systems you can query). In-memory state is a cache, never the truth.
3. **Collapsible**: ten events for the same key can be served by one reconcile, because only the current state matters.

## 2. The informer stack

Polling the API server for every object on every loop would not scale. client-go's informers give each controller a local, eventually consistent cache fed by a watch.

```
API server ──LIST + WATCH──► Reflector ──► DeltaFIFO ──► processLoop
                                                           │
                                     ┌─────────────────────┴─────────────┐
                                     ▼                                   ▼
                              Indexer (thread-safe store)      event handlers
                              by key + custom indexes          (OnAdd/OnUpdate/OnDelete)
                                     ▲                                   │
                                     │ Lister.Get / List                 ▼
                                Reconcile ◄──────── work queue ◄──── enqueue key
```

- **Reflector** runs `ListAndWatch`: a LIST to get a full snapshot plus its `resourceVersion`, then a WATCH starting from that version. Each watch event (`ADDED`, `MODIFIED`, `DELETED`, `BOOKMARK`) is pushed into the queue.
- **DeltaFIFO** stores, per object key, the list of deltas that have not been processed yet. It keeps ordering per key and lets the consumer see deletions even if the object is already gone (as a `DeletedFinalStateUnknown` tombstone when a delete was missed during a relist).
- **Indexer** is the in-memory store the controller reads from. It is keyed by `namespace/name` and supports secondary indexes, e.g. "all Pods on node X" or "all objects owned by UID Y".
- **Event handlers** are called after the store is updated. A typical handler does no work besides computing the key and adding it to the work queue.

### Shared informers

Ten controllers in `kube-controller-manager` all care about Pods. A `SharedInformerFactory` makes sure there is one watch and one cache per resource type per process, with multiple handlers registered on it. This is why a controller must treat objects from the cache as **read-only**: mutating a cached pointer corrupts what every other controller sees. Always `DeepCopy()` before modifying.

### Resync

Informers can be configured with a resync period that periodically replays every object in the cache to the handlers as an update. It does **not** go to the API server; it re-delivers cached state. Its purpose is to give level-triggered logic a chance to fix drift in *external* systems (a cloud load balancer someone edited by hand). controller-runtime's default `SyncPeriod` is 10 hours, which tells you how rarely you should depend on it; if you need periodic checks, return `RequeueAfter` from Reconcile instead.

## 3. resourceVersion, bookmarks and 410 Gone

Every object carries a `resourceVersion`, an opaque string that the API server derives from etcd's revision. Clients must treat it as opaque and only compare for equality ([API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)).

A watch started at version N streams every change after N. But etcd compacts history, and the API server's watch cache only keeps a window of recent events. If a reflector reconnects with a version that has fallen out of that window, the server answers **`410 Gone`** ("too old resource version"). The reflector then has to relist: LIST everything again and diff it against the store, synthesising adds, updates and deletes.

Relists on large clusters are expensive (a LIST of 100k Pods is a lot of serialisation and memory on both sides), so the API offers two mitigations:

- **Watch bookmarks** (`allowWatchBookmarks=true`): periodic `BOOKMARK` events that carry only a fresh `resourceVersion`. A quiet watch therefore still advances its version and can resume without hitting 410.
- **Streaming lists** (`sendInitialEvents=true` on a watch): newer API servers can deliver the initial state as a stream of watch events from the watch cache instead of one giant LIST response, cutting memory spikes.

The practical lesson: a controller's cache can be briefly empty or stale at startup and after relists. That is why controllers wait for `HasSynced` (`WaitForCacheSync`) before starting workers, and why logic like "the object is not in my cache, so it does not exist" must be written carefully.

## 4. The work queue

Between event handlers and Reconcile sits `k8s.io/client-go/util/workqueue` ([package docs](https://pkg.go.dev/k8s.io/client-go/util/workqueue)). It looks like a channel but provides three guarantees that make level-triggered controllers practical:

1. **Fair and deduplicated**: if a key is already waiting, adding it again is a no-op. A burst of 50 updates to one Deployment becomes one reconcile.
2. **No concurrent processing of the same key**: while a worker holds a key (between `Get` and `Done`), it is not handed to another worker. If it is re-added meanwhile, it is marked dirty and re-queued on `Done`. So you can run many workers (`MaxConcurrentReconciles`) without two goroutines reconciling the same object at once.
3. **Rate limiting**: `AddRateLimited` delays a retry; `Forget` resets the failure count after success. The default controller limiter is the max of a per-item exponential backoff (5 ms doubling up to 1000 s) and an overall token bucket (10 qps, burst 100).

Here is a stdlib-only model of that contract. I ran this with Go on my machine; the output follows.

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

// Queue models the client-go workqueue contract:
// - an item already waiting is not added twice (dirty set)
// - an item being processed is never handed to a second worker
// - if it is re-added while processing, it is queued again after Done()
type Queue struct {
	mu         sync.Mutex
	cond       *sync.Cond
	queue      []string
	dirty      map[string]bool
	processing map[string]bool
	failures   map[string]int
}

func NewQueue() *Queue {
	q := &Queue{dirty: map[string]bool{}, processing: map[string]bool{}, failures: map[string]int{}}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *Queue) Add(key string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.dirty[key] {
		return // already waiting: collapse events
	}
	q.dirty[key] = true
	if q.processing[key] {
		return // will be re-queued by Done()
	}
	q.queue = append(q.queue, key)
	q.cond.Signal()
}

func (q *Queue) Get() string {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.queue) == 0 {
		q.cond.Wait()
	}
	key := q.queue[0]
	q.queue = q.queue[1:]
	q.processing[key] = true
	delete(q.dirty, key)
	return key
}

func (q *Queue) Done(key string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	delete(q.processing, key)
	if q.dirty[key] {
		q.queue = append(q.queue, key)
		q.cond.Signal()
	}
}

// AddRateLimited re-adds after base * 2^failures, capped at max.
func (q *Queue) AddRateLimited(key string, base, max time.Duration) time.Duration {
	q.mu.Lock()
	n := q.failures[key]
	q.failures[key] = n + 1
	q.mu.Unlock()
	d := base << n
	if d > max || d <= 0 {
		d = max
	}
	time.AfterFunc(d, func() { q.Add(key) })
	return d
}

func (q *Queue) Forget(key string) {
	q.mu.Lock()
	delete(q.failures, key)
	q.mu.Unlock()
}
```

The driver feeds five events for the same key, makes the first two reconciles fail as if the API server had returned `409 Conflict`, then changes the desired replica count once more (the driver's shutdown line is omitted):

```text
reconcile default/web: conflict, retry in 5ms
reconcile default/web: conflict, retry in 10ms
reconcile default/web: replicas 0 -> 3
reconcile default/web: replicas 3 -> 5
events=6 reconciles=4 final actual=5
```

Six events, four reconciles, correct final state. The five-event burst collapsed into one queued key; retries backed off exponentially; the later spec change was picked up because Reconcile reads the current desired state rather than the content of the event.

## 5. Writing back: optimistic concurrency and status

The API server has no locks you can hold. Instead every update is a compare-and-swap on `resourceVersion`: if you send an object whose version no longer matches what is stored, you get **`409 Conflict`**. With a cache that may be a few milliseconds behind, conflicts are routine, not exceptional. The idiomatic response is to return the error (or requeue) and let the next reconcile re-read and recompute. `retry.RetryOnConflict` exists for short read-modify-write loops, but blindly retrying with the same in-memory object is a bug.

Other conventions that matter:

- **Status subresource**: with `/status` enabled, writes to the main resource ignore `status`, and writes to `/status` ignore `spec`. Users own spec, controllers own status, and they do not clobber each other.
- **`metadata.generation`** increments when the spec changes (status updates do not bump it). A controller writes `status.observedGeneration` after it has acted on a given generation, so `kubectl rollout status` and other clients can tell "accepted" from "processed". Conditions (`type`, `status`, `reason`, `observedGeneration`) follow the same idea.
- **Server-side apply** (`PATCH` with `application/apply-patch+yaml`): the server tracks which field manager owns which fields in `managedFields`. A controller that applies only the fields it cares about avoids overwriting fields set by users or other controllers, and conflicts become explicit per-field instead of whole-object.

## 6. Lifecycle: owner references, garbage collection, finalizers

**Owner references** link dependents to owners: a Pod's `ownerReferences` points at its ReplicaSet, with `controller: true` marking the managing owner. The garbage collector controller deletes dependents whose owners are gone ([Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)). Deletion propagation can be:

- **Background** (default): the owner is deleted immediately; the GC deletes dependents afterwards.
- **Foreground**: the owner gets `deletionTimestamp` and a `foregroundDeletion` finalizer, and only disappears after dependents with `blockOwnerDeletion` are gone.
- **Orphan**: dependents are left alone and their owner references removed.

Owner references are also how controllers route events: controller-runtime's `Owns(&corev1.Pod{})` maps a Pod event to its controlling owner's key, so the ReplicaSet is reconciled when one of its Pods changes.

**Finalizers** cover cleanup outside the cluster ([Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)). When an object with finalizers is deleted, the API server only sets `deletionTimestamp`; the object stays until every finalizer string is removed. The controller pattern is:

```go
const fin = "databases.example.com/cleanup"

if obj.DeletionTimestamp.IsZero() {
    if controllerutil.AddFinalizer(obj, fin) {
        return ctrl.Result{}, r.Update(ctx, obj)
    }
} else {
    if controllerutil.ContainsFinalizer(obj, fin) {
        if err := r.dropExternalDatabase(ctx, obj); err != nil {
            return ctrl.Result{}, err // keep finalizer, retry
        }
        controllerutil.RemoveFinalizer(obj, fin)
        return ctrl.Result{}, r.Update(ctx, obj)
    }
    return ctrl.Result{}, nil
}
```

The external cleanup must be idempotent, because the process can crash after dropping the database but before removing the finalizer. The classic production failure is a finalizer whose controller has been uninstalled: the object (often a whole namespace) hangs in `Terminating` forever.

## 7. Stale caches and expectations

Level-triggering assumes you can observe the true state. With an informer cache you observe a *slightly old* state. Consider a ReplicaSet controller that creates 3 Pods, and then is triggered again before the Pod-add events reach its cache: it still sees 0 Pods and creates 3 more.

The upstream ReplicaSet and Job controllers solve this with **expectations** (`ControllerExpectations` in `kube-controller-manager`): before creating N Pods, record "expect N adds for this key"; the Pod informer handler decrements as adds arrive; while expectations are unsatisfied (and not expired), reconcile skips scaling actions. It is a small piece of in-memory state, but it only *suppresses* action, never replaces the observed truth, and it expires so a lost event cannot wedge the controller.

Simpler alternatives in operators: deterministic names (create `web-0`, `web-1`, so a duplicate create returns `AlreadyExists`), reading through the API instead of the cache for critical checks, or relying on server-side apply being idempotent.

## 8. Leader election

You usually run two or three replicas of a controller manager for availability, but only one should act at a time; otherwise both reconcile the same object and fight. client-go's `leaderelection` package implements a lease lock on a `coordination.k8s.io/v1` **Lease** object ([Leases](https://kubernetes.io/docs/concepts/architecture/leases/)):

- The leader writes its identity and renews `renewTime` every `RetryPeriod`.
- If it cannot renew within `RenewDeadline`, it must stop acting (controller-runtime exits the process).
- Followers try to acquire once `LeaseDuration` has passed since the last renewal.

controller-runtime's defaults are 15 s lease duration, 10 s renew deadline and 2 s retry period. This is not a perfect mutual exclusion: it relies on roughly synchronised clocks and on the old leader stopping promptly, and a long GC pause can create a short window with two actors. Idempotent reconcile and optimistic concurrency on every write are what make that window harmless. Failover time is roughly the lease duration plus cache sync time for the new leader, which on large clusters can dominate.

## 9. controller-runtime: the packaging

[controller-runtime](https://github.com/kubernetes-sigs/controller-runtime) (used by Kubebuilder and Operator SDK, see the [Kubebuilder book](https://book.kubebuilder.io/)) wires the pieces together:

```go
func (r *DatabaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&dbv1.Database{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
        Owns(&appsv1.StatefulSet{}).
        Owns(&corev1.Service{}).
        WithOptions(controller.Options{MaxConcurrentReconciles: 4}).
        Complete(r)
}
```

| Concept | client-go | controller-runtime |
|---|---|---|
| Cache | SharedInformerFactory + Listers | `Manager` cache; `client.Client` reads from cache, writes to API |
| Event → key | handwritten handlers | `For`, `Owns`, `Watches` + `handler.EnqueueRequestsFromMapFunc` |
| Filtering | in handler | predicates (e.g. `GenerationChangedPredicate` ignores status-only updates) |
| Queue + workers | workqueue + loop | built in, `MaxConcurrentReconciles` (default 1) |
| Retry | `AddRateLimited` | return error, or `Result{RequeueAfter: d}` |
| HA | leaderelection package | `LeaderElection: true` in manager options |

A few traps the abstraction hides:

- **The default client reads from the cache.** A `Get` right after a `Create` may return NotFound. Use the API reader (`mgr.GetAPIReader()`) when you need a strongly consistent read.
- **Caching every type you `Get` starts an informer for it.** Getting a Secret once quietly caches every Secret in the cluster, with memory and RBAC implications. Limit the cache by namespace or label selector, or use metadata-only watches for types where you only need names and labels.
- **Predicates drop events, which can hide drift.** `GenerationChangedPredicate` is great for ignoring your own status writes, but it also ignores label and annotation changes.
- **Returning both an error and `RequeueAfter`** means the error path wins; pick one.

## 10. Trade-offs and when the pattern fits

The reconcile loop trades latency and efficiency for robustness. Every pass recomputes the world, events are lossy hints, and correctness depends on idempotency rather than on delivering every message exactly once. That is the same trade large distributed systems make with anti-entropy repair: it is slower per change, but it self-heals after crashes, partitions, and manual edits.

Where it fits less well:

- **Imperative workflows** with strict ordering and a history (a multi-step migration that must not repeat step 2). You can model them as a state machine in `status`, but a workflow engine may be a better fit.
- **Very high-cardinality, high-churn data**. Watching millions of small objects through the API server and etcd is expensive; Kubernetes is a control plane, not a database for application data.
- **External systems with weak read APIs**. If you cannot cheaply read the current state of the thing you manage, level-triggering degenerates into blind retries.

## Summary

- Controllers are level-triggered: events are hints, Reconcile reads current state and converges, and must be idempotent.
- Informers (Reflector → DeltaFIFO → Indexer) give a shared, eventually consistent cache fed by LIST + WATCH; `resourceVersion`, bookmarks and 410-driven relists keep it in sync.
- The work queue deduplicates keys, never lets two workers hold the same key, and backs off failures exponentially.
- Writes use optimistic concurrency: `409 Conflict` is normal; status subresources, `observedGeneration` and server-side apply keep owners from trampling each other.
- Owner references drive garbage collection; finalizers gate deletion on idempotent external cleanup.
- Stale caches need expectations, deterministic names or uncached reads; HA uses Lease-based leader election, whose small overlap window is made safe by everything above.

## References

- Kubernetes docs: [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- Kubernetes docs: [API Concepts (resourceVersion, watch, bookmarks)](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- Kubernetes docs: [Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
- Kubernetes docs: [Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- Kubernetes docs: [Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- [client-go workqueue package](https://pkg.go.dev/k8s.io/client-go/util/workqueue)
- [controller-runtime](https://github.com/kubernetes-sigs/controller-runtime) and the [Kubebuilder book](https://book.kubebuilder.io/)
