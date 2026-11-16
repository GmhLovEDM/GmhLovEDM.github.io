---
title: "深入虚拟内存：页表、TLB、大页与一次缺页的代价"
tag: performance
description: 用户态指针如何变成物理地址——x86-64 的 4 级与 5 级页表、PTE 标志位、TLB 与 TLB shootdown、PCID/ASID、次要与主要缺页、写时复制、按需分页与过度提交、2 MiB/1 GiB 大页与透明大页的取舍，以及一个比较 4 KiB 与 2 MiB 映射的可运行页表遍历模型
date: "2026-11-16T13:40:00.000Z"
---

## 目标

程序里的每一个指针，都是*虚拟*地址。CPU 必须先把它翻译成*物理*地址，才能从 DRAM 取出一个字节。完成翻译的数据结构是页表；让这条路径不至于慢到不可用的缓存是 TLB；补上缺失页的事件是缺页异常。生产环境里几乎所有让人意外的内存代价——一次把 Redis 冻住的 `fork`、把时间花在走页表而不是读行上的数据库、一次分配成功却在之后被杀掉的进程——都是这条路径上的意外。

本文会讲到：

1. 为什么需要虚拟内存，以及一页到底是什么。
2. x86-64 的 **4 级页表遍历**、canonical 地址，以及 **5 级分页**（LA57）。
3. PTE 标志位：present、可写、user、NX、accessed、dirty、global，以及页大小位。
4. **TLB**：覆盖范围、缺失、PCID/ASID，以及 shootdown。
5. **缺页**：次要与主要、按需分页、写时复制，以及权限错误。
6. `mmap`、过度提交，以及稍后才到来的 OOM killer。
7. **大页**：2 MiB 与 1 GiB，hugetlb 与透明大页，以及为什么 Redis 和 PostgreSQL 看起来在给相反的建议。
8. 这对语言运行时和数据服务意味着什么。
9. 一个可运行的模型：统计页表占用，并比较 4 KiB 与 2 MiB 映射下的 TLB 行为。

## 1. 为什么程序看见的地址不是物理地址

虚拟内存让每个进程拥有自己的地址空间。同一个虚拟地址，在两个进程里可以映射到不同的物理页，也可以什么都不映射。隔离靠的就是这个；内核也因此能在只有几 GiB 内存的机器上，给程序提供 128 TiB 的用户态空间（4 级分页的 x86-64）：先建立映射，物理页稍后再挂上。

映射的单位是**页**。x86-64 的体系结构基本页大小是 4 KiB。4 KiB 页同时是权限的单位、这种页大小下一条 TLB 表项的单位，也是内核做按需分页、写时复制和换出的单位。更大的页大小是存在的，那是第 7 节的主题；它们存在，是因为今天的工作集常常让 4 KiB 显得太小。

内核用 **VMA**（virtual memory area）跟踪映射：权限和后备存储（匿名、文件、共享）相同的连续范围。`/proc/<pid>/maps` 就是这些范围的转储。VMA 不是页表。它是内核用来*构建*和*补全*页表项的账本。

## 2. 走一遍 4 级页表

在启用 4 级分页的现代 x86-64 上，用户态虚拟地址是存放在 64 位寄存器里的 48 位值。更高的位必须是第 47 位的符号扩展——也就是 **canonical** 地址。非 canonical 地址会直接故障。这 48 位从上到下拆成：

| 位 | 字段 | 索引的对象 |
| --- | --- | --- |
| 47:39 | PML4 | Page Map Level 4（512 项） |
| 38:30 | PDPT | Page Directory Pointer Table |
| 29:21 | PD | Page Directory |
| 20:12 | PT | Page Table |
| 11:0 | offset | 4 KiB 页内的字节偏移 |

