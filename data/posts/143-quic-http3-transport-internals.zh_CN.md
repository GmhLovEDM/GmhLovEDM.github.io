---
title: "深入 QUIC 与 HTTP/3：连接 ID、流、丢包恢复与生产环境落地"
tag: devops
description: 深入 HTTP/3 底层的传输协议——TCP + TLS 为什么走到了瓶颈，QUIC 如何把 TLS 1.3 握手融入传输层，连接 ID 与连接迁移，相互独立的流与两级流量控制，包号空间与丢包检测，0-RTT 及其重放风险，QPACK，以及在 nginx、负载均衡器和 Linux UDP 栈上部署 HTTP/3 的工程实践
date: "2026-10-29T14:20:00.000Z"
---

## 目标

如今很多头部网站都已经提供 HTTP/3，主流浏览器也默认开启。但在不少工程师眼里，它仍然只是"跑在 UDP 上的 HTTP/2"。这种说法把最有意思的部分全藏起来了。HTTP/3 本身只是一层很薄的映射，真正干活的是 **QUIC**——IETF 在 2021 年标准化的一个通用、加密、多路复用的传输协议。

本文内容：

1. 促使 QUIC 诞生的 TCP + TLS 结构性问题。
2. 握手：QUIC 如何内嵌 TLS 1.3，实现 1-RTT（甚至 0-RTT）。
3. 连接 ID、NAT 重绑定与连接迁移。
4. 流与两级流量控制——以及队头阻塞为什么（基本）消失了。
5. 包号空间、ACK 区间与丢包恢复（RFC 9002）。
6. QUIC 之上的 HTTP/3 与 QPACK。
7. 生产落地：nginx、`Alt-Svc` / HTTPS DNS 记录、负载均衡、UDP 缓冲区、GSO，以及用 qlog 做可观测性。

核心规范是 RFC 8999（与版本无关的不变量）、RFC 9000（传输）、RFC 9001（TLS）、RFC 9002（丢包检测与拥塞控制）、RFC 9114（HTTP/3）和 RFC 9204（QPACK）。下文的机制均依据这些文档描述，链接见文末。

## 1. 为什么不继续改进 TCP？

HTTP/2 已经能在一条 TCP 连接上多路复用多个请求，但还剩三个结构性问题。

**传输层队头阻塞（HOL blocking）。** TCP 只提供一条有序字节流。只要丢了一个报文段，它之后的所有字节都得在内核接收缓冲区里等重传到达——哪怕这些字节属于毫不相干的 HTTP/2 流。在丢包较多的移动网络上，HTTP/2 的多路复用甚至可能不如几条并行的 HTTP/1.1 连接，因为一次丢包会卡住所有请求。

**握手延迟。** 基于 TCP 的全新 HTTPS 连接要先做 TCP 握手（1 RTT），再做 TLS 1.3 握手（1 RTT），之后才能发出第一个请求字节。TCP Fast Open 试图解决前一半，但由于中间设备会丢弃或篡改这个选项，实际部署非常有限。

**协议僵化（ossification）。** TCP 实现在操作系统内核里，报文头对路径上的所有中间设备可见。防火墙、NAT 和各种"加速器"都对 TCP 头字段做了假设，导致扩展 TCP 又慢又脆弱；上线一个新的 TCP 特性要等几十亿台设备的内核升级。

QUIC 的答案是：在 UDP 之上、在用户态实现传输层，并且**几乎加密一切**——包括大部分传输层元数据——让中间设备无从僵化它。RFC 8999 只定义了极少数在所有 QUIC 版本中保证不变的字段（版本号、连接 ID、长/短包头标志位），其余都可以改变；RFC 9369（QUIC v2）的存在，部分就是为了实际行使这种自由。

## 2. 握手：把 TLS 1.3 放进传输层

QUIC 并不像 TCP 那样把 TLS 跑在传输层*之上*，而是把 TLS 1.3 握手当作一个密钥交换组件（RFC 9001）。TLS 握手消息放在 QUIC 的 `CRYPTO` 帧里传输，TLS 把派生出的密钥交还给 QUIC，由 QUIC 自己用 AEAD 做包保护。

