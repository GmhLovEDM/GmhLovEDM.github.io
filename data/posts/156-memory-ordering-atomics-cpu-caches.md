---
title: "Memory Ordering and Atomics: CPU Caches, Store Buffers, Acquire/Release and the C++/Rust Memory Model"
tag: performance
description: Why multithreaded code can observe "impossible" results, and how to reason about it — cache coherence and MESI, store buffers and out-of-order execution, x86-TSO versus weakly ordered ARM, POWER and RISC-V, the C11/C++11/Rust memory model with relaxed, acquire/release and sequentially consistent atomics, fences, compare-and-swap and ABA, how orderings map to real instructions, a lock-free single-producer/single-consumer ring buffer, false sharing, and the memory models of Java and Go, with litmus experiments and benchmarks verified on real hardware
date: "2026-11-11T14:20:00.000Z"
---

## Goal

Most programmers carry an intuitive model of shared memory: there is one memory, every thread's operations happen in program order, and they interleave like shuffled cards. That model is called **sequential consistency** (SC), and no mainstream CPU or compiler actually provides it by default. Compilers reorder memory operations, CPUs buffer stores and execute loads out of order, and on some architectures different cores can even disagree about the order in which two writes happened.

Lock-free queues, reference counting, `Arc`, `shared_ptr`, double-checked initialization, sequence locks, RCU and every mutex implementation are built on the rules that govern this. This article covers:

1. Where reordering comes from: compilers, store buffers, out-of-order cores, and cache coherence.
2. A store-buffering litmus experiment that produces a "forbidden" result on an ordinary x86 server — measured, not hypothetical.
3. Hardware memory models: x86-TSO versus ARM, POWER and RISC-V.
4. The language memory model shared by C11, C++11 and Rust: data races, happens-before, and the five orderings.
5. How each ordering compiles to real instructions.
6. Read-modify-write operations, CAS loops and the ABA problem.
7. A verified lock-free SPSC ring buffer in Rust.
8. False sharing, measured.
9. Java and Go, verification tools, and a practical checklist.

## 1. Where reordering comes from

### 1.1 The compiler

As long as a single thread cannot tell the difference, the compiler may reorder, merge, hoist or delete memory accesses. Consider:

```c
int data;
int ready;          // plain int, not atomic

void producer(void) { data = 42; ready = 1; }
void consumer(void) { while (!ready) {} use(data); }
```

The compiler is entitled to store `ready` before `data`, and in the consumer it may load `ready` once and turn the loop into `if (!ready) for (;;) {}`. Both transformations are valid because, in C and C++, two threads accessing the same non-atomic variable concurrently with at least one write is a **data race**, and a data race is undefined behavior. The language assumes your program has none, and optimizes accordingly. Hans Boehm's classic paper "Threads Cannot Be Implemented as a Library" (PLDI 2005) explains why this has to be part of the language, not just a library of lock functions.

