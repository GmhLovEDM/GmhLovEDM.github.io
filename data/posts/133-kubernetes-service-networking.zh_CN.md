---
title: "Kubernetes Service 流量到底怎么走：kube-proxy（iptables、IPVS、nftables）与 eBPF"
tag: devops
description: 从 `curl my-svc` 到后端 Pod 之间究竟发生了什么——EndpointSlice、kube-proxy 的 iptables/IPVS/nftables 三种数据面、Cilium 基于 eBPF 的 socket 级负载均衡、流量策略、DNS，以及由此衍生的生产问题（优雅下线、conntrack、长连接）
date: "2026-10-19T14:20:00.000Z"
---

## 目标

Kubernetes 的 `Service` 在 YAML 里看起来再简单不过：一个名字、一个 selector、一个端口。但每个经过它的请求，背后都穿过了一整套出人意料的深层机制——一个 API 对象、一个控制器、每个节点上的一个代理进程，以及一个会改写数据包的内核数据面。发布时延迟飙升、客户端源 IP 丢失、某个 Pod 独吞全部 gRPC 流量，原因几乎都藏在这套机制的某一层里。

本文完整梳理这条链路：Service 如何变成 endpoint；kube-proxy 在 Linux 上的三种模式（iptables、IPVS、nftables）如何对内核编程；Cilium 等基于 eBPF 的数据面如何彻底替代 kube-proxy；以及真实集群里最要紧的流量策略和故障模式。

## 背景：为什么需要一个虚拟 IP？

Pod 是可替换的。一次 Deployment 滚动发布会替换掉所有 Pod，每个新 Pod 都拿到新 IP。客户端需要稳定地址，所以 Kubernetes 给每个 Service 分配一个 **ClusterIP**——一个虚拟 IP，（在多数模式下）不绑定在任何网卡上，也不属于任何一台机器。

为什么不直接把所有 Pod IP 发布成多条 DNS A 记录，让客户端自己轮询？官方文档给了三个理由：

- 很多 DNS 实现历史上不遵守记录的 TTL，过期后仍继续使用缓存结果；
- 有些应用只解析一次域名，然后永久缓存；
- 即便客户端都很规矩，极低的 TTL 也会给 DNS 带来巨大压力。

于是 Kubernetes 选择了**在虚拟 IP 上做代理**：地址固定不变，由每个节点上的组件在每条新连接建立时把它翻译成一个存活的后端。

## 控制面：从 Service 到 EndpointSlice

```yaml
apiVersion: v1
kind: Service
metadata:
  name: orders
  namespace: shop
spec:
  selector:
    app: orders
  ports:
    - name: http
      port: 80          # ClusterIP 上的端口
      targetPort: 8080  # 容器端口
```

三个组件协同工作：

1. **API Server** 从 Service 网段（例如 `10.96.0.0/12`）中分配一个 ClusterIP。
2. **EndpointSlice 控制器**（位于 kube-controller-manager）监听匹配 selector 的 Pod，写出 `EndpointSlice` 对象，记录它们的 IP、端口和状态条件（`ready`、`serving`、`terminating`）。每个 Slice 默认最多容纳 100 个 endpoint，所以拥有上千个 Pod 的 Service 会被拆成许多小对象，而不是像旧的 `Endpoints` 那样一个巨大对象、任何变化都要整体重写。
3. **kube-proxy**（或替代它的组件）运行在每个节点上，监听 Service 和 EndpointSlice，并对本机内核进行配置。

```bash
kubectl -n shop get endpointslices -l kubernetes.io/service-name=orders -o wide
```

关键结论：**路由决策发生在客户端所在的节点上**，依据的是该节点本地的那份 endpoint 列表。没有中心化的负载均衡器，每个节点都独立、异步地收敛到新的 endpoint 集合。记住这一点，后文的大部分坑都由此而来。

## 一条连接的完整路径

假设节点 1 上的 Pod A 调用 `http://orders.shop/`，ClusterIP 为 `10.96.12.34`。