一次典型的新建连接：

```text
Client                                              Server
Initial[CRYPTO: ClientHello + transport params]  -->
                                         <--  Initial[CRYPTO: ServerHello, ACK]
                                              Handshake[CRYPTO: EncryptedExtensions,
                                                        Certificate, CertVerify, Finished]
                                              1-RTT[server may already send data]
Handshake[CRYPTO: Finished, ACK]             -->
1-RTT[STREAM: HTTP request]                  -->
```

传输建立与加密协商在同一个往返内完成，客户端在 **1 RTT** 后即可发送请求，而不是 2 RTT。

有几个细节在实践中很重要：

- **传输参数**（初始流控窗口、最大流数量、空闲超时、`max_udp_payload_size` 等）放在 TLS 扩展里传递，因此受握手认证保护。
- **Initial 包是加密的，但不是保密的。** 其密钥由客户端的目标连接 ID 和一个版本相关的盐值派生，任何观察者都能解密。它防的是路径外篡改和协议僵化，而不是路径上的窃听者——除非使用加密 ClientHello（ECH），否则 ClientHello 里的 SNI 依然可见。
- **反放大限制。** UDP 源地址很容易伪造，因此在地址被验证之前，服务器发出的字节数不得超过从该地址收到字节数的**三倍**。客户端必须把携带 Initial 包的数据报填充到至少 **1200 字节**，既给服务器留出发送额度，也验证路径能承载这个大小。证书链过大可能超出 3 倍额度，多花一个往返——证书压缩（RFC 8879）和更短的证书链会有帮助。
- **Retry。** 在高负载或遭受攻击时，服务器可以回复一个带 token 的 Retry 包，客户端携带该 token 重发 Initial，以证明自己确实能在声称的地址上收包。这会多一个往返，所以服务器通常只在压力大时启用。

### 0-RTT 与重放

如果客户端持有上一次连接的会话票据，就可以在第一个 Initial 旁边直接用 **0-RTT** 包发送应用数据。延迟收益是真实的，风险也是真实的：0-RTT 数据可能被截获它的攻击者**重放**，因为此时服务器还没有收到客户端的新鲜输入。TLS 1.3（RFC 8446 第 8 节）与 RFC 9001 都把防重放留给应用层处理。

实践规则：0-RTT 只允许用于**幂等、无副作用的请求**（例如不改变状态的 `GET`）。RFC 8470 定义了代理在转发早期数据时添加的 `Early-Data: 1` 请求头，以及后端可返回的 `425 Too Early` 状态码，强制客户端在握手完成后重试。

## 3. 连接 ID 与连接迁移

TCP 连接由四元组（源 IP、源端口、目的 IP、目的端口）标识。手机从 Wi-Fi 切到蜂窝网络，或 NAT 在空闲后重新分配端口，四元组一变，连接就断了。

QUIC 用各端自选的**连接 ID（CID）**标识连接。每一端告诉对方发给自己时目标连接 ID 字段应该填什么，并可以通过 `NEW_CONNECTION_ID` 帧下发更多 CID。

- **NAT 重绑定：** 如果带着同一个 CID 的包从新地址到达，服务器可以让连接继续存活。
- **主动迁移：** 客户端可以有意切换到新路径。在新路径上发送大量数据之前，双方用 `PATH_CHALLENGE` / `PATH_RESPONSE` 帧验证路径，并为新路径重置拥塞状态，因为它的容量未知。
- **隐私：** 迁移时端点会换用新的 CID，观察者无法轻易把新旧路径关联到同一个连接。
- **服务端路由：** CID 可以编码负载均衡器所需的信息，即使客户端地址变化，也能把包路由到正确的后端。IETF 的 QUIC-LB 工作定义了相关做法；如果没有类似机制，按四元组哈希的四层负载均衡器会把迁移后的包发到错误的服务器上。

