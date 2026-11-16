---
title: "Virtual Memory in Depth: Page Tables, TLBs, Huge Pages and the Cost of a Page Fault"
tag: performance
description: How a userspace pointer becomes a physical address — 4-level and 5-level page tables on x86-64, PTE flags, TLBs and TLB shootdowns, PCID/ASID, minor versus major faults, copy-on-write, demand paging and overcommit, 2 MiB/1 GiB huge pages versus transparent huge pages, and a runnable page-walk model that compares 4 KiB and 2 MiB mappings
date: "2026-11-16T13:40:00.000Z"
---

## Goal

Every pointer your program holds is a *virtual* address. The CPU cannot fetch a byte from DRAM until that address has been translated into a *physical* one. The data structure that makes the translation is the page table; the cache that keeps it from being unbearably slow is the TLB; the event that fills a missing page is a page fault. Almost every surprising memory cost in production — a `fork` that froze a Redis instance, a database that spent more time walking page tables than reading rows, a process that allocated successfully and was later killed — is a surprise about this path.

This article covers:

1. Why virtual memory exists, and what a page actually is.
2. The x86-64 **4-level page walk**, canonical addresses, and **5-level paging** (LA57).
3. PTE flags: present, writable, user, NX, accessed, dirty, global, and the page-size bit.
4. The **TLB**: reach, misses, PCID/ASID, and shootdowns.
5. **Page faults**: minor versus major, demand paging, copy-on-write, and protection faults.
6. `mmap`, overcommit, and the OOM killer.
7. **Huge pages**: 2 MiB and 1 GiB, hugetlb versus transparent huge pages, and why Redis and PostgreSQL give opposite-looking advice.
8. What this means for language runtimes and data services.
9. A runnable model that accounts page-table memory and compares TLB behavior for 4 KiB and 2 MiB mappings.

## 1. Why the address your program sees is not a physical one

Virtual memory gives each process its own address space. The same virtual address can map to different physical pages in two processes, or to nothing at all. That is how isolation works, and it is also how the kernel can offer a sparse 128 TiB userspace (on 4-level x86-64) to a program that only has a few GiB of RAM: mappings are created first, physical pages are attached later.

The unit of mapping is the **page**. The architectural base size on x86-64 is 4 KiB. A 4 KiB page is also the unit of permission, the unit of a TLB entry for that size, and the unit the kernel uses for demand paging, copy-on-write and swap. Larger page sizes exist; they are the subject of section 7, and they exist because 4 KiB is often too small for the working sets we run today.

The kernel tracks mappings as **VMAs** (virtual memory areas): contiguous ranges with the same permissions and backing (anonymous, file, shared). `/proc/<pid>/maps` is a dump of those ranges. A VMA is not a page table. It is the bookkeeping the kernel uses to *build* and *fault* page-table entries.

## 2. Walking a 4-level table

On modern x86-64 with 4-level paging, a userspace virtual address is a 48-bit value stored in a 64-bit register. The upper bits must be a sign extension of bit 47 — a **canonical** address. Non-canonical addresses fault. The 48 bits are split, from the top:

| Bits | Field | What it indexes |
| --- | --- | --- |
| 47:39 | PML4 | Page Map Level 4 (512 entries) |
| 38:30 | PDPT | Page Directory Pointer Table |
| 29:21 | PD | Page Directory |
| 20:12 | PT | Page Table |
| 11:0 | offset | Byte within a 4 KiB page |

Each table is itself one 4 KiB page of 512 eight-byte entries, so each level consumes 9 address bits. CR3 holds the physical address of the PML4 (and, when PCID is on, a 12-bit address-space tag in the low bits). The hardware walk is then four dependent memory reads: PML4 entry → PDPT entry → PD entry → PT entry, after which bits 11:0 are added to the physical page address in the leaf. A 2 MiB page stops one level earlier: the PD entry has the **PS** (page size) bit set, and bits 20:0 are the offset. A 1 GiB page stops at the PDPT, with bits 29:0 as the offset.

That walk is why page tables are not free. A 32 GiB contiguous mapping of 4 KiB pages needs 8,388,608 leaf PTEs, which occupy 16,384 page-table pages, plus a handful of upper-level tables — 64.13 MiB of page-table memory, all of which must itself be translated and cached. The model in section 9 works this out exactly.