1. DNS（CoreDNS）返回 `10.96.12.34`。
2. Pod A 向 `10.96.12.34:80` 发出 SYN。数据包通过 veth pair 离开 Pod 的网络命名空间，进入宿主机命名空间。
3. 在宿主机上，数据面拦截该包（kube-proxy 用 netfilter 钩子，eBPF 数据面用 BPF 钩子），选出一个后端，比如 `192.168.3.17:8080`，并改写目的地址（DNAT）。
4. CNI 插件的路由把包送到后端 Pod，可能在另一个节点上。
5. **conntrack** 记住这次地址转换，同一连接的后续数据包不再走选择逻辑；回包在到达 Pod A 之前，源地址会被改写回 `10.96.12.34:80`。

因此负载均衡**按连接进行，且只在 L4 层发生一次**。HTTP 请求、keep-alive、多路复用这些都在更上层，对 Service 完全不可见。

## iptables 模式的 kube-proxy

iptables 模式至今仍是 Linux 上的默认模式。kube-proxy 把规则写进 `nat` 表，挂在 `PREROUTING`（进入节点的流量）和 `OUTPUT`（宿主机进程发出的流量）钩子上。一个有三个 endpoint 的 Service，简化后的规则大致如下：

```text
-A KUBE-SERVICES -d 10.96.12.34/32 -p tcp --dport 80 -j KUBE-SVC-ORDERS
-A KUBE-SVC-ORDERS -m statistic --mode random --probability 0.33333333349 -j KUBE-SEP-A
-A KUBE-SVC-ORDERS -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-B
-A KUBE-SVC-ORDERS -j KUBE-SEP-C
-A KUBE-SEP-A -p tcp -j DNAT --to-destination 192.168.1.10:8080
-A KUBE-SEP-B -p tcp -j DNAT --to-destination 192.168.2.11:8080
-A KUBE-SEP-C -p tcp -j DNAT --to-destination 192.168.3.17:8080
```

（真实的链名是 `KUBE-SVC-XGLOHA7QRQ3V22RZ` 这样的哈希串，这里为便于阅读做了简化。）

这些概率组合起来是均匀选择：第一条规则拿走 1/3；剩下的 2/3 中第二条拿走一半，也就是 1/3；最后一条兜底剩下的部分。可以在节点上查看真实规则：

```bash
sudo iptables-save -t nat | grep -A4 'KUBE-SVC'
```

**规模变大后的痛点：**

- **线性匹配。** `KUBE-SERVICES` 中大致每个 Service 端口一条规则，netfilter 按顺序逐条匹配。每条新连接的首包都要走一遍这个列表。Service 达到数万个时，这会带来可观测的延迟——这正是 nftables 模式提案中提到的"数据面延迟"问题。
- **更新代价高。** iptables 没有细粒度 API，kube-proxy 需要构造规则集并通过 `iptables-restore` 加载。旧版本每次同步都会重写所有 Service 的规则；从 Kubernetes v1.28 起，iptables 模式只重写真正发生变化的 Service 和 EndpointSlice 对应的规则，改善很大，但底层 API 依然粗糙。
- **部分路径会做 SNAT。** 来自集群网络之外的流量、被转发到其他节点的 NodePort 流量，以及"回环"（hairpin）流量（Pod 访问自己所属的 Service 又落回自身），会经由 `KUBE-MARK-MASQ` / `KUBE-POSTROUTING` 链做地址伪装，确保回包经过同一节点返回。这就是后端有时看到的是节点 IP 而不是真实客户端 IP 的原因。

## IPVS 模式的 kube-proxy

IPVS（IP Virtual Server）是 Linux 内核中历史悠久的 L4 负载均衡器。在这种模式下，kube-proxy 会：

- 创建一个 dummy 网卡 `kube-ipvs0`，把所有 ClusterIP 绑定上去，使内核接收发往这些 IP 的数据包；
- 为每个 Service 的 IP 和端口创建一个 IPVS 虚拟服务，以 Pod IP 作为真实服务器，存放在内核**哈希表**中——查找开销不再随 Service 数量增长；
- 仍然借助 iptables 加 `ipset` 完成地址伪装和过滤；
- 支持真正的调度算法：`rr`（轮询）、`lc`（最少连接）、`sh`（源地址哈希）、`mh`（Maglev 哈希）等。

```bash
sudo ipvsadm -Ln -t 10.96.12.34:80
```