各实现对迁移的支持并不一致，通常只支持客户端发起的迁移；部署在 anycast 或普通四元组 ECMP 之后的服务端，应把它当作需要专门设计的能力，而不是免费附赠的功能。

## 4. 流与流量控制

一条 QUIC 连接承载许多**流（stream）**，每条流都是独立的有序字节序列。流的开销很低：用一个新 ID 发送 `STREAM` 帧就算打开了。流 ID 的最低两位编码了发起方以及是否双向：

| 低两位 | 类型 |
|---|---|
| `0x0` | 客户端发起，双向 |
| `0x1` | 服务端发起，双向 |
| `0x2` | 客户端发起，单向 |
| `0x3` | 服务端发起，单向 |

丢失的数据**按流**重传。若某个包含流 4 数据的包丢了，流 8 依然可以把自己的数据交付给应用。这消除了跨流的传输层队头阻塞，但*单条流内部*的队头阻塞依然存在；如果应用层自己把东西串行化了，QUIC 也无能为力（后面会看到，QPACK 为了不重新引入队头阻塞费了很大功夫）。

**流量控制**分两级：

- 流级：`MAX_STREAM_DATA` 限制对端在单条流上可发送的字节数。
- 连接级：`MAX_DATA` 限制所有流的总和。

并发流数量还受 `MAX_STREAMS` 限制（双向、单向分别计算）。想要高吞吐，接收方必须足够快地扩大窗口以覆盖带宽时延积，很多实现会自动调优。基准对比中 QUIC 吞吐不理想的常见原因，就是在高 RTT 路径上窗口设得太小。

流可以用 `RESET_STREAM`（发送方放弃）或 `STOP_SENDING`（接收方要求对方停止）异常终止，HTTP/3 用它们来取消请求而不必关闭整个连接。

对于完全不需要可靠性的数据——游戏状态、媒体、隧道里的 IP 包——**DATAGRAM** 扩展（RFC 9221）在加密连接内承载不可靠但受拥塞控制的消息。它是 MASQUE（`CONNECT-UDP`，RFC 9298）和 WebTransport 数据报的基础。

## 5. 包、ACK 与丢包恢复

### 包号空间

QUIC 有三个**包号空间**：Initial、Handshake 和 Application Data（0-RTT 与 1-RTT 共用最后一个）。每个空间有独立的密钥和 ACK，因此 Handshake 包永远不会被 1-RTT 的 ACK 确认。不同类型的多个 QUIC 包可以**合并（coalesce）**进同一个 UDP 数据报，服务器的第一批数据正是这样把 Initial + Handshake + 1-RTT 装在一起的。

### 单调递增的包号

在 TCP 中，重传的报文段沿用原来的序列号，ACK 到达时发送方并不总能分清它确认的是原始报文还是重传报文——这就是经典的*重传歧义*，让 RTT 估计变得复杂。QUIC 的包号**永不复用**：重传的是*帧*，放进一个带新包号的*新*包里。因此每个 ACK 都没有歧义，每次 RTT 测量都是干净的。

`ACK` 帧还携带 **ACK 区间**（类似 TCP SACK，但没有 TCP 选项空间那种很小的固定上限）以及显式的 **ACK Delay**，发送方可以从 RTT 测量中扣除接收方有意的延迟确认时间。端点通过传输参数通告 `max_ack_delay`。

### 丢包检测（RFC 9002）

当一个更晚发送的包已被确认，且满足以下任一条件时，该包被判定为丢失：

- **包数阈值：** 它比已确认的最大包号至少小 3（`kPacketThreshold = 3`）；或
- **时间阈值：** 它的发送时间早于 `9/8 × max(smoothed_rtt, most_recent_rtt)`，以最新确认到达的时刻为基准（`kTimeThreshold = 9/8`）。

当完全收不到回应时，**探测超时（PTO）**触发：

```text
PTO = smoothed_rtt + max(4 × rttvar, kGranularity) + max_ack_delay
```

