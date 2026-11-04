---
title: "eBPF Internals: The Verifier, JIT, Maps, CO-RE, XDP and How Cilium, Katran and Modern Observability Use It"
tag: devops
description: A deep look at how eBPF actually works inside the Linux kernel — the instruction set and register model, the load path through the bpf() syscall, what the verifier proves and why it rejects your program, JIT compilation, helpers and kfuncs, maps and ring buffers, BTF and CO-RE portability, the major hook points from kprobes and fentry to XDP, tc and LSM, annotated libbpf code for tracing and packet filtering, and the engineering trade-offs behind Cilium, Katran, Cloudflare's DDoS defenses and eBPF-based observability
date: "2026-11-04T14:20:00.000Z"
---

## Goal

For most of Linux's history there were two ways to change what the kernel does: send a patch upstream and wait years for it to reach your fleet, or load a kernel module and accept that one bad pointer can crash the machine. eBPF added a third option: small programs, written in a restricted subset of C (or Rust), that the kernel **proves safe before running** and then executes at native speed at well-defined hook points.

That one idea now underpins Kubernetes networking (Cilium), large-scale load balancing (Meta's Katran), DDoS mitigation (Cloudflare), continuous profiling, security monitoring (Falco, Tetragon) and even pluggable CPU schedulers (`sched_ext`). This article explains the mechanism rather than the marketing:

1. The eBPF virtual machine: instructions, registers and the stack.
2. The life of a program: compile, load, verify, JIT, attach.
3. What the verifier proves, how it does it, and why it says no.
4. Helpers, kfuncs, tail calls and BPF-to-BPF calls.
5. Maps: the state and communication layer.
6. BTF and CO-RE: compile once, run on many kernels.
7. Hook points: tracing, networking, security and scheduling.
8. Annotated code: an exec tracer and an XDP packet filter.
9. How real systems use it, and the trade-offs against modules, iptables and kernel bypass.
10. Operating eBPF in production.

## 1. The eBPF virtual machine

eBPF ("extended" BPF) grew out of the 1992 BSD Packet Filter used by `tcpdump`. Classic BPF had two 32-bit registers and could only filter packets. The extended version, merged in Linux 3.18 (2014) and expanded every release since, is a general-purpose 64-bit RISC instruction set designed to map almost one-to-one onto modern CPUs.

The register model:

| Register | Role |
| --- | --- |
| `r0` | Return value from helpers and from the program itself |
| `r1`–`r5` | Arguments to helper / function calls (clobbered by calls) |
| `r6`–`r9` | Callee-saved registers, preserved across calls |
| `r10` | Read-only frame pointer to a 512-byte stack |

Each instruction is 64 bits wide (a 64-bit immediate load uses two slots): an 8-bit opcode, two 4-bit register fields, a 16-bit offset and a 32-bit immediate. There are ALU operations (32- and 64-bit), loads and stores, conditional jumps, `call` and `exit`. Because there are at most five argument registers and the stack is tiny, programs are deliberately constrained: they are meant to run in a few hundred nanoseconds inside a hot kernel path, not to be applications.

When a program starts, `r1` holds a pointer to its **context**, whose type depends on the program type: a `struct xdp_md` for XDP, a `struct __sk_buff` for tc, a `struct pt_regs` for kprobes, a tracepoint record for tracepoints, and so on. The context type is what decides which fields and helpers the program may touch.

## 2. The life of a program

```text
 C / Rust source
      │  clang -O2 -g -target bpf
      ▼
 ELF object  (.text / SEC("xdp") sections, .maps, .BTF, .BTF.ext, relocations)
      │  libbpf / cilium/ebpf / aya: parse ELF, create maps, apply CO-RE relocations
      ▼
 bpf(BPF_MAP_CREATE) ... bpf(BPF_PROG_LOAD)
      │
      ▼
 Verifier ──reject──▶ error + verifier log
      │ accept
      ▼
 JIT compiler → native x86-64 / arm64 / riscv code
      │
      ▼
 Attach (bpf_link): XDP on eth0, tracepoint, cgroup, LSM hook ...
      │
      ▼
 Runs on every event; talks to user space through maps
```

A few details that matter in practice:

- **Everything goes through one syscall**, `bpf(2)`, with commands such as `BPF_MAP_CREATE`, `BPF_PROG_LOAD`, `BPF_LINK_CREATE` and `BPF_OBJ_PIN`. Programs, maps and links are kernel objects referenced by file descriptors.
- **Lifetime is reference-counted.** When the last file descriptor closes, the program is detached and freed — unless it is *pinned* into the BPF filesystem (`/sys/fs/bpf`) or held by a `bpf_link`. Links are the modern attach API: they make ownership explicit and prevent one process from silently replacing another's program.
- **Privileges.** Since Linux 5.8, loading most programs requires `CAP_BPF` (plus `CAP_PERFMON` for tracing or `CAP_NET_ADMIN` for networking) rather than full `CAP_SYS_ADMIN`. Most distributions set `kernel.unprivileged_bpf_disabled` so unprivileged users cannot load programs at all, largely because of Spectre-class side channels.

## 3. The verifier: what it proves

The verifier is the reason eBPF can run in kernel context without being a kernel module. Before a single instruction executes, it must convince itself that the program:

1. **Terminates.** Historically this meant no back-edges at all. Since 5.3, bounded loops are allowed if the verifier can prove they exit; 5.17 added the `bpf_loop()` helper, and newer kernels add open-coded iterators, for loops whose bound is not statically obvious.
2. **Never reads uninitialized memory**, including stack slots and registers.
3. **Only accesses memory it is allowed to**, with every pointer dereference proven in bounds.
4. **Calls only helpers allowed for its program type**, with arguments of the right types.
5. **Releases every resource it acquires** — a socket reference from a lookup, a ring buffer reservation, a lock.
6. **Does not leak kernel pointers** to user space (for unprivileged or restricted contexts).

### Two passes

The first pass builds the control-flow graph and rejects unreachable instructions and, where not permitted, unbounded loops.

The second pass is the heart of it: **symbolic execution of every path**. The verifier walks instructions while tracking, for each register and stack slot, an abstract state:

- A **type**: `SCALAR_VALUE`, `PTR_TO_CTX`, `PTR_TO_MAP_VALUE`, `PTR_TO_MAP_VALUE_OR_NULL`, `PTR_TO_PACKET`, `PTR_TO_PACKET_END`, `PTR_TO_STACK`, `PTR_TO_BTF_ID` and so on.
- For scalars, **value ranges**: signed and unsigned min/max for both 64-bit and 32-bit views, plus a *tnum* ("tristate number") that records which individual bits are known 0, known 1 or unknown. An `and r1, 0xff` therefore tells the verifier that `r1 ≤ 255`, even though it knows nothing else.
- For pointers, an **offset** (fixed and variable parts) and, for packet pointers, a proven safe **range**.

At every conditional jump the state is split, and each branch refines it. This is why the classic packet-access pattern looks the way it does:

```c
struct ethhdr *eth = data;
if ((void *)(eth + 1) > data_end)   // compare packet pointer with PTR_TO_PACKET_END
    return XDP_PASS;
// On this branch, the verifier has learned: data + 14 <= data_end,
// so reading any byte of *eth is provably in bounds.
```

Remove the check and the program is rejected with an "invalid access to packet" style error, even if every real packet is longer than 14 bytes. The verifier does not reason about "real" packets; it reasons about all possible ones.

The same thing happens with map lookups. `bpf_map_lookup_elem()` returns `PTR_TO_MAP_VALUE_OR_NULL`; dereferencing it before a `NULL` check fails verification. After `if (!v) return 0;`, the register becomes `PTR_TO_MAP_VALUE` on the fall-through branch.

### Complexity limits and state pruning

Exploring every path is exponential, so the verifier caps the work: since 5.2, a privileged program may be up to 1 million instructions long, and the verifier gives up after processing 1 million instructions across all explored paths (before 5.2, programs were capped at 4,096 instructions). To stay under that, it uses **state pruning**: at certain instructions it stores the abstract states it has already explored; if a new path reaches the same point with a state that is *equivalent to or contained in* a previously verified one, that path is considered safe without being walked again. Precision tracking ("this register's exact value never mattered") makes pruning much more effective.

This has a very practical consequence: **two semantically identical programs can verify differently.** Clang may spill a bounded value to the stack and reload it in a way that loses the bounds, or merge two checks into one the verifier cannot follow. Common fixes include re-checking a bound right before use, masking a value (`idx & (MAX - 1)`), using `__always_inline` or, conversely, splitting a huge function into BPF-to-BPF calls so each is verified separately, and compiling with `-O2` (unoptimized BPF code is often unverifiable).

### Spectre hardening

The verifier also rewrites code. For example, it masks pointer arithmetic with variable offsets and may insert speculation barriers so that a mispredicted branch cannot be used to read out of bounds speculatively. These rewrites are part of why unprivileged eBPF is mostly disabled — the side-channel surface is hard to close completely.

## 4. JIT, helpers, kfuncs and calls

Once verified, the program is JIT-compiled to native code on all mainstream architectures (x86-64, arm64, s390x, riscv64, ppc64 and others). Most distributions enable `CONFIG_BPF_JIT_ALWAYS_ON`, which removes the interpreter entirely. Because eBPF registers map directly to hardware registers, JITed code is close to what a C compiler would emit for the same logic.

A program cannot call arbitrary kernel functions. It reaches kernel functionality through:

- **Helpers**: a stable, numbered set of functions such as `bpf_map_lookup_elem`, `bpf_ktime_get_ns`, `bpf_get_current_pid_tgid`, `bpf_redirect`, `bpf_probe_read_kernel`, `bpf_ringbuf_reserve`. Each program type exposes a subset, and each helper has a prototype the verifier checks.
- **kfuncs**: since 5.13, ordinary kernel functions explicitly annotated as callable from BPF and described by BTF. They are how most new functionality is added, and unlike helpers they carry no formal ABI stability promise.
- **BPF-to-BPF calls** (4.16): real function calls inside a program, each with its own stack frame; total stack across the call chain is still bounded (512 bytes per frame, with an overall limit).
- **Tail calls**: `bpf_tail_call(ctx, &prog_array, idx)` jumps to another program and never returns, reusing the stack frame. Chains are limited (33 in current kernels) to guarantee termination. Cilium and Katran use tail calls to split large datapaths into stages and to swap stages atomically by updating a `PROG_ARRAY` map.

## 5. Maps: state and communication

Programs are stateless between invocations; **maps** hold everything else. They are key/value stores in kernel memory, accessible both from BPF programs and from user space through the `bpf()` syscall (or by memory-mapping some types).

| Map type | Typical use |
| --- | --- |
| `HASH`, `LRU_HASH` | Connection tracking, per-flow state, caches with eviction |
| `ARRAY` | Configuration, fixed-index counters (preallocated, no deletion) |
| `PERCPU_HASH`, `PERCPU_ARRAY` | Lock-free counters: each CPU updates its own slot, user space sums |
| `LPM_TRIE` | Longest-prefix-match for CIDR allow/deny lists and routing |
| `PROG_ARRAY` | Tail call targets |
| `DEVMAP`, `CPUMAP`, `XSKMAP` | XDP redirect to another NIC, another CPU, or an AF_XDP socket |
| `PERF_EVENT_ARRAY` | Per-CPU event streaming (older approach) |
| `RINGBUF` | A single multi-producer ring buffer shared by all CPUs (5.8+) |
| `SOCKMAP`, `SOCKHASH` | Redirecting data between sockets |

Two design points are worth internalizing:

- **Concurrency.** Programs run concurrently on many CPUs. Hash map updates are atomic per element, but read-modify-write of a value is not. Use per-CPU maps for counters, `__sync_fetch_and_add` for shared atomics, or `bpf_spin_lock` inside a map value for small critical sections.
- **Ring buffer versus perf buffer.** The perf event array gives each CPU its own buffer, which wastes memory and can reorder events across CPUs. `BPF_MAP_TYPE_RINGBUF` is one shared buffer with a reserve/submit API: the program reserves space, fills it in place (no extra copy), and submits or discards it. The verifier enforces that every reservation is submitted or discarded on every path. For new code, ring buffers are the default choice.

## 6. BTF and CO-RE: portability

Tracing programs read kernel structures like `struct task_struct`, whose layout changes across versions and configurations. The old approach (BCC) shipped clang to every host and compiled at runtime against local kernel headers — heavy, slow to start and fragile.

**BTF** (BPF Type Format) is a compact type description of the kernel, exposed at `/sys/kernel/btf/vmlinux` when the kernel is built with `CONFIG_DEBUG_INFO_BTF`. **CO-RE** ("Compile Once – Run Everywhere") uses it like this:

1. Generate a single header with all kernel types: `bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h`.
2. Compile the program once. When code uses `BPF_CORE_READ(task, real_parent, tgid)`, clang records a **relocation**: "the offset of field `tgid` in `struct task_struct`", not a hard-coded number.
3. At load time, libbpf compares the program's BTF with the running kernel's BTF and patches each offset. Programs can also check whether a field or type exists (`bpf_core_field_exists`) and branch on kernel features.

The result is a small, self-contained binary that runs across kernel versions — what made tools like the libbpf-tools rewrite of BCC, and most modern eBPF agents, practical to distribute.

## 7. Hook points

| Area | Hooks | Notes |
| --- | --- | --- |
| Kernel tracing | kprobe/kretprobe, fentry/fexit (5.5), tracepoints, raw tracepoints | fentry uses BPF trampolines: lower overhead than kprobes and typed arguments via BTF |
| User-space tracing | uprobes, USDT | Instrument any binary without restarting it, at the cost of a trap per hit |
| Profiling | perf events | Capture stacks at a fixed frequency for flame graphs |
| Packet path (earliest) | XDP | Runs in the NIC driver before an `sk_buff` is allocated |
| Packet path (stack) | tc (clsact, tcx in 6.6) | Ingress and egress, full `sk_buff` access, can rewrite and redirect |
| Sockets | sockops, sk_msg, sk_lookup, cgroup/connect | Policy and redirection at the socket layer |
| Containers | cgroup skb/sock/device/sysctl | Per-cgroup networking and device policy |
| Security | BPF LSM (5.7) | Attach to Linux Security Module hooks and return allow/deny |
| Kernel extension | struct_ops | Implement kernel interfaces in BPF: TCP congestion control, `sched_ext` schedulers (6.12) |

### XDP in more detail

XDP runs at the earliest software point: in the driver's receive loop, on the raw DMA buffer, before the kernel allocates an `sk_buff`. A program returns one of:

- `XDP_DROP` — discard immediately (the cheapest possible drop on Linux),
- `XDP_PASS` — continue into the normal network stack,
- `XDP_TX` — bounce the (possibly rewritten) packet out the same NIC,
- `XDP_REDIRECT` — send to another NIC, another CPU, or an AF_XDP socket in user space,
- `XDP_ABORTED` — drop and fire a tracepoint (for errors).

There are three modes: **native** (driver support, the fast path), **generic** (works on any device but runs after `sk_buff` allocation, so mainly for development), and **offloaded** (runs on SmartNICs that support it). Because XDP sees packets before the stack, it is ideal for DDoS filtering and L4 load balancing, but it only covers ingress and has no socket context — tc is the place for egress and policy that needs more metadata.

## 8. Annotated code

### An exec tracer with CO-RE and a ring buffer

Kernel side (`execsnoop.bpf.c`):

```c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>

struct event {
    u32 pid;
    u32 ppid;
    char comm[16];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 256 * 1024);          /* bytes, power of two */
} events SEC(".maps");

SEC("tp/sched/sched_process_exec")
int handle_exec(void *ctx)
{
    struct task_struct *task = (struct task_struct *)bpf_get_current_task();
    struct event *e;

    e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)                                   /* verifier: must check for NULL */
        return 0;

    e->pid  = bpf_get_current_pid_tgid() >> 32;
    e->ppid = BPF_CORE_READ(task, real_parent, tgid);   /* CO-RE relocated */
    bpf_get_current_comm(&e->comm, sizeof(e->comm));

    bpf_ringbuf_submit(e, 0);                 /* verifier: must submit or discard */
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

User side, using a libbpf skeleton generated by `bpftool gen skeleton execsnoop.bpf.o > execsnoop.skel.h`:

```c
#include <stdio.h>
#include <bpf/libbpf.h>
#include "execsnoop.skel.h"

struct event { unsigned int pid, ppid; char comm[16]; };

static int on_event(void *ctx, void *data, size_t len)
{
    const struct event *e = data;
    printf("%-7u %-7u %s\n", e->pid, e->ppid, e->comm);
    return 0;
}

int main(void)
{
    struct execsnoop_bpf *skel = execsnoop_bpf__open_and_load(); /* create maps, CO-RE, verify */
    if (!skel || execsnoop_bpf__attach(skel))
        return 1;

    struct ring_buffer *rb =
        ring_buffer__new(bpf_map__fd(skel->maps.events), on_event, NULL, NULL);
    while (rb && ring_buffer__poll(rb, 100 /* ms */) >= 0)
        ;
    ring_buffer__free(rb);
    execsnoop_bpf__destroy(skel);
    return 0;
}
```

Notice what the skeleton hides: ELF parsing, map creation, CO-RE relocation, `BPF_PROG_LOAD`, and link creation. Notice also the two verifier obligations in the kernel code: the `NULL` check after reserve and the guaranteed submit.

### An XDP filter that drops UDP to one port

```c
#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/in.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} drops SEC(".maps");

SEC("xdp")
int xdp_drop_udp_9999(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;
    if (eth->h_proto != bpf_htons(ETH_P_IP))
        return XDP_PASS;

    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end || ip->ihl < 5)
        return XDP_PASS;
    if (ip->protocol != IPPROTO_UDP)
        return XDP_PASS;

    /* Variable-length IP header: the verifier tracks ihl as a bounded scalar (0..15). */
    struct udphdr *udp = (void *)ip + ip->ihl * 4;
    if ((void *)(udp + 1) > data_end)
        return XDP_PASS;

    if (udp->dest == bpf_htons(9999)) {
        __u32 key = 0;
        __u64 *cnt = bpf_map_lookup_elem(&drops, &key);
        if (cnt)
            (*cnt)++;                 /* per-CPU slot: no atomic needed */
        return XDP_DROP;
    }
    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

Build and attach with standard tooling:

```bash
clang -O2 -g -target bpf -c xdp_drop.c -o xdp_drop.o
sudo ip link set dev eth0 xdpdrv obj xdp_drop.o sec xdp   # native mode
sudo bpftool prog show                                     # find the program id
sudo bpftool map dump name drops                           # per-CPU counters
sudo ip link set dev eth0 xdpdrv off
```

Every pointer comparison against `data_end` in that program exists for the verifier. The IPv4 options case is the interesting one: `ip->ihl * 4` is a variable offset, and the program is accepted only because the following comparison re-establishes a proven range for `udp`.

## 9. How real systems use eBPF, and the trade-offs

**Cilium** implements Kubernetes Services, network policy and load balancing in eBPF at tc, XDP and socket hooks. Its kube-proxy replacement translates Service lookups into hash map lookups instead of long iptables chains, and its socket-level load balancing rewrites the destination at `connect()` time, so in-cluster traffic never needs per-packet NAT.

**Katran**, open-sourced by Meta in 2018, is an XDP-based L4 load balancer. Packets are hashed to backends with consistent hashing (a Maglev-style lookup table in a BPF map), encapsulated with IP-in-IP, and sent back out with `XDP_TX`, all without entering the kernel stack. Backends reply directly to clients (direct server return).

**Cloudflare** has described dropping DDoS traffic with XDP (its "L4Drop" work) and generating BPF rules from attack signatures, so that floods are discarded in the driver before consuming stack resources.

**Observability and security** tools — `bpftrace`, the libbpf-based BCC tools, continuous profilers like Parca, and runtime security agents like Falco and Tetragon — use kprobes, fentry, tracepoints, uprobes, perf events and BPF LSM to see system calls, network flows and process behavior without changing applications.

### Versus the alternatives

| Approach | Strengths | Weaknesses |
| --- | --- | --- |
| Kernel module | Unlimited power, any kernel API | Can crash or corrupt the kernel; must be rebuilt per kernel; hard to ship |
| eBPF | Proven-safe, hot-loadable, per-event cost close to native code, portable with CO-RE | Verifier constraints, limited stack and helpers, feature availability depends on kernel version |
| iptables / nftables | Mature, well understood, declarative | Linear rule evaluation in iptables; complex updates at Kubernetes scale |
| Kernel bypass (DPDK, AF_XDP user space) | Highest raw packet rates, full user-space flexibility | Dedicated cores busy-polling; you lose the kernel stack and its tooling |
| User-space agents / sidecars | Easy to write and debug | Extra hops, context switches and copies |

The honest summary: eBPF does not make everything faster. It makes it possible to put *small, hot, safety-critical* logic exactly where the data already is. Complex logic still belongs in user space, with eBPF collecting, filtering or steering data for it.

## 10. Operating eBPF in production

- **Know your kernel floor.** Ring buffers and `CAP_BPF` need 5.8, fentry 5.5, BPF LSM 5.7, kfuncs keep evolving. Detect features at runtime (libbpf and `bpftool feature probe` help) and provide fallbacks.
- **Make sure BTF is present.** CO-RE needs `/sys/kernel/btf/vmlinux`. For older kernels without it, projects like BTFHub provide external BTF files.
- **Read verifier logs.** Load with a larger log buffer and log level; the log shows the abstract register state at each instruction and pinpoints where a bound was lost. `veristat` compares verification cost across program versions.
- **Inspect what is running.** `bpftool prog show`, `bpftool map show`, `bpftool link show` and `bpftool prog dump xlated`/`jited` reveal everything loaded on a host, which matters when several agents (CNI, security, profiling) share one machine.
- **Measure overhead.** `sysctl kernel.bpf_stats_enabled=1` makes `bpftool prog show` report run time and run counts per program. A kprobe on a function called millions of times per second is not free, even if each run is 100 ns.
- **Be deliberate about multiple attachments.** Use `bpf_link`-based attach (and tcx / multi-program XDP via libxdp) so tools do not overwrite each other.
- **Treat it as privileged code.** A loaded program can observe sensitive data. Restrict who holds `CAP_BPF`, keep `unprivileged_bpf_disabled` on, and audit agents that load programs.

## Engineering checklist

1. Start from libbpf + CO-RE (or `cilium/ebpf` in Go, Aya in Rust), not runtime compilation.
2. Keep the BPF side minimal: filter, aggregate, steer; do heavy logic in user space.
3. Use per-CPU maps for counters and the ring buffer for events.
4. Write bounds checks the verifier can follow, right before each access; compile with `-O2 -g`.
5. Probe kernel features at startup and degrade gracefully.
6. Pin or link programs deliberately and know how they are cleaned up.
7. Enable BPF stats and watch per-program cost on hot hooks.

## Summary

eBPF is a small 64-bit instruction set plus a verifier that proves, by symbolic execution over every path, that a program terminates, touches only memory it has proven in bounds, uses only allowed helpers and releases what it acquires. Verified programs are JIT-compiled and attached to hooks across the kernel — from XDP in the NIC driver to tracepoints, LSM and scheduler callbacks — and keep state in maps shared with user space. BTF and CO-RE make one binary portable across kernels. Those properties are why networking, load balancing, DDoS defense, profiling and runtime security have moved into eBPF — and the verifier's limits are why the best designs keep the in-kernel part small.

## References

- Linux kernel documentation, BPF: https://docs.kernel.org/bpf/index.html
- Kernel documentation, eBPF verifier: https://docs.kernel.org/bpf/verifier.html
- Kernel documentation, BPF instruction set (RFC 9669): https://www.rfc-editor.org/rfc/rfc9669
- ebpf.io, "What is eBPF?": https://ebpf.io/what-is-ebpf/
- Andrii Nakryiko, "BPF CO-RE (Compile Once – Run Everywhere)": https://nakryiko.com/posts/bpf-portability-and-co-re/
- Andrii Nakryiko, "BPF ring buffer": https://nakryiko.com/posts/bpf-ringbuf/
- libbpf: https://github.com/libbpf/libbpf and libbpf-bootstrap: https://github.com/libbpf/libbpf-bootstrap
- Cilium documentation, kube-proxy replacement: https://docs.cilium.io/
- Katran: https://github.com/facebookincubator/katran
- Cloudflare blog, "L4Drop: XDP DDoS Mitigations": https://blog.cloudflare.com/l4drop-xdp-ebpf-based-ddos-mitigations/
- Høiland-Jørgensen et al., "The eXpress Data Path" (CoNEXT 2018): https://dl.acm.org/doi/10.1145/3281411.3281443
- Brendan Gregg, *BPF Performance Tools* (Addison-Wesley, 2019)
- sched_ext documentation: https://docs.kernel.org/scheduler/sched-ext.html