多年来，IPVS 一直是"iptables 模式在大规模下太慢"的标准答案。但社区后来改变了方向：**Kubernetes 文档标注 ipvs 模式自 v1.35 起已弃用，计划从 v1.40 起默认关闭、在 v1.43 中彻底移除**，并推荐 nftables 模式作为 iptables 和 IPVS 两者的替代。原因之一是 IPVS 始终没能在所有 Service 特性上与 iptables 的语义完全一致，而且它本来就仍需依赖 iptables 完成部分工作。

## nftables 模式的 kube-proxy

nftables 是同一 netfilter 子系统中 iptables API 的继任者。该模式在 Kubernetes 1.29 以 alpha 引入，1.33 进入 GA，要求 Linux 内核 **5.13 及以上**。出于兼容性考虑，默认仍是 iptables，需要显式开启：

```yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: nftables
```

有两个特性让它从根本上优于 iptables 模式：

1. **用映射代替规则列表。** nftables 原生支持集合（set）和 *verdict map*。kube-proxy 可以把"根据目的 IP、协议和端口跳转到对应 Service 的链"表达为一次哈希查找，而不是逐条遍历每个 Service 的规则。示意片段：

   ```text
   map service-ips {
       type ipv4_addr . inet_proto . inet_service : verdict
       elements = { 10.96.12.34 . tcp . 80 : goto service-ORDERS-shop/orders/tcp/http }
   }
   chain service-ORDERS-shop/orders/tcp/http {
       numgen random mod 3 vmap { 0 : goto endpoint-A, 1 : goto endpoint-B, 2 : goto endpoint-C }
   }
   ```

2. **增量事务。** 变更以原子事务提交，只触及受影响的元素，大集群里一个 endpoint 变化不再意味着重新生成一整套庞大的规则。

可以这样查看 kube-proxy 安装的内容：

```bash
sudo nft list table ip kube-proxy
```

文档列出了迁移时需要注意的几处行为差异：

- NodePort Service 默认只在节点的**主 IP** 上可达（`--nodeport-addresses primary`），而不像 iptables 模式那样在所有本地地址上都可达；
- nftables 模式不会为了兼容严格的本地防火墙而添加放行规则，需要自行放通 NodePort 端口范围；
- iptables 模式会为 6.1 之前内核中一个可能重置长连接的 conntrack bug 安装规避规则，nftables 模式默认不装。迁移前先看 `iptables_ct_state_invalid_dropped_packets_total` 指标，若确实依赖它，可使用 `--conntrack-tcp-be-liberal`。

## 用 eBPF 替代 kube-proxy

eBPF 允许把经过校验的程序加载进内核并挂到各种钩子上。**Cilium** 等数据面借此完全不依赖 netfilter 规则来实现 Service。Cilium 文档描述了几个层次：

- **Socket 级负载均衡。** 挂在 cgroup socket 钩子（如 `connect()`、`sendmsg()`）上的 BPF 程序，在*应用建立连接的那一刻*就把 ClusterIP 翻译成后端地址。离开 Pod 的数据包本身就带着后端 IP，因此东西向流量不需要逐包 DNAT，也不需要为这次转换建立 conntrack 条目。
- **tc / XDP 程序** 处理到达节点的 NodePort、LoadBalancer 和 externalIPs 流量。XDP 运行在网卡驱动层、内核分配 socket buffer 之前，适合高包速率场景。
- **BPF map**（内核哈希表）保存 Service、后端和连接状态，由 agent 增量更新。
- 可选的 **Maglev 一致性哈希**，使节点或后端变化时选择结果尽量稳定；以及 **DSR（直接服务器返回）**，远端后端的回包直接发给客户端，而不必绕回入口节点。

```bash
# 在 Cilium agent Pod 内执行（新版本中该二进制名为 cilium-dbg）
cilium-dbg service list
cilium-dbg bpf lb list
```

不过取舍是真实存在的：

- 依赖较新的内核和某一家的数据面实现，功能可用性随内核版本而变；
- 熟悉的工具（`iptables-save`、`conntrack -L`）不再能反映全貌，需要使用数据面自带的 CLI 和可观测性工具（Cilium 的是 Hubble）；
- Socket 级转换会改变应用观察到的东西（例如 `getpeername()` 返回的是后端地址，Cilium 对此做了专门处理），文档也描述了需要绕过它的场景，比如某些服务网格 sidecar 部署。

## 横向对比

