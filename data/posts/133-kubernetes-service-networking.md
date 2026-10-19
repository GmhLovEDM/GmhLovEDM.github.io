---
title: "How a Kubernetes Service Really Routes Traffic: kube-proxy (iptables, IPVS, nftables) vs eBPF"
tag: devops
description: What actually happens between `curl my-svc` and a backend Pod — EndpointSlices, the iptables/IPVS/nftables data planes of kube-proxy, eBPF socket-level load balancing in Cilium, traffic policies, DNS, and the production pitfalls (graceful shutdown, conntrack, long-lived connections) that follow from the design
date: "2026-10-19T14:20:00.000Z"
---

## Goal

A Kubernetes `Service` looks trivial in YAML: a name, a selector, a port. Yet every request that goes through it passes through a surprisingly deep stack — an API object, a controller, an agent on every node, and a kernel data plane that rewrites packets. When latency spikes during a rollout, when a client source IP disappears, or when one Pod gets all the gRPC traffic, the cause is almost always somewhere in that stack.

This article walks through the whole path: how Services become endpoints, how kube-proxy programs the kernel in its three Linux modes (iptables, IPVS, nftables), how eBPF-based data planes such as Cilium replace kube-proxy entirely, and which traffic policies and failure modes matter in real clusters.

## Background: Why a Virtual IP at All?

Pods are disposable. A Deployment rollout replaces every Pod, and each new Pod gets a new IP. Clients need a stable address, so Kubernetes gives each Service a **ClusterIP** — a virtual IP that is not bound to any network interface (in most modes) and that no machine "owns".

Why not just publish all Pod IPs as DNS A records and let clients round-robin? The official documentation gives three reasons:

- Many DNS implementations historically ignore record TTLs and cache results after they should have expired.
- Some applications resolve a name once and cache the result forever.
- Even with well-behaved clients, very low TTLs would put heavy load on DNS.

So Kubernetes chose **proxying at the virtual IP**: the address stays fixed, and something on each node translates it to a live backend on every new connection.

## The Control Plane Side: From Service to EndpointSlice

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
      port: 80          # the port on the ClusterIP
      targetPort: 8080  # the container port
```

Three components cooperate:

1. **The API server** allocates a ClusterIP from the service CIDR (for example `10.96.0.0/12`).
2. **The EndpointSlice controller** (in kube-controller-manager) watches Pods matching the selector and writes `EndpointSlice` objects listing their IPs, ports and conditions (`ready`, `serving`, `terminating`). Slices hold up to 100 endpoints by default, so a Service with thousands of Pods is split across many small objects instead of one giant `Endpoints` object that must be rewritten on every change.
3. **kube-proxy** (or its replacement) runs on every node, watches Services and EndpointSlices, and programs the local kernel.

```bash
kubectl -n shop get endpointslices -l kubernetes.io/service-name=orders -o wide
```

The important consequence: **routing decisions are made on the client's node**, from that node's local copy of the endpoint list. There is no central load balancer, and every node converges on the new endpoint set independently and asynchronously. Keep that in mind; it explains most of the pitfalls later.

## The Path of One Connection

Assume Pod A on node 1 calls `http://orders.shop/` and the ClusterIP is `10.96.12.34`.

1. DNS (CoreDNS) returns `10.96.12.34`.
2. Pod A sends a SYN to `10.96.12.34:80`. The packet leaves the Pod's network namespace through a veth pair into the host namespace.
3. On the host, the data plane intercepts the packet (netfilter hooks for kube-proxy, BPF hooks for eBPF data planes), picks a backend such as `192.168.3.17:8080`, and rewrites the destination (DNAT).
4. The CNI plugin's routing delivers the packet to the backend Pod, possibly on another node.
5. **conntrack** remembers the translation, so later packets of the same connection skip the selection logic, and replies get their source rewritten back to `10.96.12.34:80` before reaching Pod A.

Load balancing therefore happens **once per connection, at L4**. Everything about HTTP requests, keep-alive and multiplexing lives above that level and is invisible to the Service.

## kube-proxy in iptables Mode

iptables mode is still the default on Linux. kube-proxy writes rules into the `nat` table that hang off the `PREROUTING` (traffic arriving at the node) and `OUTPUT` (traffic from host processes) hooks. An abbreviated view for a Service with three endpoints:

```text
-A KUBE-SERVICES -d 10.96.12.34/32 -p tcp --dport 80 -j KUBE-SVC-ORDERS
-A KUBE-SVC-ORDERS -m statistic --mode random --probability 0.33333333349 -j KUBE-SEP-A
-A KUBE-SVC-ORDERS -m statistic --mode random --probability 0.50000000000 -j KUBE-SEP-B
-A KUBE-SVC-ORDERS -j KUBE-SEP-C
-A KUBE-SEP-A -p tcp -j DNAT --to-destination 192.168.1.10:8080
-A KUBE-SEP-B -p tcp -j DNAT --to-destination 192.168.2.11:8080
-A KUBE-SEP-C -p tcp -j DNAT --to-destination 192.168.3.17:8080
```

