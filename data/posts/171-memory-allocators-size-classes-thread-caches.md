---
title: "Inside Memory Allocators: Size Classes, Thread Caches, and How Go, jemalloc, and mimalloc Hand Out Memory"
tag: performance
description: How modern allocators turn a size into a pointer without taking a lock on the fast path — size classes and why they waste a few bytes on purpose, spans that cannot be recycled for a different size, the local / central / heap / OS cache hierarchy, Go's per-P mcache and 16-byte tiny allocator, the size-specialized malloc path added in Go 1.27, how glibc, jemalloc, tcmalloc and mimalloc each place that hierarchy, when an arena is the better tool, and a runnable model that measures rounding waste, class isolation and cache hit rates
date: "2026-11-26T13:41:00.000Z"
---

## Goal

`malloc(24)` looks like a solved problem. You ask for 24 bytes, you get a pointer, and later you give it back. Programming languages have shipped an allocator for decades: glibc's `malloc`, jemalloc, tcmalloc, mimalloc, the Go runtime, the JVM's TLABs. It is tempting to treat the implementation as a finished commodity.

It is not. The interesting part is not the system call that reserves address space. It is a way to serve millions of small allocations from many threads without taking a lock on the fast path, without rounding every request up to the next power of two, and without holding on to so much free memory that RSS never comes back down. The shared idea, invented and reinvented from Doug Lea's allocator through Google's tcmalloc and into today's runtimes, is a **size class**: a rounded size, a page carved into equal slots of that size, and a small cache in front of a locked central structure so that the common allocation is a pop from something the current thread already owns.

This article covers:

1. What an allocator actually has to solve.
2. Size classes, and why they waste a few bytes on purpose.
3. Spans, slabs and pages: why a free 24-byte slot cannot satisfy a 32-byte request.
4. The cache hierarchy: local, central, heap, operating system.
5. Go's allocator: `mcache`, `mcentral`, `mheap`, the 16-byte tiny allocator, and the size-specialized malloc path added in Go 1.27.
6. How glibc, jemalloc, tcmalloc and mimalloc each place that same hierarchy, and where they disagree.
7. When a general-purpose allocator is the wrong tool.
8. A runnable model that measures rounding waste, class isolation, tiny packing, and cache hit rates.

## 1. What malloc has to solve

An allocator sits between the program and the operating system. The OS hands out pages — 4 KiB on a typical Linux process, 8 KiB in the Go runtime's own page size — and wants to be called infrequently. The program hands out objects of 16, 24, 48, or 80 bytes, and wants each of those to be cheap, correctly aligned, and eventually reusable.

Those two granularities do not match. The allocator's job is to cut pages into objects, give them out, take them back, and decide when a page is empty enough to return. Along the way it has to deal with four pressures that pull against each other:

- **Latency.** The common path should be a handful of instructions, with no lock and no system call.
- **Contention.** Many threads allocating at once should not serialize on a single heap lock.
- **Internal fragmentation.** If a 17-byte request occupies a 32-byte slot, 15 bytes are paid for and unused.
- **External fragmentation and reuse.** Memory freed as 24-byte objects should, if possible, eventually serve some other request, or be given back to the OS. Holding a large free cache makes the next allocation fast and makes RSS look permanently high.

A first-fit walk of a single free list can reuse memory across sizes, because neighboring free chunks can be coalesced into a larger one. It also tends to walk farther as the heap ages, and a single list is a single lock. Modern general-purpose allocators keep the coalescing idea for some paths (glibc still coalesces neighboring chunks) and abandon it for the small-object fast path, which is dominated by size classes.

## 2. Size classes: trading a few wasted bytes for a fast path

A size class is a rounded size. A 17-byte request does not get a 17-byte block. It is lifted to the smallest class that can hold it, and it is served from a free list (or a bitmap of free slots) that contains only objects of that class.

The coarsest policy is rounding up to a power of two: 17 becomes 32, 33 becomes 64. It is simple, and it wastes a lot. A tighter policy, used by jemalloc, is to have **four size classes for each doubling in size**, which the jemalloc manual says limits internal fragmentation to approximately 20% for all but the smallest classes. On a 64-bit system with a 16-byte quantum and 4 KiB pages, the manual's Table 1 starts at 8 bytes, then 16, 32, 48, 64, and so on — there is no 24-byte class. A 17-byte request therefore occupies 32 bytes.

