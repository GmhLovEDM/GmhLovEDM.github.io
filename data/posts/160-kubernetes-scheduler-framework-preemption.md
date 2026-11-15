---
title: "Inside the Kubernetes Scheduler: Filtering, Scoring, Preemption and Topology Spread"
tag: devops
description: How kube-scheduler places a Pod — the serial scheduling cycle versus the concurrent binding cycle, the active/backoff/unschedulable queues and QueueingHints, the plugin framework from PreFilter through Bind, why resource Fit uses requests not limits, default score weights and the 5%–50% node-scoring window, topology spread and taints, how DefaultPreemption picks victims, what the scheduler will not move, and a runnable model that compares LeastAllocated against packing and shows preemption
date: "2026-11-15T13:30:00.000Z"
---

## Goal

A Pod that has no `spec.nodeName` is not running anywhere. The only component standing between "created" and "bound" is kube-scheduler: a decision loop that reads the cluster cache, picks a node, and writes that choice back to the API server. Almost every production surprise around Pending Pods — CPU that looked free, a zone that went lopsided, a high-priority workload that still sat in the queue, a batch job that disappeared when a service Pod arrived — is a surprise about this loop.

This article covers:

1. The two halves of a scheduling context: a serial **scheduling cycle** and a concurrent **binding cycle**.
2. The scheduling queue: activeQ, backoffQ, the unschedulable pool, PreEnqueue gates and QueueingHints.
3. The **scheduling framework** and its extension points, from PreFilter through Bind.
4. Filtering: taints, affinity, volumes, topology spread, and why Fit uses **requests, not limits**.
5. Scoring: plugin weights, LeastAllocated versus MostAllocated, and why the scheduler does not score every node.
6. Reserve, Permit and the assume-cache, which stop two Pods from claiming the same resources.
7. **Topology spread constraints** and how they interact with taints and cordons.
8. **Preemption**: victim selection, `nominatedNodeName`, PodDisruptionBudget as best-effort, and the gaps the algorithm will not cross.
9. What the scheduler will not do — and which other components fill those gaps.
10. A runnable model that places a mixed workload and then admits a critical Pod.

## 1. Two cycles: pick a node, then tell the cluster

The scheduling framework has been stable since Kubernetes v1.19. Every attempt to place one Pod is a *scheduling context* with two phases ([Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)):

- The **scheduling cycle** is the decision. It is **run serially**: the scheduler never scores two Pods at once against the same snapshot. That is how it avoids double-booking a node's last 500 millicores.
- The **binding cycle** is the write. It creates a Binding (or sets `spec.nodeName`) and may run **concurrently** with the next scheduling cycle, because a remote API call should not stall the decision loop.

If either cycle decides the Pod is unschedulable, or hits an internal error, the Pod goes back to the queue and will be retried. Between "I picked node N" and "the Binding has been persisted", the scheduler **assumes** the assignment in its cache and runs Reserve plugins so the next scheduling cycle already sees those resources as used. If the bind later fails, Unreserve runs in reverse order and the assumption is dropped.

This split is the performance story of kube-scheduler: decisions are cheap and strictly ordered; binds are slower and pipelined.

## 2. The queue in front of the cycle