The original 4-level design gives 256 TiB of virtual address space and, as the kernel documents the original hardware, 64 TiB of physical address space ([5-level paging](https://docs.kernel.org/arch/x86/x86_64/5level-paging.html)). Linux splits the 256 TiB evenly: roughly 128 TiB for userspace, the rest for the kernel, with a non-canonical hole in the middle ([x86-64 memory layout](https://docs.kernel.org/arch/x86/x86_64/mm.html)).

### 2.1 Five levels, and why Linux will not give you the extra bits unless you ask

5-level paging adds a PML5 and extends the virtual address to 57 bits: 128 PiB of virtual space and 4 PiB of physical space. The feature is advertised as `la57`. It is a straightforward extra level, but it collides with a widespread userspace habit: JIT compilers and runtimes that stash tags in the high bits of a pointer. A pointer that was "safe to tag" in a 48-bit world is a valid address in a 57-bit world, and using it as a tagged pointer will crash.

Linux's answer is conservative. With 5-level paging enabled, the kernel still allocates userspace virtual addresses from the lower 47-bit window **by default**. A process that wants the high range must pass a hint address above bit 47 to `mmap` (with or without `MAP_FIXED`). The hint is ignored on older kernels and on machines without LA57, so the same source keeps working. This is documented in the [5-level paging guide](https://docs.kernel.org/arch/x86/x86_64/5level-paging.html).

## 3. What a PTE actually records

A leaf page-table entry is a physical page address plus a packed set of flags. The ones that show up in everyday debugging:

- **P** (present). If clear, the entry is not a translation. The remaining bits are then free for the kernel to use as a swap slot, a file offset, or a "this is the first-touch anonymous page" marker. A access through a not-present entry is a page fault, not a TLB fill.
- **R/W**. Write permission. Fork uses this: parent and child share the same physical page with the PTE marked read-only, and the first write becomes a copy-on-write fault.
- **U/S**. User versus supervisor. Kernel mappings are not accessible from ring 3.
- **NX** (the high bit, if `EFER.NXE` is set). Execute permission, the hardware side of W^X.
- **A** (accessed) and **D** (dirty). Hardware sets these on use and on write. The kernel reads them to decide what to reclaim, what to write back, and which COW pages have actually been modified.
- **G** (global). The translation survives a CR3 reload. Kernel pages typically set this so a context switch does not throw away the kernel's TLB entries.
- **PS**. On a PD or PDPT entry, this marks a 2 MiB or 1 GiB leaf rather than a pointer to a lower table.
- **PWT / PCD / PAT**. Cacheability. Most ordinary memory is write-back; device memory is not.

Permission checks are applied during the walk. A user write to a read-only present page, an execute through NX, or a user access to a supervisor page all fault, even though the translation exists.

## 4. The TLB is the translation cache, and it is small

Four dependent memory reads per load would be catastrophic, so the CPU caches translations in the **translation lookaside buffer**. A TLB hit turns the virtual address into a physical one without walking anything. A miss walks the tables (often with the help of a page-walk cache that keeps recent upper-level entries) and fills the TLB.

Two quantities matter more than microarchitectural trivia:

- **Reach** — how much virtual memory the TLB can cover at once. Reach is `entries × page size`. A 1024-entry last-level TLB covers **4 MiB** of 4 KiB pages, or **2 GiB** of 2 MiB pages. That is not a small difference; it is the difference between "the working set fits in translations" and "almost every new page walks the table."
- **Associativity and split**. Real cores usually have a small L1 dTLB/iTLB and a larger shared last-level TLB, and they often keep 2 MiB translations in a separate, smaller array. The model in section 9 uses a unified fully-associative LRU (64-entry L1, 1024-entry last-level) so the arithmetic stays honest and inspectable. Treat those capacities as **parameters**, not as a claim about a particular CPU. The qualitative result — 4 KiB reach is measured in megabytes, 2 MiB reach is measured in gigabytes — does not depend on the exact SKU.

### 4.1 Context switches: PCID and ASID

Reloading CR3 used to flush the TLB, except for global entries. That made process switches more expensive than they needed to be: the process you just left might run again in a few milliseconds, and its translations were gone.

**PCID** (Process-Context Identifiers) tags each TLB entry with a 12-bit identifier carried in CR3. A CR3 write that changes the PCID does not have to flush other PCIDs' entries. `INVPCID` invalidates by address, by PCID, or more broadly. ARM's analogue is the **ASID** sitting next to the translation in the TLB. Linux uses these tags so a context switch can keep translations for recently run address spaces.

### 4.2 Shootdowns scale with cores, not with the size of a load

A TLB is a *per-core* cache. When software changes a translation — `munmap`, `mprotect`, a COW break, a ksm merge, a migrate — every core that might still hold the stale entry has to drop it. Locally that is `INVLPG` (or a broader flush). Remotely it is an inter-processor interrupt. This is a **TLB shootdown**.

The cost follows the number of cores that have the address space loaded, not the number of bytes the program just wrote. Unmapping a large region, or flipping permissions on one, can therefore stall many cores at once. Kernels batch flushes, defer them on cores that are not currently running that `mm`, and use range or individual invalidations to avoid a full flush. It is one reason a "cheap" `mprotect` or a allocator that calls `madvise(MADV_DONTNEED)` on a large range can show up in profiles as system time on a many-core box.

## 5. Page faults are how pages come into existence

A fault is the walk reporting "I cannot complete this access." The kernel then either fixes the mapping and resumes the instruction, or delivers a signal (`SIGSEGV`, `SIGBUS`).

The useful split is **minor versus major**:

- A **minor** fault does not need a storage I/O. Typical cases: the first write to a still-resident copy-on-write page; an anonymous page that has never been touched and can be filled with zeros; a file page that is already in the page cache. The process is delayed by allocation and bookkeeping, not by a disk.
- A **major** fault has to read the page from storage (or from a remote filesystem). This is the "the program paused because of memory" event people usually mean by "paging."

Demand paging is the policy that makes `mmap` cheap: creating a VMA does not allocate physical pages. The first access to each page faults, and only then does the kernel attach a frame. `MAP_POPULATE` and `mlock` exist to pull that cost forward when a later stall would be worse.

Copy-on-write is the same mechanism, reused for `fork`. After `fork`, parent and child share physical pages with read-only PTEs. A write in either process faults, the kernel allocates a new page, copies the old one, and updates the writer's PTE. The first byte written is not "one byte of extra memory"; it is a whole page. With 4 KiB pages that is 4 KiB. With a 2 MiB huge page it is 2 MiB. That factor of 512 is the start of the Redis story in section 7.

Protection faults are the remaining case: the page is present, but the access is not allowed. Some of these are COW in disguise. The rest are bugs, stack overflows that hit a guard page, or intentional probes.

## 6. mmap, overcommit and the killer that arrives later

`mmap` is how most runtimes obtain large regions: anonymous heaps, thread stacks, file-backed data, shared buffers. The call returns a pointer when the *virtual* range has been reserved. Whether the *physical* memory will be there when you touch it is a separate question, answered by the overcommit policy ([Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html)):

| `vm.overcommit_memory` | Policy |
| --- | --- |
| 0 (default) | Heuristic. Obviously insane reservations are refused; ordinary overcommit is allowed. |
| 1 | Always overcommit. Sparse address spaces that will never populate most pages can reserve huge holes. |
| 2 | No overcommit. Commit is capped at swap plus a configurable share of RAM (`vm.overcommit_ratio`, default 50%), reported as `CommitLimit` in `/proc/meminfo`. `Committed_AS` is the current charge. |

In modes 0 and 1, a successful `mmap` or `malloc` is not a promise that the pages exist. The failure can arrive later, as a fault the kernel cannot satisfy, or as the **OOM killer** choosing a process and sending it `SIGKILL`. PostgreSQL's documentation calls out the default heuristic as a poor fit for a database and discusses both `vm.overcommit_memory=2` and protecting the postmaster with `oom_score_adj=-1000` ([Managing Kernel Resources](https://www.postgresql.org/docs/current/kernel-resources.html)).

File-backed shared or read-only mappings do not charge commit the way private writable anonymous mappings do — the file is the backing store. That is why a process can `mmap` a 50 GiB file on a 8 GiB machine and, as long as it only touches a working set that fits, keep running.

## 7. Huge pages: the same walk, fewer entries

A 2 MiB page is 512 base pages in one TLB entry and one leaf PTE (at the PD). A 1 GiB page is 512 of those. The gains are mechanical:

- **TLB reach** grows by the same factor. The 1024-entry last-level in the model covers 4 MiB at 4 KiB and 2 GiB at 2 MiB.
- **Page-table memory** shrinks by roughly the same factor at the leaf. A 32 GiB mapping occupies 64.13 MiB of tables at 4 KiB, 136 KiB at 2 MiB, and 8 KiB at 1 GiB.
- **Walks are shorter**: three table references for 2 MiB, two for 1 GiB, instead of four.

Linux offers two very different ways to get them.

**hugetlb** (and `mmap(..., MAP_HUGETLB)`, or the hugetlbfs mount) draws from a pool sized by `vm.nr_hugepages` or the per-size file under `/sys/kernel/mm/hugepages/`. The pages are reserved up front. You get predictability: either the pool had a page, or the allocation failed. You also get the operational burden of sizing the pool, dealing with fragmentation when you try to reserve later, and granting the process permission to use it. This is what PostgreSQL's `huge_pages = try | on | off` path is for: the main shared-memory region (typically `shared_buffers`) is a large, long-lived, contiguous mapping, exactly the workload huge pages were designed for. The default is `try`. `on` will refuse to start if the pool is too small. The official docs also note that **transparent** huge pages have caused regressions for some users and are currently discouraged for PostgreSQL, in contrast to this explicit path ([Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html), [Linux Huge Pages](https://www.postgresql.org/docs/current/kernel-resources.html)).

**Transparent huge pages (THP)** take the opposite bet. The kernel may allocate a PMD-sized (2 MiB) page for an anonymous mapping, or later collapse a run of 4 KiB pages into one, without the application asking. `khugepaged` does the background collapse. The knobs are `always`, `madvise` and `never`, plus `madvise(MADV_HUGEPAGE)` / `MADV_NOHUGEPAGE`. Recent kernels also support **multi-size THP** (mTHP): intermediate, power-of-two sizes that stay PTE-mapped. The kernel documentation's point is that mTHP reduces fault counts without the same tail-latency spike as a full 2 MiB allocation that also has to be zeroed ([Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html)).

THP is the right default for many throughput-heavy programs that never `fork` a large dirty heap. It is the wrong default for a latency-sensitive process that does. Redis persists with `fork`: the child shares the parent's pages, then the still-busy parent writes through its event loop. Official Redis documentation describes what happens when those shared pages are huge: a few thousand writes, each breaking a 2 MiB COW page, copy almost the whole process, and produce both a latency spike and a memory spike. The documented remedy is to disable THP for the host and restart Redis ([Diagnosing latency issues](https://redis.io/docs/operate/oss_and_stack/management/optimization/latency/)).

So the "opposite" advice is not a contradiction. PostgreSQL wants **explicit, reserved, long-lived** huge pages for a shared buffer pool that is not being copy-on-write-forked on the request path. Redis wants **no transparent promotion** of a heap that *is*. The shared lesson is that page size is a COW and fault-latency decision, not just a TLB decision.

## 8. What this looks like in runtimes and services

Language runtimes are virtual-memory programs first and allocators second. A GC heap is usually a large anonymous `mmap`, populated on first touch, sometimes with `madvise` hints about what can be given back (`MADV_DONTNEED` or `MADV_FREE`). Thread stacks are mappings with a **guard page** — a `PROT_NONE` hole that turns a runaway stack into a fault instead of a silent smash of adjacent memory. Allocators that return memory to the kernel on a large free are choosing a shootdown and a future fault, in exchange for RSS.

The same mechanics show up in services:

- A process that `fork`s to snapshot itself inherits every huge page's COW amplification. Redis is the documented case; any copy-on-write snapshot of a large heap has the same shape.
- A process that maps tens of GiB with 4 KiB pages spends tens of MiB on page tables alone, and those tables compete for cache with the data. Huge pages shrink that overhead into the noise.
- A process that relies on overcommit can die at first touch, far from the call that "succeeded." Databases that care about this tighten overcommit and shield the supervisor process from the OOM killer.
- Profiles that show a lot of time in page-fault or TLB-miss counters are often telling you the working set no longer fits in translation reach, not that the algorithm got slower.

A short ARM note, because the ideas travel. AArch64 can use 4 KiB, 16 KiB or 64 KiB granules; the number of table levels then depends on the granule and the virtual-address width. TLB entries are tagged with an ASID, which plays the same role as a PCID. The leaf still carries present, permission and page-size information. The walk is the same shape with different constants.

## 9. A runnable model

The program below does two things, both of which are arithmetic rather than a claim about a particular core.

First, it counts the 4 KiB table pages needed for a single contiguous mapping under a 4-level x86-64 walk, at 4 KiB, 2 MiB and 1 GiB leaves. Second, it runs a two-level fully-associative LRU TLB (64-entry L1, 1024-entry last-level) over sequential and random page traces, for the same regions mapped with 4 KiB and 2 MiB pages. A 4 KiB miss costs four table references; a 2 MiB miss costs three. The last-level reach is 4 MiB versus 2 GiB.

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

Output on CPython 3:

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

Reading those numbers:

1. **Page-table memory is a leaf-PTE problem.** A 32 GiB mapping costs 64.13 MiB of tables at 4 KiB and 136 KiB at 2 MiB — about 480 times less. At 256 GiB the 4 KiB tables alone are 513 MiB, which is already a cache-resident "working set" before the application data is counted. 1 GiB pages collapse the same 256 GiB mapping to two table pages (8 KiB): one PDPT and one PML4.

2. **Sequential scans that exceed TLB reach miss every time.** Four passes over 16 MiB of 4 KiB pages are 4,096 pages per pass. The 1,024-entry last-level covers a quarter of that, but LRU on a cyclic scan evicts a page before it is needed again, so the walk rate is 100%. The same 16 MiB as eight 2 MiB pages fits in L1: the first pass walks eight times, the next three passes hit, and 75% of all accesses are L1 hits.

3. **Random access makes the reach gap obvious.** Over 16 MiB, 4 KiB pages still walk on 75.0% of accesses; 2 MiB pages walk eight times in 200,000 accesses and then hit L1 for the rest (199,992 L1 hits). Over 256 MiB, 4 KiB random access walks 98.5% of the time; 2 MiB pages (128 of them) fit in the last-level TLB, walk once each, and then split hits between L1 (64 entries — about half) and the last level. Over 2 GiB, 4 KiB random access walks 99.8% of the time. 2 MiB pages produce exactly 1,024 translations, which fills the last-level TLB: 1,024 compulsory walks (0.5%) and a 99.5% last-level hit rate on L1 misses.

The model is kind to 4 KiB pages in one respect — a real last-level TLB is not a 1024-entry fully-associative CAM — and kind to 2 MiB pages in another — some cores have fewer 2 MiB slots than 4 KiB slots. Neither caveat changes the shape of the result: once the working set in *pages* exceeds the TLB, you pay a walk, and page size is how you change the number of pages.

## Summary

- Virtual addresses are translated by a multi-level page table. On 4-level x86-64 the walk is four dependent reads for a 4 KiB page, three for 2 MiB, two for 1 GiB. 5-level paging adds a PML5 and 57-bit addresses, but Linux keeps userspace in the 47-bit window unless a `mmap` hint asks for more.
- The TLB's useful metric is reach: entries times page size. Shootdowns, not just misses, are the many-core cost: a permission or mapping change has to invalidate every core that might have cached the old entry.
- Faults populate mappings. Minor faults are bookkeeping; major faults wait on storage. `fork` is copy-on-write of whole pages, so a 2 MiB leaf copies 2 MiB when a single byte is written.
- `mmap` reserves virtual space. Overcommit decides whether that reservation is a promise. Modes 0 and 1 can fail later, via a fault or the OOM killer.
- Huge pages cut table memory and raise TLB reach by the same factor. Use a reserved hugetlb pool for long-lived shared regions (PostgreSQL's explicit `huge_pages`). Be careful with THP on heaps that `fork` under load (Redis's documented advice is to turn it off).
- When a service's time moves into page-fault handling or TLB-miss counters, look at page size, working-set reach, and whether a `fork` or an `madvise` is amplifying COW or shootdowns, before looking at the algorithm.

## References

- Intel, *Intel 64 and IA-32 Architectures Software Developer's Manual*, Volume 3, Chapter 4 (Paging), including PCID and INVPCID
- AMD, *AMD64 Architecture Programmer's Manual*, Volume 2 (System Programming)
- Linux kernel: [x86-64 memory layout](https://docs.kernel.org/arch/x86/x86_64/mm.html)
- Linux kernel: [5-level paging](https://docs.kernel.org/arch/x86/x86_64/5level-paging.html)
- Linux kernel: [Transparent Hugepage Support](https://docs.kernel.org/admin-guide/mm/transhuge.html)
- Linux kernel: [HugeTLB Pages](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html)
- Linux kernel: [Overcommit Accounting](https://docs.kernel.org/mm/overcommit-accounting.html)
- Redis: [Diagnosing latency issues](https://redis.io/docs/operate/oss_and_stack/management/optimization/latency/) (transparent huge pages and `fork`)
- PostgreSQL: [Managing Kernel Resources](https://www.postgresql.org/docs/current/kernel-resources.html) (overcommit, Linux huge pages)
- PostgreSQL: [Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html) (`huge_pages`, note on THP)
- Ulrich Drepper, [What Every Programmer Should Know About Memory](https://www.akkadia.org/drepper/cpumemory.pdf) (2007)
