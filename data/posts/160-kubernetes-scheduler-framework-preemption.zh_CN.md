---
title: "深入 Kubernetes 调度器：过滤、打分、抢占与拓扑打散"
tag: devops
description: kube-scheduler 如何给 Pod 选节点——串行的调度周期与并发的绑定周期，active/backoff/不可调度队列与 QueueingHints，从 PreFilter 到 Bind 的插件框架，为什么资源 Fit 看的是 requests 而不是 limits，默认打分权重和 5%–50% 的节点评分窗口，拓扑打散与污点，DefaultPreemption 如何挑选牺牲者，调度器不会做的事，以及一个比较 LeastAllocated 与装箱并演示抢占的可运行模型
date: "2026-11-15T13:30:00.000Z"
---

## 目标

一个没有 `spec.nodeName` 的 Pod，此刻并不在任何节点上运行。站在「已创建」和「已绑定」之间的，只有 kube-scheduler：它读取集群缓存，选出一个节点，再把这个选择写回 API server。生产里几乎所有和 Pending Pod 有关的意外——CPU 看起来还有空、某个可用区倾斜了、高优先级工作负载仍然卡在队列里、一个批处理任务在服务 Pod 到来时消失——其实都是这个循环里的意外。

本文包括：

1. 一次调度上下文的两半：串行的 **调度周期** 与并发的 **绑定周期**。
2. 调度队列：activeQ、backoffQ、不可调度池、PreEnqueue 门闩和 QueueingHints。
3. **调度框架** 及其扩展点，从 PreFilter 一直到 Bind。
4. 过滤：污点、亲和性、卷、拓扑打散，以及为什么 Fit 看的是 **requests 而不是 limits**。
5. 打分：插件权重、LeastAllocated 与 MostAllocated，以及为什么调度器不会给每个节点打分。
6. Reserve、Permit 和 assume-cache，用来阻止两个 Pod 抢走同一份资源。
7. **拓扑打散约束**，以及它们与污点、cordon 的相互作用。
8. **抢占**：牺牲者选择、`nominatedNodeName`、作为尽力而为的 PodDisruptionBudget，以及算法跨不过去的缺口。
9. 调度器不会做的事——以及哪些组件填补这些缺口。
10. 一个可运行模型：先放置一组混合负载，再接入一个关键 Pod。

## 1. 两个周期：先选节点，再告诉集群

调度框架从 Kubernetes v1.19 起就保持稳定。每一次给一个 Pod 选节点，都是一次带两个阶段的 *调度上下文*（[Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)）：

- **调度周期** 是决策。它是 **串行运行的**：调度器绝不会同时用同一份快照给两个 Pod 打分。这就是它避免把节点最后 500 millicore 订给两个人的办法。
- **绑定周期** 是写入。它创建一个 Binding（或设置 `spec.nodeName`），并且可以与下一次调度周期 **并发** 运行，因为一次远程 API 调用不该堵住决策循环。

任一周期判定 Pod 不可调度，或遇到内部错误，Pod 都会回到队列里重试。在「我选了节点 N」和「Binding 已经持久化」之间，调度器会在缓存里 **assume** 这次分配，并运行 Reserve 插件，好让下一次调度周期已经把这些资源看成已占用。如果随后的 bind 失败，Unreserve 会按相反顺序执行，assumption 被撤销。

这种拆分就是 kube-scheduler 的性能故事：决策便宜且严格有序；绑定更慢，但可以流水线化。

## 2. 周期前面的队列

