---
title: "QUIC and HTTP/3 Internals: Connection IDs, Streams, Loss Recovery and Running It in Production"
tag: devops
description: A deep look at the transport under HTTP/3 — why TCP + TLS hit a wall, how QUIC folds the TLS 1.3 handshake into the transport, connection IDs and migration, independent streams and two-level flow control, packet number spaces and loss detection, 0-RTT and its replay risk, QPACK, and the operational side of deploying HTTP/3 behind nginx, load balancers and Linux UDP stacks
date: "2026-10-29T14:20:00.000Z"
---

## Goal

HTTP/3 is now served by a large share of the web's biggest sites and is enabled by default in every major browser. Yet for many engineers it remains "HTTP/2, but over UDP". That description hides almost everything interesting. HTTP/3 is a thin mapping; the real work happens in **QUIC**, a general-purpose, encrypted, multiplexed transport standardized by the IETF in 2021.

This article covers:

1. The problems with TCP + TLS that motivated QUIC.
2. The handshake: how QUIC embeds TLS 1.3 and reaches 1-RTT (or 0-RTT).
3. Connection IDs, NAT rebinding and connection migration.
4. Streams and two-level flow control — and why head-of-line blocking goes away (mostly).
5. Packet number spaces, ACK ranges and loss recovery (RFC 9002).
6. HTTP/3 and QPACK on top of QUIC.
7. Running it in production: nginx, `Alt-Svc` / HTTPS DNS records, load balancers, UDP buffers, GSO, and observability with qlog.

The core specifications are RFC 8999 (version-independent invariants), RFC 9000 (transport), RFC 9001 (TLS), RFC 9002 (loss detection and congestion control), RFC 9114 (HTTP/3) and RFC 9204 (QPACK). Every mechanism below is described from those documents; links are at the end.

## 1. Why not just keep improving TCP?

HTTP/2 already multiplexes many requests over one TCP connection. Three structural problems remained.

**Transport-level head-of-line (HOL) blocking.** TCP delivers one ordered byte stream. If a single segment is lost, every byte after it waits in the kernel's receive buffer until the retransmission arrives — even bytes that belong to entirely unrelated HTTP/2 streams. On a lossy mobile link, HTTP/2's multiplexing can make things worse than several parallel HTTP/1.1 connections, because one loss stalls everything.

**Handshake latency.** A fresh HTTPS connection over TCP needs a TCP handshake (1 RTT) followed by a TLS 1.3 handshake (1 RTT) before the first request byte can be sent. TCP Fast Open tried to fix the first part, but saw very limited deployment because middleboxes dropped or mangled the option.

**Ossification.** TCP lives in OS kernels and its headers are visible to every middlebox on the path. Firewalls, NATs and "accelerators" make assumptions about TCP header fields, so extending TCP is slow and fragile. Deploying a new TCP feature means waiting for kernels to update across billions of devices.

QUIC's answer is to build the transport in user space on top of UDP, and to **encrypt almost everything** — including most transport metadata — so middleboxes cannot ossify it. RFC 8999 defines the tiny set of fields that are guaranteed stable across all QUIC versions (version, connection IDs, the long/short header bit); everything else may change, and RFC 9369 (QUIC v2) exists partly to exercise that freedom.

## 2. The handshake: TLS 1.3 inside the transport

QUIC does not run TLS *over* the transport the way TCP does. Instead, it uses the TLS 1.3 handshake as a key-exchange component (RFC 9001). TLS handshake messages are carried in QUIC `CRYPTO` frames, and TLS hands the derived keys back to QUIC, which does its own packet protection with AEAD.

A typical new connection:

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

Transport and cryptographic setup happen in the same round trip, so the client can send its request after **1 RTT** instead of 2.

Some details matter in practice:

