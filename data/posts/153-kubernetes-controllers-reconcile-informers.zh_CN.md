---
title: "深入 Kubernetes 控制器：调和循环、Informer、工作队列、乐观并发与 Leader 选举"
tag: devops
description: Kubernetes 控制器的真实工作方式——水平触发的调和、client-go Informer 体系（Reflector、ListAndWatch、DeltaFIFO、Indexer）、resourceVersion 与 410 Gone 重新 List、工作队列的去重与限速保证、乐观并发与 409 Conflict、generation/observedGeneration、Finalizer 与 OwnerReference、基于 Lease 的 Leader 选举，以及 controller-runtime 如何把这些打包给 Operator 使用
date: "2026-11-08T13:20:00.000Z"
---

## Goal

Kubernetes 里几乎一切都是控制器。Deployment 控制器创建 ReplicaSet，ReplicaSet 控制器创建 Pod，调度器把 Pod 绑定到节点，kubelet 让容器与 Pod 规格保持一致；你安装的每一个 Operator（cert-manager、Argo CD、各种数据库 Operator）也只是又一个跑着同样模式的控制器。

用 Kubebuilder 写一个控制器只要一个下午；写一个在高负载、API Server 重启、缓存滞后、多方并发写入下依然表现正确的控制器，则需要理解底层机制。本文包括：

1. 控制器为什么是**水平触发（level-triggered）**的，这带来了什么。
2. client-go **Informer** 体系：Reflector、ListAndWatch、DeltaFIFO、Indexer、共享 Informer。
3. `resourceVersion`、Watch 书签与 **410 Gone** 重新 List。
4. **工作队列**：去重、「同一个 key 不会被两个 worker 同时处理」以及限速重试——附可运行的 Go 模型。
5. 安全写回：**乐观并发**、`409 Conflict`、status 子资源、`generation` / `observedGeneration`、Server-Side Apply。
6. 生命周期：**OwnerReference**、垃圾回收与 **Finalizer**。
7. 缓存滞后与 **expectations** 模式。
8. 基于 Lease 的 **Leader 选举**。
9. **controller-runtime** 的封装方式与工程取舍。

## 1. 控制循环：期望状态与观测状态

官方文档把控制器描述为一个永不终止的循环：通过 API Server 观察集群共享状态，并尝试把当前状态推向期望状态（[Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)）。关键设计在于：控制器不对「发生了什么变化」做反应，而是对「现在是什么样」做反应。

- **边沿触发**：「一个 Pod 被删了，所以创建一个。」只要漏掉一次事件（网络抖动、崩溃、重启），系统就永远是错的。
- **水平触发**：「ReplicaSet 要 3 个 Pod，我看到 2 个，所以创建 1 个。」漏事件无所谓，只要最终会再看一次，因为每一轮都从头计算差异。

实践中，事件只是一个*提示*：某个对象 key（`namespace/name`）值得看一眼。调和函数只接收 key，读取当前状态，然后收敛：

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

由此得出编写任何控制器都要遵守的三条规则：

1. **幂等**：在同样的世界状态下执行两次 Reconcile，不会产生额外副作用。
2. **调用之间无状态**：需要的一切都必须能从 API（或可查询的外部系统）推导出来。内存状态只是缓存，永远不是事实来源。
3. **可合并**：同一个 key 的十个事件可以由一次调和处理，因为只有最新状态才重要。

## 2. Informer 体系

每一轮都去 API Server 轮询所有对象是无法扩展的。client-go 的 Informer 为每个控制器提供一个由 Watch 驱动的本地、最终一致的缓存。

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

- **Reflector** 执行 `ListAndWatch`：先 LIST 获取完整快照及其 `resourceVersion`，再从该版本开始 WATCH。每个 Watch 事件（`ADDED`、`MODIFIED`、`DELETED`、`BOOKMARK`）都被推入队列。
- **DeltaFIFO** 按对象 key 保存尚未处理的变更列表。它保证同一 key 的顺序，并且即使对象已经不存在，消费者也能看到删除（重新 List 时如果漏掉了删除，会以 `DeletedFinalStateUnknown` 墓碑形式出现）。
- **Indexer** 是控制器读取的内存存储，以 `namespace/name` 为主键，支持二级索引，例如「节点 X 上的所有 Pod」或「属于 UID Y 的所有对象」。
- **事件处理函数**在存储更新之后被调用。典型的处理函数除了计算 key 并加入工作队列之外什么也不做。

### 共享 Informer

