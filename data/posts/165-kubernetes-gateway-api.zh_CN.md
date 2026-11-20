---
title: "深入 Kubernetes Gateway API：监听器、HTTPRoute 匹配、ReferenceGrant，以及告别 Ingress"
tag: devops
description: Gateway API 如何把南北向路由拆到 GatewayClass、Gateway 与 Route 上——双向挂载约定，监听器隔离与主机名交集，规范真正要求的 HTTPRoute 匹配优先级，带权重的后端以及无效或空端点时的 500/503 规则，作为跨命名空间许可的 ReferenceGrant，GAMMA 把同一条 HTTPRoute 挂到 Service 上，Ingress NGINX 退役之后该怎么迁，以及一个可运行模型来验证这些规则
date: "2026-11-20T14:50:00.000Z"
---

## 目标

多年来，Kubernetes 南北向路由里可移植的那一层，是一个单独的 `Ingress` 对象：主机名、路径、一个 Service。装不下的东西——按请求头匹配、流量权重、超时、改写、CORS、请求镜像——都漏进了各家的注解。那些注解从来不可移植，也从来不是 Kubernetes API 契约的一部分。[更早一篇](/blog/133-kubernetes-service-networking/zh_CN)沿着 Service 名字往下走到了 kube-proxy 和 eBPF；这篇从再上一层开始，从请求刚进入集群的边缘讲起。

**Gateway API** 是官方的后继者。它不是“换了个名字的 Ingress”。它按组织角色把工作拆到一小族资源上，把常见的路由需求做成一等字段而不是注解，并且用同一类 Route 来描述服务网格里的东西向流量。标准通道（Standard channel）从 v1.0（2023 年 10 月）起，对 `GatewayClass`、`Gateway` 和 `HTTPRoute` 已经稳定；`GRPCRoute` 和 GAMMA 的网格工作在 v1.1 毕业。截至 2026 年 10 月 29 日，当前版本是 [v1.7.0](https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.7.0)。

本文会讲到：

1. Ingress 为什么走到了头，以及 Ingress NGINX 退役在实践里改变了什么。
2. 资源模型：`GatewayClass`、`Gateway`、Route，以及它们围绕的三种角色。
3. Route 如何挂载：`parentRefs`、`allowedRoutes`、主机名交集，以及监听器隔离。
4. HTTPRoute 的匹配，以及规范真正要求的优先级算法。
5. 带权重的后端、过滤器、超时，以及后端不可用时的 500/503 规则。
6. Gateway 上的 TLS，以及作为跨命名空间握手的 `ReferenceGrant`。
7. GAMMA：把同一条 HTTPRoute 挂到 Service 上，供网格使用。
8. 从 Ingress 迁走，包括 Ingress2Gateway 1.0 会翻译什么、不会翻译什么。
9. 什么时候不该把赌注只押在 Gateway API 上，或者它只是答案的一半。
10. 一个可运行的模型，把官方的匹配、隔离和权重规则用到一组固定的请求上。

## 1. 为什么 Ingress 不再够用

Ingress API 故意做得很小。在 2015 年这是优点，后来成了约束。生产环境里的边缘通常需要按请求头和方法匹配、把一部分流量切到新版本、用另一个命名空间里的证书终结 TLS、再设一个请求超时。这些事情 Ingress 几乎都表达不了，除非借助注解，而每个控制器都发明了自己的词汇。一个看起来可移植的对象，实际上已经和某一种数据面绑死了。

后果在 Ingress NGINX 上表现得最清楚：正是因为那些注解足够灵活，它成了大量集群的默认边缘。2025 年 11 月 11 日，Kubernetes SIG Network 和安全响应委员会[宣布](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)，尽力而为的维护将在 2026 年 3 月结束。那之后不会再有新版本、不会再修缺陷、也不会再有安全补丁。已经部署的实例会继续运行，已经发布的镜像也还在；它们只是不再是 Kubernetes 项目里一份有人维护的组件。2026 年 1 月，指导委员会和安全响应委员会的[后续声明](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)写得很直白：退役之后继续留在 Ingress NGINX 上，会让集群处于无补丁状态；曾经看起来很有用的 snippets 注解，已经成为严重的安全包袱；而这个项目这些年是靠一两个人用业余时间撑下来的。那份声明还引用了 Datadog 的内部研究——截至 2026 年 1 月——大约一半的云原生环境仍在依赖 Ingress NGINX。配套的替代项目 InGate 始终没有成熟，一并退役。

Gateway API 要做的，是让常见需求可移植，把其余部分明确写成扩展点，而不是另搞一套注解阴影 API。它本身并不会替你选定数据面。那是一个单独的决定，也是本文最后要谈的取舍之一。

## 2. 面向角色的资源模型

官方文档里写了三种角色，资源就是按他们来切的。

- **基础设施提供者**发布一个集群作用域的 `GatewayClass`。这一层真正要紧的字段是 `spec.controllerName`，它指出谁来调和这一类 Gateway——和 `IngressClass` 是同一个想法，只是被写进了规范。
- **集群操作者**创建 `Gateway`：一套流量处理基础设施的实例，比如云负载均衡器，或集群内的代理。Gateway 写明自己的 class，并列出**监听器（listener）**——协议、端口、可选的主机名、TLS，以及 `allowedRoutes`。一个 Gateway 只关联一个 GatewayClass。
- **应用开发者**创建按协议分类的 Route，通常是 `HTTPRoute` 或 `GRPCRoute`，把它们挂到 Gateway 上，描述请求该如何匹配、该去哪里。