| | iptables | IPVS | nftables | eBPF（如 Cilium） |
|---|---|---|---|---|
| Service 查找 | 线性遍历规则 | 哈希表 | verdict map（哈希） | BPF map（哈希） |
| 规则更新 | 重载规则集（v1.28 起部分同步） | 按对象更新 | 增量事务 | 增量更新 map |
| 后端选择 | 随机 | rr、lc、sh、mh 等 | 随机 | 随机、Maglev |
| 东西向逐包 NAT | 有（DNAT + conntrack） | 有 | 有 | 开启 socket LB 时没有 |
| 内核要求 | 任意受支持版本 | IPVS 内核模块 | 5.13+ | 较新内核，视功能而定 |
| 状态 | 默认 | v1.35 起弃用 | v1.33 起 GA | 第三方，广泛使用 |

## 改变流量路径的策略

**`externalTrafficPolicy: Local`**（NodePort/LoadBalancer）。默认的 `Cluster` 允许任意节点转发到任意后端，这需要 SNAT，会丢失客户端 IP。`Local` 只使用接收节点上的后端：没有第二跳、保留客户端源 IP，但没有后端的节点会直接丢弃流量，所以云负载均衡器必须对每个节点做健康检查（kube-proxy 为此暴露 `healthCheckNodePort`），且 Pod 分布不均时负载也会不均。

**`internalTrafficPolicy: Local`** 把集群内流量限制在同节点的后端上——适合日志采集器这类节点本地 agent，用于普通服务则很危险，因为没有本地后端的节点会完全访问不到该 Service。

**`trafficDistribution`** 表达的是偏好而非硬性规则。`PreferSameZone` 在客户端所在可用区有就绪 endpoint 时把流量留在区内（降低跨区延迟和云厂商流量费用），否则回退到全集群路由；`PreferSameNode` 优先同节点。旧值 `PreferClose` 现在是 `PreferSameZone` 的已弃用别名。

**`sessionAffinity: ClientIP`** 把同一客户端 IP 固定到一个后端（默认超时 10800 秒）。粒度很粗：同一个 NAT 网关后面的所有客户端都会落到同一个 Pod。

## DNS：Service 调用的另一半

CoreDNS 负责解析 `orders.shop.svc.cluster.local`。每个 Pod 的 `/etc/resolv.conf` 通常长这样：

```text
search shop.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

`ndots:5` 表示点号少于 5 个的域名会先依次拼接每个搜索后缀去查询。所以在 Pod 里解析 `api.github.com`，可能先产生好几次失败的查询（每次还分 A 和 AAAA），才轮到真正的那次。对高频访问的外部域名，可以使用带结尾点号的完全限定名（`api.github.com.`），或按 Pod 调整 `dnsConfig`。

基于 UDP 的 DNS 与 conntrack 的配合也有问题：一个广为人知的 Linux conntrack 插入竞态——在 glibc 用同一个 socket 并行发送 A 和 AAAA 查询时触发——曾让大量集群出现间歇性的 **5 秒 DNS 超时**。常见缓解手段是 resolver 选项 `single-request-reopen`，以及 **NodeLocal DNSCache**：在每个节点上运行一个缓存 DNS agent，Pod 访问本地 IP，向上游的查询可以改走 TCP。

## 由设计带来的生产问题

### 1. 发布期间报错：endpoint 传播竞态

Pod 被删除时，两件事并行发生：kubelet 向容器发送 `SIGTERM`；EndpointSlice 控制器移除该 Pod，随后各节点的代理再更新规则。两者之间没有任何先后保证。如果应用立刻退出，部分节点在短时间内仍会把新连接路由给它，客户端就会看到连接被拒绝或被重置。

标准做法是在开始终止后继续服务几秒钟：

```yaml
spec:
  terminationGracePeriodSeconds: 40
  containers:
    - name: orders
      lifecycle:
        preStop:
          sleep:
            seconds: 10   # 较老的集群可用：exec: { command: ["sleep", "10"] }