(Real chain names are hashes such as `KUBE-SVC-XGLOHA7QRQ3V22RZ`; the names above are shortened for readability.)

The probabilities produce a uniform choice: the first rule takes 1/3; of the remaining 2/3, the second rule takes half, which is another 1/3; the last rule takes the rest. You can inspect the real thing on a node:

```bash
sudo iptables-save -t nat | grep -A4 'KUBE-SVC'
```

**Where it hurts at scale:**

- **Linear matching.** `KUBE-SERVICES` contains roughly one rule per Service port, and netfilter evaluates rules in order. The first packet of every new connection walks that list. With tens of thousands of Services this becomes measurable latency — this is the "data plane latency" problem cited by the nftables mode proposal.
- **Expensive updates.** iptables has no fine-grained API; kube-proxy builds a ruleset and loads it with `iptables-restore`. Older versions rewrote rules for all Services on every sync. Since Kubernetes v1.28, iptables mode only rewrites the rules for Services and EndpointSlices that actually changed, which helped a lot, but the underlying API is still coarse.
- **SNAT in some paths.** Traffic from outside the cluster network, NodePort traffic forwarded to another node, and "hairpin" traffic (a Pod calling its own Service and landing on itself) gets masqueraded via the `KUBE-MARK-MASQ` / `KUBE-POSTROUTING` chains so that replies come back through the same node. That is why the backend may see a node IP instead of the real client.

## kube-proxy in IPVS Mode

IPVS (IP Virtual Server) is an L4 load balancer that has lived in the Linux kernel for a long time. In this mode kube-proxy:

- creates a dummy interface `kube-ipvs0` and binds every ClusterIP to it, so the kernel accepts packets addressed to those IPs;
- creates one IPVS virtual server per Service IP and port, with the Pod IPs as real servers, stored in kernel **hash tables** — lookup cost no longer grows with the number of Services;
- still uses iptables plus `ipset` for masquerading and filtering;
- supports real scheduling algorithms: `rr` (round robin), `lc` (least connections), `sh` (source hashing), `mh` (Maglev hashing) and others.

```bash
sudo ipvsadm -Ln -t 10.96.12.34:80
```

For years IPVS was the standard answer to "iptables mode is slow at scale". The project has since changed course: **the Kubernetes documentation marks the ipvs mode as deprecated since v1.35, planned to be disabled by default from v1.40 and removed in v1.43**, and points to nftables mode as the replacement for both iptables and IPVS. Part of the reasoning is that IPVS never fully matched iptables semantics for all Service features, and it still needed iptables for parts of the job anyway.

## kube-proxy in nftables Mode

nftables is the successor to the iptables API inside the same netfilter subsystem. The mode was introduced as alpha in Kubernetes 1.29 and reached GA in 1.33; it requires Linux **5.13 or later**. iptables remains the default for compatibility, so you opt in explicitly:

```yaml
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: nftables
```

Two properties make it fundamentally better than iptables mode:

1. **Maps instead of rule lists.** nftables has native sets and *verdict maps*. kube-proxy can express "jump to the chain for this destination IP, protocol and port" as a single hashed lookup, rather than walking one rule per Service. An illustrative fragment:

   ```text
   map service-ips {
       type ipv4_addr . inet_proto . inet_service : verdict
       elements = { 10.96.12.34 . tcp . 80 : goto service-ORDERS-shop/orders/tcp/http }
   }
   chain service-ORDERS-shop/orders/tcp/http {
       numgen random mod 3 vmap { 0 : goto endpoint-A, 1 : goto endpoint-B, 2 : goto endpoint-C }
   }
   ```

2. **Incremental transactions.** Changes are submitted as atomic transactions that touch only the affected elements, so an endpoint change in a huge cluster does not mean regenerating a huge ruleset.

You can inspect what kube-proxy installed with:

```bash
sudo nft list table ip kube-proxy
```

The documentation lists a few behaviour differences to plan for when migrating:

- NodePort Services are reachable only on the node's **primary** IPs by default (`--nodeport-addresses primary`), not on every local address as in iptables mode.
- nftables mode does not add "accept" rules to work around a restrictive local firewall; you must open the NodePort range yourself.
- iptables mode installs a workaround for a conntrack bug in kernels before 6.1 that can reset long-lived connections; nftables mode does not by default. Check the `iptables_ct_state_invalid_dropped_packets_total` metric before migrating, and use `--conntrack-tcp-be-liberal` if you depend on it.