`kube-controller-manager` 里有十个控制器都关心 Pod。`SharedInformerFactory` 保证每个进程中每种资源类型只有一个 Watch 和一份缓存，多个处理函数注册在上面。这也是为什么控制器必须把缓存中的对象视为**只读**：修改缓存里的指针会污染所有其他控制器看到的数据。修改前一定要 `DeepCopy()`。

### Resync

Informer 可以配置一个 resync 周期，定期把缓存中的每个对象作为 update 重新投递给处理函数。它**不会**请求 API Server，只是重放缓存状态。目的是让水平触发逻辑有机会修复*外部*系统的漂移（比如有人手动改了云负载均衡器）。controller-runtime 的默认 `SyncPeriod` 是 10 小时，说明你不应该依赖它；需要周期性检查时，应在 Reconcile 中返回 `RequeueAfter`。

## 3. resourceVersion、书签与 410 Gone

每个对象都带有 `resourceVersion`，这是 API Server 根据 etcd revision 生成的不透明字符串。客户端必须把它当作不透明值，只做相等比较（[API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)）。

从版本 N 开始的 Watch 会推送 N 之后的所有变化。但 etcd 会压缩历史，API Server 的 watch cache 也只保留最近一段事件窗口。如果 Reflector 用一个已经掉出窗口的版本重连，服务端返回 **`410 Gone`**（"too old resource version"）。此时 Reflector 必须重新 List：再次 LIST 全量数据并与本地存储做差异，合成新增、更新和删除事件。

在大集群上重新 List 代价很高（LIST 10 万个 Pod 在两端都意味着大量序列化和内存），因此 API 提供了两种缓解手段：

- **Watch 书签**（`allowWatchBookmarks=true`）：周期性的 `BOOKMARK` 事件只携带一个新的 `resourceVersion`。这样即使 Watch 很安静，其版本也会前进，重连时不会触发 410。
- **流式 List**（在 Watch 上设置 `sendInitialEvents=true`）：较新的 API Server 可以把初始状态从 watch cache 以 Watch 事件流的形式发送，而不是一个巨大的 LIST 响应，从而削减内存峰值。

实践教训：控制器缓存在启动时和重新 List 之后可能短暂为空或滞后。这就是为什么控制器要在启动 worker 前等待 `HasSynced`（`WaitForCacheSync`），以及为什么「缓存里没有这个对象，所以它不存在」这类逻辑必须谨慎编写。

## 4. 工作队列