每一级表本身就是一个 4 KiB 页，装 512 个 8 字节表项，所以每一级消耗 9 位地址。CR3 保存 PML4 的物理地址（若开启了 PCID，低位还带着 12 位地址空间标签）。硬件随后做四次依赖的内存读取：PML4 项 → PDPT 项 → PD 项 → PT 项，最后把 11:0 加到叶子里的物理页地址上。2 MiB 页会早停一级：PD 项的 **PS**（page size）位置位，20:0 是页内偏移。1 GiB 页停在 PDPT，29:0 是偏移。

正因为要走这么多级，页表本身不是免费的。一段连续的 32 GiB、用 4 KiB 页来映射，需要 8,388,608 个叶子 PTE，占用 16,384 个页表页，再加上寥寥几张上级表——一共 64.13 MiB 的页表内存，而这些页表自己也要被翻译、被缓存。第 9 节的模型会把这笔账算精确。

最初的 4 级设计提供 256 TiB 虚拟地址空间，以及内核文档所记载的、原版硬件上的 64 TiB 物理地址空间（[5-level paging](https://docs.kernel.org/arch/x86/x86_64/5level-paging.html)）。Linux 把这 256 TiB 对半切开：用户态大约 128 TiB，其余给内核，中间隔着一块非 canonical 的空洞（[x86-64 memory layout](https://docs.kernel.org/arch/x86/x86_64/mm.html)）。

### 2.1 五级分页，以及为什么 Linux 默认不把多出来的位给你

5 级分页增加一级 PML5，把虚拟地址扩展到 57 位：128 PiB 虚拟空间，4 PiB 物理空间。CPU 用 `la57` 来宣传这一能力。它只是多走一级，却会撞上用户态一个很普遍的习惯：JIT 和运行时把标签塞进指针的高位。在 48 位的世界里“可以安全打标签”的指针，在 57 位的世界里是合法地址，再当标签指针用就会崩溃。

Linux 的回答很保守。即便启用了 5 级分页，内核**默认**仍然只从低 47 位窗口里分配用户态虚拟地址。想要高位范围的进程，必须在 `mmap` 里传入一个高于第 47 位的 hint 地址（带或不带 `MAP_FIXED` 都可以）。在旧内核或没有 LA57 的机器上，这个 hint 会被忽略，同一份源码仍然能工作。这写在 [5-level paging 指南](https://docs.kernel.org/arch/x86/x86_64/5level-paging.html) 里。

## 3. 一个 PTE 真正记录了什么

叶子页表项是物理页地址，再加上一组打包的标志位。日常排查里最常见的是：

- **P**（present）。若清零，这一项就不是一次翻译。剩下的位于是可以给内核当交换槽、文件偏移，或“这是第一次触摸的匿名页”之类的标记。经过一个不存在的表项，是缺页，而不是一次 TLB 填充。
- **R/W**。写权限。`fork` 靠的就是它：父进程和子进程共享同一物理页，PTE 标成只读，第一次写入变成写时复制缺页。
- **U/S**。用户态还是特权态。内核映射不能从 ring 3 访问。
- **NX**（最高位，若 `EFER.NXE` 已置位）。执行权限，也就是 W^X 的硬件一侧。
- **A**（accessed）和 **D**（dirty）。硬件在使用和写入时置位。内核读它们，以决定回收什么、回写什么，以及哪些 COW 页真的被改过。
- **G**（global）。这次翻译在 CR3 重载后仍然保留。内核页通常置上这一位，这样上下文切换不会丢掉内核自己的 TLB 表项。
- **PS**。在 PD 或 PDPT 项上，它表示这是 2 MiB 或 1 GiB 的叶子，而不是指向下一级表的指针。
- **PWT / PCD / PAT**。缓存属性。普通内存大多是 write-back；设备内存不是。

权限检查发生在遍历过程中。对一个存在但只读的页做用户态写入、在 NX 页上执行，或从用户态访问特权页，即使翻译存在，也会故障。

## 4. TLB 是翻译缓存，而且它很小

如果每次 load 都要做四次依赖的内存读取，代价会高到无法接受，所以 CPU 把翻译缓存在 **TLB**（translation lookaside buffer）里。TLB 命中时，虚拟地址直接变成物理地址，不必再走页表。缺失时则遍历页表（常常还要借助保存了近期上级表项的 page-walk cache），再填进 TLB。

比微架构细节更重要的是两个量：

- **覆盖范围（reach）**——TLB 一次能覆盖多少虚拟内存。它等于 `表项数 × 页大小`。一个 1024 项的最后一级 TLB，用 4 KiB 页只能覆盖 **4 MiB**，用 2 MiB 页则能覆盖 **2 GiB**。这不是一个小差距；这是“工作集的翻译能放下”和“几乎每一个新页都要走页表”之间的差距。
- **相联度与拆分**。真实的核心通常有较小的 L1 dTLB/iTLB，再加一个更大的共享最后一级 TLB，而且常常把 2 MiB 翻译放在一个单独的、更小的阵列里。第 9 节的模型使用统一的全相联 LRU（64 项 L1，1024 项最后一级），好让算术诚实、可检查。请把这些容量当成**参数**，而不是对某一款 CPU 的断言。定性结论——4 KiB 的覆盖范围以兆字节计，2 MiB 的覆盖范围以吉字节计——并不依赖于具体型号。

### 4.1 上下文切换：PCID 与 ASID

过去，重载 CR3 会冲刷 TLB，全局表项除外。这让进程切换比应有的更贵：你刚刚离开的进程可能几毫秒后还会再跑，而它的翻译已经没了。

**PCID**（Process-Context Identifiers）给每条 TLB 表项打上一个放在 CR3 里的 12 位标识。一次只改 PCID 的 CR3 写入，不必冲刷其他 PCID 的表项。`INVPCID` 可以按地址、按 PCID，或按更大的范围失效。ARM 上对等的机制是 TLB 里与翻译放在一起的 **ASID**。Linux 使用这些标签，让上下文切换可以保留最近运行过的地址空间的翻译。

### 4.2 Shootdown 随核心数放大，而不是随一次写入的大小放大

TLB 是*每核*的缓存。当软件改动一次翻译——`munmap`、`mprotect`、一次 COW 断裂、一次 ksm 合并、一次页面迁移——每一个可能还握着过期表项的核心都必须丢掉它。在本核上，这是 `INVLPG`（或一次范围更大的冲刷）。在远端，这是一次核间中断。这就是 **TLB shootdown**。

代价跟随的是已经加载了这个地址空间的核心数，而不是程序刚刚写入的字节数。因此，取消映射一大片区域，或翻转其中的权限，可能一下子卡住许多核心。内核会批量冲刷，在当前没有运行这个 `mm` 的核心上推迟失效，并用范围或单条失效来避免整表冲刷。这也是为什么一次看上去“很便宜”的 `mprotect`，或分配器对大范围调用 `madvise(MADV_DONTNEED)`，会在多核机器的剖析里以系统时间的形式出现。

## 5. 缺页，是页如何诞生的

缺页就是遍历报告“这次访问无法完成”。内核接着要么修好映射并恢复那条指令，要么向进程投递信号（`SIGSEGV`、`SIGBUS`）。

有用的划分是**次要缺页与主要缺页**：

- **次要缺页**不需要一次存储 I/O。典型情况：对仍在内存里的写时复制页的第一次写入；从未被触摸、可以填零的匿名页；已经在页缓存里的文件页。进程被推迟的是分配和记账，不是磁盘。
- **主要缺页**必须从存储（或远程文件系统）读入这一页。这才是人们通常说的“因为内存而卡住”的换页事件。

按需分页是让 `mmap` 便宜的策略：创建 VMA 并不分配物理页。每一页的第一次访问都会缺页，内核这时才挂上一个页框。`MAP_POPULATE` 和 `mlock` 的存在，就是为了在“稍后卡住会更糟”的时候，把这笔代价提前付掉。

写时复制是同一套机制，被 `fork` 拿来再用。`fork` 之后，父子共享物理页，PTE 为只读。任一方写入都会缺页，内核分配新页、拷贝旧页，并更新写入方的 PTE。写入的第一个字节并不是“多占用一个字节”；它是整整一页。4 KiB 页就是 4 KiB。2 MiB 大页就是 2 MiB。这个 512 倍，就是第 7 节里 Redis 故事的起点。

权限错误是剩下的情形：页是存在的，但这次访问不被允许。其中一部分其实是伪装成权限错误的 COW。其余则是缺陷、打到保护页的栈溢出，或有意的探测。

## 6. mmap、过度提交，以及稍后才到来的杀手

大多数运行时用 `mmap` 获取大块区域：匿名堆、线程栈、文件映射、共享缓冲区。这个调用在*虚拟*范围被预留下之后就会返回一个指针。你真正去触摸时，*物理*内存是否还在，则是另一个问题，由过度提交策略回答（[Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html)）：

| `vm.overcommit_memory` | 策略 |
| --- | --- |
| 0（默认） | 启发式。明显荒唐的预留会被拒绝；普通的过度提交是允许的。 |
| 1 | 总是过度提交。那些永远不会填满大部分页的稀疏地址空间，可以预留巨大的空洞。 |
| 2 | 不过度提交。提交上限是交换空间加上可配置的内存份额（`vm.overcommit_ratio`，默认 50%），在 `/proc/meminfo` 里记为 `CommitLimit`。`Committed_AS` 是当前已记账的量。 |

在模式 0 和 1 下，一次成功的 `mmap` 或 `malloc` 并不承诺这些页真的存在。失败可能稍后才到来：一次内核无法满足的缺页，或 **OOM killer** 选中一个进程并发送 `SIGKILL`。PostgreSQL 的文档指出，默认启发式对数据库并不合适，并讨论了 `vm.overcommit_memory=2`，以及用 `oom_score_adj=-1000` 保护 postmaster（[Managing Kernel Resources](https://www.postgresql.org/docs/current/kernel-resources.html)）。

文件后备的共享或只读映射，并不像私有可写匿名映射那样计入提交——文件本身就是后备存储。所以一个进程可以在 8 GiB 的机器上 `mmap` 一个 50 GiB 的文件，只要它触摸的工作集能放下，就可以继续运行。

## 7. 大页：同样的遍历，更少的表项

一个 2 MiB 页，等于一条 TLB 表项、一个叶子 PTE（在 PD 上）里的 512 个基本页。一个 1 GiB 页则是 512 个这样的 2 MiB。收益是机械的：

- **TLB 覆盖范围**按同样的倍数增长。模型里 1024 项的最后一级，在 4 KiB 下覆盖 4 MiB，在 2 MiB 下覆盖 2 GiB。
- **页表占用**在叶子这一级大致按同样倍数缩小。32 GiB 的映射，4 KiB 时占 64.13 MiB 的页表，2 MiB 时占 136 KiB，1 GiB 时占 8 KiB。
- **遍历更短**：2 MiB 是三次表引用，1 GiB 是两次，而不是四次。

Linux 提供两条非常不同的获得途径。

**hugetlb**（以及 `mmap(..., MAP_HUGETLB)`，或 hugetlbfs 挂载）从由 `vm.nr_hugepages` 或 `/sys/kernel/mm/hugepages/` 下按大小划分的文件所决定的池子里取页。这些页是预先保留的。你得到的是可预期性：池子里要么有页，要么分配失败。你也要承担运维负担：给池子定大小、在较晚时再去保留可能面对碎片，以及授予进程使用权限。这正是 PostgreSQL 的 `huge_pages = try | on | off` 路径所做的事：主共享内存区（通常是 `shared_buffers`）是一块很大、很长寿、连续的映射，恰好是大页被设计来服务的工作负载。默认是 `try`。设为 `on` 时，若池子不够，服务器会拒绝启动。官方文档还指出，**透明**大页曾给部分用户带来回退，目前不建议 PostgreSQL 使用，这与这条显式路径形成对照（[Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html)，[Linux Huge Pages](https://www.postgresql.org/docs/current/kernel-resources.html)）。

**透明大页（THP）** 下的是相反的赌注。内核可以在应用程序并不提出请求的情况下，给匿名映射分配一个 PMD 大小（2 MiB）的页，或稍后把一串 4 KiB 页折叠成一张。`khugepaged` 在后台做这种折叠。旋钮是 `always`、`madvise` 和 `never`，再加上 `madvise(MADV_HUGEPAGE)` / `MADV_NOHUGEPAGE`。较新的内核还支持 **multi-size THP**（mTHP）：介于中间的、2 的幂次大小，仍然用 PTE 映射。内核文档的要点是：mTHP 能减少缺页次数，却不必承担一次还要清零的完整 2 MiB 分配所带来的那种尾延迟尖峰（[Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html)）。

对许多从不对一块又大又脏的堆做 `fork` 的吞吐型程序来说，THP 是合理的默认。对一个确实会 `fork`、又对延迟敏感的进程来说，它就不是。Redis 用 `fork` 来持久化：子进程共享父进程的页，仍然繁忙的父进程则继续在事件循环里写入。官方 Redis 文档描述了这些共享页是大页时会发生什么：几千次写入，每一次都撕开一个 2 MiB 的 COW 页，几乎拷贝整个进程，既造成延迟尖峰，也造成内存尖峰。文档给出的办法是在主机上关闭 THP，并重启 Redis（[Diagnosing latency issues](https://redis.io/docs/operate/oss_and_stack/management/optimization/latency/)）。

所以这看起来“相反”的建议并不是矛盾。PostgreSQL 想要的是**显式、预留、长寿**的大页，用在一块不会在请求路径上被写时复制 `fork` 的共享缓冲池上。Redis 想要的是**不要透明地提升**一块*确实会*被这样 `fork` 的堆。共同的教训是：页大小既是 COW 和缺页延迟的决策，而不只是 TLB 的决策。

## 8. 在运行时和服务里，这是什么样子

语言运行时首先是虚拟内存程序，其次才是分配器。GC 堆通常是一次很大的匿名 `mmap`，在第一次触摸时才填上，有时还会用 `madvise` 提示哪些可以还回去（`MADV_DONTNEED` 或 `MADV_FREE`）。线程栈是带**保护页**的映射——一个 `PROT_NONE` 的空洞，让失控的栈变成一次缺页，而不是悄悄砸坏旁边的内存。分配器在一次大的释放时把内存还给内核，等于选择了一次 shootdown 和未来的一次缺页，来换 RSS。

同样的机制也出现在服务里：

- 一个为了给自己做快照而 `fork` 的进程，会继承每一个大页的 COW 放大。Redis 是有文档记载的例子；任何对大堆做写时复制快照的做法，形状都一样。
- 一个用 4 KiB 页映射几十 GiB 的进程，光是页表就要花掉几十 MiB，而这些页表还会和数据一起抢缓存。大页能把这笔开销缩小到可以忽略。
- 一个依赖过度提交的进程，可能在第一次触摸时死去，远离那个曾经“成功”的调用。在意这一点的数据库会收紧过度提交，并把监督进程从 OOM killer 下保护起来。
- 剖析里大量出现在缺页处理或 TLB 缺失计数器上的时间，常常是在告诉你工作集已经放不进翻译的覆盖范围，而不是算法变慢了。

再补一句 ARM，因为这些想法是可迁移的。AArch64 可以使用 4 KiB、16 KiB 或 64 KiB 的粒度；页表级数随后取决于粒度和虚拟地址宽度。TLB 表项带着 ASID，扮演与 PCID 相同的角色。叶子仍然携带存在、权限和页大小信息。遍历是同样的形状，只是常数不同。

## 9. 一个可运行的模型

下面的程序做两件事，它们都是算术，而不是对某一款核心的断言。

第一，它统计在 4 级 x86-64 遍历下，一段连续映射分别用 4 KiB、2 MiB 和 1 GiB 叶子时，需要多少 4 KiB 的页表页。第二，它用一个两级全相联 LRU TLB（64 项 L1，1024 项最后一级），在同样的区域上跑顺序和随机的按页轨迹，并比较 4 KiB 与 2 MiB 映射。一次 4 KiB 缺失花费四次表引用；一次 2 MiB 缺失花费三次。最后一级的覆盖范围分别是 4 MiB 和 2 GiB。

```python
from collections import OrderedDict
import random

ENTRIES_PER_TABLE = 512
TABLE_BYTES = 4096
KIB, MIB, GIB = 1024, 1024 * 1024, 1024 * 1024 * 1024
PAGE_4K, PAGE_2M, PAGE_1G = 4 * KIB, 2 * MIB, 1 * GIB


def page_table_pages(mapping_bytes, page_bytes):
    leaves = mapping_bytes // page_bytes
    levels = {PAGE_4K: 4, PAGE_2M: 3, PAGE_1G: 2}[page_bytes]
    pages, n = [], leaves
    for _ in range(levels):
        n_tables = (n + ENTRIES_PER_TABLE - 1) // ENTRIES_PER_TABLE
        pages.append(n_tables)
        n = n_tables
    return pages


class LRUTLB:
    def __init__(self, capacity):
        self.capacity = capacity
        self.entries = OrderedDict()
        self.hits = self.misses = 0

    def lookup(self, vpn):
        if vpn in self.entries:
            self.entries.move_to_end(vpn)
            self.hits += 1
            return True
        self.misses += 1
        return False

    def insert(self, vpn):
        if vpn in self.entries:
            self.entries.move_to_end(vpn)
            return
        if len(self.entries) >= self.capacity:
            self.entries.popitem(last=False)
        self.entries[vpn] = None


class TwoLevelTLB:
    def __init__(self, l1, last_level, walk_refs):
        self.l1, self.last = LRUTLB(l1), LRUTLB(last_level)
        self.walk_refs = walk_refs
        self.walks = self.refs_from_walks = self.accesses = 0

    def access(self, vpn):
        self.accesses += 1
        if self.l1.lookup(vpn):
            return
        if self.last.lookup(vpn):
            self.l1.insert(vpn)
            return
        self.walks += 1
        self.refs_from_walks += self.walk_refs
        self.last.insert(vpn)
        self.l1.insert(vpn)
```

在 CPython 3 上的输出：

```text
Page-table memory for a single contiguous mapping
(4-level x86-64, 8-byte entries, 4 KiB table pages, leaf first: PT/PD/PDPT/PML4)

   mapping    page                  tables       total
------------------------------------------------------
     1 GiB   4 KiB               512+1+1+1    2.01 MiB
     1 GiB   2 MiB                   1+1+1      12 KiB
     1 GiB   1 GiB                     1+1       8 KiB
     8 GiB   4 KiB              4096+8+1+1   16.04 MiB
     8 GiB   2 MiB                   8+1+1      40 KiB
     8 GiB   1 GiB                     1+1       8 KiB
    32 GiB   4 KiB            16384+32+1+1   64.13 MiB
    32 GiB   2 MiB                  32+1+1     136 KiB
    32 GiB   1 GiB                     1+1       8 KiB
   256 GiB   4 KiB          131072+256+1+1  513.01 MiB
   256 GiB   2 MiB                 256+1+1    1.01 MiB
   256 GiB   1 GiB                     1+1       8 KiB

TLB model: fully associative LRU, L1=64 entries, last-level=1024 entries
  reach with 4 KiB pages: 256 KiB L1 / 4 MiB last-level
  reach with 2 MiB pages: 128 MiB L1 / 2 GiB last-level
  4 KiB walks cost 4 table references; 2 MiB walks cost 3.

sequential    16 MiB, 4 KiB pages, 4 passes, 4096 pages/pass
  accesses=16384  L1 hits=0 (0.0%)  last-level hits=0 (0.0% of L1 misses)
  walks=16384 (100.0%)  page-table memory references=65536
random         16 MiB, 4 KiB pages, 200000 accesses, seed=1
  accesses=200000  L1 hits=3228 (1.6%)  last-level hits=46704 (23.7% of L1 misses)
  walks=150068 (75.0%)  page-table memory references=600272
sequential    16 MiB, 2 MiB pages, 4 passes, 8 pages/pass
  accesses=32  L1 hits=24 (75.0%)  last-level hits=0 (0.0% of L1 misses)
  walks=8 (25.0%)  page-table memory references=24
random         16 MiB, 2 MiB pages, 200000 accesses, seed=1
  accesses=200000  L1 hits=199992 (100.0%)  last-level hits=0 (0.0% of L1 misses)
  walks=8 (0.0%)  page-table memory references=24

sequential   256 MiB, 4 KiB pages, 4 passes, 65536 pages/pass
  accesses=262144  L1 hits=0 (0.0%)  last-level hits=0 (0.0% of L1 misses)
  walks=262144 (100.0%)  page-table memory references=1048576
random        256 MiB, 4 KiB pages, 200000 accesses, seed=1
  accesses=200000  L1 hits=203 (0.1%)  last-level hits=2815 (1.4% of L1 misses)
  walks=196982 (98.5%)  page-table memory references=787928
sequential   256 MiB, 2 MiB pages, 4 passes, 128 pages/pass
  accesses=512  L1 hits=0 (0.0%)  last-level hits=384 (75.0% of L1 misses)
  walks=128 (25.0%)  page-table memory references=384
random        256 MiB, 2 MiB pages, 200000 accesses, seed=1
  accesses=200000  L1 hits=100027 (50.0%)  last-level hits=99845 (99.9% of L1 misses)
  walks=128 (0.1%)  page-table memory references=384

sequential     2 GiB, 4 KiB pages, 4 passes, 524288 pages/pass
  accesses=2097152  L1 hits=0 (0.0%)  last-level hits=0 (0.0% of L1 misses)
  walks=2097152 (100.0%)  page-table memory references=8388608
random          2 GiB, 4 KiB pages, 200000 accesses, seed=1
  accesses=200000  L1 hits=24 (0.0%)  last-level hits=379 (0.2% of L1 misses)
  walks=199597 (99.8%)  page-table memory references=798388
sequential     2 GiB, 2 MiB pages, 4 passes, 1024 pages/pass
  accesses=4096  L1 hits=0 (0.0%)  last-level hits=3072 (75.0% of L1 misses)
  walks=1024 (25.0%)  page-table memory references=3072
random          2 GiB, 2 MiB pages, 200000 accesses, seed=1
  accesses=200000  L1 hits=12598 (6.3%)  last-level hits=186378 (99.5% of L1 misses)
  walks=1024 (0.5%)  page-table memory references=3072
```

读这些数字：

1. **页表占用主要是叶子 PTE 的问题。** 32 GiB 的映射，4 KiB 时要 64.13 MiB 页表，2 MiB 时只要 136 KiB——大约少 480 倍。到了 256 GiB，4 KiB 的页表单独就有 513 MiB，这在计入应用数据之前，已经是一份住在缓存里的“工作集”。1 GiB 页能把同一段 256 GiB 映射收成两张表（8 KiB）：一张 PDPT 和一张 PML4。

2. **超过 TLB 覆盖范围的顺序扫描，每一次都会缺失。** 对 16 MiB 的 4 KiB 页做 4 遍扫描，每遍 4,096 页。1,024 项的最后一级只能覆盖其中四分之一，但在循环扫描上，LRU 会在一页再次被需要之前就把它淘汰，于是遍历率是 100%。同样的 16 MiB 换成 8 个 2 MiB 页，就能放进 L1：第一遍走 8 次，后三遍命中，全部访问里有 75% 是 L1 命中。

3. **随机访问让覆盖范围的差距变得一目了然。** 在 16 MiB 上，4 KiB 页仍然有 75.0% 的访问要走页表；2 MiB 页在 200,000 次访问里只走 8 次，其余全部命中 L1（199,992 次 L1 命中）。在 256 MiB 上，4 KiB 随机访问有 98.5% 要走页表；2 MiB 页（一共 128 个）能放进最后一级 TLB，每个只走一次，随后的命中则在 L1（64 项，大约一半）和最后一级之间分配。在 2 GiB 上，4 KiB 随机访问有 99.8% 要走页表。2 MiB 页恰好产生 1,024 条翻译，填满最后一级 TLB：1,024 次必经的遍历（0.5%），以及 L1 缺失时 99.5% 的最后一级命中率。

这个模型在一个方面对 4 KiB 页偏客气——真实的最后一级 TLB 并不是 1024 项的全相联 CAM——在另一个方面又对 2 MiB 页偏客气——有些核心的 2 MiB 槽比 4 KiB 槽更少。这两点都不会改变结果的形状：一旦以*页数*计的工作集超出了 TLB，你就要付一次遍历的代价，而页大小就是你改变页数的方式。

## 小结

- 虚拟地址由多级页表翻译。在 4 级 x86-64 上，4 KiB 页要四次依赖读取，2 MiB 三次，1 GiB 两次。5 级分页增加 PML5 和 57 位地址，但除非 `mmap` 的 hint 明确要求，Linux 仍把用户态留在 47 位窗口里。
- TLB 真正有用的指标是覆盖范围：表项数乘以页大小。在多核上，shootdown 而不只是缺失才是代价：一次权限或映射变更，必须让每一个可能缓存了旧表项的核心失效。
- 缺页用来填上映射。次要缺页是记账；主要缺页要等存储。`fork` 是整页的写时复制，所以一片 2 MiB 的叶子在写入一个字节时会拷贝 2 MiB。
- `mmap` 预留的是虚拟空间。过度提交决定这份预留是不是承诺。模式 0 和 1 可以在稍后失败，通过缺页或 OOM killer。
- 大页按同样的倍数削减页表占用、提高 TLB 覆盖范围。对长寿的共享区域，使用预留的 hugetlb 池（PostgreSQL 显式的 `huge_pages`）。对会在负载下 `fork` 的堆，要小心 THP（Redis 文档中的建议是关掉它）。
- 当一个服务的时间转移到缺页处理或 TLB 缺失计数器上时，先看页大小、工作集是否还在覆盖范围内，以及 `fork` 或 `madvise` 是否在放大 COW 或 shootdown，再去看算法本身。

## 参考文献

- Intel，《Intel 64 and IA-32 Architectures Software Developer's Manual》，第 3 卷，第 4 章（Paging），包括 PCID 与 INVPCID
- AMD，《AMD64 Architecture Programmer's Manual》，第 2 卷（System Programming）
- Linux 内核：[x86-64 memory layout](https://docs.kernel.org/arch/x86/x86_64/mm.html)
- Linux 内核：[5-level paging](https://docs.kernel.org/arch/x86/x86_64/5level-paging.html)
- Linux 内核：[Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html)
- Linux 内核：[HugeTLB Pages](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html)
- Linux 内核：[Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html)
- Redis：[Diagnosing latency issues](https://redis.io/docs/operate/oss_and_stack/management/optimization/latency/)（透明大页与 `fork`）
- PostgreSQL：[Managing Kernel Resources](https://www.postgresql.org/docs/current/kernel-resources.html)（过度提交，Linux 大页）
- PostgreSQL：[Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html)（`huge_pages`，关于 THP 的说明）
- Ulrich Drepper，[What Every Programmer Should Know About Memory](https://www.akkadia.org/drepper/cpumemory.pdf)（2007）
