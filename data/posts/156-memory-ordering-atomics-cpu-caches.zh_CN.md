---
title: "内存序与原子操作：CPU 缓存、Store Buffer、Acquire/Release 与 C++/Rust 内存模型"
tag: performance
description: 为什么多线程代码会观察到"不可能"的结果，以及如何推理它——缓存一致性与 MESI、store buffer 与乱序执行、x86-TSO 与弱序的 ARM、POWER、RISC-V、C11/C++11/Rust 内存模型中的 relaxed、acquire/release 与顺序一致原子操作、内存栅栏、CAS 与 ABA 问题、各种内存序如何映射到真实指令、无锁单生产者单消费者环形队列、伪共享，以及 Java 和 Go 的内存模型，附在真实硬件上运行验证的 litmus 实验与基准数据
date: "2026-11-11T14:20:00.000Z"
---

## 目标

大多数程序员对共享内存有一个直觉模型：只有一块内存，每个线程的操作按程序顺序发生，多个线程像洗牌一样交错执行。这个模型叫**顺序一致性**（Sequential Consistency，SC），而主流 CPU 和编译器默认都不提供它。编译器会重排内存操作，CPU 会缓冲写入、乱序执行读取，在某些架构上，不同核心甚至会对两次写入的先后顺序产生分歧。

无锁队列、引用计数、`Arc`、`shared_ptr`、双重检查初始化、顺序锁（seqlock）、RCU 以及每一个互斥锁的实现，都建立在这些规则之上。本文包括：

1. 重排从哪里来：编译器、store buffer、乱序核心与缓存一致性。
2. 一个 store-buffering litmus 实验，在普通 x86 服务器上实际跑出"被禁止"的结果——是实测，不是假设。
3. 硬件内存模型：x86-TSO 与 ARM、POWER、RISC-V。
4. C11、C++11 与 Rust 共享的语言内存模型：数据竞争、happens-before 与五种内存序。
5. 每种内存序编译成什么真实指令。
6. 读-改-写操作、CAS 循环与 ABA 问题。
7. 经过验证的 Rust 无锁 SPSC 环形队列。
8. 伪共享的实测。
9. Java 与 Go、验证工具与实践清单。

## 1. 重排从哪里来

### 1.1 编译器

只要单个线程察觉不到差别，编译器就可以重排、合并、提升或删除内存访问。看这段代码：

```c
int data;
int ready;          // plain int, not atomic

void producer(void) { data = 42; ready = 1; }
void consumer(void) { while (!ready) {} use(data); }
```

编译器有权先写 `ready` 再写 `data`；在消费者里，它可以只读一次 `ready`，把循环变成 `if (!ready) for (;;) {}`。这两种变换都合法，因为在 C 和 C++ 中，两个线程并发访问同一个非原子变量且至少一个是写，就构成**数据竞争**，而数据竞争是未定义行为。语言假定你的程序没有数据竞争，并据此优化。Hans Boehm 的经典论文《Threads Cannot Be Implemented as a Library》（PLDI 2005）解释了为什么这必须是语言的一部分，而不能只是一个锁函数库。

C 和 C++ 的 `volatile` 解决不了这个问题。它阻止编译器省略或合并对该变量的访问，但不提供原子性，也不对其他非 volatile 访问提供顺序，更不会生成硬件屏障。（Java 的 `volatile` 是完全不同的东西，见第 9 节。）

### 1.2 Store buffer

即便编译器完全听话，CPU 也会重排。一次在 L1 缓存未命中的写入，需要取回缓存行并获得所有权，会让核心停顿许多个周期。所以核心把写入放进 **store buffer**，然后继续执行。同一核心后续的读会先查 store buffer（store-to-load forwarding），因此核心按顺序看到自己的写入；而其他核心要等写入从缓冲区排空进缓存后才能看到。

可见的后果是：一次写入之后紧跟一次对*不同*地址的读，在其他核心看来可能像是读先发生了。包括 x86 在内的所有主流架构都允许这种重排。

### 1.3 乱序执行与推测执行

现代核心乱序、推测地执行指令，同时有数百个操作在途，最后按序提交。读操作可能被提前满足，用的可能是另一个核心马上要使其失效的缓存行。强序架构（x86）花硬件代价去检测这种情况并在会被观察到时重放读操作；弱序架构（ARM、POWER）基本放任重排，需要顺序时由你显式加屏障。

### 1.4 缓存一致性不等于内存序

