---
title: "eBPF 内核机制深度解析：验证器、JIT、Map、CO-RE、XDP，以及 Cilium、Katran 和现代可观测性如何使用它"
tag: devops
description: 深入剖析 eBPF 在 Linux 内核中到底如何工作——指令集与寄存器模型、经由 bpf() 系统调用的加载路径、验证器证明了什么以及为什么会拒绝你的程序、JIT 编译、helper 与 kfunc、Map 与 ring buffer、BTF 与 CO-RE 可移植性、从 kprobe、fentry 到 XDP、tc 和 LSM 的主要挂载点，附带用于追踪和包过滤的 libbpf 注释代码，以及 Cilium、Katran、Cloudflare DDoS 防护和基于 eBPF 的可观测性背后的工程取舍
date: "2026-11-04T14:20:00.000Z"
---

## 目标

在 Linux 的大部分历史里，想改变内核的行为只有两条路：向上游提交补丁，再等几年让它进入你的机器；或者加载一个内核模块，并接受"一个野指针就能让整台机器崩溃"的风险。eBPF 提供了第三条路：用受限的 C（或 Rust）子集编写的小程序，内核在运行前**先证明它是安全的**，然后在明确定义的挂载点以接近原生的速度执行。

这个想法如今支撑着 Kubernetes 网络（Cilium）、大规模负载均衡（Meta 的 Katran）、DDoS 防护（Cloudflare）、持续性能剖析、安全监控（Falco、Tetragon），甚至可插拔的 CPU 调度器（`sched_ext`）。本文讲机制，而不是讲概念宣传：

1. eBPF 虚拟机：指令、寄存器与栈。
2. 程序的一生：编译、加载、验证、JIT、挂载。
3. 验证器证明了什么、怎么证明、为什么拒绝。
4. Helper、kfunc、尾调用与 BPF-to-BPF 调用。
5. Map：状态与通信层。
6. BTF 与 CO-RE：一次编译，到处运行。
7. 挂载点：追踪、网络、安全与调度。
8. 注释代码：exec 追踪器与 XDP 包过滤器。
9. 真实系统如何使用 eBPF，以及与内核模块、iptables、内核旁路方案的取舍。
10. 在生产环境中运维 eBPF。

## 1. eBPF 虚拟机

eBPF（"扩展的" BPF）源自 1992 年 `tcpdump` 使用的 BSD Packet Filter。经典 BPF 只有两个 32 位寄存器，只能过滤数据包。扩展版本在 Linux 3.18（2014 年）合入，此后每个版本都在扩充，它是一套通用的 64 位 RISC 指令集，设计目标是几乎一对一地映射到现代 CPU 上。

寄存器模型：

| 寄存器 | 作用 |
| --- | --- |
| `r0` | helper 调用和程序本身的返回值 |
| `r1`–`r5` | helper / 函数调用的参数（调用后被破坏） |
| `r6`–`r9` | 被调用者保存的寄存器，跨调用保持不变 |
| `r10` | 只读帧指针，指向 512 字节的栈 |

每条指令 64 位宽（64 位立即数加载占两个槽位）：8 位操作码、两个 4 位寄存器字段、16 位偏移和 32 位立即数。指令包括 ALU 运算（32 位和 64 位）、load/store、条件跳转、`call` 和 `exit`。参数寄存器最多五个、栈又很小，这些约束是刻意的：程序要在内核热路径上几百纳秒内跑完，而不是用来写应用。

程序启动时，`r1` 指向它的**上下文（context）**，类型取决于程序类型：XDP 是 `struct xdp_md`，tc 是 `struct __sk_buff`，kprobe 是 `struct pt_regs`，tracepoint 是对应的事件记录，等等。上下文类型决定了程序可以访问哪些字段、调用哪些 helper。

## 2. 程序的一生

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

实践中重要的几个细节：