Unscheduled Pods do not sit in a single FIFO. The scheduler keeps three structures ([scheduler queue notes](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md), [QueueingHint blog](https://kubernetes.io/blog/2024/12/12/scheduler-queueinghint/)):

- **activeQ** — Pods that are ready to be popped for a scheduling cycle. The pop order comes from the QueueSort plugin. The default, `PrioritySort`, orders by Priority (higher first) and then by timestamp.
- **backoffQ** — Pods that should be retried, but not immediately. The default initial backoff is one second and the cap is ten seconds; the delay grows with consecutive failed attempts so a Pod that cannot place does not burn a cycle every time the loop is free.
- **unschedulable pool** — Pods the scheduler has already failed to place, and for which no relevant cluster event has happened yet; also Pods that PreEnqueue plugins have refused to admit (for example a Pod still blocked by a scheduling gate).

Two background flushers exist as a backstop: completed backoffs are moved to activeQ as their backoff expires, and a 30-second loop retries Pods that have sat in the unschedulable pool longer than `podMaxInUnschedulablePodsDuration` (default five minutes) even if no event fired.

The interesting part is how a Pod leaves the unschedulable pool early. Plugins that reject a Pod can implement **EnqueueExtension** / **QueueingHint**: a callback that, on a given cluster event, answers whether that event *might* make this Pod schedulable. QueueingHint became stable in Kubernetes v1.34 and is enabled by default. A Node-affinity failure should not retry just because some unrelated Pod was deleted; a resource-fit failure should retry when a Pod on a matching node disappears. Without hints, the scheduler had to be conservative and often moved every unschedulable Pod back, which is expensive in a large cluster.

**PreEnqueue** runs before a Pod is allowed into activeQ. The in-tree `SchedulingGates` plugin is the usual reason a Pod is held here: as long as `spec.schedulingGates` is non-empty, the Pod is not "unschedulable" in the sense of a failed Filter — it has not been allowed to try.

## 3. The plugin framework

Almost every scheduling feature is a plugin compiled into kube-scheduler and registered at one or more extension points. A `KubeSchedulerConfiguration` profile can disable a default plugin, add an out-of-tree one, or change a score weight. The points, in order, are:

| Point | When it runs | What it can do |
| --- | --- | --- |
| QueueSort | Ordering activeQ | Exactly one plugin; default is PrioritySort |
| PreEnqueue | Before activeQ | Block a Pod from being considered |
| PreFilter | Once per cycle | Precompute, or abort the cycle |
| Filter | Per node (concurrently) | Reject a node; later filters are skipped for that node |
| PostFilter | Only if **no** node passed Filter | Typically preemption; stops early if one plugin marks the Pod schedulable |
| PreScore | Once, on the feasible set | Shared state for scoring |
| Score + NormalizeScore | Per feasible node, then once per plugin | 0–100 per plugin, then a weighted sum |
| Reserve / Unreserve | After a node is picked | Optimistic bookkeeping; Unreserve is the rollback and must be idempotent |
| Permit | End of the scheduling cycle | Approve, deny, or **wait** (with a timeout) before binding |
| PreBind, Bind, PostBind | Binding cycle | Volume work, the actual bind, bookkeeping |

The default MultiPoint set in current kube-scheduler (`pkg/scheduler/apis/config/v1/default_plugins.go`) includes `SchedulingGates`, `PrioritySort`, `NodeName`, `NodeUnschedulable`, `TaintToleration` (score weight 3), `NodeAffinity` (2), `NodePorts`, `NodeResourcesFit` (1), volume plugins, `PodTopologySpread` (2), `InterPodAffinity` (2), `DynamicResources` (2), `DefaultPreemption`, `NodeResourcesBalancedAllocation` (1), `ImageLocality` (1) and `DefaultBinder`. Those weights are why a preferred toleration or a soft affinity can outvote a small difference in remaining CPU.

**Permit** is the hook that makes "wait for the rest of the group" possible. A plugin may approve immediately, deny (the Pod returns to the queue and Unreserve runs), or return wait: the Pod is held in an internal waiting list and the binding cycle blocks until approval or timeout. In-tree kube-scheduler still places **one Pod at a time**; all-or-nothing job placement lives in extensions such as the [scheduler-plugins Coscheduling](https://github.com/kubernetes-sigs/scheduler-plugins) Permit plugin, Volcano, or newer workload-aware features that have to be turned on explicitly.

## 4. Filter: hard constraints, and requests not limits

Filter plugins are the old "predicates". For each node, they run in configured order and the first rejection wins. The important in-tree checks:

- `NodeUnschedulable` — honours `spec.unschedulable` (a cordon).
- `NodeName` — `spec.nodeName` already set (rare at this stage).
- `TaintToleration` — a `NoSchedule` / `NoExecute` taint without a matching toleration rejects the node. A node you tainted for GPU workloads is invisible to every Pod that forgot the toleration, including batch jobs that would have been happy with the leftover CPU.
- `NodeAffinity` / `nodeSelector` — required affinity is a filter; preferred affinity is a score.
- `NodePorts` — `hostPort` conflicts.
- `NodeResourcesFit` — the node has enough **remaining allocatable** for the Pod's **resource requests**.
- Volume plugins — zone constraints, CSI attach limits, `WaitForFirstConsumer` binding.
- `PodTopologySpread` — required (`whenUnsatisfiable: DoNotSchedule`) constraints.
- `InterPodAffinity` — required affinity / anti-affinity.

The resource check is the one that bites people. The scheduler accounts **requests**, never limits. A node with 8 CPU allocatable and four Pods each requesting 1 CPU and limiting 4 CPU still looks half empty. Whether those four Pods can actually run together is a kubelet / cgroup question, and a frequent source of CPU throttling later, long after the Binding succeeded. If you want the scheduler to refuse overcommit, set requests to the resources the process actually needs, not to a token 10 millicores.

The same function is why "the node has free CPU in `kubectl top`" does not mean a Pending Pod will land there: `top` is usage, Fit is requests, and unschedulable / taints / ports / volumes / spread can reject a node that still has unused requests.

## 5. Score: weights, packing versus spreading, and not visiting every node

Feasible nodes are ranked. Each Score plugin returns a value that is normalized into `0..100`, then multiplied by its weight. The node with the highest sum wins.

`NodeResourcesFit` can score in three ways, configured on the plugin args:

- **LeastAllocated** (the default) — prefer nodes with more unused requested capacity. This spreads load.
- **MostAllocated** — prefer nodes that would be more full. This packs, which is what you want if you would like Cluster Autoscaler or Karpenter to remove empty nodes.
- **RequestedToCapacityRatio** — a custom shape of utilization to score.

`NodeResourcesBalancedAllocation` prefers a node where CPU and memory utilization would stay close, so you do not fill a node's memory and leave its CPU stranded (or the other way around). `ImageLocality` prefers a node that already has the image layers. Preferred affinity, preferred taints and preferred topology spread all contribute with the weights listed above.

Scoring every node in a 10,000-node cluster would be wasteful. `percentageOfNodesToScore` in `KubeSchedulerConfiguration` controls the search. The default is `0`, meaning *adaptive*: the scheduler uses a percentage between 5% and 50% depending on cluster size ([Scheduler Configuration](https://kubernetes.io/docs/reference/scheduling/config/), and the comment on `PercentageOfNodesToScore` in `pkg/scheduler/apis/config/types.go`). Independently, current kube-scheduler always aims for at least `minFeasibleNodesToFind = 100` feasible nodes and never goes below `minFeasibleNodesPercentageToFind = 5` (`pkg/scheduler/schedule_one.go`). Once enough feasible nodes are in hand, the rest of the cluster is not scored. That is good for throughput; it is also why a slightly better node on the other side of the cluster is sometimes never considered.

## 6. Topology spread

[`topologySpreadConstraints`](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/) are how you ask the scheduler to keep matching Pods even across failure domains:

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

After placing the Pod, the number of matching Pods in any one domain minus the number in the smallest domain must be no greater than `maxSkew`. `DoNotSchedule` makes that a Filter; `ScheduleAnyway` makes it a Score. The constraint is about the *topology key*, not about packing inside a domain: two replicas in the same zone can still land on the same node if that zone has only one eligible node.

`minDomains` treats missing domains as empty (count 0), which is how you stop a Deployment from all landing in the first two zones while a third zone is still coming up. `nodeAffinityPolicy` and `nodeTaintsPolicy` decide whether nodes the Pod would not have been eligible for still count as domains. `matchLabelKeys` (commonly `pod-template-hash`) is the rolling-update escape hatch: without it, old and new ReplicaSets share a selector, and a `maxSkew` of 1 can block the new ReplicaSet because the old one already occupies every domain.

The scheduler can also be configured with `defaultConstraints` so Pods that omit the field still get a soft spread. That is not on by default in the plugin args; if you want it, you set it.

## 7. Preemption

When Filter finds zero feasible nodes, PostFilter runs. The in-tree `DefaultPreemption` plugin then asks: is there a node where evicting one or more **lower-priority** Pods would make this Pod feasible? ([Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/))

A few rules that are easy to get wrong:

- Priority is necessary but not sufficient. A PriorityClass with `preemptionPolicy: Never` will not evict anyone. A Pod that is still gated is not even in the cycle.
- The candidate set is "nodes that would work if every lower-priority Pod on *that* node disappeared". The plugin then evicts only as many as needed, lowest priority first.
- Among those candidates, `pickOneNodeForPreemption` uses a fixed lexicographic order (from the comments in `pkg/scheduler/framework/preemption/preemption.go`): fewest PodDisruptionBudget violations, then the lowest *highest* victim priority, then the smallest sum of victim priorities, then the fewest victims, then the most recent start time among the highest-priority victims.
- **PDB is honoured only as a preference.** If every candidate would violate a PDB, preemption still happens. The official documentation is explicit: support is best-effort.
- **Cross-node preemption does not happen.** If Pod P can only fit on node N after a Pod on a *different* node is removed (a classic zone anti-affinity case), the scheduler will not evict that other Pod for P.
- Inter-Pod affinity to a *lower-priority* Pod on the same node can make the node ineligible, because the affinity would break once the victim is gone. Prefer affinity toward equal- or higher-priority Pods.
- Victims get their graceful termination period. During that window the preemptor is **not** necessarily running yet. The scheduler sets `status.nominatedNodeName` so subsequent cycles remember the reservation, but it may still place the preemptor on a different node if one becomes free, or give the nominated node to an even higher-priority arrival and clear the nomination.

Until victims actually exit, a 6000-millicore "critical" Pod may sit Pending with a nominated node even though preemption already fired. Shrinking `terminationGracePeriodSeconds` on evictable batch Pods closes that gap; setting it to a large value on a low-priority Pod is how a batch job stalls a service rollout.

## 8. What this loop will not do

kube-scheduler assigns a node **once**, at bind time. It does not rebalance a cluster that drifted after the fact, it does not provision nodes, and by default it does not wait for a whole group of Pods to become feasible together.

- Already-bound Pods that landed poorly are the job of a **descheduler**, or of disruption you trigger yourself (a rolling update, an eviction, a node drain).
- Pods that remain unschedulable because the cluster is actually full are the signal for **Cluster Autoscaler** or **Karpenter**. Those controllers watch Pending Pods and add nodes; they do not replace the scheduler, they feed it.
- In-place Pod resize and workload-aware group scheduling exist as newer, often feature-gated paths. Do not assume the default profile will hold a job until every replica fits.

If a Pod is Pending, the useful question is which Filter failed (`kubectl describe pod` records the condition and the plugin message), not "does some node have unused CPU".

## 9. A runnable model

The program below is a compact model of the decision loop: Filter (cordon, taints, requests, required zone spread), Score (LeastAllocated or MostAllocated, balanced allocation, spread), and preemption that evicts lower-priority Pods and picks a node by victim priority and count. It is not kube-scheduler — there is no backoff, no Bind, no PDB, no percentage window — but the placements are enough to see the trade-offs.

The cluster has six nodes of 8000 millicores and 16384 MiB in three zones. `z3n2` is cordoned. `z1n2` has a `gpu` NoSchedule taint. The workload arrives in order: six `web` replicas (1000 millicores, priority 100, required `maxSkew: 1` across zones), one `infer` Pod (4000 millicores, priority 80, tolerates `gpu`), eight `batch` Pods (3000 millicores, priority 0), and then a late `critical-1` Pod (6000 millicores, priority 1000).

```python
#!/usr/bin/env python3
"""Compact model of kube-scheduler: filter, score, topology spread and preemption."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

MAX_SCORE = 100

# In-tree MultiPoint score weights (kube-scheduler default_plugins.go)
W_FIT = 1
W_BALANCED = 1
W_SPREAD = 2


@dataclass
class Node:
    name: str
    zone: str
    cpu: int
    mem: int
    unschedulable: bool = False
    taint: Optional[str] = None
    pods: list = field(default_factory=list)

    def used_cpu(self) -> int:
        return sum(p.cpu for p in self.pods)

    def used_mem(self) -> int:
        return sum(p.mem for p in self.pods)

    def free_cpu(self) -> int:
        return self.cpu - self.used_cpu()

    def free_mem(self) -> int:
        return self.mem - self.used_mem()


@dataclass
class Pod:
    name: str
    cpu: int
    mem: int
    priority: int = 0
    app: str = ""
    toleration: Optional[str] = None
    max_skew: Optional[int] = None
    allow_preempt: bool = True
    node: Optional[str] = None
    preempted: bool = False


FitMode = Literal["least", "most"]


def resource_ok(node: Node, pod: Pod) -> bool:
    return node.free_cpu() >= pod.cpu and node.free_mem() >= pod.mem


def taint_ok(node: Node, pod: Pod) -> bool:
    return node.taint is None or pod.toleration == node.taint


def counts_by_zone(nodes: list[Node], app: str) -> dict[str, int]:
    c: dict[str, int] = {}
    for n in nodes:
        c.setdefault(n.zone, 0)
        c[n.zone] += sum(1 for p in n.pods if p.app == app)
    return c


def spread_ok(nodes: list[Node], node: Node, pod: Pod) -> bool:
    if pod.max_skew is None or not pod.app:
        return True
    counts = counts_by_zone(nodes, pod.app)
    projected = dict(counts)
    projected[node.zone] = projected.get(node.zone, 0) + 1
    return max(projected.values()) - min(projected.values()) <= pod.max_skew


def feasible(nodes: list[Node], node: Node, pod: Pod) -> bool:
    if node.unschedulable:
        return False
    return taint_ok(node, pod) and resource_ok(node, pod) and spread_ok(nodes, node, pod)


def least_allocated_score(node: Node, pod: Pod) -> int:
    cpu = (node.free_cpu() - pod.cpu) / node.cpu
    mem = (node.free_mem() - pod.mem) / node.mem
    return int(((cpu + mem) / 2) * MAX_SCORE)


def most_allocated_score(node: Node, pod: Pod) -> int:
    cpu = (node.used_cpu() + pod.cpu) / node.cpu
    mem = (node.used_mem() + pod.mem) / node.mem
    return int(((cpu + mem) / 2) * MAX_SCORE)


def balanced_score(node: Node, pod: Pod) -> int:
    u_cpu = (node.used_cpu() + pod.cpu) / node.cpu
    u_mem = (node.used_mem() + pod.mem) / node.mem
    return int((1.0 - abs(u_cpu - u_mem)) * MAX_SCORE)


def spread_score(nodes: list[Node], node: Node, pod: Pod) -> int:
    if not pod.app:
        return 0
    counts = counts_by_zone(nodes, pod.app)
    projected = counts.get(node.zone, 0) + 1
    smallest = min(counts.values()) if counts else 0
    skew = projected - smallest
    return int(max(0, MAX_SCORE * (5 - skew) / 5))


def total_score(nodes: list[Node], node: Node, pod: Pod, mode: FitMode, use_spread_score: bool) -> int:
    fit = least_allocated_score(node, pod) if mode == "least" else most_allocated_score(node, pod)
    parts = [(fit, W_FIT), (balanced_score(node, pod), W_BALANCED)]
    if use_spread_score and pod.app:
        parts.append((spread_score(nodes, node, pod), W_SPREAD))
    num = sum(s * w for s, w in parts)
    den = sum(w for _, w in parts)
    return num // den


def bind(node: Node, pod: Pod) -> None:
    pod.node = node.name
    pod.preempted = False
    node.pods.append(pod)


def select_victims(node: Node, pod: Pod) -> Optional[list[Pod]]:
    if not pod.allow_preempt:
        return None
    candidates = sorted(
        [p for p in node.pods if p.priority < pod.priority],
        key=lambda p: (p.priority, p.name),
    )
    evicted: list[Pod] = []
    free_cpu, free_mem = node.free_cpu(), node.free_mem()
    if free_cpu >= pod.cpu and free_mem >= pod.mem:
        return []
    for v in candidates:
        evicted.append(v)
        free_cpu += v.cpu
        free_mem += v.mem
        if free_cpu >= pod.cpu and free_mem >= pod.mem:
            return evicted
    return None


def pick_preemption(nodes: list[Node], pod: Pod) -> Optional[tuple[Node, list[Pod]]]:
    options: list[tuple[tuple, Node, list[Pod]]] = []
    for n in nodes:
        if n.unschedulable or not taint_ok(n, pod):
            continue
        victims = select_victims(n, pod)
        if victims is None or not victims:
            continue
        for v in victims:
            n.pods.remove(v)
        ok_spread = spread_ok(nodes, n, pod)
        ok_res = resource_ok(n, pod)
        for v in victims:
            n.pods.append(v)
        if not ok_spread or not ok_res:
            continue
        highest = max(v.priority for v in victims)
        total_p = sum(v.priority for v in victims)
        key = (highest, total_p, len(victims), n.name)
        options.append((key, n, victims))
    if not options:
        return None
    options.sort(key=lambda x: x[0])
    _, node, victims = options[0]
    return node, victims


def schedule_arrivals(pods: list[Pod], nodes: list[Node], mode: FitMode, use_spread_score: bool) -> list[str]:
    evicted_names: list[str] = []
    for pod in pods:
        if pod.node is not None:
            continue
        fits = [n for n in nodes if feasible(nodes, n, pod)]
        if fits:
            fits.sort(key=lambda n: (-total_score(nodes, n, pod, mode, use_spread_score), n.name))
            bind(fits[0], pod)
            continue
        picked = pick_preemption(nodes, pod)
        if picked is None:
            continue
        node, victims = picked
        for v in victims:
            v.preempted = True
            v.node = None
            node.pods.remove(v)
            evicted_names.append(v.name)
        bind(node, pod)
    return evicted_names


def make_cluster() -> list[Node]:
    nodes: list[Node] = []
    for z in (1, 2, 3):
        for i in (1, 2):
            nodes.append(Node(f"z{z}n{i}", f"zone-{z}", cpu=8000, mem=16384))
    nodes[-1].unschedulable = True
    next(n for n in nodes if n.name == "z1n2").taint = "gpu"
    return nodes


def make_base_workload() -> list[Pod]:
    pods: list[Pod] = []
    for i in range(1, 7):
        pods.append(Pod(f"web-{i}", cpu=1000, mem=1024, priority=100, app="web", max_skew=1))
    pods.append(Pod("infer-1", cpu=4000, mem=8192, priority=80, app="infer", toleration="gpu"))
    for i in range(1, 9):
        pods.append(Pod(f"batch-{i}", cpu=3000, mem=4096, priority=0, app="batch"))
    return pods


def report(label: str, nodes: list[Node], pods: list[Pod], evicted: list[str]) -> None:
    pending = [p.name for p in pods if p.node is None]
    bound = [p.name for p in pods if p.node]
    print(f"== {label} ==")
    print(
        "bound={}/{}  pending={}  evicted={}".format(
            len(bound),
            len(pods),
            pending if pending else "[]",
            evicted if evicted else "[]",
        )
    )
    print("web zone counts:", dict(sorted(counts_by_zone(nodes, "web").items())))
    used = sum(n.used_cpu() for n in nodes)
    cap = sum(n.cpu for n in nodes if not n.unschedulable)
    print(f"requested CPU on schedulable nodes: {used}/{cap} millicores")
    for n in nodes:
        names = [p.name for p in n.pods]
        flag = " CORDONED" if n.unschedulable else (f" taint={n.taint}" if n.taint else "")
        print(
            f"  {n.name} ({n.zone}{flag}): "
            f"cpu {n.used_cpu()}/{n.cpu}  mem {n.used_mem()}/{n.mem}  pods={names}"
        )
    print()


def run(mode: FitMode, use_spread_score: bool, admit_critical: bool, allow_preempt: bool) -> None:
    nodes = make_cluster()
    pods = make_base_workload()
    evicted = schedule_arrivals(pods, nodes, mode, use_spread_score)
    label = f"{mode}-alloc, spread_score={use_spread_score}"
    report(label + " (before critical)", nodes, pods, evicted)
    if admit_critical:
        crit = Pod(
            "critical-1",
            cpu=6000,
            mem=8192,
            priority=1000,
            app="critical",
            allow_preempt=allow_preempt,
        )
        pods.append(crit)
        evicted2 = schedule_arrivals([crit], nodes, mode, use_spread_score)
        evicted = evicted + evicted2
        tag = "preemption on" if allow_preempt else "preemption off"
        report(label + f" (after critical, {tag})", nodes, pods, evicted)


if __name__ == "__main__":
    print("Cluster: 6x 8000mCPU/16384MiB, 3 zones; z3n2 cordoned; z1n2 taint=gpu")
    print("Arrival order: web-1..6, infer-1, batch-1..8, then critical-1")
    print()
    run("least", True, admit_critical=True, allow_preempt=True)
    run("most", False, admit_critical=True, allow_preempt=True)
    run("least", True, admit_critical=True, allow_preempt=False)
```

Output on CPython 3:

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

Reading those placements:

1. **Required topology spread works as a Filter, not a wish.** In every configuration the six web replicas land 2/2/2 across zones, even when spread *scoring* is turned off, because `maxSkew: 1` with `DoNotSchedule` is a hard check. What spread does *not* do is spread inside a zone: both of zone-1's web replicas sit on `z1n1`, because `z1n2` is tainted and the web Pods do not tolerate `gpu`. Topology keys are not nodes.

2. **LeastAllocated uses the GPU node; MostAllocated can leave it empty.** Under LeastAllocated, `infer-1` takes `z1n2` (the most empty eligible node) and all eight batch Pods fit on the remaining four: 15/15 bound, 34000 of 40000 schedulable millicores requested. Under MostAllocated, `infer-1` packs onto `z1n1` beside two web replicas, `z1n2` stays empty — batch cannot tolerate the taint — and `batch-7` and `batch-8` stay Pending. Same cluster, same requests, two fewer running Pods, 28000 millicores requested instead of 34000. Packing is the right call when you want empty nodes for scale-down; it is the wrong call when leftover capacity sits behind a taint.

3. **Preemption evicts the cheapest victims, not the web tier.** When `critical-1` arrives into the LeastAllocated cluster, no node has 6000 millicores free. The plugin evicts `batch-2` and `batch-5` from `z1n1` (two priority-0 Pods) and binds the critical Pod next to the two web replicas. The web spread is untouched. With preemption disabled, `critical-1` stays Pending and the batch Pods keep their nodes: priority alone does not move anyone.

4. **Evicted Pods go back to the queue, and they may still not fit.** After preemption the model has 14 of 16 bound; `batch-2` and `batch-5` are Pending. In kube-scheduler they would be retried after backoff. In this cluster they would still fail Filter: the only node with 4000 millicores left is the GPU node they cannot tolerate, and every other node has at most 1000 millicores free. Preemption made room for the high-priority Pod; it did not create capacity.

## Summary

- kube-scheduler is a serial decision loop plus a concurrent bind path. The assume-cache and Reserve plugins make the next decision see the last one before the Binding has landed.
- The queue is three structures and a hint: activeQ, backoffQ, the unschedulable pool, PreEnqueue gates, and QueueingHints so retries follow events that could actually help.
- Filter is hard (cordon, taints, affinity, volumes, required spread, **requests**). Score is a weighted 0–100 sum (LeastAllocated by default, plus balance, image locality, preferred affinity and spread) and, in large clusters, only a 5%–50% window of nodes is scored.
- Topology spread balances domains, not nodes, and `matchLabelKeys` is what keeps a rolling update from fighting the old ReplicaSet.
- Preemption is a PostFilter: lower-priority victims, PDB as best-effort, no cross-node evictions, and a graceful-termination gap behind `nominatedNodeName`.
- The scheduler will not rebalance running Pods or grow the cluster. Deschedulers and node autoscalers start where this loop stops.

## References

- Kubernetes docs: [Scheduling Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
- Kubernetes docs: [Scheduler Configuration](https://kubernetes.io/docs/reference/scheduling/config/)
- Kubernetes docs: [Pod Priority and Preemption](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- Kubernetes docs: [Pod Topology Spread Constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- Kubernetes docs: [Assigning Pods to Nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- Kubernetes blog: [QueueingHint](https://kubernetes.io/blog/2024/12/12/scheduler-queueinghint/) (stable since v1.34)
- [KEP-624: Scheduling Framework](https://github.com/kubernetes/enhancements/blob/master/keps/sig-scheduling/624-scheduling-framework/README.md)
- kube-scheduler source: `pkg/scheduler/backend/queue/scheduling_queue.go` (`DefaultPodMaxInUnschedulablePodsDuration`, flush loop), `pkg/scheduler/apis/config/v1/default_plugins.go` (default plugins and score weights), `pkg/scheduler/apis/config/types.go` (`PercentageOfNodesToScore`), `pkg/scheduler/schedule_one.go` (`minFeasibleNodesToFind`, `minFeasibleNodesPercentageToFind`), `pkg/scheduler/framework/preemption/preemption.go` (`pickOneNodeForPreemption`)
- [scheduler queue notes](https://github.com/kubernetes/community/blob/master/contributors/devel/sig-scheduling/scheduler_queues.md)
- [kubernetes-sigs/scheduler-plugins](https://github.com/kubernetes-sigs/scheduler-plugins)