连续 PTO 时按指数退避。PTO 本身并不等于丢包，也不会像 TCP RTO 那样把拥塞窗口打回最小；发送方只是发出一两个需要确认的探测包。判定"持续拥塞"需要更长时间都收不到 ACK。

### 拥塞控制

RFC 9002 规定了一个类似 NewReno 的默认算法，但拥塞控制是可插拔的，而且因为运行在用户态，服务端无需升级内核就能上线新算法。生产环境的协议栈普遍使用 CUBIC 和各种 BBR 变体。这种灵活性是双刃剑：很容易部署一个过于激进或有 bug 的控制器，因此修改拥塞控制要像任何改变线上流量行为的变更一样谨慎。

### 包头保护

包号和部分包头位本身也经过**包头保护**加密（掩码由密文中的若干字节派生）。中间设备看不到包号，也无法据此推断丢包。唯一有意保留的例外是可选的**自旋位（spin bit）**，若端点选择启用，路径上的运维方可以借此估算 RTT（RFC 9000 第 17.4 节；RFC 9312 讨论了可管理性）。

## 6. HTTP/3 与 QPACK

HTTP/3（RFC 9114）把 HTTP 语义映射到 QUIC 上：

- 每个请求/响应对使用一条**客户端发起的双向流**，承载 `HEADERS` 和 `DATA` 帧。
- 双方各开一条**控制流**（单向流类型 `0x00`），第一帧是 `SETTINGS`。
- 服务器推送使用类型 `0x01`（很少使用，Chrome 已移除）。
- QPACK 使用**编码器流**（`0x02`）和**解码器流**（`0x03`）。

HTTP/2 需要而 HTTP/3 不再需要的东西：流级流量控制和 `PRIORITY` 帧都没了（流控由 QUIC 负责；优先级迁移到 RFC 9218 的可扩展优先级方案，即 `Priority` 头和 `PRIORITY_UPDATE` 帧）。

### 为什么不能沿用 HPACK

HPACK（HTTP/2）维护一张动态头部表，按每个头部块的严格顺序更新。在 TCP 上这没问题，因为一切都按序到达。而在 QUIC 上，不同流的头部块可能以任意顺序到达；若沿用 HPACK，一条流上的丢包会阻塞其他所有流的解码——在应用层把队头阻塞又带了回来。

**QPACK**（RFC 9204）的解法是把动态表更新放到专用的编码器流上。每个头部块声明一个 **Required Insert Count**，即它依赖的表插入次数。如果解码器还没收到这些插入，*只有这条流*会被阻塞。解码器通过 `SETTINGS_QPACK_BLOCKED_STREAMS` 限制最多允许多少条流被阻塞；编码器可以选择只引用已被确认的条目（不会阻塞，压缩率略差），也可以冒险换取更好的压缩率。这是压缩率与抗队头阻塞能力之间的显式取舍。

## 7. 在生产环境运行 HTTP/3

### 服务发现

浏览器不会盲目尝试 UDP，而是通过以下方式得知服务器支持 HTTP/3：

- HTTP/1.1 或 HTTP/2 响应中的 **`Alt-Svc`** 响应头（RFC 7838），例如 `Alt-Svc: h3=":443"; ma=86400`。首次访问一般走 TCP，之后的连接会竞速或切换到 QUIC。
- **HTTPS DNS 记录**（RFC 9460），可以在首次连接前就通告 `alpn="h3,h2"`，省掉那次 TCP 首访。

客户端始终保留 TCP 作为后备。一些企业网络会封禁 UDP/443，浏览器会让 QUIC 与 TCP 竞速或在失败后回退，所以你必须继续通过 TCP 提供 HTTP/2。

### nginx

nginx 从主线版本 1.25.0 起支持 HTTP/3（需用 `--with-http_v3_module` 编译，并搭配支持 QUIC 的 TLS 库）。最小配置如下：