`volatile` in C and C++ does not fix this. It prevents the compiler from eliding or merging accesses to that variable, but it gives no atomicity and no ordering with respect to other, non-volatile accesses, and it emits no hardware barriers. (Java's `volatile` is a different thing entirely, covered in section 9.)

### 1.2 Store buffers

Even with a perfectly obedient compiler, the CPU reorders. A store that misses in the L1 cache would stall the core for many cycles while the cache line is fetched and ownership is acquired. So cores put stores into a **store buffer** and continue executing. Later loads from the same core check the store buffer first (store-to-load forwarding), so the core sees its own writes in order. Other cores do not see the store until it drains from the buffer into the cache.

The visible consequence: a store followed by a load to a *different* address can appear to other cores as if the load happened first. Every mainstream architecture, including x86, allows this.

### 1.3 Out-of-order execution and speculation

Modern cores execute instructions out of order and speculatively, keep hundreds of operations in flight, and retire them in order. Loads may be satisfied early, possibly from a cache line that another core is about to invalidate. Strongly ordered architectures (x86) spend hardware to detect and replay such loads when it would be visible; weakly ordered architectures (ARM, POWER) mostly let the reordering through and require explicit barriers when you need ordering.

### 1.4 Cache coherence is not memory ordering

Coherence protocols such as MESI (Modified, Exclusive, Shared, Invalid) and its variants (MOESI on AMD, MESIF on Intel) guarantee that, *for a single memory location*, all cores agree on one order of writes, and a read eventually sees the most recent one. A core must hold a line in M or E state to write it, which means invalidating every other copy first.

Coherence says nothing about the relative order of accesses to *different* locations. That is the job of the **memory consistency model**. Store buffers and invalidation queues sit outside the coherent cache, which is exactly why a coherent system can still be weakly ordered. "A Primer on Memory Consistency and Cache Coherence" by Sorin, Hill and Wood (2nd edition 2020) is the standard reference for this distinction.

## 2. Verified: store buffering on x86

The classic litmus pattern, called SB (store buffering), with `x` and `y` initially 0:

```text
Thread 1          Thread 2
x = 1             y = 1
r1 = y            r2 = x
```

Under sequential consistency, at least one store comes first, so `r1 == 0 && r2 == 0` is impossible. With store buffers it is easy: both stores sit in their buffers while both loads read 0 from the cache.

I ran this in C11 with two persistent threads, resetting `x` and `y` and releasing both threads for each iteration (the coordination flags use sequentially consistent atomics, so each round is cleanly separated). The two stores and two loads use either `memory_order_relaxed` or `memory_order_seq_cst`:

```c
#include <stdatomic.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#ifndef ORD
#define ORD memory_order_relaxed
#endif
static _Atomic int x, y, r1, r2;
static _Atomic int go1, go2, done1, done2;

static void *t1(void *a) { for (;;) {
    while (!atomic_load(&go1)); atomic_store(&go1, 0);
    atomic_store_explicit(&x, 1, ORD);
    atomic_store(&r1, atomic_load_explicit(&y, ORD));
    atomic_store(&done1, 1); } }

static void *t2(void *a) { for (;;) {
    while (!atomic_load(&go2)); atomic_store(&go2, 0);
    atomic_store_explicit(&y, 1, ORD);
    atomic_store(&r2, atomic_load_explicit(&x, ORD));
    atomic_store(&done2, 1); } }

int main(int argc, char **argv) {
    long n = atoi(argv[1]), both0 = 0; pthread_t a, b;
    pthread_create(&a, 0, t1, 0); pthread_create(&b, 0, t2, 0);
    for (long i = 0; i < n; i++) {
        atomic_store(&x, 0); atomic_store(&y, 0);
        atomic_store(&go1, 1); atomic_store(&go2, 1);
        while (!atomic_load(&done1) || !atomic_load(&done2));
        atomic_store(&done1, 0); atomic_store(&done2, 0);
        if (atomic_load(&r1) == 0 && atomic_load(&r2) == 0) both0++;
    }
    printf("iterations=%ld r1==0&&r2==0: %ld\n", n, both0);
}
```

Results on an 8-vCPU Intel Xeon VM, GCC 14.2, `-O2`:

```text
$ ./sb_relaxed 1000000
iterations=1000000 r1==0&&r2==0: 8932
$ ./sb_seq_cst 1000000
iterations=1000000 r1==0&&r2==0: 0
```

About 0.9% of the relaxed rounds produced the result sequential consistency forbids. With `seq_cst`, zero. The exact rate depends on timing and the machine; the point is that the outcome is real on the most strongly ordered mainstream architecture. The difference comes from a single instruction, shown in section 5.

## 3. Hardware memory models

| Architecture | Model | Reorderings visible to other cores |
| --- | --- | --- |
| x86 / x86-64 | TSO (total store order) | Only store→later load (to a different address) |
| SPARC (TSO mode) | TSO | Same as x86 |
| ARMv8 / AArch64 | Weak, "other-multi-copy atomic" | Load→load, load→store, store→store, store→load, unless ordered by dependencies or barriers |
| POWER | Weak, not multi-copy atomic | All of the above, and different cores may see two independent writes in different orders |
| RISC-V | RVWMO (weak), optional Ztso | Similar to ARMv8 by default |

**x86-TSO** was formalized by Sewell, Sarkar, Owens, Zappa Nardelli and Myreen ("x86-TSO: A Rigorous and Usable Programmer's Model for x86 Multiprocessors", CACM 2010). The model is essentially: each core has a FIFO store buffer, and there is one shared memory. Loads are not reordered with other loads, stores are not reordered with other stores, and locked instructions (`lock`-prefixed RMWs, `xchg`) drain the buffer. That is why on x86 plain `mov` already gives you acquire loads and release stores.

**ARMv8** is weaker but was revised to be *other-multi-copy atomic*: once a write is visible to any other core, it is visible to all of them. POWER does not guarantee this, which permits the "IRIW" (independent reads of independent writes) anomaly where two readers disagree on the order of two unrelated writes.

The practical lesson: code that "works on my laptop" with relaxed atomics or plain variables may be relying on x86-TSO, and can break when deployed on ARM servers (AWS Graviton, Ampere, Apple silicon). The language memory model exists so you can write portable code against one abstract model and let the compiler insert the right instructions for each target.

## 4. The C11 / C++11 / Rust memory model

C11 and C++11 introduced a common memory model; Rust adopts the C++ model (minus `consume`) for its `std::sync::atomic` types. Its core rules:

1. A **data race** — two conflicting accesses, at least one a write, at least one non-atomic, not ordered by happens-before — is undefined behavior.
2. Atomic operations never race with each other. Each atomic object has a single **modification order** that all threads agree on (this is coherence, lifted into the language).
3. Ordering between threads is established by **synchronizes-with** edges, which combine with program order (**sequenced-before**) into **happens-before**. If a write happens-before a read and no other write intervenes, the read must see it.

### 4.1 The orderings

- **Relaxed**: atomicity and per-object modification order only. No ordering with other memory. Suitable for counters, statistics, and unique-ID generation where you only care about the final value or uniqueness.
- **Release** (stores) and **Acquire** (loads): if an acquire load reads the value written by a release store (or a later value in its release sequence), the store *synchronizes-with* the load. Everything the writer did before the release becomes visible to the reader after the acquire. This is the "publish then consume" pattern and is the workhorse of lock-free code.
- **AcqRel**: for read-modify-write operations; acquire on the read side, release on the write side.
- **SeqCst**: acquire/release plus a single total order over all `seq_cst` operations that every thread agrees on. Needed when correctness depends on the relative order of operations on *different* variables observed by different threads, as in the SB experiment or Dekker/Peterson-style mutual exclusion.
- **Consume** (C++ only): intended to order only data-dependent loads, cheaper on ARM and POWER. It proved too hard to specify and implement; C++17 discourages its use, and all major compilers treat it as acquire.

Acquire and release are one-directional barriers: nothing after an acquire may move before it, and nothing before a release may move after it. Operations can still move *into* the critical region, which is exactly what a lock needs and nothing more.

### 4.2 Message passing, correctly

```cpp
#include <atomic>
#include <cassert>
#include <thread>

int payload = 0;                      // plain, non-atomic
std::atomic<bool> ready{false};

void producer() {
    payload = 42;                                    // (1)
    ready.store(true, std::memory_order_release);    // (2) publishes (1)
}

void consumer() {
    while (!ready.load(std::memory_order_acquire))   // (3) synchronizes-with (2)
        ;
    assert(payload == 42);                           // (4) guaranteed, no data race
}
```

(1) is sequenced-before (2), (2) synchronizes-with (3), and (3) is sequenced-before (4), so (1) happens-before (4). The non-atomic `payload` is safe because the atomic flag orders it. Change either ordering to `relaxed` and the assertion may fail on ARM — and the program has a data race on `payload`, so it is undefined everywhere.

### 4.3 Fences

`std::atomic_thread_fence(order)` (Rust: `std::sync::atomic::fence`) lets you separate the ordering from the access. A release fence followed by a relaxed store, paired with a relaxed load followed by an acquire fence, synchronizes just like release/acquire. This is useful when one fence can cover several relaxed operations, or when the acquire is only needed on one branch:

```rust
use std::sync::atomic::{fence, AtomicUsize, Ordering};

fn drop_ref(count: &AtomicUsize, free: impl FnOnce()) {
    // Same shape as Rust's Arc::drop: a Release decrement on every path,
    // and an Acquire fence only on the path that frees the object.
    if count.fetch_sub(1, Ordering::Release) == 1 {
        fence(Ordering::Acquire);
        free();
    }
}
```

Every thread's prior uses of the object are released by its decrement, and the final thread's acquire fence makes them all happen-before the free. The common case (not the last reference) pays no acquire cost.

## 5. What the orderings compile to

On x86-64 I compiled these functions with GCC 14.2 at `-O2`:

```c
void st_rel(_Atomic int *p) { atomic_store_explicit(p, 1, memory_order_release); }
void st_sc (_Atomic int *p) { atomic_store_explicit(p, 1, memory_order_seq_cst); }
int  ld_acq(_Atomic int *p) { return atomic_load_explicit(p, memory_order_acquire); }
int  faa   (_Atomic int *p) { return atomic_fetch_add_explicit(p, 1, memory_order_relaxed); }
```

```text
st_rel:  movl  $1, (%rdi)            ; plain store
st_sc:   movl  $1, %eax
         xchgl (%rdi), %eax          ; implicitly locked: drains the store buffer
ld_acq:  movl  (%rdi), %eax          ; plain load
faa:     movl  $1, %eax
         lock xaddl %eax, (%rdi)     ; every RMW is a full barrier on x86
```

So on x86 acquire and release are free at the instruction level (they only constrain the compiler), and the *only* extra cost of `seq_cst` is on stores, which is exactly the store→load reordering TSO allows. That `xchg` is what turned 8,932 anomalies into zero in section 2. Some compilers emit `mov` + `mfence` instead; both are correct.

On AArch64, the standard mapping (used by GCC and LLVM) is:

| Operation | AArch64 |
| --- | --- |
| relaxed load / store | `ldr` / `str` |
| acquire load | `ldar` (or `ldapr` with ARMv8.3 RCpc, used for acquire but not seq_cst) |
| release store | `stlr` |
| seq_cst load / store | `ldar` / `stlr` |
| RMW | `ldaxr`/`stlxr` loop, or single LSE instructions such as `ldaddal` (ARMv8.1) |
| full fence | `dmb ish` |

ARM designed `ldar`/`stlr` so that a `stlr` followed by an `ldar` is not reordered, which lets seq_cst use the same instructions as acquire/release. POWER, by contrast, needs `lwsync` for release and a heavyweight `sync` for seq_cst. The Cambridge "C/C++11 mappings to processors" table (Sewell et al.) lists these for every major architecture.

## 6. Read-modify-write, CAS and ABA

Atomic RMW operations — `fetch_add`, `swap`, `compare_exchange` — always read the most recent value in the modification order. That is why a relaxed `fetch_add` counter never loses increments even though it orders nothing else.

Compare-and-swap is the universal building block. A typical lock-free update:

```rust
use std::sync::atomic::{AtomicU64, Ordering::*};

fn update_max(max: &AtomicU64, v: u64) {
    let mut cur = max.load(Relaxed);
    while v > cur {
        match max.compare_exchange_weak(cur, v, Relaxed, Relaxed) {
            Ok(_) => break,
            Err(actual) => cur = actual, // someone else won; retry with their value
        }
    }
}
```

`compare_exchange_weak` may fail spuriously. On LL/SC architectures (ARM without LSE, POWER, RISC-V) a strong CAS needs an inner retry loop, so use the weak form inside your own loop and the strong form when a single attempt matters. Rust's `fetch_update` wraps this pattern.

**ABA.** CAS checks that a value is unchanged, not that nothing happened. In a lock-free stack, thread A reads head `X` with `next = Y`, is preempted; thread B pops `X`, pops `Y`, frees `Y`, pushes `X` back. A's CAS from `X` to `Y` succeeds and installs a dangling pointer. Standard defenses:

- **Tagged pointers / version counters**: CAS a (pointer, counter) pair with a double-width CAS (`cmpxchg16b` on x86-64, `casp` on ARMv8.1), or pack a counter into unused pointer bits.
- **Safe memory reclamation**: hazard pointers (now `std::hazard_pointer` in C++26), epoch-based reclamation (Rust's `crossbeam-epoch`), or RCU in the Linux kernel, so a node cannot be reused while a thread might still read it.
- **Garbage collection**: in Java and Go, a node is not reused while referenced, which removes the classic ABA-via-reuse bug (though logical ABA on values is still possible).

## 7. Verified: a lock-free SPSC ring buffer in Rust

A single-producer/single-consumer queue is the cleanest real-world use of acquire/release. Each index has exactly one writer, so no CAS is needed; acquire/release carries the slot contents between threads.

```rust
use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicUsize, Ordering::{Acquire, Relaxed, Release}};
use std::sync::Arc;
use std::thread;

const CAP: usize = 1024; // power of two

pub struct Spsc<T> {
    buf: Box<[UnsafeCell<Option<T>>]>,
    head: AtomicUsize, // next slot to read  (written only by consumer)
    tail: AtomicUsize, // next slot to write (written only by producer)
}
unsafe impl<T: Send> Sync for Spsc<T> {}

impl<T> Spsc<T> {
    pub fn new() -> Self {
        Spsc { buf: (0..CAP).map(|_| UnsafeCell::new(None)).collect(),
               head: AtomicUsize::new(0), tail: AtomicUsize::new(0) }
    }
    /// Must be called from exactly one producer thread.
    pub fn push(&self, v: T) -> Result<(), T> {
        let tail = self.tail.load(Relaxed);          // only we write tail
        if tail - self.head.load(Acquire) == CAP {   // see consumer's frees
            return Err(v);
        }
        unsafe { *self.buf[tail % CAP].get() = Some(v); }
        self.tail.store(tail + 1, Release);          // publish the slot
        Ok(())
    }
    /// Must be called from exactly one consumer thread.
    pub fn pop(&self) -> Option<T> {
        let head = self.head.load(Relaxed);          // only we write head
        if head == self.tail.load(Acquire) {         // pairs with push's Release
            return None;
        }
        let v = unsafe { (*self.buf[head % CAP].get()).take() };
        self.head.store(head + 1, Release);          // hand the slot back
        v
    }
}

fn main() {
    let q = Arc::new(Spsc::<u64>::new());
    const N: u64 = 10_000_000;
    let p = { let q = q.clone(); thread::spawn(move || {
        for i in 0..N {
            let mut v = i;
            while let Err(back) = q.push(v) { v = back; std::hint::spin_loop(); }
        }
    })};
    let (mut sum, mut expect) = (0u64, 0u64);
    while expect < N {
        if let Some(v) = q.pop() { assert_eq!(v, expect); sum += v; expect += 1; }
        else { std::hint::spin_loop(); }
    }
    p.join().unwrap();
    println!("received {} items in order, sum = {}", expect, sum);
    assert_eq!(sum, N * (N - 1) / 2);
}
```

```text
$ rustc -O --edition 2021 spsc.rs && time ./spsc
received 10000000 items in order, sum = 49999995000000
real    0m0.325s
```

Built with rustc 1.85 on the same machine: ten million items arrive in order, about 31 million items per second including spin-waiting. The two pairings to notice:

- Producer `tail.store(Release)` → consumer `tail.load(Acquire)`: the write into the slot happens-before the consumer reads it.
- Consumer `head.store(Release)` → producer `head.load(Acquire)`: the consumer's `take()` finishes before the producer overwrites the slot.

The `unsafe` safety contract is "one producer, one consumer"; a production version would enforce it with split `Producer`/`Consumer` handles. Production implementations (for example the `rtrb` crate, or the queues in LMAX Disruptor and DPDK's `rte_ring`) also cache the other side's index locally and pad `head` and `tail` onto separate cache lines, which brings us to false sharing.

## 8. Verified: false sharing

Coherence works per cache line (64 bytes on current x86 and most ARM cores). Two threads writing *different* variables on the *same* line force the line to bounce between cores in M state on every write. The benchmark: two threads, each doing 50 million relaxed `fetch_add`s on its own counter, with the counters either adjacent or aligned to separate 64-byte lines.

```c
struct packed { _Atomic long a, b; } P;
struct padded { _Alignas(64) _Atomic long a; _Alignas(64) _Atomic long b; } Q;

static void *inc(void *p) {
    _Atomic long *c = p;
    for (long i = 0; i < 50000000L; i++)
        atomic_fetch_add_explicit(c, 1, memory_order_relaxed);
    return 0;
}
```

```text
same line: 1.439s  separate lines: 0.235s
same line: 1.264s  separate lines: 0.254s
same line: 1.254s  separate lines: 0.246s
```

Same machine, GCC 14.2, `-O2`: about 5× slower when the counters share a line, with no logical sharing at all. Notes for real code:

- C++17 provides `std::hardware_destructive_interference_size`; Rust code commonly uses `crossbeam_utils::CachePadded`, which pads to 128 bytes on x86-64 and AArch64 because Intel's spatial prefetcher pulls lines in adjacent pairs and some Apple and ARM server cores have 128-byte lines.
- Java has `@jdk.internal.vm.annotation.Contended` (used by `LongAdder` and `ConcurrentHashMap` counter cells); Go programs pad with `_ [56]byte`-style fields or rely on `sync/atomic` types in separately allocated structs.
- Per-thread or per-core sharded counters (`LongAdder`, Linux `percpu_counter`) avoid the contended line entirely and merge on read.

## 9. Other languages, tools and a checklist

### 9.1 Java

The Java Memory Model (JSR-133, Java 5) makes `volatile` reads and writes sequentially consistent and gives them acquire/release semantics for surrounding accesses; `final` fields have special initialization-safety guarantees. Java 9's `VarHandle` exposes graded modes — plain, opaque, release/acquire, and volatile — mirroring the C++ orderings. Double-checked locking is correct in Java only if the field is `volatile`.

### 9.2 Go

The Go memory model was revised in June 2022 (shipped with Go 1.19). It defines `sync/atomic` operations as sequentially consistent, there are no weaker orderings to choose from, and it adopts "DRF-SC": programs free of data races behave sequentially consistently. Channels, `sync.Mutex`, `sync.Once` and `sync.WaitGroup` establish happens-before edges. Racy Go programs have more limited consequences than in C++, but are still bugs; the `-race` flag of the Go toolchain finds them.

### 9.3 Tools

- **ThreadSanitizer** (`-fsanitize=thread` in Clang and GCC, the `-race` flag of the Go toolchain, `RUSTFLAGS=-Zsanitizer=thread` on nightly Rust) detects data races dynamically using happens-before tracking.
- **loom** (Rust, tokio-rs) exhaustively explores thread interleavings and C11 memory-model behaviors for small models; **Miri** checks for undefined behavior including some weak-memory effects.
- **herd7 / litmus7** (the diy tool suite) run and simulate litmus programs against formal models of x86, ARM, POWER and RISC-V, and the Linux kernel memory model (LKMM) is specified in this tooling.
- **CDSChecker / GenMC** model-check C/C++11 atomic code.

### 9.4 Checklist

1. Prefer higher-level primitives: mutexes, channels, `Arc`, `OnceLock`/`std::call_once`, concurrent containers. Uncontended mutexes are cheap (one atomic RMW to lock, one to unlock).
2. If you need atomics, start with `SeqCst`, make it correct, then weaken orderings only where a benchmark shows it matters and you can name the synchronizes-with edge each one forms.
3. Every `Release` should have a matching `Acquire` reading the same atomic. If you cannot point to the pair, the ordering is probably wrong.
4. `Relaxed` is right for counters, flags with no associated data, and ID generators — not for publishing data.
5. Never use C/C++ `volatile` for inter-thread communication.
6. Run on weakly ordered hardware (ARM) and with TSan or loom; x86 hides store→store and load→load bugs.
7. Pad hot, independently written atomics onto separate cache lines, and prefer sharding to contention.
8. For lock-free structures that free memory, decide on reclamation (hazard pointers, epochs, RCU) up front; it is usually the hardest part.

## References

- Hans-J. Boehm, "Threads Cannot Be Implemented as a Library", PLDI 2005.
- Peter Sewell et al., "x86-TSO: A Rigorous and Usable Programmer's Model for x86 Multiprocessors", Communications of the ACM, 2010.
- Daniel J. Sorin, Mark D. Hill, David A. Wood, *A Primer on Memory Consistency and Cache Coherence*, 2nd ed., Morgan & Claypool, 2020.
- Mara Bos, *Rust Atomics and Locks*, O'Reilly, 2023.
- Paul E. McKenney, *Is Parallel Programming Hard, And, If So, What Can You Do About It?* (perfbook).
- cppreference, `std::memory_order`; the Rust standard library documentation for `std::sync::atomic`.
- The Go Memory Model, go.dev/ref/mem (version of June 6, 2022).
- Linux kernel `Documentation/memory-barriers.txt` and `tools/memory-model/`.
- Jeff Preshing's blog series on lock-free programming and acquire/release semantics (preshing.com).

## Practical takeaways

- Sequential consistency is not the default: compilers reorder, store buffers delay stores, and weak architectures reorder almost everything. Coherence orders one location; the memory model orders the rest.
- On an ordinary x86 Xeon, a relaxed store-buffering experiment produced the SC-forbidden `r1 == r2 == 0` in 8,932 of 1,000,000 rounds; `seq_cst`, which compiles the store to `xchg`, produced zero.
- Acquire/release is the everyday tool: a release store publishes everything before it to the acquire load that reads it. On x86 it costs nothing at the instruction level; on ARM it maps to `stlr`/`ldar`.
- Use `SeqCst` when correctness depends on a global order across different variables, `Relaxed` only where no other data is published, and treat `consume` as acquire.
- A lock-free SPSC ring needs only acquire/release pairs and moved 10 million items in order in about a third of a second; most lock-free complexity lies in CAS loops, ABA and memory reclamation.
- False sharing made two independent counters about 5× slower; pad hot atomics to separate lines or shard them.

Memory ordering is less about memorizing barrier instructions than about being able to point at every happens-before edge your program relies on. When you can name them all, the orderings choose themselves.