MESI（Modified、Exclusive、Shared、Invalid）及其变体（AMD 的 MOESI、Intel 的 MESIF）这类一致性协议保证：*对单个内存位置*，所有核心对写入顺序达成一致，读最终会看到最新写入的值。核心必须以 M 或 E 状态持有缓存行才能写，这意味着要先让其他所有副本失效。

一致性对*不同*位置之间访问的相对顺序什么也没说，那是**内存一致性模型**的职责。store buffer 和失效队列位于一致性缓存之外，这正是一个缓存一致的系统仍可以是弱序的原因。Sorin、Hill、Wood 合著的《A Primer on Memory Consistency and Cache Coherence》（2020 年第 2 版）是讲清这一区分的标准参考书。

## 2. 实测：x86 上的 store buffering

经典的 litmus 模式叫 SB（store buffering），`x` 和 `y` 初始为 0：

```text
Thread 1          Thread 2
x = 1             y = 1
r1 = y            r2 = x
```

在顺序一致性下，至少有一个写先发生，所以 `r1 == 0 && r2 == 0` 不可能出现。有了 store buffer 就很容易出现：两个写都还待在各自的缓冲区里，两个读都从缓存中读到 0。

我用 C11 写了这个实验：两个常驻线程，每轮重置 `x`、`y` 并放行两个线程（协调用的标志位都是顺序一致的原子操作，所以每一轮干净地隔开）。两次写和两次读使用 `memory_order_relaxed` 或 `memory_order_seq_cst`：

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

在一台 8 vCPU 的 Intel Xeon 虚拟机上，GCC 14.2，`-O2`：

```text
$ ./sb_relaxed 1000000
iterations=1000000 r1==0&&r2==0: 8932
$ ./sb_seq_cst 1000000
iterations=1000000 r1==0&&r2==0: 0
```

relaxed 版本约 0.9% 的轮次出现了顺序一致性所禁止的结果；`seq_cst` 版本为零。具体比例取决于时序和机器，重点在于：即使在主流架构中最强序的 x86 上，这个结果也真实存在。差别只来自一条指令，见第 5 节。

## 3. 硬件内存模型

| 架构 | 模型 | 其他核心可观察到的重排 |
| --- | --- | --- |
| x86 / x86-64 | TSO（全局存储序） | 仅"写→后续对不同地址的读" |
| SPARC（TSO 模式） | TSO | 同 x86 |
| ARMv8 / AArch64 | 弱序，"other-multi-copy atomic" | 读→读、读→写、写→写、写→读都可能，除非被依赖关系或屏障约束 |
| POWER | 弱序，非 multi-copy atomic | 以上全部，而且不同核心可能以不同顺序看到两次独立写入 |
| RISC-V | RVWMO（弱序），可选 Ztso | 默认与 ARMv8 类似 |

**x86-TSO** 由 Sewell、Sarkar、Owens、Zappa Nardelli 和 Myreen 形式化（《x86-TSO: A Rigorous and Usable Programmer's Model for x86 Multiprocessors》，CACM 2010）。这个模型本质上是：每个核心有一个 FIFO 的 store buffer，外加一块共享内存。读不会与其他读重排，写不会与其他写重排，带锁指令（`lock` 前缀的 RMW、`xchg`）会排空缓冲区。这就是为什么在 x86 上普通的 `mov` 就已经具备 acquire 读和 release 写的语义。

**ARMv8** 更弱，但后来被修订为 *other-multi-copy atomic*：一次写入一旦对任何其他核心可见，就对所有核心可见。POWER 不保证这一点，因此允许"IRIW"（independent reads of independent writes）异常：两个读者对两次无关写入的顺序看法不一致。

实践上的教训是：依赖 relaxed 原子或普通变量、"在我笔记本上能跑"的代码，可能其实依赖了 x86-TSO，部署到 ARM 服务器（AWS Graviton、Ampere、Apple 芯片）上就会出错。语言内存模型存在的意义，就是让你面向同一个抽象模型写可移植代码，由编译器为每个目标插入正确的指令。

## 4. C11 / C++11 / Rust 内存模型

C11 和 C++11 引入了共同的内存模型；Rust 的 `std::sync::atomic` 采用 C++ 模型（不含 `consume`）。核心规则：

1. **数据竞争**——两个冲突访问，至少一个是写，至少一个是非原子的，且没有被 happens-before 排序——是未定义行为。
2. 原子操作之间永远不构成数据竞争。每个原子对象有一个所有线程都认同的**修改顺序**（modification order），这就是把一致性提升到了语言层面。
3. 线程之间的顺序由 **synchronizes-with** 边建立，它与程序顺序（**sequenced-before**）组合成 **happens-before**。如果一次写 happens-before 一次读且中间没有其他写，这次读必须看到它。