- **一切都通过一个系统调用**：`bpf(2)`，命令包括 `BPF_MAP_CREATE`、`BPF_PROG_LOAD`、`BPF_LINK_CREATE`、`BPF_OBJ_PIN` 等。程序、Map 和 link 都是用文件描述符引用的内核对象。
- **生命周期靠引用计数。** 最后一个文件描述符关闭时，程序被卸载并释放——除非它被 *pin* 到 BPF 文件系统（`/sys/fs/bpf`），或被 `bpf_link` 持有。link 是现代的挂载 API：它让所有权变得明确，防止一个进程悄悄替换掉另一个进程的程序。
- **权限。** 从 Linux 5.8 开始，加载大多数程序需要 `CAP_BPF`（追踪还要 `CAP_PERFMON`，网络还要 `CAP_NET_ADMIN`），而不再是完整的 `CAP_SYS_ADMIN`。大多数发行版都设置了 `kernel.unprivileged_bpf_disabled`，禁止非特权用户加载程序，主要原因是 Spectre 一类的侧信道风险。

## 3. 验证器：它证明了什么

验证器是 eBPF 能在内核上下文中运行、却又不是内核模块的根本原因。在执行任何一条指令之前，它必须确认程序：

1. **一定会终止。** 早期这意味着完全不允许回边。从 5.3 起，只要验证器能证明循环会退出，有界循环就被允许；5.17 增加了 `bpf_loop()` helper，更新的内核还加入了 open-coded 迭代器，用于边界无法静态看出的循环。
2. **从不读取未初始化的内存**，包括栈槽位和寄存器。
3. **只访问被允许的内存**，每一次指针解引用都已被证明在边界之内。
4. **只调用该程序类型允许的 helper**，且参数类型正确。
5. **释放它获取的每一个资源**——查找得到的 socket 引用、ring buffer 预留空间、锁。
6. **不向用户态泄露内核指针**（针对非特权或受限上下文）。

### 两遍检查

第一遍构建控制流图，拒绝不可达指令，以及在不允许时出现的无界循环。

第二遍是核心：**对每条路径做符号执行**。验证器逐条走指令，为每个寄存器和栈槽位追踪一个抽象状态：

- **类型**：`SCALAR_VALUE`、`PTR_TO_CTX`、`PTR_TO_MAP_VALUE`、`PTR_TO_MAP_VALUE_OR_NULL`、`PTR_TO_PACKET`、`PTR_TO_PACKET_END`、`PTR_TO_STACK`、`PTR_TO_BTF_ID` 等。
- 对标量，记录**取值范围**：64 位和 32 位视角下的有符号、无符号最小值与最大值，外加一个 *tnum*（"三态数"），记录每一位是已知 0、已知 1 还是未知。所以 `and r1, 0xff` 之后，验证器就知道 `r1 ≤ 255`，哪怕它对其他一无所知。
- 对指针，记录**偏移**（固定部分和可变部分），对包指针还记录已被证明安全的**范围**。

在每个条件跳转处，状态被拆分，每个分支各自细化状态。这就是经典的包访问写法长成这样的原因：

```c
struct ethhdr *eth = data;
if ((void *)(eth + 1) > data_end)   // compare packet pointer with PTR_TO_PACKET_END
    return XDP_PASS;
// On this branch, the verifier has learned: data + 14 <= data_end,
// so reading any byte of *eth is provably in bounds.
```

去掉这个检查，程序就会因"invalid access to packet"一类的错误被拒绝，即使现实中每个包都长于 14 字节。验证器不考虑"真实"的包，它考虑的是所有可能的包。

Map 查找也一样。`bpf_map_lookup_elem()` 返回 `PTR_TO_MAP_VALUE_OR_NULL`，在 `NULL` 检查之前解引用会验证失败。执行 `if (!v) return 0;` 之后，在继续往下的分支上，这个寄存器就变成了 `PTR_TO_MAP_VALUE`。

### 复杂度上限与状态剪枝

遍历所有路径是指数级的，所以验证器限制了工作量：从 5.2 起，特权程序最长可达 100 万条指令，验证器在所有探索路径上累计处理 100 万条指令后就会放弃（5.2 之前，程序长度上限是 4096 条指令）。为了不超限，它使用**状态剪枝**：在某些指令处保存已经探索过的抽象状态；如果新路径到达同一位置时的状态*等价于或被包含于*某个已验证的状态，这条路径就被视为安全，不再重复遍历。精度追踪（"这个寄存器的确切值从未影响结果"）让剪枝效果大大提升。