## Replacing kube-proxy with eBPF

eBPF lets you load verified programs into the kernel and attach them to hooks. Data planes such as **Cilium** use this to implement Services without netfilter rules at all. The Cilium documentation describes several layers:

- **Socket-level load balancing.** BPF programs attached to cgroup socket hooks (such as `connect()` and `sendmsg()`) translate the ClusterIP to a backend address *when the application opens the connection*. The packets that leave the Pod already carry the backend IP, so there is no per-packet DNAT and no conntrack entry needed for that translation on the east–west path.
- **tc / XDP programs** handle NodePort, LoadBalancer and externalIPs traffic arriving at the node. XDP runs in the NIC driver before the kernel allocates a socket buffer, which is useful for high packet rates.
- **BPF maps** (kernel hash tables) hold Services, backends and connection state, updated incrementally by the agent.
- Optional **Maglev consistent hashing**, so backend selection stays stable when nodes or backends change, and **DSR (direct server return)**, so replies from a remote backend go straight to the client instead of back through the ingress node.

```bash
# inside the Cilium agent Pod (the binary is named cilium-dbg in recent releases)
cilium-dbg service list
cilium-dbg bpf lb list
```

The trade-offs are real, though:

- You depend on a reasonably modern kernel and on one vendor's data plane; feature availability varies with kernel version.
- Familiar tools (`iptables-save`, `conntrack -L`) no longer show the full picture; you need the data plane's own CLI and observability (Hubble in Cilium's case).
- Socket-level translation changes what the application observes (for example, `getpeername()` returns the backend address, which Cilium handles specially), and the docs describe cases where it must be bypassed, such as some service-mesh sidecar setups.

## Side-by-Side

| | iptables | IPVS | nftables | eBPF (e.g. Cilium) |
|---|---|---|---|---|
| Service lookup | linear rule walk | hash table | verdict map (hashed) | BPF map (hashed) |
| Rule updates | ruleset reload (partial since v1.28) | per-object | incremental transactions | incremental map updates |
| Backend selection | random | rr, lc, sh, mh, ... | random | random, Maglev |
| Per-packet NAT for east–west | yes (DNAT + conntrack) | yes | yes | no, with socket LB |
| Kernel requirement | any supported | IPVS modules | 5.13+ | modern kernel, varies by feature |
| Status | default | deprecated since v1.35 | GA since v1.33 | third-party, widely used |

## Traffic Policies That Change the Path

**`externalTrafficPolicy: Local`** (NodePort/LoadBalancer). The default `Cluster` lets any node forward to any backend, which requires SNAT and loses the client IP. `Local` only uses backends on the receiving node: no second hop, the client source IP is preserved, but nodes without backends drop the traffic, so the cloud load balancer must health-check each node (kube-proxy exposes `healthCheckNodePort` for this), and load can be uneven if Pods are unevenly spread.

**`internalTrafficPolicy: Local`** restricts in-cluster traffic to backends on the same node — useful for node-local agents such as log collectors, dangerous for ordinary services because a node without a local backend simply cannot reach the Service.

**`trafficDistribution`** expresses a preference rather than a hard rule. `PreferSameZone` keeps traffic in the client's zone when there are ready endpoints there (cutting cross-zone latency and cloud transfer cost), and falls back to cluster-wide routing otherwise; `PreferSameNode` prefers the client's own node. The older value `PreferClose` is now a deprecated alias of `PreferSameZone`.

**`sessionAffinity: ClientIP`** pins a client IP to one backend (default timeout 10800 seconds). It is coarse: every client behind one NAT gateway lands on the same Pod.

## DNS: The Other Half of a Service Call

CoreDNS serves `orders.shop.svc.cluster.local`. Each Pod's `/etc/resolv.conf` typically looks like:

```text
search shop.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

`ndots:5` means any name with fewer than five dots is first tried with every search suffix. Resolving `api.github.com` from a Pod can therefore generate several failed queries (and both A and AAAA for each) before the real one. For hot external names, use a fully qualified name with a trailing dot (`api.github.com.`) or tune `dnsConfig` per Pod.

DNS over UDP also interacts badly with conntrack: a well-known Linux conntrack insertion race, triggered when glibc sends A and AAAA queries in parallel from the same socket, caused intermittent **5-second DNS timeouts** in many clusters. Common mitigations are the `single-request-reopen` resolver option and **NodeLocal DNSCache**, which runs a caching DNS agent on every node so Pods talk to a local IP and upstream queries can use TCP.

## Production Pitfalls That Follow From the Design

### 1. Errors during rollouts: the endpoint propagation race

When a Pod is deleted, two things happen in parallel: the kubelet sends `SIGTERM` to the container, and the EndpointSlice controller removes the Pod, after which every node's proxy updates its rules. Nothing orders these. If the application exits immediately, some nodes still route new connections to it for a short while, and clients see connection refused or resets.

The standard fix is to keep serving for a few seconds after termination begins:

```yaml
spec:
  terminationGracePeriodSeconds: 40
  containers:
    - name: orders
      lifecycle:
        preStop:
          sleep:
            seconds: 10   # on older clusters: exec: { command: ["sleep", "10"] }