今天的标准通道里，大多数人会用到的稳定种类有四个：`GatewayClass`、`Gateway`、`HTTPRoute`、`GRPCRoute`。后面会讲到的 `ReferenceGrant` 是第五个；只要 Route 或 Gateway 指向另一个命名空间里的对象，你就会需要它。TCP、TLS、UDP 这类 Route 仍在实验通道（Experimental channel）里，除非某个实现另有说明。项目[建议](https://gateway-api.sigs.k8s.io/docs/concepts/versioning/)默认使用标准通道；实验通道不做兼容承诺，Gateway API 还用 Validating Admission Policy 拦住实验字段，免得它们在你没有明确选择的情况下漏进标准通道的安装。

一个最小的 HTTP 边缘像下面这样。`controllerName` 以实现文档为准；下面这个字符串是 Kubernetes 文档里的占位符，不是某个真实控制器。

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: internet
spec:
  controllerName: example.com/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: www
  namespace: infra
spec:
  gatewayClassName: internet
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: www.example.com
    tls:
      mode: Terminate
      certificateRefs:
      - name: www-cert
    allowedRoutes:
      namespaces:
        from: Same
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: www
  namespace: infra
spec:
  parentRefs:
  - name: www
  hostnames:
  - www.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: www-svc
      port: 8080
```

这张图里有两处很容易看漏。

第一，挂载是**双向的**。Route 在 `parentRefs` 里写出它想挂上的 Gateway；Gateway 的监听器也必须按命名空间和种类允许这条 Route。`allowedRoutes.namespaces.from` 的默认值是 `Same`。另一个命名空间里的 Route，要等操作者把这个监听器放宽到 `All` 或命名空间选择器才会挂上；即便如此，跨命名空间的*后端*或*证书*引用仍然需要 `ReferenceGrant`。这是两道不同的门。

第二，Gateway 被故意设计成可共享的。由不同团队持有的多条 HTTPRoute，可以在这些门的约束下挂到同一个监听器上。角色拆分的意义正在这里：操作者决定 VIP 的形状、以及谁可以绑上来；应用团队描述自己的 HTTP 行为，而不去改负载均衡器。

## 3. 挂载、主机名交集，以及监听器隔离

一条 Route 可以指向整个 Gateway，也可以通过 `parentRefs[].sectionName`（监听器的 `name`）或端口指向其中某一个监听器。当几个监听器共用一个端口号时，按端口绑定更省事；代价是 Route 和这个端口号绑死了，以后 Gateway 改端口，每一条 Route 都得跟着改。Gateway API 的文档建议：你的意思如果是“就是这个监听器”，就用 `sectionName`；只有端口号本身就是契约时，才按端口绑定。

主机名是第二层、彼此独立的协商。监听器可以声明一个主机名，Route 也可以列出主机名，只有这两边的集合**相交**时，Route 才会挂上：

- 监听器主机名 `*.example.com` 是后缀匹配。它接受 `shop.example.com` 和 `foo.shop.example.com`，不接受光秃秃的父域 `example.com`。
- 如果两边都列了主机名且没有任何交集，这条 Route 不会被接受。实现必须在对应的 `RouteParentStatus` 上把 `Accepted` 设为 `False`，原因通常是 `NoMatchingListenerHostname`。
- 不相交的主机名会被忽略，而不是额外变成一条兜底规则。

真正锋利的边是**监听器隔离**，官方的[流量匹配](https://gateway-api.sigs.k8s.io/docs/concepts/traffic-matching/)页面写得很明确。已经被某一个监听器认领的流量，不允许再落到同一 Gateway 上的另一个监听器，哪怕挂在那个监听器上的 Route 本来也能匹配这次请求。特别是，一个 `shop.example.com` 的监听器挨着一个 `*.example.com` 的监听器时，所有 Host 为 `shop.example.com` 的请求都属于前者。如果特定监听器上唯一的 Route 只匹配 `GET /checkout`，那么这个主机上的 `GET /other` 就是 **404**。它不会被转到通配监听器上那条兜底 Route。从那种“把所有主机并进一张路由表”的 Ingress 控制器迁过来时，这是一个常见的意外。

当多条 HTTPRoute 确实挂到了同一个监听器、并且声明了相交的主机名时，优先级属于“匹配到的非通配主机名字符数最多”的那条 Route，然后再比“匹配到的主机名字符数”。因此，对同一次请求，精确主机名会压过通配符。按 Route 上*原来*配置的主机名来比这个优先级，而不是按和监听器算出来的交集来比，是一项名为 `GatewayRouteHostnameIntersectionPrecedence` 的扩展（Extended）能力。

## 4. HTTPRoute 的匹配

请求一旦有了监听器和一组已挂上的 Route，就由 HTTPRoute 规则决定哪一条规则——如果有的话——来处理它。每条规则有一份 `matches` 列表。同一条规则里的 match 之间是**或**；单个 match 内部的条件——路径、请求头、查询参数、方法——是**与**。如果一条规则没有写 matches，默认就是 `PathPrefix /`，会匹配所有请求。

路径匹配对 `Exact` 和 `PathPrefix` 是 Core，对 `RegularExpression` 是实现相关的。两个 Core 类型都比“字符串前缀”更严：

- `Exact` 区分大小写，并且是字面上的精确匹配。`/api/v1` 只接受 `/api/v1`，不接受 `/api/v1/`、`/api/v1/items`，也不接受 `/Api/v1`。
- `PathPrefix` 区分大小写，并且按**路径元素**匹配。路径按 `/` 切开，前缀末尾的斜杠会被忽略。`/api` 匹配 `/api`、`/api/` 和 `/api/users`，不匹配 `/apiv1`。前缀 `/` 匹配所有请求。规范写明，这和 Ingress 的 `Prefix` 路径类型语义相同。

多条规则——常常来自多条 Route——可能同时匹配同一次请求。规范要求实现必须选出恰好一条，按下面的顺序比较，打平再往下比。这些注释写在 [HTTPRoute API 类型](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go) 的 `HTTPRouteRule.Matches` 上：

1. `Exact` 路径压过任何前缀。
2. 前缀之中，路径值**字符数最多**的那一个获胜。
3. 写了 HTTP 方法的 match，压过没写方法的。
4. 请求头匹配个数更多的获胜。
5. 查询参数匹配个数更多的获胜。
6. 如果**跨 Route** 仍然打平：创建时间更早的 Route 获胜，再打平则按 `{namespace}/{name}` 的字母序，靠前的获胜。
7. 如果**同一条 Route 内部**仍然打平：规则列表里第一条仍能匹配的获胜。

`RegularExpression` 路径匹配的优先级被故意规定为实现相关。一份可移植的配置，不应该依赖正则去压过、或被 `Exact` / `PathPrefix` 压过。如果已挂上的规则里没有任何一条匹配，实现**必须**返回 HTTP 404。

由此得到两条值得记住的推论。第一，`Exact /api/v1` 并不会“覆盖整个 v1 子树”；子树仍然属于剩下的那个前缀，通常是 `/api`。第二，在路径相同的前提下，带方法的匹配会压过条件更“丰富”的请求头匹配。这份列表不是“条件越多越优先”，就是上面这个顺序。

## 5. 权重、过滤器、超时，以及失败

一条规则的 `backendRefs` 是带权重的列表。每一项分到的比例是 `weight / sum(weights)`。权重不是百分数，也不需要加起来等于 100；默认是 1，最大是 1,000,000，权重为 0 的项分不到流量。权重的支持级别是 Core。

后端不能使用时会发生什么，规范同样写死了，而且不是“跳过这一项，把流量重新分给别人”。如果这条规则上的后端全部无效、并且没有过滤器，所有匹配到的请求**必须**得到 HTTP 500。如果只是一部分后端无效，那部分本该打到它们的请求**必须**仍然得到 500——官方的例子是两个相等的权重、其中一个无效，一半流量返回 500。实现可以自己决定这“一半”怎么抽，但不能悄悄把它们倒进还活着的那个后端。一个引用会在这些情况下被判为无效：种类未知、对象不存在、跨命名空间引用没有 `ReferenceGrant`，或无法满足 Service 的 `appProtocol`，等等。若指向的是一个没有就绪端点的 Service，实现**应当**返回 503 而不是 500，并且套用同一套按比例分配的规则。

过滤器是一大类 Ingress 注解的可移植替代。它们作用在已经匹配上的请求上，实现应当按列表顺序应用。符合级别在这里很重要：

- **Core**，每个实现都必须支持：`RequestHeaderModifier`、`ResponseHeaderModifier`、`RequestRedirect`。
- **Extended**，鼓励实现支持：`RequestMirror`、`URLRewrite`、`CORS`，以及 `timeouts` 字段（`request` 覆盖整段事务，`backendRequest` 覆盖到后端的那一跳；时长为零表示在数据面做得到的前提下“关闭超时”）。在 v1.7.0 里，HTTPRoute 的重试——`codes`、`attempts`、`backoff`——也毕业到了标准通道，依据是 [GEP-1731](https://gateway-api.sigs.k8s.io/geps/gep-1731/)。`backoff` 仍然是实现相关的，因为抖动和具体的延迟函数因数据面而异。
- **实现相关**：一个指向自定义过滤器的 `ExtensionRef`。如果这个引用无法解析，过滤器绝不能被跳过，请求必须收到一个 HTTP 错误。

`RequestRedirect` 和 `backendRefs` 不能写在同一条规则里，这正是“把 HTTP 重定向到 HTTPS”的表达方式，而不需要发明一个空的 Service。`RequestMirror` 把请求复制到第二个后端，并丢弃那边的响应；它不会等待那个响应，也不能代替权重。

## 6. TLS 与 ReferenceGrant

监听器的 TLS 模式默认是 `Terminate`，也可以是 `Passthrough`。Terminate 从 `certificateRefs` 拿出证书——Core 支持是指向一个 `kubernetes.io/tls` Secret 的单一引用——并在 Gateway 上解密。Passthrough 按 SNI 路由，把 TLS 会话留给后端；`certificateRefs` 会被忽略。前端校验、客户端证书、以及大多数密码套件选项属于实现相关或 Extended，不是 Core。

跨命名空间引用默认是禁止的。`infra` 里的 Gateway 不能直接取走 `certs` 里的证书 Secret，`apps` 里的 HTTPRoute 也不能转发到 `payments` 里的 Service，除非*目标命名空间的所有者*在那边创建一条 `ReferenceGrant`。这条授权列出谁可以指过来（`from`：group、kind、namespace），以及他们可以指什么（`to`：group、kind，可选地加上名字）。授权不能伸到自己的命名空间之外。规范对状态也写得很谨慎：如果一次跨命名空间引用没有授权，实现**不得**透露目标是否存在。条件应该说缺少 `ReferenceGrant`，而不是说某个 Secret 或 Service 在或不在。这条规则是为了避免一个租户命名空间里的 Route 去探测它本不该看见的对象。

`ReferenceGrant` 从 v0.6.0 起就在标准通道里。它目前仍是 v1beta1 种类，版本说明里把它写成在 Gateway API 中冻结，等待迁入由 sig-auth 负责的核心 Kubernetes API。在那之前，它仍然随 Gateway API 一起安装。

## 7. 同一条 Route，用在东西向：GAMMA

GAMMA（Gateway API for Mesh / Multi-cluster）在 v1.1.0 毕业到标准通道。在网格场景里，一个集群通常只有一张网格，所以不再使用 `Gateway` 和 `GatewayClass`。HTTPRoute（或 GRPCRoute）把 `parentRefs` 设成一个 **Service**。网格随后把这条 Route 应用到目的地是该 Service 的流量上，包括那些从不经过南北向监听器的集群内东西向调用。

这就是设计的另一半：边缘和网格共用一套路由词汇。一个团队可以写出“把 `checkout.payments` 的 10% 打到新版本”，而不用再学第二套 CRD。在项目的实现列表里，Cilium 和 Istio 是符合这一模型的服务网格实现；不少 Gateway 控制器实现了南北向那一半，包括 Envoy Gateway、Cilium、Istio、NGINX Gateway Fabric、Traefik、Kong Operator、Kgateway，以及 GKE 的 Gateway 控制器。符合性是按实现公布的，和 Extended 字段上的功能对等不是一回事。

## 8. 告别 Ingress

Ingress 并没有从 Kubernetes 里删除，也仍有一些 Ingress 控制器在维护。2026 年 3 月结束的，是作为 Kubernetes 项目控制器、并且还有安全响应的 Ingress NGINX。对仍在运行它的集群，推荐的去向是 Gateway API；如果有理由继续留在 Ingress API 上，也可以换一个仍在维护的 Ingress 控制器。

[Ingress2Gateway 1.0](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/) 发布于 2026 年 3 月 20 日，是迁移助手，不是一次性的替换工具。它读取 Ingress 对象——包括一部分有用的 Ingress NGINX 注解——输出 Gateway 和 HTTPRoute 清单，并对无法忠实映射的地方给出警告。CORS 注解会变成 CORS 过滤器；HTTP 到 HTTPS 的重定向会变成 80 端口上的一条 `RequestRedirect` 规则；正则路径会被写成 `RegularExpression` 匹配，工具还会提醒你：Ingress NGINX 的正则其实是不区分大小写的前缀匹配，这往往不是你想保留的行为。配置片段（snippets）无法翻译。TCP 层面的 `proxy-read-timeout` / `proxy-send-timeout` 会被尽力映射成 `timeouts.request`，但那不是同一只时钟。`proxy-body-size` 会被丢掉，并注明大多数实现有自己的请求体大小默认值。URL 规范化不是 Gateway API 的功能。正确的用法是：先生成一份清单，把每一条警告读完，然后再改。

一次干净的迁移，也意味着丢掉一些旧习惯。Snippets 和其他控制器私有的逃逸口，应当变成受支持的过滤器，或你愿意自己维护的 `ExtensionRef`，或者干脆取消。监听器隔离必须被有意识地设计：如果 `shop.example.com` 应该和 `*.example.com` 共享同一条兜底规则，这些主机名就该待在同一个监听器上，或者这个精确主机需要自己的完整规则集。

## 9. 取舍

Gateway API 是一份接口。它不会自己变出一个代理；两个“符合规范”的实现，在每一个 Extended 字段上仍可能不同——重试、超时、CORS、请求镜像、正则方言、以及 50/50 分流究竟怎么落地。如果你的边缘依赖某种实现相关的行为，你还是得去读某一家的文档，只不过边界比注解前缀更诚实。

南北向的 Gateway 也不是服务网格。它可以在边缘切换流量、终结 TLS、应用过滤器；它本身不会在集群内的 Service 之间提供 mTLS、身份或重试。只有你同时运行一个实现了 GAMMA 的网格时，GAMMA 才会补上这道缝。有些产品（Istio、Cilium）两个角色都能演；许多 Gateway 控制器不能。常见的生产形态是：用 Gateway 做入口，需要的时候再用网格做东西向，两边配置同一类 Route。

暂时不采用 Gateway API，仍然可能有理由：一套你已经熟悉的托管 Ingress 控制器；数据面对 Gateway 的支持还只是部分符合（官方列表目前包括 AWS Load Balancer Controller、Amazon EKS / VPC Lattice，以及 Gloo Gateway）；或者一整支仍停留在 Ingress NGINX 上的集群，需要小心地翻译注解。这些是排期问题，并不能说明 Ingress API 还有很大的生长空间。

## 10. 一个可运行的模型

下面的脚本是前面这些规则的一个压缩模型：按元素匹配的 `PathPrefix`、字面量的 `Exact`、监听器隔离、主机名交集与特异性、HTTPRoute 的优先级列表、`allowedRoutes` 的 `Same` 与 `All`，以及不能使用时仍按份额返回 500 或 503 的带权重后端。它不模拟正则匹配、过滤器或 TLS，也不是一个数据面。它的用处，是让那些容易算错的情形变成可以度量的结果。

```python
"""A compact model of Kubernetes Gateway API HTTP routing.

The matching, listener isolation, PathPrefix element rules, weight
proportions, and invalid-backend 500 behavior follow the Gateway API
HTTPRoute and Gateway type comments (upstream kubernetes-sigs/gateway-api,
apis/v1). RegularExpression path matches are omitted: their precedence is
implementation-specific, so a portable model cannot rank them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


def path_elements(path: str) -> list[str]:
    """Split a URL path into elements, ignoring a trailing slash."""
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    if path == "/" or path == "":
        return []
    return [part for part in path.split("/") if part]


def path_matches(path_type: str, value: str, request_path: str) -> bool:
    if path_type == "Exact":
        # Exact is case-sensitive and does not ignore a trailing slash.
        return request_path == value
    if path_type == "PathPrefix":
        # Element-wise, case-sensitive; a trailing slash on the prefix is ignored.
        # "/" matches every request. "/abc" matches "/abc", "/abc/", "/abc/def",
        # but not "/abcd".
        prefix = path_elements(value) if value != "/" else []
        if not prefix:
            return True
        elements = path_elements(request_path)
        return elements[: len(prefix)] == prefix
    raise ValueError(f"unsupported path type: {path_type}")


def hostname_matches(pattern: str, host: str) -> bool:
    """Exact hostname, or a leading '*.' suffix match that does not include the bare parent."""
    if pattern.startswith("*."):
        suffix = pattern[1:]  # ".example.com"
        parent = pattern[2:]  # "example.com"
        return host.endswith(suffix) and host != parent
    return host == pattern


def hostname_intersection(
    listener_host: Optional[str], route_hosts: list[str]
) -> Optional[list[str]]:
    """Return the intersecting hostnames, or None if the route cannot attach."""
    if listener_host is None:
        return list(route_hosts) if route_hosts else [None]  # type: ignore[list-item]
    if not route_hosts:
        return [listener_host]
    accepted: list[str] = []
    for route_host in route_hosts:
        if hostname_matches(listener_host, route_host) or hostname_matches(
            route_host, listener_host
        ) or listener_host == route_host:
            # Keep only route hostnames that actually intersect the listener.
            # A listener "*.example.com" accepts shop.example.com and *.example.com,
            # but not example.com or shop.example.net.
            if listener_host.startswith("*."):
                if route_host == listener_host or hostname_matches(listener_host, route_host):
                    accepted.append(route_host)
            elif route_host.startswith("*."):
                if hostname_matches(route_host, listener_host):
                    accepted.append(route_host)
            elif route_host == listener_host:
                accepted.append(route_host)
    return accepted or None


def hostname_specificity(pattern: Optional[str], host: str) -> tuple[int, int, int]:
    """Higher is more specific: exact non-wildcard first, then character counts.

    The HTTPRoute hostname comments rank intersecting hostnames by the
    number of characters in a matching non-wildcard hostname, then by the
    number of characters in a matching hostname.
    """
    if pattern is None:
        return (0, 0, 0)
    if pattern.startswith("*."):
        if hostname_matches(pattern, host):
            return (1, 0, len(pattern))
        return (0, 0, 0)
    if pattern == host:
        return (2, len(pattern), len(pattern))
    return (0, 0, 0)


@dataclass(frozen=True)
class Match:
    path_type: str = "PathPrefix"
    path: str = "/"
    method: Optional[str] = None
    headers: dict[str, str] = field(default_factory=dict)
    query: dict[str, str] = field(default_factory=dict)

    def accepts(self, req: "Request") -> bool:
        if not path_matches(self.path_type, self.path, req.path):
            return False
        if self.method is not None and req.method != self.method:
            return False
        for name, value in self.headers.items():
            # Header names are compared case-insensitively (RFC 7230).
            have = {k.lower(): v for k, v in req.headers.items()}
            if have.get(name.lower()) != value:
                return False
        for name, value in self.query.items():
            if req.query.get(name) != value:
                return False
        return True

    def precedence_tuple(self) -> tuple:
        is_exact = self.path_type == "Exact"
        prefix_chars = 0 if is_exact else len(self.path.rstrip("/") or "/")
        if self.path_type == "PathPrefix" and self.path == "/":
            prefix_chars = 1  # "/" is one character; least-specific prefix
        return (
            1 if is_exact else 0,
            prefix_chars,
            1 if self.method is not None else 0,
            len(self.headers),
            len(self.query),
        )


@dataclass(frozen=True)
class Backend:
    name: str
    weight: int = 1
    invalid: bool = False
    no_ready: bool = False


@dataclass
class Rule:
    matches: list[Match]
    backends: list[Backend]

    def effective_matches(self) -> list[Match]:
        return self.matches or [Match()]


@dataclass
class Route:
    namespace: str
    name: str
    created: datetime
    hostnames: list[str]
    rules: list[Rule]
    section_name: Optional[str] = None
    source_ns: Optional[str] = None  # namespace the object lives in; defaults to namespace

    @property
    def ns(self) -> str:
        return self.source_ns or self.namespace

    @property
    def key(self) -> str:
        return f"{self.ns}/{self.name}"


@dataclass
class Listener:
    name: str
    port: int
    hostname: Optional[str] = None
    allowed_from: str = "Same"  # Same or All
    gateway_ns: str = "infra"


@dataclass(frozen=True)
class Request:
    host: str
    path: str
    port: int = 80
    method: str = "GET"
    headers: dict[str, str] = field(default_factory=dict)
    query: dict[str, str] = field(default_factory=dict)


@dataclass
class Decision:
    status: int
    listener: Optional[str]
    route: Optional[str]
    rule_index: Optional[int]
    backend: Optional[str]
    reason: str


def select_listener(listeners: list[Listener], req: Request) -> Optional[Listener]:
    candidates = []
    for listener in listeners:
        if listener.port != req.port:
            continue
        if listener.hostname is None or hostname_matches(listener.hostname, req.host):
            candidates.append(listener)
    if not candidates:
        return None

    def key(listener: Listener) -> tuple:
        return hostname_specificity(listener.hostname, req.host)

    candidates.sort(key=key, reverse=True)
    return candidates[0]


def route_attaches(listener: Listener, route: Route) -> bool:
    if route.section_name is not None and route.section_name != listener.name:
        return False
    if listener.allowed_from == "Same" and route.ns != listener.gateway_ns:
        return False
    if hostname_intersection(listener.hostname, route.hostnames) is None:
        return False
    # Host of the request must also be accepted by the route (if it lists hostnames).
    return True


def route_accepts_host(route: Route, host: str) -> bool:
    if not route.hostnames:
        return True
    return any(hostname_matches(pattern, host) for pattern in route.hostnames)


def route_host_specificity(route: Route, host: str) -> tuple[int, int, int]:
    if not route.hostnames:
        return (0, 0, 0)
    return max(hostname_specificity(pattern, host) for pattern in route.hostnames)


def pick_backend(backends: list[Backend], request_index: int) -> tuple[int, Optional[str], str]:
    """Return (status, backend name, reason) for the request_index-th request.

    Weight is weight/sum(weights). A zero-weight entry receives no traffic.
    An invalid entry still occupies its share and yields HTTP 500. A backend
    with no ready endpoints occupies its share and yields HTTP 503.
    """
    live = [b for b in backends if b.weight > 0]
    if not live:
        return 500, None, "no positive-weight backend"
    total = sum(b.weight for b in live)
    slot = request_index % total
    acc = 0
    for backend in live:
        acc += backend.weight
        if slot < acc:
            if backend.invalid:
                return 500, backend.name, "invalid backend occupies its weight"
            if backend.no_ready:
                return 503, backend.name, "no ready endpoints"
            return 200, backend.name, "forwarded"
    raise AssertionError("weight walk fell off the end")


def route_request(
    listeners: list[Listener],
    routes: list[Route],
    req: Request,
    request_index: int = 0,
) -> Decision:
    listener = select_listener(listeners, req)
    if listener is None:
        return Decision(404, None, None, None, None, "no listener for host/port")

    attached = [
        route
        for route in routes
        if route_attaches(listener, route) and route_accepts_host(route, req.host)
    ]

    # Collect every (route, rule_index, match) that accepts this request.
    candidates: list[tuple[tuple, Route, int, Match]] = []
    for route in attached:
        for rule_index, rule in enumerate(route.rules):
            for match in rule.effective_matches():
                if match.accepts(req):
                    # Hostname specificity first (core for intersecting hostnames),
                    # then the HTTPRoute match precedence from the spec comments,
                    # then oldest Route, then namespace/name, then first rule.
                    key = (
                        route_host_specificity(route, req.host),
                        match.precedence_tuple(),
                        # Older creation timestamp wins: sort ascending, so negate
                        # by using the timestamp itself as a later tie-break with
                        # reversed comparison in the sort below.
                        route.created,
                        route.key,
                        rule_index,
                    )
                    candidates.append((key, route, rule_index, match))

    if not candidates:
        return Decision(
            404,
            listener.name,
            None,
            None,
            None,
            "no attached rule matched; listener isolation does not fall through",
        )

    def min_key(item: tuple) -> tuple:
        host_spec, match_prec, created, key, rule_index = item[0]
        return (
            tuple(-x for x in host_spec),
            tuple(-x for x in match_prec),
            created,
            key,
            rule_index,
        )

    winner = min(candidates, key=min_key)
    _, route, rule_index, _match = winner
    rule = route.rules[rule_index]
    status, backend, reason = pick_backend(rule.backends, request_index)
    return Decision(status, listener.name, route.key, rule_index, backend, reason)

def ts(year: int, month: int, day: int, hour: int = 0) -> datetime:
    return datetime(year, month, day, hour, tzinfo=timezone.utc)


def banner(title: str) -> None:
    print(f"\n== {title} ==")


def show(req: Request, decision: Decision) -> None:
    backend = decision.backend or "-"
    route = decision.route or "-"
    listener = decision.listener or "-"
    label = f"{req.method:6} {req.host}{req.path}"
    if req.headers:
        hdr = ",".join(f"{k}={v}" for k, v in req.headers.items())
        label += f" ({hdr})"
    print(
        f"  {label:<48} "
        f"-> {decision.status} listener={listener:<10} "
        f"route={route:<20} backend={backend:<16} ({decision.reason})"
    )


def scenario_prefix_and_exact() -> None:
    banner("Exact path wins over a longer-looking prefix, and a longer prefix wins over a shorter one")
    listeners = [Listener("http", 80, hostname="api.example.com", allowed_from="All")]
    routes = [
        Route(
            "apps",
            "root",
            ts(2026, 1, 1),
            ["api.example.com"],
            [Rule([Match("PathPrefix", "/")], [Backend("root-svc")])],
        ),
        Route(
            "apps",
            "api",
            ts(2026, 1, 2),
            ["api.example.com"],
            [Rule([Match("PathPrefix", "/api")], [Backend("api-svc")])],
        ),
        Route(
            "apps",
            "api-v1-exact",
            ts(2026, 1, 3),
            ["api.example.com"],
            [Rule([Match("Exact", "/api/v1")], [Backend("api-v1-svc")])],
        ),
        Route(
            "apps",
            "api-users",
            ts(2026, 1, 4),
            ["api.example.com"],
            [Rule([Match("PathPrefix", "/api/users")], [Backend("users-svc")])],
        ),
    ]
    requests = [
        Request("api.example.com", "/"),
        Request("api.example.com", "/api"),
        Request("api.example.com", "/api/"),
        Request("api.example.com", "/api/v1"),
        Request("api.example.com", "/api/v1/"),
        Request("api.example.com", "/api/v1/items"),
        Request("api.example.com", "/api/users"),
        Request("api.example.com", "/api/users/42"),
        Request("api.example.com", "/apiv1"),
        Request("api.example.com", "/health"),
    ]
    for req in requests:
        show(req, route_request(listeners, routes, req))


def scenario_method_and_headers() -> None:
    banner("After path ties, a method match and then more header matches win")
    listeners = [Listener("http", 80, hostname="shop.example.com", allowed_from="All")]
    # All three rules use the same PathPrefix "/", so path does not decide.
    routes = [
        Route(
            "apps",
            "shop",
            ts(2026, 3, 1),
            ["shop.example.com"],
            [
                Rule(
                    [Match("PathPrefix", "/", headers={"env": "canary"})],
                    [Backend("shop-canary")],
                ),
                Rule(
                    [Match("PathPrefix", "/", method="GET", headers={"env": "canary"})],
                    [Backend("shop-canary-get")],
                ),
                Rule([Match("PathPrefix", "/")], [Backend("shop-stable")]),
            ],
        )
    ]
    requests = [
        Request("shop.example.com", "/cart"),
        Request("shop.example.com", "/cart", headers={"env": "canary"}),
        Request("shop.example.com", "/cart", method="POST", headers={"env": "canary"}),
        Request("shop.example.com", "/cart", method="GET", headers={"env": "prod"}),
    ]
    for req in requests:
        show(req, route_request(listeners, routes, req))


def scenario_oldest_route_and_name() -> None:
    banner("Identical matches: oldest Route wins; equal age falls back to namespace/name")
    listeners = [Listener("http", 80, hostname="app.example.com", allowed_from="All")]
    older = Route(
        "team-a",
        "web",
        ts(2026, 2, 1, 8),
        ["app.example.com"],
        [Rule([Match("PathPrefix", "/app")], [Backend("team-a-svc")])],
    )
    newer = Route(
        "team-b",
        "web",
        ts(2026, 2, 10, 8),
        ["app.example.com"],
        [Rule([Match("PathPrefix", "/app")], [Backend("team-b-svc")])],
    )
    print("-- different creation timestamps --")
    show(Request("app.example.com", "/app/home"), route_request(listeners, [newer, older], Request("app.example.com", "/app/home")))
    twin_b = Route(
        "team-b",
        "web",
        ts(2026, 2, 1, 8),
        ["app.example.com"],
        [Rule([Match("PathPrefix", "/app")], [Backend("team-b-svc")])],
    )
    twin_a = Route(
        "team-a",
        "web",
        ts(2026, 2, 1, 8),
        ["app.example.com"],
        [Rule([Match("PathPrefix", "/app")], [Backend("team-a-svc")])],
    )
    print("-- same timestamp, alphabetical namespace/name --")
    show(Request("app.example.com", "/app/home"), route_request(listeners, [twin_b, twin_a], Request("app.example.com", "/app/home")))


def scenario_listener_isolation() -> None:
    banner("Listener isolation: a more specific hostname does not fall through to the wildcard")
    listeners = [
        Listener("specific", 80, hostname="shop.example.com", allowed_from="All"),
        Listener("wildcard", 80, hostname="*.example.com", allowed_from="All"),
    ]
    routes = [
        Route(
            "apps",
            "shop-only",
            ts(2026, 4, 1),
            ["shop.example.com"],
            [Rule([Match("Exact", "/checkout")], [Backend("checkout-svc")])],
            section_name="specific",
        ),
        Route(
            "apps",
            "wildcard-root",
            ts(2026, 4, 1),
            ["*.example.com"],
            [Rule([Match("PathPrefix", "/")], [Backend("wildcard-svc")])],
            section_name="wildcard",
        ),
    ]
    requests = [
        Request("shop.example.com", "/checkout"),
        Request("shop.example.com", "/other"),
        Request("blog.example.com", "/other"),
        Request("example.com", "/other"),
        Request("shop.example.net", "/other"),
    ]
    for req in requests:
        show(req, route_request(listeners, routes, req))


def scenario_hostname_specificity() -> None:
    banner("Hostname specificity: an exact hostname outranks a wildcard on the same listener set")
    # Two routes attached to one catch-all listener, distinguished only by hostname.
    listeners = [Listener("http", 80, hostname=None, allowed_from="All")]
    routes = [
        Route(
            "apps",
            "wildcard",
            ts(2026, 5, 1),
            ["*.example.com"],
            [Rule([Match("PathPrefix", "/")], [Backend("wildcard-svc")])],
        ),
        Route(
            "apps",
            "shop",
            ts(2026, 5, 2),  # newer, but more specific hostname
            ["shop.example.com"],
            [Rule([Match("PathPrefix", "/")], [Backend("shop-svc")])],
        ),
    ]
    for host, path in [
        ("shop.example.com", "/"),
        ("blog.example.com", "/"),
        ("example.com", "/"),
    ]:
        show(Request(host, path), route_request(listeners, routes, Request(host, path)))


def scenario_cross_namespace() -> None:
    banner("allowedRoutes from: Same rejects a Route in another namespace")
    same = [Listener("http", 80, hostname="api.example.com", allowed_from="Same", gateway_ns="infra")]
    open_ = [Listener("http", 80, hostname="api.example.com", allowed_from="All", gateway_ns="infra")]
    routes = [
        Route(
            "apps",
            "api",
            ts(2026, 6, 1),
            ["api.example.com"],
            [Rule([Match("PathPrefix", "/")], [Backend("api-svc")])],
            source_ns="apps",
        )
    ]
    req = Request("api.example.com", "/status")
    print("-- Gateway listener allowedRoutes.namespaces.from = Same --")
    show(req, route_request(same, routes, req))
    print("-- Gateway listener allowedRoutes.namespaces.from = All --")
    show(req, route_request(open_, routes, req))


def count_backends(
    listeners: list[Listener], routes: list[Route], req: Request, n: int
) -> dict[tuple[int, Optional[str]], int]:
    tallies: dict[tuple[int, Optional[str]], int] = {}
    for i in range(n):
        decision = route_request(listeners, routes, req, request_index=i)
        key = (decision.status, decision.backend)
        tallies[key] = tallies.get(key, 0) + 1
    return tallies


def print_tallies(title: str, tallies: dict[tuple[int, Optional[str]], int], n: int) -> None:
    print(f"-- {title} ({n} requests) --")
    for (status, backend), count in sorted(tallies.items(), key=lambda kv: (-kv[1], kv[0])):
        pct = 100.0 * count / n
        print(f"  status={status} backend={backend or '-':<16} count={count:<6} {pct:5.1f}%")


def scenario_weights() -> None:
    banner("Weighted backends, a zero-weight entry, and an invalid backend that keeps its share as 500")
    listeners = [Listener("http", 80, hostname="api.example.com", allowed_from="All")]
    n = 10_000
    req = Request("api.example.com", "/v2")

    split = [
        Route(
            "apps",
            "split",
            ts(2026, 7, 1),
            ["api.example.com"],
            [
                Rule(
                    [Match("PathPrefix", "/")],
                    [Backend("stable-svc", 90), Backend("canary-svc", 10)],
                )
            ],
        )
    ]
    print_tallies("90/10 weight split", count_backends(listeners, split, req, n), n)

    held = [
        Route(
            "apps",
            "held",
            ts(2026, 7, 1),
            ["api.example.com"],
            [
                Rule(
                    [Match("PathPrefix", "/")],
                    [Backend("stable-svc", 90), Backend("held-svc", 0), Backend("canary-svc", 10)],
                )
            ],
        )
    ]
    print_tallies("same split with a weight-0 backend in the list", count_backends(listeners, held, req, n), n)

    broken = [
        Route(
            "apps",
            "broken",
            ts(2026, 7, 1),
            ["api.example.com"],
            [
                Rule(
                    [Match("PathPrefix", "/")],
                    [Backend("stable-svc", 50), Backend("missing-svc", 50, invalid=True)],
                )
            ],
        )
    ]
    print_tallies("equal weights, one backend invalid", count_backends(listeners, broken, req, n), n)

    drained = [
        Route(
            "apps",
            "drained",
            ts(2026, 7, 1),
            ["api.example.com"],
            [
                Rule(
                    [Match("PathPrefix", "/")],
                    [Backend("stable-svc", 50), Backend("draining-svc", 50, no_ready=True)],
                )
            ],
        )
    ]
    print_tallies("equal weights, one backend has no ready endpoints", count_backends(listeners, drained, req, n), n)


def main() -> None:
    scenario_prefix_and_exact()
    scenario_method_and_headers()
    scenario_oldest_route_and_name()
    scenario_listener_isolation()
    scenario_hostname_specificity()
    scenario_cross_namespace()
    scenario_weights()


if __name__ == "__main__":
    main()
```

第一组情形把四条 Route 挂在同一个监听器上：兜底前缀 `/`、前缀 `/api`、精确路径 `/api/v1`，以及更长的前缀 `/api/users`。

- `/` 和 `/health` 打到 `root-svc`。`/apiv1` 也是，因为 `PathPrefix /api` 是按元素匹配的，不会把 `/apiv1` 看成 `/api` 的孩子。
- `/api` 和 `/api/` 打到 `api-svc`，`/api/v1/` 和 `/api/v1/items` 也是。`Exact /api/v1` 只赢得字面路径 `/api/v1`。多一个尾斜杠就退回前缀，这正是规范对 `Exact` 的要求。
- `/api/users` 和 `/api/users/42` 打到 `users-svc`，因为在没有 `Exact` 的情况下，更长的前缀会压过更短的。

请求头与方法那一组，在同一条 Route 上放了三条规则，前缀都是 `/`。没有 `env` 头的请求落到兜底的 `shop-stable`。同一路径带上 `env: canary` 并且是 `GET`，落到 `shop-canary-get`，也就是写了方法的那条；只写了请求头的 canary 规则其实也能匹配，但输了，因为方法匹配的优先级高于请求头个数。带同样请求头的 `POST` 用不上 GET 那条规则，于是落到只按请求头匹配的 canary 后端。`GET` 加上 `env: prod` 则只匹配兜底规则。

当两条 Route 写了完全相同的前缀、并且再没有别的区分时，创建时间更早的获胜——`team-a/web` 早九天创建，即便较新的那条在列表里排在前面，也还是选它。时间戳相同时，按 `{namespace}/{name}` 的字母序，`team-a/web` 排在 `team-b/web` 前面。

监听器隔离是最容易用手算错的结果。一个只为 `shop.example.com` 配了 `Exact /checkout` 的监听器，对这条路径返回 200，对同一主机上的 `/other` 返回 **404**，哪怕旁边那个 `*.example.com` 监听器上有一条兜底 Route。`blog.example.com/other` 由通配监听器服务。`example.com` 不会：`*.example.com` 是后缀匹配，不包含它的父域。`shop.example.net` 两个监听器都匹配不上。

在一个没有声明主机名的监听器上，主机名特异性是同一思想的温和版本。`shop.example.com` 会被精确主机名的 Route 认领，即使这条 Route 比通配 Route 更新。`blog.example.com` 走通配。`example.com` 哪个主机名都不匹配，于是是 404。

`allowedRoutes.namespaces.from: Same` 是硬门。`apps` 里的 Route 不会挂到 `infra` 里的 Gateway 监听器上，除非把监听器放宽到 `All`；在那之前，请求是 404，不会侥幸绑上去。

最后，对 10,000 次请求做权重分配，用 `request_index modulo total_weight`，让比例是精确的：

| 设置 | 10,000 次请求的结果 |
| --- | --- |
| 权重 90 与 10 | 9,000 次到 `stable-svc`，1,000 次到 `canary-svc`（90.0% / 10.0%） |
| 同一份列表再加上一个权重为 0 的后端 | 不变：权重为 0 的项分不到任何请求 |
| 权重相等，其中一个后端无效 | 5,000 次 HTTP 200 打到有效的 Service，5,000 次 HTTP 500（50.0% / 50.0%） |
| 权重相等，其中一个 Service 没有就绪端点 | 5,000 次 HTTP 200，5,000 次 HTTP 503（50.0% / 50.0%） |

500 和 503 这两种情形，是设计时真正要围着转的。一次“50/50 切换”如果切到一个还没有被授权、或者 Pod 还没有就绪的后端，并不会变成 100% 打到还活着的那一侧。一半流量会按规范失败，因为规范拒绝通过重分权重，把一个坏掉的引用藏起来。

## 小结

- Gateway API 用一套面向角色的资源图，取代了单个 Ingress 对象：`GatewayClass` 指出控制器，`Gateway` 是带监听器的流量基础设施实例，类型化的 Route 描述 HTTP 或 gRPC 行为。挂载是双向的，默认情况下监听器只接受同一命名空间里的 Route。
- 主机名在监听器和 Route 之间求交集。`*.example.com` 是后缀匹配，不包含 `example.com`。被一个监听器认领的流量不会落到另一个监听器；一个精确主机如果缺少对应路径的规则，结果是 404，即便通配监听器本来能服务它。
- 同一条规则里的 match 是或，单个 match 里的条件是与。`Exact` 是字面的、区分大小写的。`PathPrefix` 按元素匹配，所以 `/api` 不会匹配 `/apiv1`。优先级是 Exact，然后按字符数最长的前缀，然后是方法，然后是请求头个数，然后是查询参数个数，然后是更老的 Route，然后是 `{namespace}/{name}`，然后是列表顺序。正则路径的优先级不可移植。
- 后端权重是比例，不是百分数。无效后端会按自己的份额返回 HTTP 500；没有就绪端点的 Service 应当返回 503，并套用同一套比例规则。权重 0 分不到流量。
- 跨命名空间的后端和证书，需要在目标命名空间里有一条 `ReferenceGrant`。状态不得透露一个未经授权的目标是否存在。
- GAMMA 从 v1.1 起属于标准通道，把同一类 Route 挂到 Service 上，让网格在东西向使用它们。Gateway 本身仍然不是一张网格。
- Ingress NGINX 的维护已于 2026 年 3 月结束。Ingress2Gateway 1.0 可以把一部分有用的 Ingress 和 Ingress NGINX 注解翻译成 Gateway API 对象，并会清楚地告诉你哪些没有映射上。它是起点，不是一次已经完成的迁移。
- 文中的模型复现了官方的匹配、隔离和权重规则。值得记住的结果是：监听器隔离带来的 404、`/api/v1` 只精确匹配它自己，以及带权重的一对后端里有一半无效时出现的 50% HTTP 500。

## 参考资料

- Kubernetes SIG Network，[Gateway API](https://gateway-api.sigs.k8s.io/docs/)（资源模型、角色、标准通道与实验通道）
- Kubernetes 文档，[Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- Gateway API，[流量匹配](https://gateway-api.sigs.k8s.io/docs/concepts/traffic-matching/)（监听器隔离）
- Gateway API，[HTTPRoute](https://gateway-api.sigs.k8s.io/reference/api-types/httproute/) 与 [HTTPRoute API 类型](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go)（匹配优先级、PathPrefix / Exact 语义、过滤器、500 / 503 规则）
- Gateway API，[ReferenceGrant](https://gateway-api.sigs.k8s.io/reference/api-types/referencegrant/)
- Gateway API，[版本说明](https://gateway-api.sigs.k8s.io/docs/concepts/versioning/) 与 [v1.7.0 发布说明](https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.7.0)（2026 年 10 月 29 日；标准通道中的 HTTPRoute 重试，[GEP-1731](https://gateway-api.sigs.k8s.io/geps/gep-1731/)）
- Gateway API，[实现列表](https://gateway-api.sigs.k8s.io/implementations/)
- Tabitha Sable（Kubernetes 安全响应委员会），[Ingress NGINX Retirement: What You Need to Know](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)，2025 年 11 月 11 日
- Kat Cosgrove（指导委员会），[Ingress NGINX: Statement from the Kubernetes Steering and Security Response Committees](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)，2026 年 1 月 29 日
- Beka Modebadze 与 Steven Jin，[Announcing Ingress2Gateway 1.0: Your Path to Gateway API](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/)，2026 年 3 月 20 日