这带来一个很实际的后果：**两个语义完全相同的程序，验证结果可能不同。** clang 可能把一个有界值溢出到栈上再读回，导致边界信息丢失；也可能把两个检查合并成一个验证器无法跟踪的形式。常见的解决办法包括：在使用前再检查一次边界、对值做掩码（`idx & (MAX - 1)`）、使用 `__always_inline`，或者反过来把巨大的函数拆成 BPF-to-BPF 调用让它们分别验证，以及用 `-O2` 编译（未优化的 BPF 代码常常无法通过验证）。

### Spectre 加固

验证器还会改写代码。例如它会对带可变偏移的指针运算加掩码，并可能插入推测执行屏障，防止利用分支预测错误进行越界的推测读取。这些改写也是非特权 eBPF 大多被禁用的原因之一——侧信道攻击面很难被完全封住。

## 4. JIT、helper、kfunc 与调用

通过验证后，程序会在所有主流架构（x86-64、arm64、s390x、riscv64、ppc64 等）上被 JIT 编译为原生代码。大多数发行版启用了 `CONFIG_BPF_JIT_ALWAYS_ON`，彻底移除解释器。由于 eBPF 寄存器直接映射到硬件寄存器，JIT 出的代码与 C 编译器对同样逻辑生成的代码相当接近。

程序不能随意调用内核函数，它通过以下方式使用内核能力：

- **Helper**：一组稳定、带编号的函数，例如 `bpf_map_lookup_elem`、`bpf_ktime_get_ns`、`bpf_get_current_pid_tgid`、`bpf_redirect`、`bpf_probe_read_kernel`、`bpf_ringbuf_reserve`。每种程序类型只开放其中一部分，每个 helper 都有原型供验证器检查。
- **kfunc**：从 5.13 起，被显式标注为可从 BPF 调用、并由 BTF 描述的普通内核函数。大多数新功能都通过 kfunc 加入，但与 helper 不同，它不承诺正式的 ABI 稳定性。
- **BPF-to-BPF 调用**（4.16）：程序内部真正的函数调用，每个调用有自己的栈帧；整个调用链的总栈空间仍有上限（每帧 512 字节，并有总体限制）。
- **尾调用**：`bpf_tail_call(ctx, &prog_array, idx)` 跳转到另一个程序且不再返回，复用栈帧。为保证终止，调用链长度有限制（当前内核为 33）。Cilium 和 Katran 用尾调用把庞大的数据路径拆分成多个阶段，并通过更新 `PROG_ARRAY` Map 来原子地替换某个阶段。

## 5. Map：状态与通信

程序在多次调用之间是无状态的，其余一切都存放在 **Map** 里。Map 是内核内存中的键值存储，BPF 程序和用户态（通过 `bpf()` 系统调用，或对某些类型做内存映射）都可以访问。

| Map 类型 | 典型用途 |
| --- | --- |
| `HASH`、`LRU_HASH` | 连接跟踪、按流状态、带淘汰的缓存 |
| `ARRAY` | 配置、固定下标的计数器（预分配，不能删除） |
| `PERCPU_HASH`、`PERCPU_ARRAY` | 无锁计数器：每个 CPU 更新自己的槽位，用户态求和 |
| `LPM_TRIE` | 最长前缀匹配，用于 CIDR 黑白名单和路由 |
| `PROG_ARRAY` | 尾调用目标 |
| `DEVMAP`、`CPUMAP`、`XSKMAP` | XDP 重定向到另一块网卡、另一个 CPU 或 AF_XDP socket |
| `PERF_EVENT_ARRAY` | 按 CPU 的事件流（较老的方式） |
| `RINGBUF` | 所有 CPU 共享的单个多生产者环形缓冲区（5.8+） |
| `SOCKMAP`、`SOCKHASH` | 在 socket 之间重定向数据 |

有两个设计要点值得牢记：