### 4.1 各种内存序

- **Relaxed**：只保证原子性和单对象修改顺序，不与其他内存访问建立顺序。适合计数器、统计量、唯一 ID 生成，即只关心最终值或唯一性的场景。
- **Release**（写）与 **Acquire**（读）：如果一次 acquire 读读到了某次 release 写写入的值（或其 release sequence 中更晚的值），这次写就 *synchronizes-with* 这次读。写者在 release 之前做的一切，在读者 acquire 之后都可见。这就是"发布再消费"模式，是无锁代码的主力。
- **AcqRel**：用于读-改-写操作；读的一侧是 acquire，写的一侧是 release。
- **SeqCst**：在 acquire/release 之上，再加一个所有线程认同的、覆盖所有 `seq_cst` 操作的全序。当正确性依赖于不同线程观察到的、*不同*变量上操作的相对顺序时需要它，比如 SB 实验，或 Dekker/Peterson 式互斥。
- **Consume**（仅 C++）：本意是只对数据依赖的读排序，在 ARM 和 POWER 上更便宜。事实证明它太难规范和实现；C++17 不鼓励使用，所有主流编译器都把它当作 acquire 处理。

Acquire 和 release 是单向屏障：acquire 之后的操作不能移到它之前，release 之前的操作不能移到它之后。但操作仍然可以*移进*临界区，这正是锁所需要的，不多也不少。

### 4.2 正确的消息传递

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

(1) sequenced-before (2)，(2) synchronizes-with (3)，(3) sequenced-before (4)，所以 (1) happens-before (4)。非原子的 `payload` 是安全的，因为原子标志给它建立了顺序。把任何一处改成 `relaxed`，断言在 ARM 上就可能失败——而且程序在 `payload` 上存在数据竞争，在任何平台上都是未定义行为。

### 4.3 内存栅栏

`std::atomic_thread_fence(order)`（Rust 中是 `std::sync::atomic::fence`）让顺序与访问分离。release 栅栏后接 relaxed 写，配对 relaxed 读后接 acquire 栅栏，其同步效果与 release/acquire 相同。当一个栅栏可以覆盖多个 relaxed 操作，或者只有某个分支需要 acquire 时，这很有用：

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

每个线程之前对对象的使用都由自己的递减操作 release，最后一个线程的 acquire 栅栏使所有这些使用都 happens-before 释放内存。常见路径（不是最后一个引用）不用付出 acquire 的代价。

## 5. 各内存序编译成什么

在 x86-64 上，用 GCC 14.2 `-O2` 编译以下函数：

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

所以在 x86 上，acquire 和 release 在指令层面是免费的（只约束编译器），`seq_cst` 唯一的额外代价在写操作上，正好对应 TSO 允许的"写→读"重排。第 2 节中把 8,932 次异常变成零的，就是这条 `xchg`。有的编译器会生成 `mov` + `mfence`，两者都正确。

在 AArch64 上，GCC 和 LLVM 使用的标准映射是：

| 操作 | AArch64 |
| --- | --- |
| relaxed 读 / 写 | `ldr` / `str` |
| acquire 读 | `ldar`（ARMv8.3 RCpc 下可用 `ldapr`，用于 acquire 但不用于 seq_cst） |
| release 写 | `stlr` |
| seq_cst 读 / 写 | `ldar` / `stlr` |
| RMW | `ldaxr`/`stlxr` 循环，或 ARMv8.1 LSE 的单条指令，如 `ldaddal` |
| 完整栅栏 | `dmb ish` |

ARM 设计 `ldar`/`stlr` 时保证 `stlr` 之后的 `ldar` 不会被重排，因此 seq_cst 可以和 acquire/release 使用相同指令。相比之下，POWER 的 release 需要 `lwsync`，seq_cst 需要重量级的 `sync`。剑桥大学的《C/C++11 mappings to processors》表格（Sewell 等人）列出了各主流架构的映射。

## 6. 读-改-写、CAS 与 ABA

原子 RMW 操作——`fetch_add`、`swap`、`compare_exchange`——总是读取修改顺序中最新的值。这就是为什么 relaxed 的 `fetch_add` 计数器即使不对其他内存排序，也从不丢失递增。

比较并交换（CAS）是通用构件。典型的无锁更新：

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