```nginx
server {
    listen 443 ssl;
    listen 443 quic reuseport;   # UDP 监听；每个 address:port 只需写一次 reuseport
    http2 on;

    server_name example.com;
    ssl_certificate     /etc/ssl/example.com.pem;
    ssl_certificate_key /etc/ssl/example.com.key;
    ssl_protocols TLSv1.3;

    # 向通过 TCP 到达的客户端通告 HTTP/3
    add_header Alt-Svc 'h3=":443"; ma=86400' always;

    # 可选：仅当所有路由都可安全重放时开启
    # ssl_early_data on;
    # proxy_set_header Early-Data $ssl_early_data;
}
```

用支持 HTTP/3 的 curl 在命令行验证：

```bash
curl -sI --http3-only https://example.com/ | head -1
# HTTP/3 200
```

记得在安全组和防火墙里放行 **UDP** 443——忘了这一步，是 HTTP/3"不生效"最常见的原因。

### 一个最小的 Go 服务

使用 `quic-go`，几行代码就能同时提供 TCP 和 HTTP/3：

```go
package main

import (
	"log"
	"net/http"

	"github.com/quic-go/quic-go/http3"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello over " + r.Proto + "\n"))
	})

	// ListenAndServeTLS 在同一地址上通过 TCP 提供 HTTP/1.1 + HTTP/2，
	// 通过 UDP 提供 HTTP/3，并自动给 TCP 响应加上 Alt-Svc 头。
	log.Fatal(http3.ListenAndServeTLS(":443", "cert.pem", "key.pem", mux))
}
```

其他成熟的协议栈包括 Cloudflare 的 quiche（Rust）、微软的 MsQuic（C）、ngtcp2（C，curl 在用）、LiteSpeed 的 lsquic、Quinn（Rust）和 AWS 的 s2n-quic。Envoy、HAProxy 和 Caddy 也都支持 HTTP/3。

### Linux 上的 UDP 路径

在用户态实现 QUIC，要付出 TCP 不必付出的成本：

- **每个包一次系统调用。** 不做批处理的话，每个约 1200–1500 字节的数据报都是一次 `sendmsg`/`recvmsg`。应使用 `sendmmsg`/`recvmmsg`，以及 **UDP GSO**（`UDP_SEGMENT` 套接字选项，Linux 4.18+）和 **GRO**，让内核拆分、合并大缓冲区。Cloudflare、Google 和 Fastly 都公开写过，这些优化对 QUIC 的 CPU 效率起决定性作用。
- **没有 TCP 卸载。** TSO、内核侧 ACK 处理、网卡 TLS 卸载都用不上。同样硬件上，QUIC 每字节的 CPU 开销会明显高于 TCP + TLS；请在自己的业务负载上实测，而不是照搬别人的数字。
- **套接字缓冲区。** 很多发行版默认的 UDP 接收缓冲区较小，突发流量下会丢包。比如 quic-go 会打印警告并建议调大上限：

```bash
sysctl -w net.core.rmem_max=7500000
sysctl -w net.core.wmem_max=7500000
```

- **路径 MTU。** QUIC 要求数据报至少 1200 字节，并可以探测更大的尺寸（DPLPMTUD，RFC 8899）。MTU 较小的隧道和 VPN 会表现为握手失败。

### 负载均衡与 anycast

按四元组哈希的四层负载均衡器一直能工作，直到客户端地址发生变化——此时已有连接的包会落到一个没有该连接状态的后端。可选方案包括：CID 感知的负载均衡（像 IETF QUIC-LB 工作描述的那样把服务器 ID 编码进 CID）、按 CID 做一致性哈希，或者干脆接受迁移后的连接失败、回退到新的握手。另外要注意，内核 `SO_REUSEPORT` 在多个 worker 进程之间的分发同样按四元组进行；支持迁移的服务端常常再加一层按 CID 分流的 eBPF 程序（`SO_ATTACH_REUSEPORT_EBPF`）。

### 可观测性

你没法再在 `tcpdump` 里读序列号了。取而代之的是：