- **并发。** 程序在多个 CPU 上并发运行。哈希 Map 的单个元素更新是原子的，但对 value 的"读-改-写"不是。计数器用 per-CPU Map，共享原子量用 `__sync_fetch_and_add`，小的临界区则在 Map value 中放一个 `bpf_spin_lock`。
- **Ring buffer 与 perf buffer。** perf event array 给每个 CPU 一个独立缓冲区，既浪费内存，又会让不同 CPU 的事件乱序。`BPF_MAP_TYPE_RINGBUF` 是一个共享缓冲区，提供 reserve/submit API：程序先预留空间、就地填写（没有额外拷贝），然后提交或丢弃。验证器会强制要求每条路径上的每次预留都被提交或丢弃。新代码默认应选择 ring buffer。

## 6. BTF 与 CO-RE：可移植性

追踪程序要读取 `struct task_struct` 这类内核结构体，而它们的布局会随版本和配置变化。旧方案（BCC）是在每台主机上带一个 clang，运行时根据本地内核头文件编译——笨重、启动慢、容易出问题。

**BTF**（BPF Type Format）是对内核类型的紧凑描述，内核以 `CONFIG_DEBUG_INFO_BTF` 构建时会通过 `/sys/kernel/btf/vmlinux` 暴露出来。**CO-RE**（"Compile Once – Run Everywhere"，一次编译，到处运行）这样使用它：

1. 生成一个包含所有内核类型的头文件：`bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h`。
2. 只编译一次。当代码使用 `BPF_CORE_READ(task, real_parent, tgid)` 时，clang 记录的是一条**重定位**："`struct task_struct` 中 `tgid` 字段的偏移"，而不是写死的数字。
3. 加载时，libbpf 对比程序的 BTF 与当前内核的 BTF，修补每个偏移。程序还能判断某个字段或类型是否存在（`bpf_core_field_exists`），并根据内核特性走不同分支。

结果是一个小巧、自包含、能跨内核版本运行的二进制——正是它让 BCC 工具基于 libbpf 的重写（libbpf-tools）以及大多数现代 eBPF agent 变得易于分发。

## 7. 挂载点

| 领域 | 挂载点 | 说明 |
| --- | --- | --- |
| 内核追踪 | kprobe/kretprobe、fentry/fexit（5.5）、tracepoint、raw tracepoint | fentry 使用 BPF trampoline：开销低于 kprobe，并通过 BTF 获得带类型的参数 |
| 用户态追踪 | uprobe、USDT | 无需重启即可探测任意二进制，代价是每次命中一次陷入 |
| 性能剖析 | perf event | 以固定频率采集调用栈，用于火焰图 |
| 包路径（最早） | XDP | 在网卡驱动中运行，早于 `sk_buff` 分配 |
| 包路径（协议栈） | tc（clsact，6.6 起的 tcx） | 入向和出向，完整的 `sk_buff` 访问，可改写和重定向 |
| Socket | sockops、sk_msg、sk_lookup、cgroup/connect | 在 socket 层做策略和重定向 |
| 容器 | cgroup skb/sock/device/sysctl | 按 cgroup 的网络和设备策略 |
| 安全 | BPF LSM（5.7） | 挂到 Linux 安全模块钩子上，返回允许或拒绝 |
| 内核扩展 | struct_ops | 用 BPF 实现内核接口：TCP 拥塞控制、`sched_ext` 调度器（6.12） |

### XDP 详解

XDP 运行在软件层最早的位置：驱动的收包循环里，直接处理 DMA 原始缓冲区，内核还没分配 `sk_buff`。程序返回以下之一：

- `XDP_DROP`——立即丢弃（Linux 上代价最低的丢包方式），
- `XDP_PASS`——交给正常的网络协议栈，
- `XDP_TX`——把（可能已改写的）包从同一块网卡弹回去，
- `XDP_REDIRECT`——发往另一块网卡、另一个 CPU，或用户态的 AF_XDP socket，
- `XDP_ABORTED`——丢弃并触发 tracepoint（用于错误情况）。

有三种模式：**native**（需要驱动支持，快速路径）、**generic**（任何设备都能用，但在 `sk_buff` 分配之后运行，主要用于开发）、**offloaded**（在支持的 SmartNIC 上运行）。由于 XDP 在协议栈之前看到数据包，它非常适合 DDoS 过滤和四层负载均衡；但它只覆盖入向，也没有 socket 上下文——出向和需要更多元数据的策略应放在 tc。