```

and to have the application, on `SIGTERM`, stop accepting new work, finish in-flight requests, and close keep-alive connections. EndpointSlice conditions help too: a terminating Pod is marked `ready: false`, and since v1.28 kube-proxy can still send traffic to `serving` terminating endpoints when a node only has terminating local endpoints under `externalTrafficPolicy: Local`, so load balancers can drain gracefully.

### 2. Long-lived connections do not rebalance

Because balancing is per connection, HTTP/2 and gRPC clients that open one connection and multiplex everything over it stick to a single backend forever. Scaling the Deployment out does not help existing clients. Options: client-side load balancing over a **headless Service** (`clusterIP: None`, DNS returns Pod IPs directly), periodic connection recycling (for example, gRPC's server-side `MaxConnectionAge`), or an L7 proxy or service mesh that balances per request.

### 3. conntrack exhaustion

Every proxied connection occupies a conntrack entry. Under heavy short-connection load, the table fills up and the kernel logs `nf_conntrack: table full, dropping packet`. kube-proxy sizes the table from `conntrack.maxPerCore` (default 32768 per CPU core); watch `nf_conntrack_count` against `nf_conntrack_max`, and prefer connection reuse in clients.

### 4. Sync tuning

`minSyncPeriod` (default 1s) batches endpoint changes so that a large rollout produces a few big syncs rather than hundreds of small ones. Larger values save CPU in big clusters at the cost of slower convergence; the docs advise against changing `syncPeriod` in most cases.

## A Debugging Checklist

```bash
# 1. Does the Service have ready endpoints?
kubectl -n shop get endpointslices -l kubernetes.io/service-name=orders -o yaml

# 2. Which proxy mode is a node using?
curl -s http://localhost:10249/proxyMode     # kube-proxy metrics port, on the node

# 3. What rules did it install?
sudo iptables-save -t nat | grep orders      # iptables mode
sudo nft list table ip kube-proxy            # nftables mode
sudo ipvsadm -Ln                             # ipvs mode

# 4. Is the translation happening?
sudo conntrack -L -d 10.96.12.34

# 5. Is DNS the real problem?
kubectl run -it --rm dnscheck --image=busybox:1.36 --restart=Never -- nslookup orders.shop
```

## How to Choose

- **Small and medium clusters on stock kube-proxy:** iptables mode is fine, and v1.28+ partial sync removed much of the update cost.
- **Large clusters, or anyone currently on IPVS:** plan a move to **nftables mode** (kernel 5.13+). It is the upstream direction and IPVS is on a removal schedule.
- **Clusters that also want network policy at scale, L7 visibility, or high packet rates on NodePort/LoadBalancer:** an eBPF data plane such as Cilium in kube-proxy replacement mode is a strong option, at the cost of a heavier dependency and new operational tooling.
- **Whatever the data plane:** handle graceful shutdown, plan for long-lived connections, and look at DNS before blaming the network.

## Summary

A Service is a contract: a stable virtual IP and name, backed by a constantly changing set of endpoints. The control plane turns selectors into EndpointSlices; every node independently turns those into kernel state; and the kernel picks a backend once per connection. iptables mode does this with linear rule lists, IPVS with hash tables but mixed semantics, nftables with hashed verdict maps and incremental updates, and eBPF data planes can skip per-packet NAT entirely by translating at the socket. Most production surprises — dropped requests during rollouts, sticky gRPC traffic, missing client IPs, 5-second DNS delays — come straight from those design choices, which is why they are worth understanding rather than memorising workarounds.

## References

- Kubernetes documentation, [Virtual IPs and Service Proxies](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- Kubernetes documentation, [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- Kubernetes blog, [NFTables mode for kube-proxy](https://kubernetes.io/blog/2025/02/28/nftables-kube-proxy/) (2025)
- [KEP-3866: Add an nftables-based kube-proxy backend](https://github.com/kubernetes/enhancements/tree/master/keps/sig-network/3866-nftables-proxy)
- Cilium documentation, [Kubernetes Without kube-proxy](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/)
- Kubernetes documentation, [Using NodeLocal DNSCache in Kubernetes Clusters](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- Weaveworks engineering blog, "Racy conntrack and DNS lookup timeouts" (2018)
