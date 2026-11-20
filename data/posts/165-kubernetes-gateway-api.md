---
title: "Inside Kubernetes Gateway API: Listeners, HTTPRoute Matching, ReferenceGrant and the Exit from Ingress"
tag: devops
description: How Gateway API splits north-south routing across GatewayClass, Gateway and Routes — the bidirectional attachment handshake, listener isolation and hostname intersection, the HTTPRoute match precedence the specification actually requires, weighted backends and the 500/503 rules for invalid or empty endpoints, ReferenceGrant as the cross-namespace permission, GAMMA attaching the same HTTPRoute to a Service, what the Ingress NGINX retirement changed, and a runnable model of those rules
date: "2026-11-20T14:50:00.000Z"
---

## Goal

For years, the portable unit of Kubernetes north-south routing was a single `Ingress` object: a host, a path, a Service. Everything that did not fit — header matches, traffic weights, timeouts, rewrites, CORS, request mirroring — leaked into vendor annotations. Those annotations were never portable, and they were never part of the Kubernetes API contract. A [previous post](/blog/133-kubernetes-service-networking/en) followed a request from a Service name down to kube-proxy and eBPF; this one starts one layer above, at the edge where that request first enters the cluster.

**Gateway API** is the official successor. It is not "Ingress with a new name". It splits the work across a small family of resources that follow organizational roles, makes the common routing cases first-class fields instead of annotations, and uses the same route types for east-west traffic inside a service mesh. The Standard channel of the API has been stable since v1.0 (October 2023) for `GatewayClass`, `Gateway` and `HTTPRoute`; `GRPCRoute` and the GAMMA mesh work graduated in v1.1. The current release, as of 29 October 2026, is [v1.7.0](https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.7.0).

This article covers:

1. Why Ingress ran out of road, and what the retirement of Ingress NGINX changed in practice.
2. The resource model: `GatewayClass`, `Gateway`, Routes, and the three personas they were designed around.
3. How a Route attaches: `parentRefs`, `allowedRoutes`, hostname intersection, and listener isolation.
4. HTTPRoute matching, and the precedence algorithm the specification actually requires.
5. Weighted backends, filters, timeouts, and the 500/503 rules for a backend that cannot be used.
6. TLS on the Gateway, and `ReferenceGrant` as the cross-namespace handshake.
7. GAMMA: attaching the same HTTPRoute to a Service for mesh traffic.
8. Migrating off Ingress, including what Ingress2Gateway 1.0 will and will not translate.
9. When Gateway API is the wrong lever, or only half of the answer.
10. A runnable model that applies the official match, isolation, and weight rules to a fixed set of requests.

## 1. Why Ingress stopped being enough

The Ingress API is deliberately small. That was a virtue in 2015 and a constraint later. A typical production edge needs to match on headers and methods, shift a fraction of traffic to a new revision, terminate TLS with certificates that live in another namespace, and set a request timeout. Ingress can express almost none of that without annotations, and every controller invented its own vocabulary. An object that looked portable was, in practice, married to one data plane.

The consequences showed up most clearly in Ingress NGINX, which became the default edge for a large share of clusters precisely because those annotations were so flexible. On 11 November 2025, Kubernetes SIG Network and the Security Response Committee [announced](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/) that best-effort maintenance would end in March 2026. After that date there would be no further releases, no bug fixes, and no security patches. Existing deployments would keep running and published images would remain available; they would also stop being a maintained part of the Kubernetes project. A follow-up [statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/) from the Steering and Security Response Committees in January 2026 was blunt: remaining on Ingress NGINX after retirement leaves a cluster exposed, the snippets annotation that once looked like helpful flexibility had become a serious security liability, and the project had been kept alive by one or two people working in their spare time. That statement also cited internal Datadog research, current as of January 2026, that about half of cloud-native environments still relied on Ingress NGINX. The accompanying InGate replacement never matured and was retired with it.

Gateway API exists to make the common cases portable and the rest explicitly extension points, rather than a shadow API of annotations. It does not, by itself, pick a data plane for you. That remains a separate decision, and it is one of the trade-offs at the end of this article.

## 2. A role-oriented resource model

The official documentation describes three personas, and the resources are shaped around them.