## 8. 注释代码

### 基于 CO-RE 和 ring buffer 的 exec 追踪器

内核侧（`execsnoop.bpf.c`）：

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

用户侧，使用 `bpftool gen skeleton execsnoop.bpf.o > execsnoop.skel.h` 生成的 libbpf skeleton：

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

注意 skeleton 帮你隐藏了什么：ELF 解析、Map 创建、CO-RE 重定位、`BPF_PROG_LOAD` 和 link 创建。也注意内核代码里的两项验证器义务：reserve 之后的 `NULL` 检查，以及必定执行的 submit。

### 丢弃发往某个端口的 UDP 包的 XDP 过滤器

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

用标准工具编译和挂载：

```bash
clang -O2 -g -target bpf -c xdp_drop.c -o xdp_drop.o
sudo ip link set dev eth0 xdpdrv obj xdp_drop.o sec xdp   # native mode
sudo bpftool prog show                                     # find the program id
sudo bpftool map dump name drops                           # per-CPU counters
sudo ip link set dev eth0 xdpdrv off
```

这个程序里每一次与 `data_end` 的比较都是为了验证器而存在的。IPv4 选项那段最有意思：`ip->ihl * 4` 是可变偏移，程序之所以被接受，只是因为紧随其后的比较为 `udp` 重新建立了已证明的范围。

## 9. 真实系统如何使用 eBPF，以及取舍

**Cilium** 在 tc、XDP 和 socket 挂载点上用 eBPF 实现 Kubernetes Service、网络策略和负载均衡。它的 kube-proxy 替代方案把 Service 查找变成哈希 Map 查找，而不是冗长的 iptables 链；它的 socket 层负载均衡在 `connect()` 时直接改写目的地址，因此集群内部流量不需要逐包 NAT。

**Katran** 是 Meta 在 2018 年开源的基于 XDP 的四层负载均衡器。数据包通过一致性哈希（存放在 BPF Map 中的 Maglev 风格查找表）映射到后端，用 IP-in-IP 封装后通过 `XDP_TX` 发出，全程不进入内核协议栈。后端直接回复客户端（直接服务器返回，DSR）。

**Cloudflare** 介绍过用 XDP 丢弃 DDoS 流量的做法（"L4Drop"），并根据攻击特征生成 BPF 规则，让洪泛流量在驱动里就被丢弃，不占用协议栈资源。

**可观测性与安全**工具——`bpftrace`、基于 libbpf 的 BCC 工具、Parca 这样的持续剖析器，以及 Falco、Tetragon 这样的运行时安全 agent——利用 kprobe、fentry、tracepoint、uprobe、perf event 和 BPF LSM 观察系统调用、网络流和进程行为，而无需修改应用。

### 与其他方案对比

| 方案 | 优势 | 劣势 |
| --- | --- | --- |
| 内核模块 | 能力不受限，可使用任意内核 API | 可能让内核崩溃或损坏；需按内核版本重新构建；难以分发 |
| eBPF | 经过证明的安全性、可热加载、单次事件开销接近原生代码、借助 CO-RE 可移植 | 受验证器约束，栈和 helper 有限，可用特性取决于内核版本 |
| iptables / nftables | 成熟、易懂、声明式 | iptables 规则线性匹配；在 Kubernetes 规模下更新复杂 |
| 内核旁路（DPDK、用户态 AF_XDP） | 最高的原始包处理速率，用户态完全灵活 | 需要专用核心忙轮询；失去内核协议栈及其工具 |
| 用户态 agent / sidecar | 易于编写和调试 | 额外的跳转、上下文切换和拷贝 |

坦白地说：eBPF 并不会让所有东西都变快。它让你可以把*小而热、对安全要求高*的逻辑精确地放在数据所在的位置。复杂逻辑仍然属于用户态，eBPF 负责为它采集、过滤或引导数据。

## 10. 在生产环境中运维 eBPF