未调度的 Pod 并不坐在一个单一的 FIFO 里。调度器维护三种结构（[scheduler queue notes](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md)，[QueueingHint 博客](https://kubernetes.io/blog/2024/12/12/scheduler-queueinghint/)）：

- **activeQ** —— 已经可以弹出、进入一次调度周期的 Pod。弹出顺序由 QueueSort 插件决定。默认的 `PrioritySort` 先按 Priority（高的在前），再按时间戳。
- **backoffQ** —— 应该重试、但不要立刻重试的 Pod。默认初始退避是一秒，上限是十秒；连续失败会拉长延迟，这样放不下去的 Pod 不会在循环一空闲就烧掉一次周期。
- **不可调度池** —— 调度器已经尝试过、并且还没有发生相关集群事件的 Pod；也包括被 PreEnqueue 插件拒绝入队的 Pod（例如仍被 scheduling gate 挡住的 Pod）。

另外还有两个后台刷新作为托底：退避到期的 Pod 会被移到 activeQ；一个 30 秒一次的循环，会把在不可调度池里停留超过 `podMaxInUnschedulablePodsDuration`（默认五分钟）的 Pod 再拿出来重试，即使期间没有任何事件。

真正有意思的是 Pod 如何提前离开不可调度池。拒绝某个 Pod 的插件可以实现 **EnqueueExtension** / **QueueingHint**：在特定集群事件上回调，回答这次事件 *是否可能* 让这个 Pod 变得可调度。QueueingHint 在 Kubernetes v1.34 成为稳定特性，并且默认开启。一次 Node 亲和性失败，不该只因为某个毫不相关的 Pod 被删除就重试；一次资源 Fit 失败，则该在匹配节点上有 Pod 消失时重试。没有 hint 时，调度器只能偏保守，常常把所有不可调度的 Pod 都搬回去，在大规模集群里代价很高。

**PreEnqueue** 在 Pod 被允许进入 activeQ 之前运行。树内的 `SchedulingGates` 插件是最常见的拦住原因：只要 `spec.schedulingGates` 非空，这个 Pod 就还不是「过滤失败」意义上的不可调度——它甚至还没被允许去试。

## 3. 插件框架

几乎每项调度功能都是编译进 kube-scheduler、并注册在一个或多个扩展点上的插件。`KubeSchedulerConfiguration` 的 profile 可以关掉默认插件、加入树外插件，或改打分权重。扩展点按顺序是：

| 扩展点 | 何时运行 | 能做什么 |
| --- | --- | --- |
| QueueSort | 为 activeQ 排序 | 恰好一个插件；默认是 PrioritySort |
| PreEnqueue | 进入 activeQ 之前 | 阻止一个 Pod 被考虑 |
| PreFilter | 每个周期一次 | 预计算，或直接中止本周期 |
| Filter | 每个节点（可并发） | 拒绝该节点；后续过滤器对该节点不再运行 |
| PostFilter | 仅当 **没有任何** 节点通过 Filter | 通常是抢占；一旦有插件把 Pod 标为可调度就提前结束 |
| PreScore | 一次，针对可行集 | 为打分准备共享状态 |
| Score + NormalizeScore | 每个可行节点，然后每个插件一次 | 每个插件 0–100，再做加权和 |
| Reserve / Unreserve | 选出节点之后 | 乐观记账；Unreserve 是回滚，必须幂等 |
| Permit | 调度周期结束时 | 批准、拒绝，或在绑定前 **等待**（带超时） |
| PreBind、Bind、PostBind | 绑定周期 | 卷相关工作、真正的 bind、收尾记账 |

当前 kube-scheduler 默认的 MultiPoint 集合（`pkg/scheduler/apis/config/v1/default_plugins.go`）包括 `SchedulingGates`、`PrioritySort`、`NodeName`、`NodeUnschedulable`、`TaintToleration`（打分权重 3）、`NodeAffinity`（2）、`NodePorts`、`NodeResourcesFit`（1）、卷相关插件、`PodTopologySpread`（2）、`InterPodAffinity`（2）、`DynamicResources`（2）、`DefaultPreemption`、`NodeResourcesBalancedAllocation`（1）、`ImageLocality`（1）和 `DefaultBinder`。这些权重解释了为什么一条 preferred toleration 或软亲和性，可以压过剩余 CPU 上的一点点差距。

**Permit** 是让「等组里其他成员到齐」成为可能的钩子。插件可以立即批准、拒绝（Pod 回到队列并运行 Unreserve），或返回 wait：Pod 被放进内部等待列表，绑定周期会一直阻塞到批准或超时。树内的 kube-scheduler 仍然 **一次只放置一个 Pod**；全有或全无的作业级放置，存在于 [scheduler-plugins 的 Coscheduling](https://github.com/kubernetes-sigs/scheduler-plugins) Permit 插件、Volcano，或需要显式打开的更新的工作负载感知特性里。

## 4. Filter：硬约束，以及 requests 而不是 limits

Filter 插件就是从前的 “predicates”。它们按配置顺序对每个节点运行，第一次拒绝即生效。重要的树内检查包括：

- `NodeUnschedulable` —— 尊重 `spec.unschedulable`（cordon）。
- `NodeName` —— `spec.nodeName` 已经设好（这个阶段很少见）。
- `TaintToleration` —— 带 `NoSchedule` / `NoExecute` 污点、却没有匹配容忍的节点会被拒绝。你为 GPU 工作负载打上污点的节点，对每一个忘了写 toleration 的 Pod 都是隐形的，包括本来很乐意使用剩余 CPU 的批处理任务。
- `NodeAffinity` / `nodeSelector` —— required 亲和性是 Filter；preferred 亲和性是 Score。
- `NodePorts` —— `hostPort` 冲突。
- `NodeResourcesFit` —— 节点剩余 **allocatable** 是否够这个 Pod 的 **resource requests**。
- 卷插件 —— 可用区约束、CSI 挂载上限、`WaitForFirstConsumer` 绑定。
- `PodTopologySpread` —— required（`whenUnsatisfiable: DoNotSchedule`）约束。
- `InterPodAffinity` —— required 亲和 / 反亲和。

真正容易踩坑的是资源检查。调度器只记账 **requests**，从不看 limits。一个可分配 8 CPU 的节点上，四个各 request 1 CPU、limit 4 CPU 的 Pod，在调度器看来仍然空着一半。这四个 Pod 能不能真正一起跑，是 kubelet / cgroup 的问题，也是 Binding 早已成功之后、CPU 被节流的常见来源。如果你希望调度器拒绝超卖，就把 requests 设成进程真正需要的资源，而不是一个象征性的 10 millicore。

同一个函数也解释了为什么「`kubectl top` 里这个节点还有空闲 CPU」并不意味着 Pending Pod 会落到那里：`top` 看的是用量，Fit 看的是 requests，而 unschedulable、污点、端口、卷、打散都可以拒绝一个 requests 尚未用满的节点。

## 5. Score：权重、装箱还是打散，以及不必访遍每个节点

可行节点会被排序。每个 Score 插件返回一个归一化到 `0..100` 的值，再乘以权重，总和最高的节点胜出。

`NodeResourcesFit` 可以按插件参数用三种方式打分：

- **LeastAllocated**（默认）—— 更偏好剩余已请求容量更多的节点。这会把负载摊开。
- **MostAllocated** —— 更偏好放上去之后更满的节点。这是装箱，适合你希望 Cluster Autoscaler 或 Karpenter 收掉空节点的场景。
- **RequestedToCapacityRatio** —— 自定义利用率到分数的形状。

`NodeResourcesBalancedAllocation` 偏好 CPU 与内存利用率能保持接近的节点，避免把节点的内存填满却把 CPU 闲置（或反过来）。`ImageLocality` 偏好已经有镜像层的节点。Preferred 亲和性、preferred 污点和 preferred 拓扑打散，都会按上面的权重加入总分。

在一个 10,000 节点的集群里给每个节点打分太浪费。`KubeSchedulerConfiguration` 里的 `percentageOfNodesToScore` 控制搜索范围。默认是 `0`，表示 *自适应*：调度器会按集群规模在 5% 到 50% 之间取一个百分比（[Scheduler Configuration](https://kubernetes.io/docs/reference/scheduling/config/)，以及 `pkg/scheduler/apis/config/types.go` 里对 `PercentageOfNodesToScore` 的注释）。与此独立，当前 kube-scheduler 总会至少寻找 `minFeasibleNodesToFind = 100` 个可行节点，并且不会低于 `minFeasibleNodesPercentageToFind = 5`（`pkg/scheduler/schedule_one.go`）。一旦手上的可行节点够了，集群的其余部分就不会再被打分。这对吞吐量有好处；这也是为什么集群另一侧一个稍好的节点，有时根本不会被考虑。

## 6. 拓扑打散

[`topologySpreadConstraints`](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/) 用来让调度器把匹配的 Pod 尽量均匀地放在故障域里：

```yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app: web
    matchLabelKeys:
      - pod-template-hash
```

放置这个 Pod 之后，任一域里匹配 Pod 的数量减去最小域里的数量，不得超过 `maxSkew`。`DoNotSchedule` 让它成为 Filter；`ScheduleAnyway` 让它成为 Score。约束针对的是 *拓扑键*，而不是域内装箱：同一个可用区里的两个副本，如果该区只有一个合格节点，仍然可能落在同一台机器上。

`minDomains` 会把缺失的域当作空域（计数为 0），用来避免 Deployment 在第三个可用区还没起来时，全部挤进前两个区。`nodeAffinityPolicy` 和 `nodeTaintsPolicy` 决定那些本来就不会被这个 Pod 选中的节点，是否仍然算作一个域。`matchLabelKeys`（常见的是 `pod-template-hash`）是滚动更新的逃生口：没有它，新旧 ReplicaSet 共享同一套选择器，`maxSkew` 为 1 时，新 ReplicaSet 可能因为旧的已经占满每个域而被挡住。

调度器也可以配置 `defaultConstraints`，让省略该字段的 Pod 仍然获得软打散。这在插件参数里默认是关闭的；想要的话需要自己设。

## 7. 抢占

当 Filter 找不到任何可行节点时，PostFilter 会运行。树内的 `DefaultPreemption` 插件接着问：有没有一个节点，驱逐一个或多个 **更低优先级** 的 Pod 之后，就能让这个 Pod 变得可行？（[Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)）

几条很容易弄错的规则：

- 优先级是必要但不是充分条件。`preemptionPolicy: Never` 的 PriorityClass 不会驱逐任何人。仍被 gate 住的 Pod 甚至还没进入这个周期。
- 候选集是「如果把 *该节点上* 所有更低优先级的 Pod 都清掉、就能放下的节点」。插件随后只驱逐必要的数量，优先低优先级。
- 在这些候选里，`pickOneNodeForPreemption` 使用固定的字典序（见 `pkg/scheduler/framework/preemption/preemption.go` 的注释）：最少的 PodDisruptionBudget 违反，然后是牺牲者中最高优先级最低的节点，然后是牺牲者优先级之和最小，然后是牺牲者数量最少，然后是最高优先级牺牲者中启动时间最晚的节点。
- **PDB 只作为偏好被尊重。** 如果每个候选都会违反 PDB，抢占仍然会发生。官方文档写得很清楚：这是尽力而为的支持。
- **不会发生跨节点抢占。** 如果 Pod P 只有在另一台节点上的某个 Pod 被删掉之后才能放进节点 N（典型的可用区反亲和场景），调度器不会为了 P 去驱逐那另一个 Pod。
- 对同一节点上 *更低优先级* Pod 的 Inter-Pod 亲和，会让这个节点不合格，因为牺牲者离开后亲和就会被打破。亲和对象应优先选择同等或更高优先级的 Pod。
- 牺牲者仍享有优雅终止期。在这段窗口里，抢占者 **不一定** 已经在跑。调度器会设置 `status.nominatedNodeName`，让后续周期记住这次预留，但如果另有节点空出来，它仍可能把抢占者放到别处；或者把被提名的节点让给一个更高优先级的后来者，并清掉这次提名。

在牺牲者真正退出之前，一个请求 6000 millicore 的「关键」Pod 可能已经触发了抢占，却仍然 Pending 在一个被提名的节点上。把可驱逐批处理 Pod 的 `terminationGracePeriodSeconds` 缩小，能收紧这个缺口；反过来，给低优先级 Pod 设一个很大的值，就是批处理任务拖住服务发布的办法。

## 8. 这个循环不会做的事

kube-scheduler 在绑定那一刻给 Pod **指定一次** 节点。它不会给事后漂移的集群再做一次均衡，不会扩容节点，默认也不会等到一整组 Pod 都变得可行才一起放置。

- 已经绑定、但落点不好的 Pod，是 **descheduler** 的工作，或是你自己触发的中断（滚动更新、驱逐、节点排空）。
- 因为集群真的满了而一直不可调度的 Pod，是给 **Cluster Autoscaler** 或 **Karpenter** 的信号。这些控制器观察 Pending Pod 并添加节点；它们不替代调度器，而是给它喂节点。
- 原地调整 Pod 资源、以及感知工作负载的组调度，作为较新、常常带 feature gate 的路径存在。不要假定默认 profile 会把一个作业一直拿着，直到每个副本都能放下。

如果一个 Pod 处于 Pending，有用的问题是哪个 Filter 失败了（`kubectl describe pod` 会记录条件和插件信息），而不是「是不是有节点还剩着没用完的 CPU」。

## 9. 一个可运行模型

下面的程序是决策循环的压缩模型：Filter（cordon、污点、requests、required 可用区打散），Score（LeastAllocated 或 MostAllocated、均衡分配、打散），以及驱逐更低优先级 Pod、并按牺牲者优先级和数量选节点的抢占。它不是 kube-scheduler——没有退避、没有 Bind、没有 PDB、没有百分比窗口——但这些放置结果已经足够看出取舍。

集群有六个节点，每个 8000 millicore、16384 MiB，分布在三个可用区。`z3n2` 被 cordon。`z1n2` 带有 `gpu` 的 NoSchedule 污点。负载按顺序到达：六个 `web` 副本（1000 millicore，优先级 100，跨可用区 required `maxSkew: 1`），一个 `infer` Pod（4000 millicore，优先级 80，容忍 `gpu`），八个 `batch` Pod（3000 millicore，优先级 0），然后是晚到的 `critical-1`（6000 millicore，优先级 1000）。

模型代码与英文版相同，在 CPython 3 上的输出为：

```text
Cluster: 6x 8000mCPU/16384MiB, 3 zones; z3n2 cordoned; z1n2 taint=gpu
Arrival order: web-1..6, infer-1, batch-1..8, then critical-1

== least-alloc, spread_score=True (before critical) ==
bound=15/15  pending=[]  evicted=[]
web zone counts: {'zone-1': 2, 'zone-2': 2, 'zone-3': 2}
requested CPU on schedulable nodes: 34000/40000 millicores
  z1n1 (zone-1): cpu 8000/8000  mem 10240/16384  pods=['web-1', 'web-5', 'batch-2', 'batch-5']
  z1n2 (zone-1 taint=gpu): cpu 4000/8000  mem 8192/16384  pods=['infer-1']
  z2n1 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-2', 'batch-1', 'batch-7']
  z2n2 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-4', 'batch-4', 'batch-8']
  z3n1 (zone-3): cpu 8000/8000  mem 10240/16384  pods=['web-3', 'web-6', 'batch-3', 'batch-6']
  z3n2 (zone-3 CORDONED): cpu 0/8000  mem 0/16384  pods=[]

== least-alloc, spread_score=True (after critical, preemption on) ==
bound=14/16  pending=['batch-2', 'batch-5']  evicted=['batch-2', 'batch-5']
web zone counts: {'zone-1': 2, 'zone-2': 2, 'zone-3': 2}
requested CPU on schedulable nodes: 34000/40000 millicores
  z1n1 (zone-1): cpu 8000/8000  mem 10240/16384  pods=['web-1', 'web-5', 'critical-1']
  z1n2 (zone-1 taint=gpu): cpu 4000/8000  mem 8192/16384  pods=['infer-1']
  z2n1 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-2', 'batch-1', 'batch-7']
  z2n2 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-4', 'batch-4', 'batch-8']
  z3n1 (zone-3): cpu 8000/8000  mem 10240/16384  pods=['web-3', 'web-6', 'batch-3', 'batch-6']
  z3n2 (zone-3 CORDONED): cpu 0/8000  mem 0/16384  pods=[]

== most-alloc, spread_score=False (before critical) ==
bound=13/15  pending=['batch-7', 'batch-8']  evicted=[]
web zone counts: {'zone-1': 2, 'zone-2': 2, 'zone-3': 2}
requested CPU on schedulable nodes: 28000/40000 millicores
  z1n1 (zone-1): cpu 6000/8000  mem 10240/16384  pods=['web-1', 'web-4', 'infer-1']
  z1n2 (zone-1 taint=gpu): cpu 0/8000  mem 0/16384  pods=[]
  z2n1 (zone-2): cpu 8000/8000  mem 10240/16384  pods=['web-2', 'web-5', 'batch-1', 'batch-2']
  z2n2 (zone-2): cpu 6000/8000  mem 8192/16384  pods=['batch-5', 'batch-6']
  z3n1 (zone-3): cpu 8000/8000  mem 10240/16384  pods=['web-3', 'web-6', 'batch-3', 'batch-4']
  z3n2 (zone-3 CORDONED): cpu 0/8000  mem 0/16384  pods=[]

== most-alloc, spread_score=False (after critical, preemption on) ==
bound=12/16  pending=['batch-1', 'batch-2', 'batch-7', 'batch-8']  evicted=['batch-1', 'batch-2']
web zone counts: {'zone-1': 2, 'zone-2': 2, 'zone-3': 2}
requested CPU on schedulable nodes: 28000/40000 millicores
  z1n1 (zone-1): cpu 6000/8000  mem 10240/16384  pods=['web-1', 'web-4', 'infer-1']
  z1n2 (zone-1 taint=gpu): cpu 0/8000  mem 0/16384  pods=[]
  z2n1 (zone-2): cpu 8000/8000  mem 10240/16384  pods=['web-2', 'web-5', 'critical-1']
  z2n2 (zone-2): cpu 6000/8000  mem 8192/16384  pods=['batch-5', 'batch-6']
  z3n1 (zone-3): cpu 8000/8000  mem 10240/16384  pods=['web-3', 'web-6', 'batch-3', 'batch-4']
  z3n2 (zone-3 CORDONED): cpu 0/8000  mem 0/16384  pods=[]

== least-alloc, spread_score=True (before critical) ==
bound=15/15  pending=[]  evicted=[]
web zone counts: {'zone-1': 2, 'zone-2': 2, 'zone-3': 2}
requested CPU on schedulable nodes: 34000/40000 millicores
  z1n1 (zone-1): cpu 8000/8000  mem 10240/16384  pods=['web-1', 'web-5', 'batch-2', 'batch-5']
  z1n2 (zone-1 taint=gpu): cpu 4000/8000  mem 8192/16384  pods=['infer-1']
  z2n1 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-2', 'batch-1', 'batch-7']
  z2n2 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-4', 'batch-4', 'batch-8']
  z3n1 (zone-3): cpu 8000/8000  mem 10240/16384  pods=['web-3', 'web-6', 'batch-3', 'batch-6']
  z3n2 (zone-3 CORDONED): cpu 0/8000  mem 0/16384  pods=[]

== least-alloc, spread_score=True (after critical, preemption off) ==
bound=15/16  pending=['critical-1']  evicted=[]
web zone counts: {'zone-1': 2, 'zone-2': 2, 'zone-3': 2}
requested CPU on schedulable nodes: 34000/40000 millicores
  z1n1 (zone-1): cpu 8000/8000  mem 10240/16384  pods=['web-1', 'web-5', 'batch-2', 'batch-5']
  z1n2 (zone-1 taint=gpu): cpu 4000/8000  mem 8192/16384  pods=['infer-1']
  z2n1 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-2', 'batch-1', 'batch-7']
  z2n2 (zone-2): cpu 7000/8000  mem 9216/16384  pods=['web-4', 'batch-4', 'batch-8']
  z3n1 (zone-3): cpu 8000/8000  mem 10240/16384  pods=['web-3', 'web-6', 'batch-3', 'batch-6']
  z3n2 (zone-3 CORDONED): cpu 0/8000  mem 0/16384  pods=[]
```

可以这样读这些放置结果：

1. **Required 拓扑打散是 Filter，不是愿望。** 无论哪种配置，六个 web 副本都是按可用区 2/2/2 落地的，即使关掉了打散 *打分*，因为带 `DoNotSchedule` 的 `maxSkew: 1` 是硬检查。打散 *不会* 在可用区内部再摊开：zone-1 的两个 web 副本都坐在 `z1n1` 上，因为 `z1n2` 有污点，而 web Pod 并不容忍 `gpu`。拓扑键不是节点。

2. **LeastAllocated 会用上 GPU 节点；MostAllocated 可能让它空着。** 在 LeastAllocated 下，`infer-1` 占据 `z1n2`（最空的合格节点），其余四个节点放下全部八个 batch Pod：15/15 绑定，可调度 millicore 中的 34000/40000 被请求。在 MostAllocated 下，`infer-1` 挤进已经有两个 web 副本的 `z1n1`，`z1n2` 保持空闲——batch 不能容忍这个污点——于是 `batch-7` 和 `batch-8` 继续 Pending。同一套集群、同一组 requests，少跑两个 Pod，请求量从 34000 降到 28000 millicore。当你想为缩容留出空节点时，装箱是对的；当剩余容量被污点挡在后面时，装箱就是错的。

3. **抢占驱逐的是最便宜的牺牲者，而不是 web 层。** `critical-1` 进入 LeastAllocated 集群时，没有任何节点还剩 6000 millicore。插件从 `z1n1` 驱逐 `batch-2` 和 `batch-5`（两个优先级为 0 的 Pod），把关键 Pod 绑到两个 web 副本旁边。web 的打散没有被打破。关掉抢占后，`critical-1` 保持 Pending，batch Pod 继续占着节点：单靠优先级并不会让任何人让位。

4. **被驱逐的 Pod 会回到队列，而且它们未必还能放下。** 抢占之后模型里是 16 个里绑定了 14 个；`batch-2` 和 `batch-5` 处于 Pending。在 kube-scheduler 里，它们会在退避之后重试。在这个集群里，它们仍然会 Filter 失败：唯一还剩 4000 millicore 的节点是它们不能容忍的 GPU 节点，其他节点最多只剩 1000 millicore。抢占为高优先级 Pod 腾出了位置；它并没有创造容量。

## 小结

- kube-scheduler 是一个串行决策循环，外加一条并发的绑定路径。assume-cache 和 Reserve 插件让下一次决策在 Binding 落地之前，就已经看到上一次选择。
- 队列是三种结构加一个 hint：activeQ、backoffQ、不可调度池、PreEnqueue 门闩，以及让重试跟随真正可能有帮助的事件的 QueueingHints。
- Filter 是硬的（cordon、污点、亲和性、卷、required 打散、**requests**）。Score 是 0–100 的加权和（默认 LeastAllocated，再加上均衡、镜像局部性、preferred 亲和与打散）；在大规模集群里，只有 5%–50% 窗口内的节点会被打分。
- 拓扑打散平衡的是域，不是节点；`matchLabelKeys` 则是避免滚动更新和旧 ReplicaSet 打架的关键。
- 抢占是 PostFilter：更低优先级的牺牲者、尽力而为的 PDB、没有跨节点驱逐，以及 `nominatedNodeName` 背后的优雅终止缺口。
- 调度器不会给正在运行的 Pod 再做均衡，也不会把集群变大。Descheduler 和节点自动扩缩，从这套循环停下的地方开始。

## 参考文献

- Kubernetes 文档：[Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
- Kubernetes 文档：[Scheduler Configuration](https://kubernetes.io/docs/reference/scheduling/config/)
- Kubernetes 文档：[Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- Kubernetes 文档：[Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- Kubernetes 文档：[Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- Kubernetes 博客：[QueueingHint](https://kubernetes.io/blog/2024/12/12/scheduler-queueinghint/)（自 v1.34 起稳定）
- [KEP-624: Scheduling Framework](https://github.com/kubernetes/enhancements/blob/master/keps/sig-scheduling/624-scheduling-framework/README.md)
- kube-scheduler 源码：`pkg/scheduler/backend/queue/scheduling_queue.go`（`DefaultPodMaxInUnschedulablePodsDuration`、刷新循环）、`pkg/scheduler/apis/config/v1/default_plugins.go`（默认插件与打分权重）、`pkg/scheduler/apis/config/types.go`（`PercentageOfNodesToScore`）、`pkg/scheduler/schedule_one.go`（`minFeasibleNodesToFind`、`minFeasibleNodesPercentageToFind`）、`pkg/scheduler/framework/preemption/preemption.go`（`pickOneNodeForPreemption`）
- [scheduler queue notes](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md)
- [kubernetes-sigs/scheduler-plugins](https://github.com/kubernetes-sigs/scheduler-plugins)