事件处理函数与 Reconcile 之间是 `k8s.io/client-go/util/workqueue`（[包文档](https://pkg.go.dev/k8s.io/client-go/util/workqueue)）。它看起来像 channel，但提供了三项让水平触发控制器真正可用的保证：

1. **公平且去重**：如果某个 key 已在等待，再次添加是空操作。同一个 Deployment 的 50 次更新会变成一次调和。
2. **同一 key 不会被并发处理**：某个 worker 持有 key（`Get` 到 `Done` 之间）时，它不会被交给其他 worker。期间如果被再次添加，会被标记为 dirty，并在 `Done` 时重新入队。因此你可以运行多个 worker（`MaxConcurrentReconciles`），而不会有两个 goroutine 同时调和同一个对象。
3. **限速**：`AddRateLimited` 延迟重试；成功后 `Forget` 重置失败计数。默认控制器限速器取两者的最大值：按条目的指数退避（5 ms 起翻倍，上限 1000 s）和全局令牌桶（10 qps，突发 100）。

下面是这一契约的纯标准库模型。我在自己的机器上用 Go 跑过，输出见后文。

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

驱动程序为同一个 key 投递 5 个事件，让前两次调和像 API Server 返回 `409 Conflict` 那样失败，然后再改一次期望副本数（省略了驱动程序的退出行）：

```text
reconcile default/web: conflict, retry in 5ms
reconcile default/web: conflict, retry in 10ms
reconcile default/web: replicas 0 -> 3
reconcile default/web: replicas 3 -> 5
events=6 reconciles=4 final actual=5
```

6 个事件、4 次调和、最终状态正确。5 个事件的突发合并成了一个排队 key；重试按指数退避；后来的规格变化也被正确处理，因为 Reconcile 读取的是当前期望状态，而不是事件内容。

## 5. 写回：乐观并发与 status

API Server 没有可以持有的锁。每次更新都是基于 `resourceVersion` 的 compare-and-swap：如果你提交的对象版本与存储中的不一致，就会得到 **`409 Conflict`**。缓存可能落后几毫秒，所以冲突是常态而不是异常。惯用做法是返回错误（或重新入队），让下一轮调和重新读取并重新计算。`retry.RetryOnConflict` 适用于短小的读-改-写循环，但拿同一个内存对象盲目重试是 bug。

其他重要约定：

- **status 子资源**：启用 `/status` 后，对主资源的写入会忽略 `status`，对 `/status` 的写入会忽略 `spec`。用户拥有 spec，控制器拥有 status，互不覆盖。
- **`metadata.generation`** 在 spec 变化时递增（status 更新不会改变它）。控制器在处理完某个 generation 后写入 `status.observedGeneration`，这样 `kubectl rollout status` 等客户端就能区分「已接受」与「已处理」。Conditions（`type`、`status`、`reason`、`observedGeneration`）也是同样的思路。
- **Server-Side Apply**（`PATCH`，`application/apply-patch+yaml`）：服务端在 `managedFields` 中记录哪个 field manager 拥有哪些字段。控制器只 apply 自己关心的字段，就不会覆盖用户或其他控制器设置的字段，冲突也从整个对象级别变成了明确的字段级别。

## 6. 生命周期：OwnerReference、垃圾回收与 Finalizer

**OwnerReference** 把从属对象与属主关联起来：Pod 的 `ownerReferences` 指向它的 ReplicaSet，`controller: true` 标记真正管理它的属主。垃圾回收控制器会删除属主已不存在的从属对象（[Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)）。删除传播策略有：

- **Background**（默认）：属主立即删除，GC 随后删除从属对象。
- **Foreground**：属主被设置 `deletionTimestamp` 和 `foregroundDeletion` finalizer，等带有 `blockOwnerDeletion` 的从属对象都删除后才消失。
- **Orphan**：保留从属对象，只移除它们的 OwnerReference。

OwnerReference 也是控制器路由事件的方式：controller-runtime 的 `Owns(&corev1.Pod{})` 会把 Pod 事件映射到其控制属主的 key，因此 Pod 变化时会调和它所属的 ReplicaSet。

**Finalizer** 用于集群之外的清理（[Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)）。删除带有 finalizer 的对象时，API Server 只设置 `deletionTimestamp`；对象会一直存在，直到所有 finalizer 字符串被移除。控制器模式如下：

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

外部清理必须幂等，因为进程可能在删掉数据库之后、移除 finalizer 之前崩溃。最经典的线上故障是：某个 finalizer 对应的控制器已被卸载，于是对象（常常是整个 namespace）永远卡在 `Terminating`。

## 7. 缓存滞后与 expectations

水平触发假设你能观察到真实状态。而通过 Informer 缓存，你观察到的是*稍旧*的状态。设想 ReplicaSet 控制器创建了 3 个 Pod，在 Pod 新增事件到达缓存之前又被触发了一次：它依然看到 0 个 Pod，于是又创建 3 个。

上游的 ReplicaSet 和 Job 控制器用 **expectations**（`kube-controller-manager` 中的 `ControllerExpectations`）解决这个问题：创建 N 个 Pod 之前记录「这个 key 期望 N 次新增」；Pod Informer 处理函数在新增事件到达时递减；在 expectations 未满足（且未过期）期间，调和会跳过扩缩容操作。这是一小段内存状态，但它只*抑制*动作，从不替代观测到的事实，而且会过期，所以丢失一个事件也不会把控制器卡死。

Operator 中更简单的替代方案：确定性命名（创建 `web-0`、`web-1`，重复创建会返回 `AlreadyExists`）、关键检查绕过缓存直接读 API，或依赖 Server-Side Apply 的幂等性。

## 8. Leader 选举

为了可用性，控制器管理器通常跑两三个副本，但同一时刻只应有一个在干活，否则两者会调和同一个对象并互相打架。client-go 的 `leaderelection` 包基于 `coordination.k8s.io/v1` 的 **Lease** 对象实现租约锁（[Leases](https://kubernetes.io/docs/concepts/architecture/leases/)）：

- Leader 写入自己的身份，并每隔 `RetryPeriod` 续约 `renewTime`。
- 如果在 `RenewDeadline` 内无法续约，就必须停止工作（controller-runtime 会直接退出进程）。
- Follower 在距上次续约超过 `LeaseDuration` 后尝试获取租约。

controller-runtime 的默认值是租约时长 15 s、续约截止 10 s、重试周期 2 s。这不是完美的互斥：它依赖大致同步的时钟以及旧 Leader 及时停手，一次长时间的 GC 停顿就可能造成短暂的双主窗口。让这个窗口无害的，正是幂等调和与每次写入的乐观并发。故障切换时间大约是租约时长加上新 Leader 的缓存同步时间，在大集群上后者可能占大头。

## 9. controller-runtime：封装

[controller-runtime](https://github.com/kubernetes-sigs/controller-runtime)（Kubebuilder 与 Operator SDK 都基于它，见 [Kubebuilder book](https://book.kubebuilder.io/)）把这些部件连接在一起：

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

| 概念 | client-go | controller-runtime |
|---|---|---|
| 缓存 | SharedInformerFactory + Lister | `Manager` 缓存；`client.Client` 从缓存读、向 API 写 |
| 事件 → key | 手写处理函数 | `For`、`Owns`、`Watches` + `handler.EnqueueRequestsFromMapFunc` |
| 过滤 | 在处理函数里 | predicate（如 `GenerationChangedPredicate` 忽略仅 status 的更新） |
| 队列与 worker | workqueue + 循环 | 内置，`MaxConcurrentReconciles`（默认 1） |
| 重试 | `AddRateLimited` | 返回 error，或 `Result{RequeueAfter: d}` |
| 高可用 | leaderelection 包 | manager 选项中 `LeaderElection: true` |

这层抽象掩盖的几个坑：

- **默认 client 从缓存读。** `Create` 之后立刻 `Get` 可能返回 NotFound。需要强一致读时，使用 API reader（`mgr.GetAPIReader()`）。
- **你 `Get` 过的每种类型都会启动一个 Informer。** 读一次 Secret，就会悄悄缓存集群中所有 Secret，带来内存与 RBAC 方面的影响。应按 namespace 或 label selector 限制缓存范围，或者对只需要名字和标签的类型使用仅元数据的 Watch。
- **predicate 会丢弃事件，可能掩盖漂移。** `GenerationChangedPredicate` 很适合忽略自己写的 status，但也会忽略 label 和 annotation 的变化。
- **同时返回 error 和 `RequeueAfter`** 时，走的是错误路径；二者选其一。

## 10. 取舍：什么时候适合这种模式

调和循环用延迟和效率换取健壮性。每一轮都重新计算世界状态，事件只是可能丢失的提示，正确性依赖幂等而不是每条消息恰好投递一次。这与大型分布式系统用反熵修复做的取舍一样：单次变更更慢，但能在崩溃、分区和人工改动之后自愈。

不太适合的场景：

- **有严格顺序和历史的命令式流程**（一个多步迁移，第 2 步绝不能重复执行）。可以在 `status` 中把它建模为状态机，但工作流引擎可能更合适。
- **超高基数、高频变化的数据**。通过 API Server 和 etcd 监听数百万个小对象代价高昂；Kubernetes 是控制面，不是应用数据的数据库。
- **读接口很弱的外部系统**。如果无法低成本读取被管理对象的当前状态，水平触发就会退化成盲目重试。

## 总结

- 控制器是水平触发的：事件只是提示，Reconcile 读取当前状态并收敛，必须幂等。
- Informer（Reflector → DeltaFIFO → Indexer）提供由 LIST + WATCH 驱动的共享、最终一致缓存；`resourceVersion`、书签和 410 触发的重新 List 保持其同步。
- 工作队列对 key 去重，从不让两个 worker 同时持有同一 key，并对失败做指数退避。
- 写入采用乐观并发：`409 Conflict` 是常态；status 子资源、`observedGeneration` 与 Server-Side Apply 让各方互不践踏。
- OwnerReference 驱动垃圾回收；Finalizer 让删除等待幂等的外部清理。
- 缓存滞后需要 expectations、确定性命名或绕过缓存读取；高可用依赖基于 Lease 的 Leader 选举，而它那一小段重叠窗口之所以安全，靠的正是以上所有机制。

## 参考资料

- Kubernetes 文档：[Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- Kubernetes 文档：[API Concepts（resourceVersion、watch、书签）](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- Kubernetes 文档：[Garbage Collection](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
- Kubernetes 文档：[Finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- Kubernetes 文档：[Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- [client-go workqueue 包](https://pkg.go.dev/k8s.io/client-go/util/workqueue)
- [controller-runtime](https://github.com/kubernetes-sigs/controller-runtime) 与 [Kubebuilder book](https://book.kubebuilder.io/)