- **Transport parameters** (initial flow-control windows, max streams, idle timeout, `max_udp_payload_size`, and so on) travel inside a TLS extension, so they are authenticated by the handshake.
- **Initial packets are encrypted, but not secret.** Their keys are derived from the client's Destination Connection ID and a version-specific salt, so any observer can decrypt them. This protects against off-path tampering and ossification, not against an on-path eavesdropper — the ClientHello's SNI is visible unless Encrypted Client Hello (ECH) is used.
- **Anti-amplification.** Because UDP source addresses are trivially spoofed, a server must not send more than **three times** the bytes it has received from an address until that address is validated. Clients must pad datagrams carrying Initial packets to at least **1200 bytes**, both to give the server budget and to verify the path supports that size. A large certificate chain can exceed the 3x budget and cost an extra round trip — certificate compression (RFC 8879) and shorter chains help.
- **Retry.** Under load or attack, a server can answer with a Retry packet containing a token; the client repeats its Initial with that token, proving it can receive at its claimed address. This costs a round trip, so servers typically only use it when under pressure.

### 0-RTT and replay

If the client has a session ticket from a previous connection, it can send application data in **0-RTT** packets alongside its first Initial. The latency win is real, but so is the risk: 0-RTT data can be **replayed** by an attacker who captures it, because the server has not yet seen fresh input from the client. TLS 1.3 (RFC 8446, section 8) and RFC 9001 leave replay protection to the application.

The practical rule: only allow 0-RTT for **idempotent, side-effect-free requests** (for example `GET` without state changes). RFC 8470 defines the `Early-Data: 1` request header that a proxy adds when forwarding early data, and the `425 Too Early` status code a backend returns to force a retry after the handshake completes.

## 3. Connection IDs and migration

A TCP connection is identified by its 4-tuple (source IP, source port, destination IP, destination port). If a phone moves from Wi-Fi to cellular, or a NAT rebinds the port after an idle period, the 4-tuple changes and the connection dies.

QUIC identifies connections by **Connection IDs (CIDs)** chosen by each endpoint. Each side tells the other which CIDs to put in the Destination Connection ID field when talking to it, and can issue additional ones with `NEW_CONNECTION_ID` frames.

- **NAT rebinding:** if packets keep arriving with the same CID from a new address, the server can keep the connection alive.
- **Active migration:** the client can deliberately move to a new path. Before sending significant data there, endpoints validate the path with `PATH_CHALLENGE` / `PATH_RESPONSE` frames, and congestion state is reset for the new path, since its capacity is unknown.
- **Privacy:** on migration, an endpoint switches to a fresh CID, so an observer cannot trivially link the old and new paths to the same connection.
- **Server-side routing:** a CID can encode information a load balancer uses to route packets to the right backend even after the client's address changes. The IETF QUIC-LB work defines ways to do this; without something like it, an L4 balancer hashing on the 4-tuple will send migrated packets to the wrong server.

Migration support is uneven across implementations and is often limited to client-initiated migration; servers that sit behind anycast or plain 4-tuple ECMP should treat it as something they must engineer for, not something they get for free.

## 4. Streams and flow control

A QUIC connection carries many **streams**, each an independent ordered byte sequence. Streams are cheap: opening one is just sending a `STREAM` frame with a new ID. The two low bits of the stream ID encode who opened it and whether it is bidirectional:

| Low bits | Type |
|---|---|
| `0x0` | client-initiated, bidirectional |
| `0x1` | server-initiated, bidirectional |
| `0x2` | client-initiated, unidirectional |
| `0x3` | server-initiated, unidirectional |

Lost data is retransmitted **per stream**. If a packet containing bytes of stream 4 is lost, stream 8 can still deliver its data to the application. This removes transport-level HOL blocking across streams. It does *not* remove HOL blocking *within* a single stream, and it cannot help if the application layer serializes things itself (we will see that QPACK has to work hard to avoid reintroducing it).

**Flow control** has two levels:

- Per stream: `MAX_STREAM_DATA` caps how many bytes the peer may send on one stream.
- Per connection: `MAX_DATA` caps the total across all streams.