- 导出 **qlog**——一种正在 IETF 标准化的结构化 JSON 事件日志，quiche、quic-go、ngtcp2 等都支持——并用 **qvis** 可视化。
- 抓包分析时，在受控环境中用 `SSLKEYLOGFILE` 记录 TLS 密钥，导入 Wireshark 即可解密 QUIC。
- 监控握手失败率、0-RTT 接受率、h3 与 h2 的流量占比，以及 UDP 接收错误（`netstat -su` 或 `/proc/net/snmp` 中的 `RcvbufErrors`）。

## 8. HTTP/3 什么时候值得上？

| 场景 | 预期效果 |
|---|---|
| 移动端 / 高丢包 / 高 RTT 客户端 | 收益最大：握手更快、没有跨流队头阻塞、网络切换不断连 |
| 有损链路上大量小的并行请求 | 相比 HTTP/2 明显改善 |
| 数据中心东西向流量、低丢包 | 延迟收益很小、CPU 开销更高；TCP（常配合内核 TLS）通常更优 |
| 干净链路上的大文件下载 | 吞吐相近，CPU 效率更关键 |
| 封禁 UDP 的网络 | 没有收益，回退逻辑略增复杂度 |

收益主要体现在长尾：网络差的那批用户。请按连接类型分组看 p90/p99 指标，而不是看光纤网络下的中位数。

## 总结

- QUIC 把传输层搬到 UDP 之上的用户态，并几乎加密一切，以摆脱 TCP 的僵化。
- TLS 1.3 被整合进握手，实现 1-RTT 建连和可选的 0-RTT——后者必须限定在可安全重放的请求上。
- 连接 ID 让连接与地址解耦，支持 NAT 重绑定和连接迁移，代价是需要 CID 感知的负载均衡。
- 相互独立的流加上两级流量控制，消除了跨流的队头阻塞。
- 永不复用的包号、丰富的 ACK 区间和显式 ACK 延迟，使丢包恢复与 RTT 估计比 TCP 更精确。
- QPACK 精心重新设计了头部压缩，避免重新引入队头阻塞。
- 生产实践：保留 TCP 后备、放行 UDP 443、用 `Alt-Svc` 或 HTTPS DNS 记录通告、用 GSO/GRO 批量收发 UDP、调大套接字缓冲区、用 qlog 观测。

## 参考资料

- RFC 9000, "QUIC: A UDP-Based Multiplexed and Secure Transport": https://www.rfc-editor.org/rfc/rfc9000
- RFC 9001, "Using TLS to Secure QUIC": https://www.rfc-editor.org/rfc/rfc9001
- RFC 9002, "QUIC Loss Detection and Congestion Control": https://www.rfc-editor.org/rfc/rfc9002
- RFC 8999, "Version-Independent Properties of QUIC": https://www.rfc-editor.org/rfc/rfc8999
- RFC 9114, "HTTP/3": https://www.rfc-editor.org/rfc/rfc9114
- RFC 9204, "QPACK: Field Compression for HTTP/3": https://www.rfc-editor.org/rfc/rfc9204
- RFC 9221, "An Unreliable Datagram Extension to QUIC": https://www.rfc-editor.org/rfc/rfc9221
- RFC 9218, "Extensible Prioritization Scheme for HTTP": https://www.rfc-editor.org/rfc/rfc9218
- RFC 9312, "Manageability of the QUIC Transport Protocol": https://www.rfc-editor.org/rfc/rfc9312
- RFC 9460, "Service Binding and Parameter Specification via the DNS (SVCB and HTTPS RRs)": https://www.rfc-editor.org/rfc/rfc9460
- RFC 8470, "Using Early Data in HTTP": https://www.rfc-editor.org/rfc/rfc8470
- nginx 文档，"Support for QUIC and HTTP/3": https://nginx.org/en/docs/quic.html
- quic-go 文档: https://quic-go.net/docs/
- Langley 等，"The QUIC Transport Protocol: Design and Internet-Scale Deployment"（SIGCOMM 2017）