`compare_exchange_weak` 可能伪失败。在 LL/SC 架构上（不带 LSE 的 ARM、POWER、RISC-V），强 CAS 需要内部重试循环，所以在你自己的循环里用 weak 形式，只尝试一次时用 strong 形式。Rust 的 `fetch_update` 封装了这个模式。

**ABA。** CAS 检查的是值没变，而不是什么都没发生。在无锁栈里，线程 A 读到栈顶 `X`，其 `next = Y`，然后被抢占；线程 B 弹出 `X`、弹出 `Y`、释放 `Y`、再把 `X` 压回去。A 从 `X` 到 `Y` 的 CAS 成功了，装上了一个悬垂指针。标准防御手段：

- **带标签的指针 / 版本计数器**：用双宽 CAS（x86-64 的 `cmpxchg16b`、ARMv8.1 的 `casp`）对（指针，计数器）对做 CAS，或把计数器塞进指针未使用的位。
- **安全内存回收**：hazard pointer（C++26 中的 `std::hazard_pointer`）、基于 epoch 的回收（Rust 的 `crossbeam-epoch`），或 Linux 内核中的 RCU，确保节点在可能还被某个线程读取时不会被复用。
- **垃圾回收**：在 Java 和 Go 中，节点被引用期间不会被复用，消除了经典的"复用导致的 ABA"（不过值层面的逻辑 ABA 仍可能出现）。

## 7. 实测：Rust 无锁 SPSC 环形队列

单生产者单消费者队列是 acquire/release 在实际工程中最干净的用法。每个下标只有一个写者，所以不需要 CAS；acquire/release 负责在线程之间传递槽位里的内容。

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

在同一台机器上用 rustc 1.85 构建：一千万个元素按序到达，包括自旋等待在内约每秒 3100 万个。需要注意的两对配对：

- 生产者 `tail.store(Release)` → 消费者 `tail.load(Acquire)`：写入槽位 happens-before 消费者读取它。
- 消费者 `head.store(Release)` → 生产者 `head.load(Acquire)`：消费者的 `take()` 在生产者覆写该槽位之前完成。

这里 `unsafe` 的安全约定是"一个生产者、一个消费者"；生产级版本会用分离的 `Producer`/`Consumer` 句柄来强制这一点。生产级实现（例如 `rtrb` crate，以及 LMAX Disruptor 和 DPDK `rte_ring` 中的队列）还会在本地缓存对方的下标，并把 `head` 和 `tail` 填充到不同缓存行上——这就引出了伪共享。

## 8. 实测：伪共享

一致性以缓存行为单位工作（当前 x86 和大多数 ARM 核心上是 64 字节）。两个线程写同一缓存行上的*不同*变量，会迫使这一行在每次写入时以 M 状态在核心之间来回弹跳。基准：两个线程，各自对自己的计数器做 5000 万次 relaxed `fetch_add`，计数器要么相邻，要么对齐到不同的 64 字节缓存行。

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

同一台机器，GCC 14.2，`-O2`：计数器共享一行时慢了约 5 倍，而逻辑上它们毫无共享。实际代码中的注意点：

- C++17 提供 `std::hardware_destructive_interference_size`；Rust 代码常用 `crossbeam_utils::CachePadded`，它在 x86-64 和 AArch64 上填充到 128 字节，因为 Intel 的空间预取器会成对拉取相邻缓存行，而一些 Apple 和 ARM 服务器核心的缓存行是 128 字节。
- Java 有 `@jdk.internal.vm.annotation.Contended`（`LongAdder` 和 `ConcurrentHashMap` 的计数单元使用它）；Go 程序用 `_ [56]byte` 之类的字段做填充。
- 按线程或按核心分片的计数器（`LongAdder`、Linux 的 `percpu_counter`）完全避开争用的缓存行，读取时再合并。

## 9. 其他语言、工具与清单

### 9.1 Java

Java 内存模型（JSR-133，Java 5）让 `volatile` 读写具有顺序一致性，并对周围访问提供 acquire/release 语义；`final` 字段有特殊的初始化安全保证。Java 9 的 `VarHandle` 提供分级模式——plain、opaque、release/acquire 和 volatile——与 C++ 的内存序对应。Java 中的双重检查锁只有在字段是 `volatile` 时才正确。

### 9.2 Go

Go 内存模型在 2022 年 6 月修订（随 Go 1.19 发布）。它规定 `sync/atomic` 操作是顺序一致的，没有更弱的内存序可选，并采用"DRF-SC"：没有数据竞争的程序表现为顺序一致。channel、`sync.Mutex`、`sync.Once` 和 `sync.WaitGroup` 都会建立 happens-before 边。有数据竞争的 Go 程序后果比 C++ 有限，但仍然是 bug；Go 工具链的 `-race` 选项可以发现它们。