The number of concurrent streams is also limited by `MAX_STREAMS` (separately for bidirectional and unidirectional). A receiver that wants high throughput must grow these windows fast enough to cover the bandwidth-delay product; many implementations auto-tune them. A frequent cause of disappointing QUIC throughput in benchmarks is simply windows that are too small for a high-RTT path.

Streams can be terminated abruptly with `RESET_STREAM` (sender gives up) or `STOP_SENDING` (receiver asks the sender to stop), which HTTP/3 uses for request cancellation without tearing down the connection.

For data that does not need reliability at all — game state, media, tunneled IP packets — the **DATAGRAM** extension (RFC 9221) carries unreliable, congestion-controlled messages inside the encrypted connection. It is the basis of MASQUE (`CONNECT-UDP`, RFC 9298) and WebTransport datagrams.

## 5. Packets, ACKs and loss recovery

### Packet number spaces

QUIC has three **packet number spaces**: Initial, Handshake and Application Data (0-RTT and 1-RTT share the last). Each has its own keys and its own ACKs, so a Handshake packet can never be acknowledged by a 1-RTT ACK. Several QUIC packets of different types can be **coalesced** into a single UDP datagram, which is how the server's first flight fits Initial + Handshake + 1-RTT data together.

### Monotonic packet numbers

In TCP, a retransmitted segment reuses the original sequence numbers, so when an ACK arrives the sender cannot always tell whether it acknowledges the original or the retransmission — the classic *retransmission ambiguity* that complicates RTT estimation. QUIC packet numbers are **never reused**: retransmitted *frames* go into a *new* packet with a new number. Every ACK is therefore unambiguous, and every RTT measurement is clean.

The `ACK` frame also carries **ACK ranges** (similar to TCP SACK but without the small fixed limit of TCP option space) and an explicit **ACK Delay**, so the sender can subtract the receiver's intentional delay from each RTT measurement. Endpoints advertise `max_ack_delay` in transport parameters.

### Loss detection (RFC 9002)

A packet is declared lost when a later packet has been acknowledged and either:

- **Packet threshold:** it is at least 3 packets older than the largest acknowledged (`kPacketThreshold = 3`), or
- **Time threshold:** it was sent more than `9/8 × max(smoothed_rtt, most_recent_rtt)` ago, measured against the arrival of the newest acknowledgment (`kTimeThreshold = 9/8`).

When nothing comes back at all, the **Probe Timeout (PTO)** fires:

```text
PTO = smoothed_rtt + max(4 × rttvar, kGranularity) + max_ack_delay
```

with exponential backoff on consecutive PTOs. A PTO does not by itself mean loss and does not collapse the congestion window the way a TCP RTO does; the sender just sends one or two ack-eliciting probe packets. Declaring persistent congestion requires a longer period with no ACKs.

### Congestion control

RFC 9002 specifies a NewReno-like default, but congestion control is pluggable, and because it lives in user space, servers can ship new algorithms without a kernel upgrade. CUBIC and BBR variants are common in production stacks. That flexibility cuts both ways: it is easy to deploy an aggressive or buggy controller, so treat congestion control changes with the same care as any other change to production traffic behavior.

### Header protection

Packet numbers and some header bits are themselves encrypted with **header protection** (a mask derived from a few bytes of the ciphertext). Middleboxes cannot see packet numbers or infer loss from them. The one deliberate exception is the optional **spin bit**, which lets on-path operators estimate RTT if the endpoints choose to enable it (RFC 9000 section 17.4; RFC 9312 discusses manageability).

## 6. HTTP/3 and QPACK

HTTP/3 (RFC 9114) maps HTTP semantics onto QUIC:

- Each request/response pair uses one **client-initiated bidirectional stream**, carrying `HEADERS` and `DATA` frames.
- Each side opens a **control stream** (unidirectional type `0x00`) whose first frame is `SETTINGS`.
- Server push uses type `0x01` (rarely used and removed from Chrome).
- QPACK uses an **encoder stream** (`0x02`) and a **decoder stream** (`0x03`).