```

同时让应用在收到 `SIGTERM` 后停止接收新任务、处理完进行中的请求、关闭 keep-alive 连接。EndpointSlice 的状态条件也有帮助：终止中的 Pod 会被标记为 `ready: false`；从 v1.28 起，在 `externalTrafficPolicy: Local` 下，如果某节点上的本地 endpoint 全部处于终止中，kube-proxy 仍可把流量发往其中 `serving` 的那些，让负载均衡器能够平滑摘流。

### 2. 长连接不会重新均衡

由于按连接均衡，HTTP/2 和 gRPC 客户端只建一条连接、所有请求在上面多路复用，于是会永远粘在一个后端上。给 Deployment 扩容对已有客户端毫无帮助。可选方案：通过 **Headless Service**（`clusterIP: None`，DNS 直接返回 Pod IP）做客户端负载均衡；定期回收连接（例如 gRPC 服务端的 `MaxConnectionAge`）；或使用按请求均衡的 L7 代理或服务网格。

### 3. conntrack 表耗尽

每条被代理的连接都占用一个 conntrack 条目。短连接压力大时表会被打满，内核日志出现 `nf_conntrack: table full, dropping packet`。kube-proxy 根据 `conntrack.maxPerCore`（默认每个 CPU 核 32768）设置表大小；要监控 `nf_conntrack_count` 与 `nf_conntrack_max` 的比值，并让客户端尽量复用连接。

### 4. 同步参数调优

`minSyncPeriod`（默认 1s）会把 endpoint 变化攒批处理，使一次大规模发布产生少量大同步，而不是几百次小同步。调大能在大集群里节省 CPU，代价是收敛变慢；文档建议多数情况下不要改动 `syncPeriod`。

## 排障清单

```bash
# 1. Service 是否有就绪的 endpoint？
kubectl -n shop get endpointslices -l kubernetes.io/service-name=orders -o yaml

# 2. 节点用的是哪种代理模式？
curl -s http://localhost:10249/proxyMode     # 在节点上访问 kube-proxy 的 metrics 端口

# 3. 装了哪些规则？
sudo iptables-save -t nat | grep orders      # iptables 模式
sudo nft list table ip kube-proxy            # nftables 模式
sudo ipvsadm -Ln                             # ipvs 模式

# 4. 地址转换是否生效？
sudo conntrack -L -d 10.96.12.34

# 5. 是不是 DNS 的问题？
kubectl run -it --rm dnscheck --image=busybox:1.36 --restart=Never -- nslookup orders.shop
```

## 如何选择

- **使用原生 kube-proxy 的中小集群：** iptables 模式够用，v1.28+ 的部分同步已经消除了大部分更新开销。
- **大集群，或目前在用 IPVS 的团队：** 规划迁移到 **nftables 模式**（内核 5.13+）。这是上游的方向，而 IPVS 已进入移除时间表。
- **同时需要大规模网络策略、L7 可观测性，或 NodePort/LoadBalancer 高包速率的集群：** 以 kube-proxy 替代模式运行的 eBPF 数据面（如 Cilium）是很有力的选择，代价是更重的依赖和一套新的运维工具。
- **无论选哪种数据面：** 都要处理好优雅下线、为长连接做规划，并且在怪罪网络之前先查 DNS。

## 总结

Service 是一份契约：稳定的虚拟 IP 和名字，背后是一组不断变化的 endpoint。控制面把 selector 变成 EndpointSlice；每个节点独立地把它们变成内核状态；内核按连接选一次后端。iptables 模式靠线性规则列表，IPVS 靠哈希表但语义不完全一致，nftables 靠哈希化的 verdict map 和增量更新，而 eBPF 数据面可以在 socket 层完成转换、彻底省掉逐包 NAT。生产中的大多数意外——发布时丢请求、gRPC 流量黏在单个 Pod、客户端 IP 丢失、5 秒 DNS 延迟——都直接源自这些设计选择。理解它们，比背诵各种规避技巧更有价值。

## 参考资料

- Kubernetes 文档，[Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- Kubernetes 文档，[Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- Kubernetes 博客，[NFTables mode for kube-proxy](https://kubernetes.io/blog/2025/02/28/nftables-kube-proxy/)（2025）
- [KEP-3866: Add an nftables-based kube-proxy backend](https://github.com/kubernetes/enhancements/tree/master/keps/sig-network/3866-nftables-proxy)
- Cilium 文档，[Kubernetes Without kube-proxy](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/)
- Kubernetes 文档，[Using NodeLocal DNSCache in Kubernetes Clusters](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- Weaveworks 工程博客，"Racy conntrack and DNS lookup timeouts"（2018）