### 9.3 工具

- **ThreadSanitizer**（Clang 和 GCC 的 `-fsanitize=thread`、Go 的 `-race`、nightly Rust 的 `RUSTFLAGS=-Zsanitizer=thread`）通过追踪 happens-before 动态检测数据竞争。
- **loom**（Rust，tokio-rs 出品）对小规模模型穷举线程交错和 C11 内存模型行为；**Miri** 检查未定义行为，包括部分弱内存效应。
- **herd7 / litmus7**（diy 工具集）针对 x86、ARM、POWER 和 RISC-V 的形式化模型运行和模拟 litmus 程序，Linux 内核内存模型（LKMM）也是用这套工具描述的。
- **CDSChecker / GenMC** 对 C/C++11 原子代码做模型检验。

### 9.4 清单

1. 优先使用更高层的原语：互斥锁、channel、`Arc`、`OnceLock`/`std::call_once`、并发容器。无争用的互斥锁很便宜（加锁一次原子 RMW，解锁一次）。
2. 如果必须用原子操作，先用 `SeqCst` 写对，再只在基准数据表明有必要、并且你能说出每个内存序构成哪条 synchronizes-with 边的地方减弱它。
3. 每个 `Release` 都应有一个读同一原子变量的 `Acquire` 与之配对。如果找不出这对配对，内存序很可能用错了。
4. `Relaxed` 适合计数器、不关联数据的标志和 ID 生成器——不适合用来发布数据。
5. 永远不要用 C/C++ 的 `volatile` 做线程间通信。
6. 在弱序硬件（ARM）上运行，并配合 TSan 或 loom；x86 会掩盖"写→写"和"读→读"类的 bug。
7. 把频繁独立写入的原子变量填充到不同缓存行，分片优于争用。
8. 对于需要释放内存的无锁结构，一开始就确定回收方案（hazard pointer、epoch、RCU）；它通常是最难的部分。

## 参考资料

- Hans-J. Boehm，《Threads Cannot Be Implemented as a Library》，PLDI 2005。
- Peter Sewell 等，《x86-TSO: A Rigorous and Usable Programmer's Model for x86 Multiprocessors》，Communications of the ACM，2010。
- Daniel J. Sorin、Mark D. Hill、David A. Wood，《A Primer on Memory Consistency and Cache Coherence》第 2 版，Morgan & Claypool，2020。
- Mara Bos，《Rust Atomics and Locks》，O'Reilly，2023。
- Paul E. McKenney，《Is Parallel Programming Hard, And, If So, What Can You Do About It?》（perfbook）。
- cppreference 的 `std::memory_order`；Rust 标准库 `std::sync::atomic` 文档。
- The Go Memory Model，go.dev/ref/mem（2022 年 6 月 6 日版）。
- Linux 内核 `Documentation/memory-barriers.txt` 与 `tools/memory-model/`。
- Jeff Preshing 关于无锁编程与 acquire/release 语义的系列博文（preshing.com）。

## 实践要点

- 顺序一致性不是默认行为：编译器会重排，store buffer 会延迟写入，弱序架构几乎什么都会重排。一致性只给单个位置排序，其余交给内存模型。
- 在一台普通的 x86 Xeon 上，relaxed 的 store-buffering 实验在 1,000,000 轮中有 8,932 轮出现 SC 禁止的 `r1 == r2 == 0`；把写编译成 `xchg` 的 `seq_cst` 版本为零。
- Acquire/release 是日常工具：release 写把它之前的一切发布给读到它的 acquire 读。在 x86 上指令层面零成本，在 ARM 上对应 `stlr`/`ldar`。
- 当正确性依赖跨不同变量的全局顺序时用 `SeqCst`，只有在不发布其他数据时才用 `Relaxed`，把 `consume` 当作 acquire。
- 无锁 SPSC 环形队列只需要 acquire/release 配对，约三分之一秒按序传递了一千万个元素；无锁编程的大部分复杂度在 CAS 循环、ABA 和内存回收上。
- 伪共享让两个独立计数器慢了约 5 倍；把热点原子变量填充到不同缓存行，或者分片。

内存序与其说是背诵屏障指令，不如说是能指出程序所依赖的每一条 happens-before 边。当你能把它们一一说出来时，内存序也就自然选定了。