- **明确内核版本下限。** ring buffer 和 `CAP_BPF` 需要 5.8，fentry 需要 5.5，BPF LSM 需要 5.7，kfunc 还在持续演进。运行时探测特性（libbpf 和 `bpftool feature probe` 都能帮忙），并提供降级方案。
- **确保 BTF 存在。** CO-RE 依赖 `/sys/kernel/btf/vmlinux`。对于没有它的老内核，BTFHub 这类项目提供外部 BTF 文件。
- **读懂验证器日志。** 加载时使用更大的日志缓冲区和更高的日志级别；日志会显示每条指令处寄存器的抽象状态，精确定位边界在哪里丢失。`veristat` 可以比较不同版本程序的验证开销。
- **检查正在运行的程序。** `bpftool prog show`、`bpftool map show`、`bpftool link show` 以及 `bpftool prog dump xlated`/`jited` 能列出主机上加载的一切；当多个 agent（CNI、安全、剖析）共享一台机器时这一点尤其重要。
- **度量开销。** `sysctl kernel.bpf_stats_enabled=1` 后，`bpftool prog show` 会报告每个程序的运行时间和运行次数。挂在每秒被调用数百万次的函数上的 kprobe 并不免费，哪怕每次只要 100 纳秒。
- **谨慎处理多程序挂载。** 使用基于 `bpf_link` 的挂载（以及 tcx、借助 libxdp 的多程序 XDP），避免不同工具互相覆盖。
- **把它当作特权代码对待。** 加载的程序能观察到敏感数据。限制谁持有 `CAP_BPF`，保持 `unprivileged_bpf_disabled` 开启，并审计会加载程序的 agent。

## 工程清单

1. 从 libbpf + CO-RE 起步（Go 用 `cilium/ebpf`，Rust 用 Aya），不要在运行时编译。
2. BPF 侧保持精简：过滤、聚合、引导；重逻辑放在用户态。
3. 计数器用 per-CPU Map，事件用 ring buffer。
4. 在每次访问之前写出验证器能跟踪的边界检查；用 `-O2 -g` 编译。
5. 启动时探测内核特性，优雅降级。
6. 有意识地 pin 或 link 程序，并清楚它们如何被清理。
7. 开启 BPF 统计，关注热点挂载点上每个程序的开销。

## 总结

eBPF 是一套小型 64 位指令集，加上一个验证器：它通过对每条路径的符号执行证明程序会终止、只访问已证明在边界内的内存、只使用允许的 helper，并释放所获取的资源。通过验证的程序被 JIT 编译，挂载到遍布内核的各个钩子上——从网卡驱动里的 XDP 到 tracepoint、LSM 和调度器回调——并把状态存放在与用户态共享的 Map 中。BTF 和 CO-RE 让同一个二进制可以跨内核运行。正是这些特性让网络、负载均衡、DDoS 防护、性能剖析和运行时安全纷纷迁移到 eBPF 上；而验证器的限制也说明了，最好的设计总是让内核内的部分保持精简。

## 参考资料

- Linux 内核文档，BPF：https://docs.kernel.org/bpf/index.html
- 内核文档，eBPF 验证器：https://docs.kernel.org/bpf/verifier.html
- BPF 指令集架构（RFC 9669）：https://www.rfc-editor.org/rfc/rfc9669
- ebpf.io，"What is eBPF?"：https://ebpf.io/what-is-ebpf/
- Andrii Nakryiko，"BPF CO-RE (Compile Once – Run Everywhere)"：https://nakryiko.com/posts/bpf-portability-and-co-re/
- Andrii Nakryiko，"BPF ring buffer"：https://nakryiko.com/posts/bpf-ringbuf/
- libbpf：https://github.com/libbpf/libbpf ，libbpf-bootstrap：https://github.com/libbpf/libbpf-bootstrap
- Cilium 文档，kube-proxy 替代：https://docs.cilium.io/
- Katran：https://github.com/facebookincubator/katran
- Cloudflare 博客，"L4Drop: XDP DDoS Mitigations"：https://blog.cloudflare.com/l4drop-xdp-ebpf-based-ddos-mitigations/
- Høiland-Jørgensen 等，"The eXpress Data Path"（CoNEXT 2018）：https://dl.acm.org/doi/10.1145/3281411.3281443
- Brendan Gregg，《BPF Performance Tools》（Addison-Wesley，2019）
- sched_ext 文档：https://docs.kernel.org/scheduler/sched-ext.html