Go is tighter still at the bottom of the range. The generated table in [`src/internal/runtime/gc/sizeclasses.go`](https://go.dev/src/internal/runtime/gc/sizeclasses.go) currently lists 67 classes, from 8 bytes to 32 KiB (`MaxSmallSize`). The runtime constant `NumSizeClasses` is 68. The first few rows are 8, 16, 24, 32, 48, 64, 80, which is why a 17-byte request in Go occupies 24 bytes, not 32. The table also records, for each class, the span size in bytes, how many objects fit, how many bytes of tail are left over, the maximum waste, and the minimum alignment. Class 3, 24 bytes, uses an 8,192-byte span, fits 341 objects, and leaves 8 bytes of tail; the commented maximum waste is 29.24%.

tcmalloc describes the same idea: small objects are mapped onto one of 60–80 size classes, and a 12-byte request is rounded to 16. When `__STDCPP_DEFAULT_NEW_ALIGNMENT__` is at most 8, tcmalloc also offers 8-byte-aligned classes for `operator new`, so that common sizes such as 24 and 40 are not forced up to a multiple of 16.

The waste is the point, not an accident. Once every object in a page has the same size, allocation is "find a free slot in this page" and freeing is "put this slot back." There is no search for a chunk that is just large enough, and no need to split or coalesce on the fast path.

The model's first run asks for every size from 1 to 256 bytes once, then for every size from 1 to 32,768 bytes once, and compares power-of-two rounding, jemalloc's published classes (including the large classes in Table 1 up to 32 KiB), and Go's table. This is not a program trace — it over-represents odd sizes that real programs never request — but it makes the rounding policy visible:

| Range | Policy | Granted vs requested |
| --- | --- | ---: |
| 1–256 bytes | power-of-two | +32.88% |
| 1–256 | jemalloc classes | +8.75% |
| 1–256 | Go size classes | +5.45% |
| 1–32,768 | power-of-two | +33.33% |
| 1–32,768 | jemalloc classes | +8.33% |
| 1–32,768 | Go size classes | +5.34% |

A 1-byte request occupies 8 bytes under all three policies (Go's minimum heap alignment is 8 bytes). The interesting differences are in the middle: 17 and 24 bytes stay at 24 in Go and jump to 32 under jemalloc and power-of-two rounding; 33 bytes becomes 48 in Go and jemalloc, and 64 if you only round to a power of two; 80 bytes is an exact class in both Go and jemalloc, and would occupy 128 under power-of-two rounding.

## 3. Spans of one class, and why they do not mix

The unit that holds objects of one class has a different name in each allocator — **span** in Go, **slab** in jemalloc, a **page** of one size class in mimalloc — and the idea is the same. A run of pages is dedicated to a single class. Go's page size is 8,192 bytes (`PageShift = 13`). A 24-byte class therefore fits 341 objects in one page, with 8 bytes left over at the tail; a 32-byte class fits 256 objects with nothing left over.

A free slot can only be reused by another request of that same class. That is the cost of the fast path. Memory that was allocated as 24-byte objects and then freed is still 24-byte memory. A later wave of 32-byte requests cannot carve those slots up differently, and cannot glue two 24-byte slots into a 32-byte object. A coalescing allocator can: once neighboring chunks are free, they merge, and a larger request can be carved out of the result.

The model's second run allocates 2,000 objects of 24 bytes, frees all of them, and then tries to allocate 2,000 objects of 32 bytes **without taking more memory from the OS**:

| Allocator | After 2,000 × 24-byte allocs, reserved | 32-byte allocs satisfied from that memory |
| --- | ---: | ---: |
| first-fit, coalescing neighbors | 68,096 bytes | 1,702 of 2,000 |
| Go-style size classes, 8 KiB pages | 49,152 bytes (6 pages) | 0 of 2,000 |

The coalescing heap uses more memory up front because the model charges an 8-byte boundary-tag header on every chunk, and because it was given a small slack region. It can still satisfy 1,702 of the 32-byte requests from the same reservation (each such request needs 40 bytes including the header; 68,096 / 40 = 1,702). The size-class heap uses less memory for the first wave — 2,000 × 24-byte objects plus page-tail waste fit in six 8 KiB pages — and then satisfies **none** of the 32-byte requests from those pages. If it is allowed to grow, it takes eight more pages for the 32-byte class and the reserved size goes from 49,152 to 114,688 bytes. The 24-byte pages sit free and unusable for the new size.

That is not an argument for first-fit. The same run shows why: a naive walk of a single free list averaged about 1,000 chunk visits per allocation, which is exactly why glibc and its ancestors keep **bins** of chunks by size rather than scanning the whole heap. It is an argument that size classes buy a O(1) free-slot operation by giving up cross-class reuse, and that the reuse problem has to be solved somewhere else — by returning empty pages to a page heap that can be recarved, or by giving them back to the OS.

## 4. The cache hierarchy

Once objects of a class live in spans, the remaining question is who is allowed to touch which span. The usual answer is a hierarchy:

1. **A local cache**, owned by a thread, a Go processor (`P`), or a CPU. Allocation and free on this cache take no lock, because only one execution context uses it at a time.
2. **A central structure** per size class, protected by a lock or by carefully designed atomics. The local cache refills from here, in batches or by taking a whole span, so the lock is amortized across many objects.
3. **A page heap**, which hands out runs of pages and takes empty ones back, recarving them for a different class if needed.
4. **The operating system**, via `mmap` or an equivalent. Allocators take memory in large-enough chunks to amortize the system call — at least 1 MiB at a time, in the Go runtime's comments — and give it back only when a larger region is unused.

The local cache is why allocation scales with thread count, and also why a process can look memory-hungry after a burst of allocation: each cache is allowed to hold a bounded number of free objects, and those objects are not visible to other threads until they are flushed. Allocators disagree about whether "local" means per-thread, per-CPU, or per-scheduling-context, and about how aggressively to purge unused pages. The next four sections are that disagreement in detail.

## 5. Go: per-P caches, a tiny allocator, and size-specialized malloc

The Go runtime's allocator was originally based on tcmalloc and has diverged. The overview at the top of [`src/runtime/malloc.go`](https://go.dev/src/runtime/malloc.go) is still the right map. Small allocations, up to and including 32 KiB, are rounded to a size class and served from a span of equal-sized slots. Large allocations bypass the caches and go to the page heap directly.

The cache is **per-P**, not per-goroutine. A `P` is the scheduling context that a kernel thread (`M`) must hold to run a goroutine (`G`). An `mcache` holds, among other things, an array of current spans indexed by **span class**. A span class encodes both the size class and whether the objects contain pointers: the Go 1.27 blog writes it as `sizeClass<<1 | noPointers`. Pointer and pointer-free objects of the same size live in different spans, because the garbage collector needs different bookkeeping for each.

A small allocation proceeds up the hierarchy described in `malloc.go`:

1. Round the size to a class and look in this P's `mcache` span. Scanning that span's free bitmap for a slot takes no lock.
2. If the span is full, take a span with free space from the corresponding `mcentral`. Taking a whole span amortizes the `mcentral` lock.
3. If `mcentral` has no such span, take a run of pages from `mheap`.
4. If `mheap` cannot satisfy the run, obtain at least 1 MiB from the operating system.

`mcentral` itself keeps two roles for its spans — partial (has a free object) and full — and, on each GC cycle, swaps which set is considered swept and which is unswept, so the sweeper and the allocator share the work of making spans reusable. Empty spans go back to `mheap`, where their pages can be used for a different class.

The heap is mapped in **arenas**. On 64-bit platforms other than Windows, iOS/arm64, and OpenBSD/arm64, an arena is 64 MiB; on Windows, 32-bit platforms, and those smaller 64-bit targets it is 4 MiB, and on Wasm it is 512 KiB. The comments in `malloc.go` explain the smaller Windows and Wasm arenas: Windows charges committed memory to the process even if it has not been touched, and Wasm programs often have very small heaps.

### The tiny allocator

Pointer-free allocations smaller than 16 bytes do not each consume an 8-byte or 16-byte slot. The **tiny allocator**, documented in the comments on `mallocgcTiny`, combines several of those requests into a single 16-byte block (`TinySize = 16`, which is size class 2). The block is freed only when every subobject in it is unreachable. The objects must be noscan (no pointers); that bound is what keeps the potential waste finite.

The same comment is explicit about the 16-byte choice. An 8-byte block would waste nothing when only one subobject remains reachable, but would combine fewer requests. A 32-byte block would combine more and could waste 4× in the worst case. Sixteen bytes is a 2× worst case. The best-case win is 8× regardless of the block size. Objects from the tiny allocator must not be freed explicitly; `SetFinalizer` has a special case so a finalizer can be attached to an interior byte of the block. The stated targets are small strings and standalone escaping variables; the runtime comment reports that on a JSON benchmark the allocator reduced the number of allocations by about 12% and the heap size by about 20%.

A recent exception is worth knowing about: allocations made while a goroutine is in secret mode skip the tiny allocator so that the block can be zeroed on free (Go issue 76356).

The model's third run packs a repeating mix of 1, 2, 3, 4, and 8-byte noscan objects — 2,000 objects, 7,200 bytes requested — using the same 2/4/8-byte alignment bumps as `mallocgcTiny`. Served one-per-slot from Go's size classes, they occupy 16,000 bytes (122.2% more than requested, because 1–4 byte objects all occupy 8-byte slots). Packed into 16-byte tiny blocks they occupy 9,616 bytes in 601 blocks, 33.6% more than requested, and 0.601 of the size-class total. Two thousand 8-byte objects, by contrast, occupy 16,000 bytes either way: exactly two fit in each tiny block, so packing does not shrink the total, it only reduces the number of heap objects the collector has to track.

### Go 1.27: size-specialized malloc

The path above is the generic one: the compiler emits a call to `newobject`, which extracts the size and whether the type has pointers, and then `mallocgc` branches on those facts. Go 1.27 adds a family of **size-specialized** allocation functions for the small end of the table, and the compiler calls them directly when it knows the span class at compile time.

Michael Matloob's [blog post](https://go.dev/blog/size-specialized-allocations) of 16 September 2026 walks through the design. Size classes 1 through 7 cover 1–8, 9–16, 17–24, 25–32, 33–48, 49–64, and 65–80 bytes. A specialized function is generated per span class — for example `mallocgcSmallNoScanSC3` allocates pointer-free objects in class 3 (17–24 bytes). Because the size and the span class are constants, the compiler can turn the zeroing of the slot into straight-line stores instead of a call to `memclrNoHeapPointers`, skip the work of computing the span class, and keep the uncommon cases (GC active, debugging flags) on a slow path. The specialized functions are also produced by an AST inliner from shared Go source, so the copies do not drift by hand.

The [Go 1.27 release notes](https://go.dev/doc/go1.27) give the published numbers: the cost of some small allocations under 80 bytes drops by up to 30%; the overall improvement in real allocation-heavy programs is expected to be about 1%; the binary grows by about 60 KB, independent of the workload. The cutoff is 80 bytes on purpose. Past that, zeroing dominates, and each new specialized function occupies instruction cache that would otherwise hold the single shared `mallocgc` or the user's own code. When the compiler does not know the size — a slice whose length is computed at run time is the post's example — `mallocgc` itself may still dispatch to a specialized function, so that function has to be enough of a win to pay for an indirect call.

The opt-out is `GOEXPERIMENT=nosizespecializedmalloc` at build time. The release notes say this setting is expected to be removed in Go 1.28.

## 6. glibc: arenas, coalescing, and a per-thread cache

The GNU C Library's `malloc` is derived from ptmalloc (pthreads malloc), which is derived from dlmalloc (Doug Lea malloc). The [official manual](https://sourceware.org/glibc/manual/latest/html_node/The-GNU-Allocator.html) draws a contrast that matters for this article: **glibc does not round chunk sizes up to powers of two**, and neighboring chunks can be coalesced on `free` no matter what their size is. That is the coalescing model from section 3, with bins so that the allocator does not walk the entire heap to find a fit.

To scale across threads, glibc maintains multiple **arenas** — independent contiguous areas from which chunks are carved — so that threads can allocate in parallel without a single heap lock. Very large blocks are allocated with `mmap`, and can be returned to the system immediately on `free`, so a large allocation cannot remain trapped between smaller ones. The default `mmap` threshold is 131,072 bytes (128 KiB) and is adjusted dynamically to match the program's allocation pattern; setting `glibc.malloc.mmap_threshold` makes the threshold static and disables that adjustment.

In front of the arenas sits a **per-thread cache** (tcache). The manual's tunables document the defaults: `glibc.malloc.tcache_max` is 1,032 bytes on 64-bit systems and 516 bytes on 32-bit systems (those values are both the default and the maximum in the current manual), and `glibc.malloc.tcache_count` is 16 chunks of each size. The approximate maximum overhead is the number of bins times the count times the chunk size. The older "fastbins" path is gone: the `mxfast` tunable is documented as having no effect because fastbins have been removed.

glibc is the allocator you get on a typical Linux userspace program that has not been linked against jemalloc or tcmalloc. It is also the one whose coalescing behavior is closest to the first-fit side of the model's isolation run, and whose thread cache is the most conservative of the caches described here — a little over a kilobyte per bin, not 32 KiB.

## 7. jemalloc: arenas, extents, and decay

[jemalloc](https://jemalloc.net/jemalloc.3.html) was originally written by Jason Evans for FreeBSD and is now widely used as a replacement allocator, including in some large server deployments and as a `LD_PRELOAD`. Its manual's implementation notes describe the same hierarchy with different names.

Memory is broken into **extents**, always aligned to a multiple of the page size. Small objects live in **slabs** inside an extent, with a bitmap of in-use regions; each large object has its own extent. Size classes follow the four-per-doubling rule already cited, with a 16-byte quantum on 64-bit systems; requests no more than half a quantum are rounded to the nearest power of two that is at least `sizeof(double)`. Small classes stop short of four times the page size; large classes start there and extend up to the largest class that does not exceed `PTRDIFF_MAX`.

**Arenas** reduce lock contention. The default `opt.narenas` is four times the number of CPUs, or one if there is a single CPU. Arenas manage memory independently, which the manual notes adds a small fixed amount of fragmentation; using substantially more arenas than the default is "not likely to improve performance, mainly due to reduced cache performance." In front of the arenas, a **thread-specific cache** (tcache) is enabled by default. The default `opt.tcache_max` is 32 KiB — much larger than glibc's tcache — and can be raised as high as 8 MiB.

Unused pages are not returned to the OS in one shot. They decay. `opt.dirty_decay_ms` is the approximate time from the creation of a set of unused dirty pages until an equivalent set is purged — converted to "muzzy" with `madvise(..., MADV_FREE)` if the OS supports it, or to clean otherwise — and the default is 10 seconds. A decay time of 0 purges immediately; a decay time of `-1` disables purging. `opt.muzzy_decay_ms` then controls how long muzzy pages sit before they are fully returned. This is jemalloc's answer to the RSS problem: keep recently freed pages around long enough to reuse them, then give them back on a curve rather than at the next `free`.

## 8. tcmalloc: per-CPU caches and restartable sequences

Google's [tcmalloc](https://google.github.io/tcmalloc/design.html) is the design Go started from, and the current library has kept moving. The published design splits the allocator into a **front-end** (the cache that serves the application), a **middle-end** (the `CentralFreeList` and the `TransferCache`, which refill that cache in batches), and a **back-end** (the `PageHeap`, which talks to the OS). Small objects go through the front-end as size classes; objects larger than `kMaxSize` go to the page heap directly and are not cached.

The original front-end was per-thread, which is where the name Thread-Caching Malloc comes from. The design doc is blunt about why that became a problem: memory footprints scaled with the number of threads, and modern applications can have so many threads that the caches are either huge in aggregate or tiny per thread. The current default is **per-CPU mode**. Each logical CPU — a hyperthread, on x86 — has a slab of metadata and pointers to free objects of each size class. The amount of memory that can be cached is limited per CPU by `MallocExtension::SetMaxPerCpuCacheSize`, so the total cache scales with active CPUs, not with thread count.

The trick that makes a per-CPU cache safe without a lock is a **restartable sequence** (`rseq(2)`). A restartable sequence is a short instruction sequence that is not allowed to leave partial updates behind; if the thread is migrated or preempted mid-sequence, the kernel restarts it from the beginning. tcmalloc uses this to push and pop a pointer on the current CPU's array. Either the update completes on that CPU, or the sequence restarts, and no lock or atomic is needed on the successful path.

## 9. mimalloc: sharded free lists

[mimalloc](https://microsoft.github.io/mimalloc/), from Microsoft Research, is built around a single idea that its authors call **free list sharding**. A mimalloc page holds blocks of one size class and is usually 64 KiB on a 64-bit system. Instead of one large free list per class, each page has its own list, so objects allocated close together in time tend to sit close together in memory, and an empty page can be found and returned to the OS eagerly.

The "big idea" in the project's own description is **multi-sharding**: each page has a thread-local free list and a concurrent free list. A free from another thread is a single compare-and-swap onto the concurrent list, without coordinated hand-off. Contention is spread across thousands of lists rather than concentrated on one central lock. The published design claims bounded worst-case allocation time (up to OS primitives), about 0.2% metadata overhead, and no internal points of contention that require more than atomics.

mimalloc also treats **heaps** as first-class objects: a heap can be destroyed in one step instead of freeing each object, which is the arena pattern provided as a library feature. Version 3 is the recommended line; it simplifies the earlier lock-free design, shares memory between threads more aggressively, and is the version that CPython's free-threaded builds use to allocate Python objects.

## 10. When a general-purpose allocator is the wrong tool

Everything above is about a **shared** allocator that has to serve an unknown mix of sizes, from many threads, for the life of the process. A lot of programs have a narrower problem, and a narrower allocator wins.

- **Arenas (bump allocators).** If a large set of objects dies at the same time — a single request, a single parser run, a single simulation step — you can bump a pointer through a large block and free the block in one step. There is no per-object free, no size class, and no cache to tune. You pay with the inability to reuse individual objects earlier, and with the obligation to not keep pointers into an arena after it is reset.
- **Fixed-size pools.** If you only ever allocate one size, you can do what a single size class already does, without the rest of the hierarchy, and often on a pre-reserved block.
- **Not allocating.** In Go, escape analysis is still the cheapest allocator: a value that never leaves the stack is not a heap object, is not a size class, and is not a GC root. The specialized malloc path in Go 1.27 makes the values that do escape cheaper; it does not change which values escape.

The caches and size classes in this article are the right default when you cannot make those narrower promises. They are the wrong default when you can.

A few practical notes follow from the designs, not from folklore. If RSS stays high after a burst of allocations, look at the cache and the purge policy before assuming a leak: jemalloc's dirty decay defaults to 10 seconds, glibc's tcache holds 16 chunks per bin, and a per-thread cache in a process with hundreds of threads can look like a leak until you measure which cache owns the bytes. If two threads share a cache line by storing hot objects next to each other, jemalloc's own manual warns that tight packing can produce cache-line sharing and suggests rounding up to a cache-line multiple or requesting cache-line alignment. If you are allocating in Go and the profiler points at `mallocgc` for small, constant-sized objects, Go 1.27's specialized path is already aimed at that; if it points at allocations whose size is only known at run time, the compiler cannot emit the direct call, and the bigger win is still fewer heap objects.

## 11. A runnable model

The script below is the model that produced every figure in this section. It is not a wall-clock comparison of glibc, jemalloc, tcmalloc, mimalloc, or the Go runtime. It counts bytes granted, pages reserved, list walks, span hits, and lock acquisitions under a fixed set of policies: Go's published size-class table, jemalloc's published classes up to 32 KiB, power-of-two rounding, an 8-byte-header first-fit list that coalesces neighbors, 8 KiB pages of a single class, a 16-byte tiny packer with Go's alignment bumps, and a per-P current-span cache in front of a central list and a page heap.

The rounding and isolation runs were discussed in sections 2 and 3, and the tiny-packer run in section 5. The last run is a cache-hierarchy count. Eight processors allocate and free objects of 16, 24, 32, 48, 64, 80, and 96 bytes for 40,000 operations (about 60% allocations, the rest frees of a live object on that processor). One side uses a current span per class per processor, refills from a central list, and takes an 8 KiB page from the heap only when the central list is empty. The other side uses a single locked free list per class, so every allocation and every free acquires that lock.

| Allocator | Allocations | Hit or lock behavior | Pages reserved |
| --- | ---: | --- | ---: |
| per-P current spans | 23,975 | 98.7% span hits; 300 refills; 72 heap takes; 0.013 central locks per alloc | 72 pages (589,824 bytes) |
| locked free list | 23,975 | 40,000 locks (1.668 per alloc) | 53 pages (434,176 bytes) |

Three things stand out.

First, **the local span absorbs almost every allocation**. A 98.7% hit rate means the current span still had a free slot. The 300 refills are the only times the allocator pays a central lock, and 228 of those refills are satisfied by a span that had been returned to the central list after its last object was later freed. Only 72 times does the heap hand out a new page.

Second, **the locked list pays a lock on every operation**, not just every allocation. 16,025 frees plus 23,975 allocations are 40,000 locks, or 1.668 locks per allocation. That is the cost the cache hierarchy exists to avoid, and it is also why "just use a free list" is not a complete design for a multi-threaded allocator.

Third, **the cache uses more memory**. 72 pages versus 53 is the footprint of letting eight processors each hold a current span of each hot class, plus the spans that are only partially empty on the central list. The difference is not a leak; it is the same trade-off jemalloc's manual states for tcaches and arenas, and the same one that pushed tcmalloc from per-thread caches to per-CPU caches with an explicit per-CPU byte budget.

```python
#!/usr/bin/env python3
"""A size-class and cache-hierarchy model for the blog post.

This is an operation-and-byte accounting model, not a wall-clock
comparison of glibc, jemalloc, tcmalloc, mimalloc, or the Go runtime.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# Official Go size-class object sizes from
# src/internal/runtime/gc/sizeclasses.go (classes 1-67).
GO_CLASS_SIZES = [
    8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224,
    240, 256, 288, 320, 352, 384, 416, 448, 480, 512, 576, 640, 704, 768,
    896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304, 2688, 3072, 3200,
    3456, 4096, 4864, 5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240,
    10880, 12288, 13568, 14336, 16384, 18432, 19072, 20480, 21760, 24576,
    27264, 28672, 32768,
]

# jemalloc small size classes on a 64-bit system with a 16-byte quantum
# and 4 KiB pages, from the jemalloc(3) manual, Table 1.
JEMALLOC_SMALL = [
    8, 16, 32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448,
    512, 640, 768, 896, 1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096,
    5 * 1024, 6 * 1024, 7 * 1024, 8 * 1024, 10 * 1024, 12 * 1024, 14 * 1024,
    16 * 1024, 20 * 1024, 24 * 1024, 28 * 1024, 32 * 1024,
]


def pow2_round(n: int) -> int:
    if n <= 8:
        return 8
    p = 8
    while p < n:
        p *= 2
    return p


def class_round(n: int, classes: list[int]) -> int:
    for c in classes:
        if c >= n:
            return c
    raise ValueError(f"size {n} exceeds the class table")


def waste_report(label: str, sizes: list[int], granted: list[int]) -> dict:
    requested = sum(sizes)
    given = sum(granted)
    wastes = [g - s for s, g in zip(sizes, granted)]
    worst_i = max(range(len(wastes)), key=lambda i: wastes[i] / sizes[i])
    return {
        "label": label,
        "requested": requested,
        "granted": given,
        "waste": given - requested,
        "waste_pct": 100.0 * (given - requested) / requested,
        "worst_req": sizes[worst_i],
        "worst_got": granted[worst_i],
        "worst_pct": 100.0 * wastes[worst_i] / sizes[worst_i],
    }


def fmt_report(r: dict) -> str:
    return (
        f"{r['label']:<22} requested={r['requested']:>8}  "
        f"granted={r['granted']:>8}  waste={r['waste']:>7}  "
        f"({r['waste_pct']:5.2f}%)  "
        f"worst {r['worst_req']}->{r['worst_got']} ({r['worst_pct']:.1f}%)"
    )


def run_rounding() -> None:
    print("=" * 72)
    print("Internal fragmentation: every size from 1 to 256 bytes, once each")
    sizes = list(range(1, 257))
    reports = [
        waste_report("power-of-two", sizes, [pow2_round(s) for s in sizes]),
        waste_report("jemalloc-small", sizes, [class_round(s, JEMALLOC_SMALL) for s in sizes]),
        waste_report("go-size-classes", sizes, [class_round(s, GO_CLASS_SIZES) for s in sizes]),
    ]
    for r in reports:
        print(fmt_report(r))

    print()
    print("Internal fragmentation: every size from 1 to 32768 bytes, once each")
    sizes = list(range(1, 32769))
    reports = [
        waste_report("power-of-two", sizes, [pow2_round(s) for s in sizes]),
        waste_report("jemalloc-small", sizes, [class_round(s, JEMALLOC_SMALL) for s in sizes]),
        waste_report("go-size-classes", sizes, [class_round(s, GO_CLASS_SIZES) for s in sizes]),
    ]
    for r in reports:
        print(fmt_report(r))

    print()
    print("Selected sizes (requested -> go class, jemalloc class, power-of-two)")
    for s in [1, 8, 9, 17, 24, 25, 33, 48, 49, 80, 81, 100, 129, 200, 257, 1000, 4097, 20000]:
        print(
            f"  {s:>5} -> go {class_round(s, GO_CLASS_SIZES):>5}   "
            f"je {class_round(s, JEMALLOC_SMALL):>5}   "
            f"p2 {pow2_round(s):>5}"
        )


# --- isolation vs coalescing -------------------------------------------------

HEADER = 8  # implicit-list chunk header, like a simplified boundary tag


@dataclass
class Chunk:
    offset: int
    size: int  # payload + header
    free: bool
    next: "Chunk | None" = None
    prev: "Chunk | None" = None


class CoalescingHeap:
    """A first-fit implicit free list that coalesces neighbors on free."""

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.head = Chunk(0, capacity, True)
        self.os_acquired = capacity
        self.alloc_walks = 0
        self.allocs = 0
        self.fails = 0

    def malloc(self, payload: int) -> int | None:
        need = payload + HEADER
        self.allocs += 1
        c = self.head
        while c is not None:
            self.alloc_walks += 1
            if c.free and c.size >= need:
                return self._carve(c, need)
            c = c.next
        self.fails += 1
        return None

    def _carve(self, c: Chunk, need: int) -> int:
        leftover = c.size - need
        if leftover >= HEADER + 8:
            rest = Chunk(c.offset + need, leftover, True, c.next, c)
            if c.next is not None:
                c.next.prev = rest
            c.next = rest
            c.size = need
        c.free = False
        return c.offset + HEADER

    def free(self, ptr: int) -> None:
        c = self.head
        while c is not None:
            if c.offset + HEADER == ptr:
                c.free = True
                if c.next is not None and c.next.free:
                    c.size += c.next.size
                    c.next = c.next.next
                    if c.next is not None:
                        c.next.prev = c
                if c.prev is not None and c.prev.free:
                    c.prev.size += c.size
                    c.prev.next = c.next
                    if c.next is not None:
                        c.next.prev = c.prev
                return
            c = c.next
        raise KeyError(ptr)

    def free_bytes(self) -> int:
        n = 0
        c = self.head
        while c is not None:
            if c.free:
                n += c.size
            c = c.next
        return n


class SizeClassHeap:
    """Pages of a single size class; a free slot cannot change class."""

    def __init__(self, page: int = 8192) -> None:
        self.page = page
        self.pages: dict[int, list[list[bool]]] = {}  # class -> list of slot-used maps
        self.os_acquired = 0
        self.allocs = 0
        self.fails = 0
        self._ptr_to = {}  # ptr -> (class, page_idx, slot)

    def malloc(self, payload: int, grow: bool = True) -> int | None:
        cls = class_round(payload, GO_CLASS_SIZES)
        self.allocs += 1
        pages = self.pages.setdefault(cls, [])
        for i, slots in enumerate(pages):
            for j, used in enumerate(slots):
                if not used:
                    slots[j] = True
                    ptr = self._encode(cls, i, j)
                    self._ptr_to[ptr] = (cls, i, j)
                    return ptr
        if not grow:
            self.fails += 1
            return None
        nslots = self.page // cls
        if nslots < 1:
            self.fails += 1
            return None
        slots = [False] * nslots
        slots[0] = True
        pages.append(slots)
        self.os_acquired += self.page
        ptr = self._encode(cls, len(pages) - 1, 0)
        self._ptr_to[ptr] = (cls, len(pages) - 1, 0)
        return ptr

    def free(self, ptr: int) -> None:
        cls, i, j = self._ptr_to.pop(ptr)
        self.pages[cls][i][j] = False

    def free_bytes(self) -> int:
        n = 0
        for cls, pages in self.pages.items():
            for slots in pages:
                n += sum(1 for u in slots if not u) * cls
        return n

    def live_bytes(self) -> int:
        n = 0
        for cls, pages in self.pages.items():
            for slots in pages:
                n += sum(1 for u in slots if u) * cls
        return n

    @staticmethod
    def _encode(cls: int, page_idx: int, slot: int) -> int:
        return (cls << 32) | (page_idx << 16) | slot


def run_isolation() -> None:
    print()
    print("=" * 72)
    print("Class isolation versus coalescing")
    n = 2000
    payload = 24
    follow = 32
    # Capacity for the coalescing heap: enough for 2000 * (24+8) plus slack.
    cap = 2000 * (payload + HEADER) + 4096

    coal = CoalescingHeap(cap)
    sc = SizeClassHeap(page=8192)
    coal_ptrs = [coal.malloc(payload) for _ in range(n)]
    sc_ptrs = [sc.malloc(payload) for _ in range(n)]
    assert all(p is not None for p in coal_ptrs) and all(p is not None for p in sc_ptrs)

    print(f"after {n} allocations of {payload} bytes:")
    print(f"  coalescing  os={coal.os_acquired}  free_bytes={coal.free_bytes()}  walks/alloc={coal.alloc_walks/coal.allocs:.2f}")
    print(f"  size-class  os={sc.os_acquired}  free_slots_bytes={sc.free_bytes()}  live_class_bytes={sc.live_bytes()}")

    for p in coal_ptrs:
        coal.free(p)
    for p in sc_ptrs:
        sc.free(p)

    print(f"after freeing all {payload}-byte objects:")
    print(f"  coalescing  os={coal.os_acquired}  free_bytes={coal.free_bytes()}")
    print(f"  size-class  os={sc.os_acquired}  free_slots_bytes={sc.free_bytes()}  (still in the {class_round(payload, GO_CLASS_SIZES)}-byte class)")

    coal.alloc_walks = 0
    coal.allocs = 0
    coal.fails = 0
    sc.allocs = 0
    sc.fails = 0
    os_before_sc = sc.os_acquired
    coal_ok = 0
    sc_ok = 0
    for _ in range(n):
        if coal.malloc(follow) is not None:
            coal_ok += 1
        if sc.malloc(follow, grow=False) is not None:
            sc_ok += 1

    print(f"then {n} allocations of {follow} bytes, without taking more memory from the OS:")
    print(f"  coalescing  succeeded={coal_ok}  failed={n-coal_ok}  os still={coal.os_acquired}  walks/alloc={coal.alloc_walks/max(coal.allocs,1):.2f}")
    print(f"  size-class  succeeded={sc_ok}  failed={n-sc_ok}  os still={os_before_sc}  (free slots stay in the {class_round(payload, GO_CLASS_SIZES)}-byte class)")
    # Show what it costs if the size-class allocator is allowed to grow.
    sc2 = SizeClassHeap(page=8192)
    for _ in range(n):
        sc2.malloc(payload)
    for ptrs in list(sc2._ptr_to):
        sc2.free(ptrs)
    os_after_free = sc2.os_acquired
    for _ in range(n):
        sc2.malloc(follow, grow=True)
    print(f"  size-class if allowed to grow for the {follow}-byte wave: os {os_after_free} -> {sc2.os_acquired}")


# --- tiny packing ------------------------------------------------------------

TINY = 16


def tiny_blocks_used(sizes: list[int]) -> tuple[int, int]:
    """Pack noscan objects into 16-byte blocks, with Go-like alignment bumps."""
    blocks = 0
    offset = 0
    have = False
    packed = 0
    for size in sizes:
        off = offset
        if size & 7 == 0:
            off = (off + 7) & ~7
        elif size & 3 == 0:
            off = (off + 3) & ~3
        elif size & 1 == 0:
            off = (off + 1) & ~1
        if have and off + size <= TINY:
            offset = off + size
            packed += 1
            continue
        # New 16-byte block.
        blocks += 1
        have = True
        offset = size
        packed += 1
    return blocks, packed


def run_tiny() -> None:
    print()
    print("=" * 72)
    print("Tiny packing versus rounding each noscan object to a size class")
    # Repeating mix of the objects the tiny allocator is aimed at:
    # small strings and standalone escaping variables (1, 2, 3, 4, 8 bytes).
    unit = [1, 2, 3, 4, 8, 1, 8, 4, 2, 3]
    sizes = unit * 200  # 2000 objects
    blocks, packed = tiny_blocks_used(sizes)
    tiny_bytes = blocks * TINY
    class_bytes = sum(class_round(s, GO_CLASS_SIZES) for s in sizes)
    requested = sum(sizes)
    print(f"objects={packed}  requested={requested} bytes")
    print(f"  each in its Go size class:  granted={class_bytes}  waste={class_bytes-requested}  ({100*(class_bytes-requested)/requested:.1f}%)")
    print(f"  packed into {TINY}-byte tiny blocks: blocks={blocks}  granted={tiny_bytes}  waste={tiny_bytes-requested}  ({100*(tiny_bytes-requested)/requested:.1f}%)")
    print(f"  tiny / class granted ratio: {tiny_bytes/class_bytes:.3f}")

    # Uniform 8-byte objects: two fit per 16-byte block.
    eights = [8] * 2000
    blocks8, _ = tiny_blocks_used(eights)
    print(f"2000 pointer-free 8-byte objects:")
    print(f"  size class 8: granted={2000*8}")
    print(f"  tiny blocks:  blocks={blocks8}  granted={blocks8*TINY}  (same total, two objects per block)")


# --- cache hierarchy ---------------------------------------------------------

PAGE = 8192


@dataclass
class Span:
    cls: int
    slots: list[bool]
    def free_count(self) -> int:
        return sum(1 for u in self.slots if not u)


@dataclass
class ProcessorCache:
    current: dict[int, Span | None] = field(default_factory=dict)
    hits: int = 0
    refill: int = 0


class CachedAllocator:
    """P local current-spans, a central list per class, and a page heap."""

    def __init__(self, nproc: int) -> None:
        self.procs = [ProcessorCache() for _ in range(nproc)]
        self.central: dict[int, list[Span]] = {}
        self.os_acquired = 0
        self.heap_takes = 0
        self.central_locks = 0
        self.allocs = 0
        self._ptr = {}  # ptr -> (proc, cls) is not enough; store span+slot
        self._next_ptr = 1

    def malloc(self, proc: int, payload: int) -> int:
        cls = class_round(payload, GO_CLASS_SIZES)
        self.allocs += 1
        pc = self.procs[proc]
        span = pc.current.get(cls)
        slot = self._take_slot(span) if span is not None else None
        if slot is not None:
            pc.hits += 1
            return self._mint(span, slot)
        # Refill from central, or take a new page from the heap.
        pc.refill += 1
        span = self._from_central_or_heap(cls)
        pc.current[cls] = span
        slot = self._take_slot(span)
        assert slot is not None
        return self._mint(span, slot)

    def _is_current(self, span: Span) -> bool:
        for pc in self.procs:
            if pc.current.get(span.cls) is span:
                return True
        return False

    def free(self, proc: int, ptr: int) -> None:
        span, slot = self._ptr.pop(ptr)
        was_full = span.free_count() == 0
        span.slots[slot] = False
        # A span that just left the "no free slot" state, and is not some
        # P's current span, goes back to the central list so another P
        # can refill from it.
        if was_full and not self._is_current(span):
            self.central.setdefault(span.cls, []).append(span)

    def _from_central_or_heap(self, cls: int) -> Span:
        pc_list = self.central.setdefault(cls, [])
        self.central_locks += 1
        while pc_list:
            span = pc_list.pop()
            if span.free_count() > 0:
                return span
        # New page from the heap.
        self.heap_takes += 1
        nslots = PAGE // cls
        self.os_acquired += PAGE
        return Span(cls, [False] * nslots)

    def park_current_if_partial(self, proc: int, cls: int) -> None:
        pc = self.procs[proc]
        span = pc.current.get(cls)
        if span is not None and span.free_count() > 0:
            self.central.setdefault(cls, []).append(span)
        pc.current[cls] = None

    @staticmethod
    def _take_slot(span: Span) -> int | None:
        for i, used in enumerate(span.slots):
            if not used:
                span.slots[i] = True
                return i
        return None

    def _mint(self, span: Span, slot: int) -> int:
        ptr = self._next_ptr
        self._next_ptr += 1
        self._ptr[ptr] = (span, slot)
        return ptr


class LockedFreeList:
    """A single locked free list per size class: every operation pays a lock."""

    def __init__(self) -> None:
        self.freelists: dict[int, list[int]] = {}
        self.os_acquired = 0
        self.locks = 0
        self.allocs = 0
        self._next = 1
        self._cls: dict[int, int] = {}

    def malloc(self, payload: int) -> int:
        cls = class_round(payload, GO_CLASS_SIZES)
        self.allocs += 1
        self.locks += 1
        bucket = self.freelists.setdefault(cls, [])
        if bucket:
            return bucket.pop()
        nslots = PAGE // cls
        self.os_acquired += PAGE
        # One object is returned; the rest go on the free list.
        base = self._next
        self._next += nslots
        for i in range(1, nslots):
            ptr = base + i
            bucket.append(ptr)
            self._cls[ptr] = cls
        self._cls[base] = cls
        return base

    def free(self, ptr: int) -> None:
        self.locks += 1
        self.freelists[self._cls[ptr]].append(ptr)


def lcg(seed: int) -> int:
    return (seed * 1664525 + 1013904223) & 0xFFFFFFFF


def run_caches() -> None:
    print()
    print("=" * 72)
    print("Cache hierarchy: per-P current spans versus a single locked list")
    nproc = 8
    nops = 40000
    # A handful of small classes, typical of short-lived heap objects.
    choices = [16, 24, 32, 48, 64, 80, 96]
    cached = CachedAllocator(nproc)
    locked = LockedFreeList()
    live_c: dict[int, list[int]] = {p: [] for p in range(nproc)}
    live_l: dict[int, list[int]] = {p: [] for p in range(nproc)}
    seed = 1
    for i in range(nops):
        seed = lcg(seed)
        proc = seed % nproc
        seed = lcg(seed)
        payload = choices[seed % len(choices)]
        seed = lcg(seed)
        # About 60% allocations, 40% frees of a live object on this P.
        if not live_c[proc] or (seed % 10) < 6:
            live_c[proc].append(cached.malloc(proc, payload))
            live_l[proc].append(locked.malloc(payload))
        else:
            seed = lcg(seed)
            k = seed % len(live_c[proc])
            cached.free(proc, live_c[proc].pop(k))
            locked.free(live_l[proc].pop(k))

    hits = sum(p.hits for p in cached.procs)
    refills = sum(p.refill for p in cached.procs)
    print(f"operations ~{nops} across {nproc} processors, sizes {choices}")
    print(f"  cached allocator: allocs={cached.allocs}  span hits={hits}  "
          f"refills={refills}  central locks={cached.central_locks}  "
          f"heap takes={cached.heap_takes}  os={cached.os_acquired}")
    print(f"  hit rate={hits/cached.allocs:.3f}  locks per alloc={cached.central_locks/cached.allocs:.3f}")
    print(f"  locked free list: allocs={locked.allocs}  locks={locked.locks}  "
          f"os={locked.os_acquired}  locks per alloc={locked.locks/locked.allocs:.3f}")


def main() -> None:
    run_rounding()
    run_isolation()
    run_tiny()
    run_caches()


if __name__ == "__main__":
    main()
```

## Summary

- Modern allocators serve small objects from **size classes**: a request is rounded to a class, and a page of equal-sized slots is managed with a free bitmap or a free list. The rounding wastes a few bytes so that the fast path does not search, split, or coalesce. Across every size from 1 to 32,768 bytes, Go's published table granted 5.34% more than requested; jemalloc's published classes granted 8.33%; power-of-two rounding granted 33.33%.
- A free slot belongs to its class. In the model, 2,000 freed 24-byte objects could not satisfy a single 32-byte request from the same pages; a coalescing first-fit list satisfied 1,702 of 2,000 from the same reservation. Empty pages have to go back to a page heap (or the OS) before that memory can be recarved.
- A **local cache** — per-P in Go, per-thread in jemalloc and glibc, per-CPU in modern tcmalloc — makes the common allocation lock-free. A central structure refills it by the span or by the batch. In the model, per-P current spans hit 98.7% of allocations and took 0.013 central locks per allocation, at the cost of 72 pages instead of 53.
- Go's allocator was originally based on tcmalloc. Small objects go through `mcache` → `mcentral` → `mheap`; large objects skip to `mheap`. Pointer-free allocations under 16 bytes are packed by the tiny allocator into 16-byte blocks. Go 1.27 adds size-specialized allocation functions for objects up to 80 bytes, cutting the cost of some of those allocations by up to 30% and growing the binary by about 60 KB.
- glibc still coalesces neighboring chunks and does not round to powers of two; its per-thread cache defaults to 16 chunks of at most 1,032 bytes on 64-bit systems. jemalloc uses four size classes per doubling, a default of four arenas per CPU, a 32 KiB tcache, and a 10-second dirty-page decay. tcmalloc moved its front-end cache from threads to CPUs and updates it with restartable sequences. mimalloc shards a free list per page and again into a thread-local list and a concurrent list, so a free from another thread is a single compare-and-swap.
- When a set of objects dies together, an arena or a fixed-size pool is a better tool than a general-purpose allocator. When a value never needs to be a heap object, not allocating remains cheaper than a faster `malloc`.

## References

- The Go Programming Language, [`src/runtime/malloc.go`](https://go.dev/src/runtime/malloc.go) (allocator overview, hierarchy, arena sizes, tiny-allocator comment)
- The Go Programming Language, [`src/internal/runtime/gc/sizeclasses.go`](https://go.dev/src/internal/runtime/gc/sizeclasses.go) (67 size classes, `MaxSmallSize = 32768`, `NumSizeClasses = 68`, `TinySize = 16`, `PageShift = 13`)
- The Go Programming Language, [`src/runtime/mcache.go`](https://go.dev/src/runtime/mcache.go) and [`src/runtime/mcentral.go`](https://go.dev/src/runtime/mcentral.go)
- Michael Matloob, [Size-Specialized Memory Allocation](https://go.dev/blog/size-specialized-allocations), 16 September 2026
- The Go Programming Language, [Go 1.27 Release Notes](https://go.dev/doc/go1.27) (faster memory allocation, `GOEXPERIMENT=nosizespecializedmalloc`)
- The GNU C Library, [The GNU Allocator](https://sourceware.org/glibc/manual/latest/html_node/The-GNU-Allocator.html)
- The GNU C Library, [Memory Allocation Tunables](https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html) (`tcache_max`, `tcache_count`, `mmap_threshold`, removal of fastbins)
- jemalloc, [jemalloc(3)](https://jemalloc.net/jemalloc.3.html) (size-class table, arenas, tcache, dirty and muzzy decay)
- Jason Evans, [A Scalable Concurrent malloc(3) Implementation for FreeBSD](https://papers.freebsd.org/2006/bsdcan/evans-jemalloc/), BSDCan 2006
- Google, [tcmalloc Design](https://google.github.io/tcmalloc/design.html) (front-end, middle-end, back-end, per-CPU caches, restartable sequences)
- Daan Leijen, Ben Zorn, and Leonardo de Moura, [Mimalloc: Free List Sharding in Action](https://www.microsoft.com/en-us/research/publication/mimalloc-free-list-sharding-in-action/), Microsoft Research MSR-TR-2019-18, June 2019
- mimalloc, [project documentation](https://microsoft.github.io/mimalloc/) (free-list sharding, multi-sharding, first-class heaps, v3)