Things HTTP/2 needed and HTTP/3 does not: stream-level flow control and `PRIORITY` frames are gone (QUIC handles flow control; prioritization moved to the Extensible Priorities scheme of RFC 9218, the `Priority` header and `PRIORITY_UPDATE` frame).

### Why HPACK could not be reused

HPACK (HTTP/2) maintains a dynamic header table updated in strict order by each header block. That works on TCP because everything arrives in order. On QUIC, header blocks from different streams can arrive in any order; with HPACK, a lost packet on one stream would block decoding of all others — HOL blocking reintroduced at the application layer.

**QPACK** (RFC 9204) fixes this by moving dynamic table updates onto the dedicated encoder stream. Each header block declares a **Required Insert Count**: the number of table insertions it depends on. If the decoder hasn't yet received those insertions, *only that stream* blocks. The decoder limits how many streams may be blocked via `SETTINGS_QPACK_BLOCKED_STREAMS`, and the encoder can choose to reference only acknowledged entries (no blocking, slightly worse compression) or take the risk for better compression. It is an explicit trade-off between compression ratio and HOL resilience.

## 7. Running HTTP/3 in production

### Discovery

Browsers do not try UDP blindly. They learn that a server speaks HTTP/3 through:

- The **`Alt-Svc`** response header (RFC 7838) on an HTTP/1.1 or HTTP/2 response, for example `Alt-Svc: h3=":443"; ma=86400`. The first visit typically uses TCP; later connections race or switch to QUIC.
- The **HTTPS DNS record** (RFC 9460), which can advertise `alpn="h3,h2"` before the first connection, saving that initial TCP visit.

Clients keep TCP as a fallback. Some enterprise networks block UDP/443, and browsers race QUIC and TCP or fall back after failures, so you must keep serving HTTP/2 over TCP.

### nginx

nginx has shipped HTTP/3 support in mainline since 1.25.0 (built with `--with-http_v3_module` and a TLS library that supports QUIC). A minimal configuration:

```nginx
server {
    listen 443 ssl;
    listen 443 quic reuseport;   # UDP listener; reuseport once per address:port
    http2 on;

    server_name example.com;
    ssl_certificate     /etc/ssl/example.com.pem;
    ssl_certificate_key /etc/ssl/example.com.key;
    ssl_protocols TLSv1.3;

    # Advertise HTTP/3 to clients that arrived over TCP.
    add_header Alt-Svc 'h3=":443"; ma=86400' always;

    # Optional: only if every route is safe to replay.
    # ssl_early_data on;
    # proxy_set_header Early-Data $ssl_early_data;
}
```

Verify from the command line with a curl built with HTTP/3 support:

```bash
curl -sI --http3-only https://example.com/ | head -1
# HTTP/3 200
```

Remember to open **UDP** 443 in security groups and firewalls; forgetting this is the single most common reason HTTP/3 "doesn't work".

### A minimal Go server