- An **infrastructure provider** publishes a cluster-scoped `GatewayClass`. The only field that matters at this layer is `spec.controllerName`, which names the controller that will reconcile Gateways of this class — the same idea as `IngressClass`, formalized.
- A **cluster operator** creates a `Gateway`: an instance of traffic-handling infrastructure, such as a cloud load balancer or an in-cluster proxy. The Gateway names its class, and it lists **listeners** — protocol, port, optional hostname, TLS, and `allowedRoutes`. A Gateway is associated with exactly one GatewayClass.
- An **application developer** creates protocol-typed Routes, usually an `HTTPRoute` or a `GRPCRoute`, that attach to a Gateway and describe how requests should match and where they should go.

The Standard channel, today, has four stable kinds that most people will use: `GatewayClass`, `Gateway`, `HTTPRoute`, and `GRPCRoute`. `ReferenceGrant`, discussed later, is the fifth object you need as soon as a Route or a Gateway points at something in another namespace. Other route types such as TCP, TLS and UDP live on the Experimental channel unless a given implementation documents otherwise. The project [recommends](https://gateway-api.sigs.k8s.io/docs/concepts/versioning/) the Standard channel by default; the Experimental channel makes no compatibility promises, and Gateway API uses Validating Admission Policies to keep experimental fields from leaking into a standard-channel installation unless you opt in.

A minimal HTTP edge looks like this. The `controllerName` is whatever the implementation documents; the string below is the placeholder used in the Kubernetes documentation, not a real controller.

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

Two properties of this graph are easy to miss.

First, attachment is **bidirectional**. The Route names the Gateway it wants in `parentRefs`; the Gateway's listener has to allow that Route, by namespace and by kind. The default for `allowedRoutes.namespaces.from` is `Same`. A Route in another namespace does not attach until the operator widens that listener to `All` or to a namespace selector, and even then a cross-namespace *backend* or *certificate* reference still needs a `ReferenceGrant`. These are different gates.

Second, a Gateway is deliberately shareable. Independent HTTPRoutes, often owned by different teams, can attach to the same listener, subject to those gates. That is the point of the role split: the operator decides the shape of the VIP and who may bind to it; application teams describe their own HTTP behavior without editing the load balancer.

## 3. Attachment, hostname intersection, and listener isolation

A Route may point at a whole Gateway, or at one listener of that Gateway via `parentRefs[].sectionName` (the listener's `name`) or via a port. Binding by port is convenient when several listeners share a number; it also couples the Route to that number, so a later port change on the Gateway has to be followed by a change on every Route. The Gateway API documentation recommends `sectionName` when you mean "this listener", and a port only when the port number itself is the contract.

Hostnames are a second, independent negotiation. A listener may advertise a hostname, a Route may list hostnames, and the Route attaches only when those sets **intersect**:

- A listener hostname of `*.example.com` is a suffix match. It accepts `shop.example.com` and `foo.shop.example.com`, and it does not accept the bare parent `example.com`.
- If both sides list hostnames and none intersect, the Route is not accepted. The implementation must raise `Accepted=False` on the corresponding `RouteParentStatus`, with a reason such as `NoMatchingListenerHostname`.
- Hostnames that do not intersect are ignored, not treated as an extra catch-all.

The sharp edge is **listener isolation**, which the official [traffic matching](https://gateway-api.sigs.k8s.io/docs/concepts/traffic-matching/) page is explicit about. Traffic that has been claimed by one listener is not allowed to fall through to another listener on the same Gateway, even if a Route attached to that other listener would have matched the request. In particular, a listener for `shop.example.com` sitting next to a listener for `*.example.com` owns every request whose Host is `shop.example.com`. If the only Route on the specific listener matches `GET /checkout`, then `GET /other` on that host is a **404**. It is not forwarded to the wildcard listener's catch-all Route. This is a common surprise when people migrate a single Ingress controller that merged every host into one routing table.

When several HTTPRoutes do attach to the same listener and specify intersecting hostnames, precedence goes to the Route with the largest number of characters in a matching non-wildcard hostname, then to the largest number of characters in a matching hostname. An exact hostname therefore outranks a wildcard for the same request. Evaluating that precedence against the original Route hostnames, rather than against the computed intersection with the listener, is an Extended feature named `GatewayRouteHostnameIntersectionPrecedence`.

## 4. HTTPRoute matching

Once a request has a listener and a set of attached Routes, HTTPRoute rules decide which rule, if any, handles it. Each rule has a list of `matches`. Matches in the same rule are **OR**; the conditions inside a single match — path, headers, query parameters, method — are **AND**. If a rule lists no matches, the default is a `PathPrefix` of `/`, which matches every request.

Path matching is Core for `Exact` and `PathPrefix`, and implementation-specific for `RegularExpression`. The two Core types are stricter than a string-prefix check:

- `Exact` is case-sensitive and literal. A match on `/api/v1` accepts only `/api/v1`. It does not accept `/api/v1/`, `/api/v1/items`, or `/Api/v1`.
- `PathPrefix` is case-sensitive and **element-wise**. The path is split on `/`; a trailing slash on the prefix is ignored. `/api` matches `/api`, `/api/`, and `/api/users`, and it does not match `/apiv1`. A prefix of `/` matches every request. The specification notes that this is the same semantics as the Ingress `Prefix` path type.

Several rules, often from several Routes, can match the same request. The specification requires implementations to pick exactly one, using this order, continuing on ties. The comments live on `HTTPRouteRule.Matches` in the [HTTPRoute API types](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go):

1. An `Exact` path match wins over any prefix.
2. Among prefixes, the match with the **largest number of characters** in the path value wins.
3. A match that specifies an HTTP method wins over one that does not.
4. The largest number of header matches.
5. The largest number of query-parameter matches.
6. If ties remain **across Routes**: the oldest Route by creation timestamp, then the Route whose `{namespace}/{name}` is first in alphabetical order.
7. If ties remain **inside one Route**: the first matching rule in list order.

The precedence of `RegularExpression` path matches is deliberately implementation-specific. A portable configuration should not depend on regexes outranking, or being outranked by, an `Exact` or `PathPrefix` rule. If no attached rule matches, the implementation **MUST** return HTTP 404.

Two consequences follow, and they are worth memorizing. First, `Exact /api/v1` does not "cover the v1 tree"; the tree still belongs to whatever prefix remains, usually `/api`. Second, a method match outranks a richer header match on the same path. The list is not "more conditions win". It is the list above, in that order.

## 5. Weights, filters, timeouts, and failures

A rule's `backendRefs` is a weighted list. The proportion for each entry is `weight / sum(weights)`. Weight is not a percentage and does not have to add up to 100; the default is 1, the maximum is 1,000,000, and a weight of 0 receives no traffic. Support for weight is Core.

What happens when a backend cannot be used is also specified, and it is not "skip this entry and redistribute". If every backend on the rule is invalid and the rule has no filters, every matching request **MUST** receive HTTP 500. If only some backends are invalid, the fraction of requests that would have gone to those backends **MUST** still receive 500 — the official illustration is two equal weights, one invalid, half the traffic getting 500. Implementations may choose how that half is selected; they may not quietly pour it into the surviving backend. A reference is invalid, among other reasons, when the kind is unknown, the object is missing, a cross-namespace reference has no `ReferenceGrant`, or the Service's `appProtocol` cannot be honored. When the referent is a Service with no ready endpoints, implementations **SHOULD** return 503 instead of 500, and the same proportional rule applies.

Filters are the portable substitute for a large class of Ingress annotations. They run on a matched request, and implementations SHOULD apply them in listed order. The conformance levels matter:

- **Core**, which every implementation must support: `RequestHeaderModifier`, `ResponseHeaderModifier`, `RequestRedirect`.
- **Extended**, which implementations are encouraged to support: `RequestMirror`, `URLRewrite`, `CORS`, and the `timeouts` field (`request` for the overall transaction, `backendRequest` for the hop to a backend, with a zero duration meaning "disable" where the data plane can). In v1.7.0, HTTPRoute retries — `codes`, `attempts`, and `backoff` — also graduated to the Standard channel, following [GEP-1731](https://gateway-api.sigs.k8s.io/geps/gep-1731/). `backoff` remains implementation-specific, because jitter and the exact delay function vary between data planes.
- **Implementation-specific**: an `ExtensionRef` that points at a custom filter. If that reference cannot be resolved, the filter MUST NOT be skipped; the request MUST receive an HTTP error.

`RequestRedirect` and `backendRefs` are mutually exclusive on the same rule, which is how an HTTP-to-HTTPS listener is expressed without inventing a dummy Service. `RequestMirror` copies a request to a second backend and discards that backend's response; it does not wait for it, and it is not a substitute for a weight.

## 6. TLS and ReferenceGrant

A listener's TLS mode is `Terminate` by default, or `Passthrough`. Terminate presents a certificate from `certificateRefs` — Core support is a single reference to a `kubernetes.io/tls` Secret — and decrypts at the Gateway. Passthrough routes on SNI and leaves the TLS session to the backend; `certificateRefs` is ignored. Frontend validation, client certificates, and most cipher options are implementation-specific or Extended, not Core.

Cross-namespace references are denied by default. A Gateway in `infra` may not pick up a certificate Secret in `certs`, and an HTTPRoute in `apps` may not forward to a Service in `payments`, unless the *owner of the target namespace* creates a `ReferenceGrant` there. The grant lists who may point (`from`: group, kind, namespace) and what they may point at (`to`: group, kind, optionally a name). The grant cannot reach outside its own namespace. The specification is also careful about status: if a cross-namespace reference is made without a grant, implementations MUST NOT reveal whether the target exists. The condition should say that a `ReferenceGrant` is missing, not that a Secret or Service is or is not present. That rule exists to keep a Route in a tenant namespace from probing objects it is not allowed to see.

`ReferenceGrant` has been in the Standard channel since v0.6.0. It is still a v1beta1 kind, and the versioning guide describes it as frozen in Gateway API while the work to move it into core Kubernetes under sig-auth proceeds. Until that happens, it remains part of a Gateway API installation.

## 7. The same Route, east-west: GAMMA

The GAMMA initiative (Gateway API for Mesh / Multi-cluster) graduated to the Standard channel in v1.1.0. In the mesh case there is usually one mesh per cluster, so `Gateway` and `GatewayClass` are not used. An HTTPRoute (or GRPCRoute) sets `parentRefs` to a **Service**. The mesh then applies that Route to traffic whose destination is the Service, including in-cluster east-west calls that never pass a north-south listener.

That is the other half of the design: one routing vocabulary for the edge and for the mesh. A team can describe "send 10% of `checkout.payments` to the new revision" without learning a second set of CRDs. As of the project's implementations list, Cilium and Istio are the conformant service-mesh implementations of this model; several Gateway controllers also implement the north-south half, including Envoy Gateway, Cilium, Istio, NGINX Gateway Fabric, Traefik, Kong Operator, Kgateway, and GKE's Gateway controller. Conformance is published per implementation and is not the same thing as feature parity on Extended fields.

## 8. Leaving Ingress

Ingress is not deleted from Kubernetes, and several Ingress controllers remain maintained. What ended in March 2026 is Ingress NGINX as a Kubernetes-project controller with a security response. For clusters that still run it, the recommended path is Gateway API, or another Ingress controller if you have a reason to stay on the Ingress API.

[Ingress2Gateway 1.0](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/), released on 20 March 2026, is a translation aid, not a one-shot replacement. It reads Ingress objects — including a useful subset of Ingress NGINX annotations — and emits Gateway and HTTPRoute manifests, along with warnings for what it could not map faithfully. CORS annotations become a CORS filter; an HTTP-to-HTTPS redirect becomes a `RequestRedirect` rule on port 80; a regex path is rewritten as a `RegularExpression` match, and the tool warns that Ingress NGINX regexes were case-insensitive prefix matches, which is often not what you want to keep. Configuration snippets do not translate. TCP-level `proxy-read-timeout` / `proxy-send-timeout` become a best-effort `timeouts.request`, which is not the same clock. `proxy-body-size` is dropped, with a note that most implementations have their own body-size defaults. URL normalization is not a Gateway API feature. The right use of the tool is to generate a first manifest, read every warning, and then edit.

A clean migration also means giving up some habits. Snippets and other controller-specific escapes should become supported filters, or an `ExtensionRef` you are willing to own, or they should disappear. Listener isolation has to be designed on purpose: if `shop.example.com` should share a catch-all with `*.example.com`, those hostnames belong on the same listener, or the specific host needs its own complete set of rules.

## 9. Trade-offs

Gateway API is an interface. It does not provision a proxy by itself, and two "conformant" implementations can still differ on every Extended field — retries, timeouts, CORS, request mirroring, regex dialects, how a 50/50 split is realized. If your edge depends on a behavior that is implementation-specific, you are back to reading one vendor's documentation, only with a more honest API boundary than an annotation prefix.

A north-south Gateway is also not a service mesh. It can shift traffic, terminate TLS, and apply filters at the edge; it does not, by itself, give you mTLS, identity, or retries between in-cluster Services. GAMMA closes that gap only if you also run a mesh that implements it. Some products (Istio, Cilium) can play both roles; many Gateway controllers cannot. The usual production shape is a Gateway for ingress and, where you need it, a mesh for east-west, configured with the same Route kinds.

There are still reasons to stay off Gateway API for a while: a managed Ingress controller you already understand, a data plane whose Gateway support is only Partially Conformant (the official list currently includes AWS Load Balancer Controller, Amazon EKS / VPC Lattice, and Gloo Gateway), or a fleet that has not yet left Ingress NGINX and needs a careful translation of annotations. Those are scheduling decisions, not arguments that the Ingress API has more room to grow.

## 10. A runnable model

The script below is a compact model of the rules in the previous sections: element-wise `PathPrefix`, literal `Exact`, listener isolation, hostname intersection and specificity, the HTTPRoute precedence list, `allowedRoutes` `Same` versus `All`, and weighted backends that keep their share as 500 or 503 when they cannot be used. It does not model regex matches, filters, or TLS, and it is not a data plane. It exists to make the surprising cases quantitative.

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

The first scenario hangs four Routes on one listener: a catch-all prefix `/`, a prefix `/api`, an exact path `/api/v1`, and a longer prefix `/api/users`.

- `/` and `/health` go to `root-svc`. So does `/apiv1`, because `PathPrefix /api` is element-wise and does not treat `/apiv1` as a child of `/api`.
- `/api` and `/api/` go to `api-svc`, as do `/api/v1/` and `/api/v1/items`. `Exact /api/v1` wins only for the literal path `/api/v1`. The trailing slash is enough to fall back to the prefix, which is exactly what the specification says `Exact` must do.
- `/api/users` and `/api/users/42` go to `users-svc`, because a longer prefix beats a shorter one once `Exact` is out of the way.

The header and method scenario puts three rules on one Route, all with prefix `/`. A request with no `env` header lands on the catch-all, `shop-stable`. The same path with `env: canary` and `GET` lands on `shop-canary-get`, which is the rule that specified a method; the header-only canary rule also matches, and loses, because a method match outranks header count. `POST` with the same header cannot use the GET rule, so it falls to the header-only canary backend. `GET` with `env: prod` matches only the catch-all.

When two Routes specify an identical prefix and nothing else distinguishes them, the older creation timestamp wins — `team-a/web`, created nine days earlier, is chosen even if the newer Route is listed first. When the timestamps are equal, alphabetical `{namespace}/{name}` selects `team-a/web` over `team-b/web`.

Listener isolation is the result that is easiest to get wrong by hand. A listener for `shop.example.com` with a single `Exact /checkout` rule returns 200 for that path and **404 for `/other`** on the same host, even though a sibling `*.example.com` listener has a catch-all Route. `blog.example.com/other` is served by the wildcard. `example.com` is not: a `*.example.com` pattern is a suffix match and does not include its parent. `shop.example.net` matches neither listener.

Hostname specificity, on a single catch-all listener, is the milder version of the same idea. `shop.example.com` is claimed by the exact-hostname Route even though that Route is newer than the wildcard Route. `blog.example.com` uses the wildcard. `example.com` matches neither hostname and is a 404.

`allowedRoutes.namespaces.from: Same` is a hard gate. A Route in `apps` does not attach to a Gateway listener in `infra` until the listener is widened to `All`; until then the request is a 404, not a lucky bind.

Finally, weights over 10,000 requests, using `request_index modulo total_weight` so the fractions are exact:

| Setup | Result over 10,000 requests |
| --- | --- |
| Weights 90 and 10 | 9,000 to `stable-svc`, 1,000 to `canary-svc` (90.0% / 10.0%) |
| The same list plus a weight-0 backend | Unchanged: the zero-weight entry receives nothing |
| Equal weights, one backend invalid | 5,000 × HTTP 200 to the valid Service, 5,000 × HTTP 500 (50.0% / 50.0%) |
| Equal weights, one Service with no ready endpoints | 5,000 × HTTP 200, 5,000 × HTTP 503 (50.0% / 50.0%) |

The 500 and 503 cases are the ones to design around. A "50/50 shift" onto a backend that has not been granted, or whose Pods are not ready, is not a 100% shift onto the survivor. Half of the traffic fails on purpose, because the specification refuses to hide a broken reference by redistributing its weight.

## Summary

- Gateway API replaces the single Ingress object with a role-oriented graph: a `GatewayClass` names a controller, a `Gateway` is an instance of traffic infrastructure with listeners, and typed Routes describe HTTP or gRPC behavior. Attachment is bidirectional, and the default is that a listener only accepts Routes from its own namespace.
- Hostnames intersect between listener and Route. A `*.example.com` pattern is a suffix match and does not include `example.com`. Traffic claimed by one listener does not fall through to another; a specific hostname that lacks a rule for the path is a 404, even if a wildcard listener would have served it.
- HTTPRoute matches in one rule are OR; conditions in one match are AND. `Exact` is literal and case-sensitive. `PathPrefix` is element-wise, so `/api` does not match `/apiv1`. Precedence is Exact, then longest prefix by character count, then method, then header count, then query-parameter count, then oldest Route, then `{namespace}/{name}`, then list order. Regex path precedence is not portable.
- Backend weights are proportions, not percentages. Invalid backends keep their share as HTTP 500; a Service with no ready endpoints SHOULD use 503, with the same proportional rule. Weight 0 receives no traffic.
- Cross-namespace backends and certificates require a `ReferenceGrant` in the target namespace. Status must not reveal whether an ungranted target exists.
- GAMMA, Standard since v1.1, attaches the same Route kinds to a Service so a mesh can apply them east-west. A Gateway is still not, by itself, a mesh.
- Ingress NGINX maintenance ended in March 2026. Ingress2Gateway 1.0 can translate a useful subset of Ingress and Ingress NGINX annotations into Gateway API objects and will tell you, loudly, what it could not map. It is a starting point, not a completed migration.
- The model in this post reproduces the official match, isolation, and weight rules. The results to remember are the 404 from listener isolation, the exact-only behavior of `/api/v1`, and the 50% HTTP 500 when half of a weighted pair is invalid.

## References

- Kubernetes SIG Network, [Gateway API](https://gateway-api.sigs.k8s.io/docs/) (resource model, personas, Standard and Experimental channels)
- Kubernetes documentation, [Gateway API](https://kubernetes.io/docs/concepts/services-networking/gateway/)
- Gateway API, [Traffic Matching](https://gateway-api.sigs.k8s.io/docs/concepts/traffic-matching/) (listener isolation)
- Gateway API, [HTTPRoute](https://gateway-api.sigs.k8s.io/reference/api-types/httproute/) and the [HTTPRoute API types](https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/httproute_types.go) (match precedence, PathPrefix / Exact semantics, filters, 500 / 503 rules)
- Gateway API, [ReferenceGrant](https://gateway-api.sigs.k8s.io/reference/api-types/referencegrant/)
- Gateway API, [Versioning](https://gateway-api.sigs.k8s.io/docs/concepts/versioning/) and the [v1.7.0 release](https://github.com/kubernetes-sigs/gateway-api/releases/tag/v1.7.0) (29 October 2026; HTTPRoute retries in Standard, [GEP-1731](https://gateway-api.sigs.k8s.io/geps/gep-1731/))
- Gateway API, [Implementations](https://gateway-api.sigs.k8s.io/implementations/)
- Tabitha Sable (Kubernetes Security Response Committee), [Ingress NGINX Retirement: What You Need to Know](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), 11 November 2025
- Kat Cosgrove (Steering Committee), [Ingress NGINX: Statement from the Kubernetes Steering and Security Response Committees](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/), 29 January 2026
- Beka Modebadze and Steven Jin, [Announcing Ingress2Gateway 1.0: Your Path to Gateway API](https://kubernetes.io/blog/2026/03/20/ingress2gateway-1-0-release/), 20 March 2026