With `quic-go`, serving HTTP/3 alongside TCP takes a few lines:

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

	// ListenAndServeTLS serves HTTP/1.1 + HTTP/2 over TCP and HTTP/3 over UDP
	// on the same address, adding an Alt-Svc header to TCP responses.
	log.Fatal(http3.ListenAndServeTLS(":443", "cert.pem", "key.pem", mux))
}
```

Other mature stacks include Cloudflare's quiche (Rust), Microsoft's MsQuic (C), ngtcp2 (C, used by curl), LiteSpeed's lsquic, Quinn (Rust) and AWS s2n-quic. Envoy, HAProxy and Caddy all have HTTP/3 support as well.

### The Linux UDP path

QUIC in user space pays costs that TCP avoids:

- **System calls per packet.** Without batching, every ~1200–1500 byte datagram is its own `sendmsg`/`recvmsg`. Use `sendmmsg`/`recvmmsg`, and **UDP GSO** (`UDP_SEGMENT` socket option, Linux 4.18+) and **GRO** so the kernel splits and merges large buffers. Cloudflare, Google and Fastly have all written publicly about these optimizations being decisive for QUIC CPU efficiency.
- **No TCP offloads.** TSO, kernel-side ACK processing and NIC TLS offload do not apply. Expect QUIC to use noticeably more CPU per byte than TCP + TLS on the same hardware; measure on your own workload rather than trusting someone else's number.
- **Socket buffers.** Default UDP receive buffers on many distributions are small, causing drops under bursts. quic-go, for example, logs a warning and recommends raising the limit:

```bash
sysctl -w net.core.rmem_max=7500000
sysctl -w net.core.wmem_max=7500000
```

- **Path MTU.** QUIC requires at least 1200-byte datagrams and can probe for larger sizes (DPLPMTUD, RFC 8899). Tunnels and VPNs with small MTUs show up as handshake failures.

### Load balancers and anycast

An L4 balancer hashing on the 4-tuple works until a client's address changes. At that point packets for an existing connection land on a backend that has no state for it. Options include CID-aware load balancing (encode a server ID in the CID, as the IETF QUIC-LB work describes), consistent hashing on the CID, or simply accepting that migrated connections will fail and fall back to a new handshake. Also note that kernel `SO_REUSEPORT` distribution across worker processes is per 4-tuple as well; servers that support migration often add eBPF steering (`SO_ATTACH_REUSEPORT_EBPF`) keyed on the CID.

### Observability

You can no longer read sequence numbers in `tcpdump`. Instead:

- Export **qlog**, a structured JSON event log being standardized in the IETF and supported by quiche, quic-go, ngtcp2 and others, and visualize it with **qvis**.
- For packet captures, log TLS secrets with `SSLKEYLOGFILE` in a controlled environment and load them in Wireshark to decrypt QUIC.
- Track handshake failure rate, 0-RTT acceptance rate, fraction of traffic on h3 vs h2, and UDP receive errors (`netstat -su` / `/proc/net/snmp` `RcvbufErrors`).

## 8. When is HTTP/3 worth it?

| Situation | Expected impact |
|---|---|
| Mobile / high-loss / high-RTT clients | Largest gains: faster handshakes, no cross-stream HOL blocking, survives network changes |
| Many small parallel requests over lossy links | Clear improvement over HTTP/2 |
| Data-center east-west traffic, low loss | Little latency gain; higher CPU cost; TCP (often with kernel TLS) usually wins |
| Large bulk downloads on clean links | Throughput similar; CPU efficiency matters more |
| Networks that block UDP | No gain; fallback adds a little complexity |

The gains come mostly from the tail: users on bad networks. Look at p90/p99 metrics segmented by connection type, not medians on a fiber connection.

## Summary

- QUIC moves the transport to user space over UDP and encrypts nearly all of it to escape TCP's ossification.
- TLS 1.3 is integrated into the handshake, giving 1-RTT setup and optional 0-RTT — which must be limited to replay-safe requests.
- Connection IDs decouple connections from addresses, enabling NAT rebinding survival and migration, at the cost of CID-aware load balancing.
- Independent streams with two-level flow control remove cross-stream head-of-line blocking.
- Never-reused packet numbers, rich ACK ranges and explicit ACK delay make loss recovery and RTT estimation more precise than TCP's.
- QPACK carefully redesigns header compression so it does not reintroduce HOL blocking.
- In production: keep TCP as a fallback, open UDP 443, advertise with `Alt-Svc` or HTTPS DNS records, batch UDP I/O with GSO/GRO, raise socket buffers, and observe with qlog.

## References

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
- nginx documentation, "Support for QUIC and HTTP/3": https://nginx.org/en/docs/quic.html
- quic-go documentation: https://quic-go.net/docs/
- Langley et al., "The QUIC Transport Protocol: Design and Internet-Scale Deployment" (SIGCOMM 2017)
