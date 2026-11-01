---
title: "深入 Rust 异步：Future、状态机、Pin、Waker 与 Tokio 运行时"
tag: rust
description: Rust 的 async/await 如何被编译成基于 poll 的状态机，自引用的 Future 为什么需要 Pin，Waker 如何把 Future 和执行器连接起来，Tokio 的工作窃取调度器、I/O 驱动和时间轮如何协同，以及取消、Send 约束、阻塞代码和 Future 体积等工程实践中的坑
date: "2026-11-01T10:15:00.000Z"
---

## 目标

Rust 的异步表面上很眼熟（`async fn`、`.await`），底层却和 JavaScript 的 Promise、Go 的 goroutine 完全不同：语言没有内置运行时，没有垃圾回收，也不会在每次调用时偷偷分配堆内存。编译器把每个 `async fn` 变成一个状态机，再由一个库（通常是 Tokio）来驱动它。

本文内容：

1. `Future` trait 与 poll 模型。
2. 编译器为 `async fn` 生成了什么。
3. `Pin` 为什么存在，它到底保证了什么。
4. Waker，以及一个约 50 行的最小执行器。
5. Tokio 内部：调度器、I/O 驱动、定时器、协作式预算。
6. 取消与取消安全（cancel safety）。
7. `Send`、阻塞代码、Future 体积等生产环境陷阱。
8. 与 Go、JavaScript 的对比。

## 1. Future trait

一切都建立在 `std::future` 里的一个 trait 上：

```rust
pub trait Future {
    type Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

pub enum Poll<T> {
    Ready(T),
    Pending,
}
```

约定如下：

- 执行器调用 `poll`，Future 在**不阻塞**的前提下尽可能推进。
- 完成时返回 `Poll::Ready(value)`。
- 无法继续时（socket 没数据、定时器没到期），返回 `Poll::Pending`，**同时**保证在可以继续推进时唤醒 `cx.waker()`。
- 被唤醒之前，执行器不应再次 poll 它（提前 poll 是允许的，只是浪费）。

由此得出两个决定一切的性质：

- **Future 是惰性的。** 调用 `async fn` 只会构造一个值，在有人 poll 之前什么都不做。对比 JavaScript 的 `Promise`：它的 executor 函数在创建时立即执行。
- **Future 基于拉取（poll），而非回调。** 执行器主动去拉，Future 从不把结果推给某个续体。正因如此，组合才能零分配：`join`、`select` 和嵌套的 `.await` 都只是 poll 子 Future 的结构体。

## 2. async fn 就是状态机

看这段代码：

```rust
async fn fetch_len(client: &Client, url: String) -> usize {
    let resp = client.get(&url).await;      // suspension point 1
    let body = resp.text().await;           // suspension point 2
    body.len()
}
```

编译器会把它降级成一个匿名类型，大致如下（经过简化，真实实现以协程形式生成）：

```rust
enum FetchLen<'a> {
    Start { client: &'a Client, url: String },
    AwaitGet { url: String, fut: GetFuture<'a> },     // fut may borrow `url`
    AwaitText { fut: TextFuture },
    Done,
}

impl Future for FetchLen<'_> {
    type Output = usize;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<usize> {
        loop {
            match /* current state */ {
                Start { .. }       => { /* build GetFuture, move to AwaitGet */ }
                AwaitGet { fut, .. } => match fut.poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(resp) => { /* build TextFuture, move to AwaitText */ }
                },
                AwaitText { fut }  => match fut.poll(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(body) => { /* move to Done */ return Poll::Ready(body.len()); }
                },
                Done => panic!("polled after completion"),
            }
        }
    }
}
```

关键结论：

- **跨 `.await` 存活的局部变量会变成状态机的字段。** Future 的大小约等于其最大状态的大小（各变体像 enum 一样共享存储）。
- **每个任务没有独立的栈。** 这就是“无栈（stackless）”并发：挂起的任务就是这个结构体本身。一百万个空闲连接就是一百万个结构体，通常每个几百字节到几 KB。
- **嵌套通过内嵌来组合。** 如果 `fetch_len` 里 await 了另一个 `async fn`，被调用者的状态机就是调用者的一个字段。整棵调用树变成一个值，执行器只需分配一次（例如每次 `tokio::spawn` 一个 `Box`）。

## 3. 为什么需要 Pin

再看 `AwaitGet` 状态。`client.get(&url)` 可能持有对 `url` 的引用，而 `url` 就存储在**同一个结构体**里。这让 Future 成为自引用类型：一个字段指向同一个值的另一个字段。

如果这样的值在内存中被移动（比如 `mem::swap`，或被放进一个会扩容的 `Vec`），内部指针就会悬空。普通的 Rust 引用无法表达这种关系，借用检查器通常会直接禁止，而异步函数却处处需要它。

`Pin<P>` 就是解决方案。`Pin<&mut T>` 是一个附带承诺的指针：**被指向的值在被 drop 之前不会再被移动**。由于 `poll` 的签名是 `self: Pin<&mut Self>`，Future 只有被固定后才能被 poll，此后它的地址稳定，内部引用就是安全的。

关于 `Pin` 值得知道的几点：

- `Unpin` 是一个自动 trait，表示“即使被 Pin 住，移动我也没问题”。几乎所有普通类型（`i32`、`String`、`Vec<T>`）都是 `Unpin`，而编译器生成的异步状态机通常不是。
- 对于 `T: Unpin`，`Pin<&mut T>` 和 `&mut T` 用起来一样。Pin 只约束 `!Unpin` 类型。
- 固定的两种方式：用 `Box::pin(fut)` 放到堆上（哪里都能用，代价是一次分配），或用 `std::pin::pin!(fut)` 固定在栈上（Rust 1.68 起稳定，无分配，但不能活过当前作用域）。
- Pin 约束的是**被指向值的内存位置**，通过 API 设计来保证。对 `!Unpin` 类型，从 `Pin<&mut T>` 拿到 `&mut T` 需要 `unsafe`（`get_unchecked_mut`）。
- 手写一个包装其他 Future 的 Future 时，需要“pin 投影”把 `Pin<&mut Outer>` 变成 `Pin<&mut Inner>`。`pin-project` / `pin-project-lite` crate 可以安全地生成这些代码，Tokio 内部就用 `pin-project-lite`。

日常最常见的场景：在循环里用 `select!`，并希望某个 Future 跨迭代保留：

```rust
let sleep = tokio::time::sleep(Duration::from_secs(5));
tokio::pin!(sleep);                    // or std::pin::pin!

loop {
    tokio::select! {
        _ = &mut sleep => { println!("deadline"); break; }
        Some(msg) = rx.recv() => handle(msg),
    }
}
```

只有当 `Sleep` 被 Pin 住时，`&mut sleep` 才实现 `Future`；不固定的话，编译器会报 `Sleep` 没有实现 `Unpin`。

## 4. Waker 与最小执行器

`Context` 主要携带一个 `Waker`。`Waker` 是一个类型擦除的句柄（数据指针加一张包含 `clone`、`wake`、`wake_by_ref`、`drop` 的虚表），用来告诉执行器“这个任务可以继续了，再 poll 一次”。叶子 Future（socket、定时器、channel）负责保存 waker，组合型 Future 只是把 `cx` 往下传。

下面是一个只用 `std` 的完整玩具执行器。每个任务是一个 `Arc`，唤醒时把它重新发送到运行队列：

```rust
use std::future::Future;
use std::pin::Pin;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::Duration;

type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

struct Task {
    future: Mutex<Option<BoxFuture>>,
    queue: Sender<Arc<Task>>,
}

impl Wake for Task {
    fn wake(self: Arc<Self>) {
        let q = self.queue.clone();
        let _ = q.send(self);            // re-schedule
    }
}

fn spawn(queue: &Sender<Arc<Task>>, fut: impl Future<Output = ()> + Send + 'static) {
    let task = Arc::new(Task { future: Mutex::new(Some(Box::pin(fut))), queue: queue.clone() });
    queue.send(task).unwrap();
}

fn run(rx: Receiver<Arc<Task>>) {
    while let Ok(task) = rx.recv() {
        let mut slot = task.future.lock().unwrap();
        if let Some(mut fut) = slot.take() {
            let waker = Waker::from(task.clone());
            let mut cx = Context::from_waker(&waker);
            if fut.as_mut().poll(&mut cx).is_pending() {
                *slot = Some(fut);       // park it until woken
            }
        }
    }
}

/// A leaf future: completes after `dur`, using a helper thread as the "reactor".
struct Delay { shared: Arc<Mutex<(bool, Option<Waker>)>> }

impl Delay {
    fn new(dur: Duration) -> Self {
        let shared = Arc::new(Mutex::new((false, None::<Waker>)));
        let s = shared.clone();
        thread::spawn(move || {
            thread::sleep(dur);
            let mut g = s.lock().unwrap();
            g.0 = true;
            if let Some(w) = g.1.take() { w.wake(); }
        });
        Delay { shared }
    }
}

impl Future for Delay {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut g = self.shared.lock().unwrap();
        if g.0 { return Poll::Ready(()); }
        g.1 = Some(cx.waker().clone());   // always store the most recent waker
        Poll::Pending
    }
}

fn main() {
    let (tx, rx) = channel();
    for i in 0..3 {
        spawn(&tx, async move {
            Delay::new(Duration::from_millis(100 * (3 - i))).await;
            println!("task {i} done");
        });
    }
    drop(tx);
    // Toy shutdown: the loop exits once every task has finished and all Sender clones are dropped.
    run(rx);
}
```

所有真实的运行时都是它的工业级版本：运行队列换成每个工作线程一个无锁双端队列，辅助线程换成 epoll/kqueue/IOCP reactor，`Arc<Task>` 换成手工实现的任务头，引用计数和状态位压在一个原子字里。

从这里已经能看出两条正确性规则：

- **每次返回 `Pending` 都要保存 waker。** Future 可能在不同任务之间移动（比如在 `select!` 里），早先 poll 时拿到的 waker 可能已经过期。`Waker::will_wake` 可以避免不必要的克隆。
- **不能丢失唤醒。** 检查就绪状态和注册 waker 要在同一把锁下完成（或用谨慎的原子操作），否则事件可能恰好发生在“未就绪”和“保存 waker”之间。

## 5. Tokio 内部

Tokio 是使用最广泛的运行时。它的多线程版本有四个主要部分。

### 调度器

设计思路见 Tokio 团队 2019 年的文章 *Making the Tokio scheduler 10x faster*：

- 默认**每个核心一个工作线程**，每个线程有一个**固定大小的本地运行队列**（256 个任务），所有者线程无锁地压入和弹出。
- 一个**全局注入队列**，用于运行时外部 spawn 的任务，以及本地队列满时的溢出。
- **工作窃取：** 空闲线程从其他线程的本地队列偷走一半任务。同时处于“搜索”状态的线程数有上限，避免窃取者惊群。
- **LIFO 槽：** 当一个任务唤醒另一个任务时（典型的通过 channel 请求/响应），被唤醒的任务放进一个特殊槽位，在同一线程上紧接着运行，此时缓存还是热的。这大幅降低了消息传递延迟。
- **公平性：** 即使本地队列很忙，工作线程也会周期性检查全局队列（间隔可通过 `Builder::global_queue_interval` 调整），避免注入的任务饿死。

还有 `current_thread` 版本：单线程、无窃取，通过 `LocalSet` 用 `spawn_local` 运行的任务不需要 `Send`。适合命令行程序、小工具和 thread-per-core 架构。

### I/O 驱动

基于 `mio`，它封装了 epoll（Linux）、kqueue（BSD/macOS）以及 Windows 上的 IOCP 式完成端口。Tokio 以**边缘触发**模式注册 socket，并按资源跟踪就绪状态。当 `TcpStream::read` 会返回 `WouldBlock` 时，清除就绪位、把 waker 存到资源上，Future 返回 `Pending`。reactor 收到事件后设置就绪位并唤醒保存的 waker。

驱动不是一个专用线程：哪个工作线程闲着，就由它阻塞在 `epoll_wait` 上，reactor 和调度器共享线程。

### 定时器

`tokio::time` 使用毫秒精度的**分层时间轮**：6 层，每层 64 个槽，每一层覆盖的范围是下一层的 64 倍。插入和取消都是 O(1)；随着时间推进，定时器逐级下沉到更精细的层。这就是为什么创建和丢弃上百万个超时的开销很低。

### 协作式预算

由于调度是协作式的，一个总能发现资源就绪的任务（比如一个很热的 channel）可能永远不让出。从 Tokio 0.2.14 开始，每个任务每次 poll 都有一个**预算**（128 个单位）。每次 Tokio 资源操作消耗一个单位；预算耗尽后资源会返回 `Pending` 并立刻唤醒该任务，迫使它回到队列。`tokio::task::consume_budget` 和 `tokio::task::unconstrained` 可以显式参与或退出这一机制。

预算对从不触碰 Tokio 资源的纯 CPU 循环无效，这类代码需要 `tokio::task::yield_now().await`、分块处理，或者把工作挪到别处。

## 6. 取消与取消安全

在 Rust 中，**取消一个 Future 就是 drop 它**，语言本身没有内置取消令牌。`select!`（落败的分支）、`tokio::time::timeout` 和 `JoinHandle::abort()` 都是在 Future 挂起所在的 `.await` 处把它 drop 掉。注意：仅仅 drop 一个 `JoinHandle` *不会*取消已 spawn 的任务，只是让它脱离（detach）。

这既强大又危险：

```rust
loop {
    tokio::select! {
        // BAD: read_exact may have consumed part of the frame when the other branch wins.
        res = stream.read_exact(&mut header) => { /* ... */ }
        _ = shutdown.recv() => break,
    }
}
```

如果一个方法在完成前被 drop 不会丢数据，它就是**取消安全**的。Tokio 文档会逐个方法标注：

- 取消安全：`mpsc::Receiver::recv`、`TcpListener::accept`、`AsyncReadExt::read`、`tokio::time::sleep`。
- 非取消安全：`read_exact`、`read_to_end`、`write_all`、`Mutex::lock`（会失去在公平队列中的位置），以及大多数“分好几步做事”的辅助方法。

应对办法：把部分状态放在 Future 之外（比如一个 `BytesMut` 缓冲区配合 `tokio_util::codec::FramedRead` 这类分帧解码器）；把一个长期存活的 Future 固定住，在 `select!` 中使用 `&mut fut`；或者把工作放进单独 spawn 的任务，通过 channel 通信。结构化关闭的常见模式是 `tokio_util::sync::CancellationToken` 加 `TaskTracker`。

另外，Rust 没有异步 `Drop`。需要 `.await` 的清理（flush、优雅关闭）必须在值被 drop 之前显式完成。

## 7. 生产环境陷阱

### Send 与多线程运行时

`tokio::spawn` 要求 `F: Future + Send + 'static`，因为任务可能在另一个工作线程上恢复。只有当**所有跨 `.await` 存活的东西**都是 `Send` 时，Future 才是 `Send`。经典报错：

```rust
let guard = std_mutex.lock().unwrap();   // std::sync::MutexGuard is !Send
do_io().await;                           // guard lives across await
drop(guard);
```

解决办法是限定 guard 的作用域，让它在 await 之前被 drop；或者在确实需要跨 I/O 持锁时使用 `tokio::sync::Mutex`。需要注意，对于短小、不含异步操作的临界区，`std::sync::Mutex` 通常比异步互斥锁更快，Tokio 文档也是这样推荐的。

### 阻塞执行器

任务里的任何阻塞调用（同步文件 I/O、`std::thread::sleep`、CPU 密集的哈希计算、同步数据库驱动）都会阻塞整个工作线程以及排在它上面的所有任务。可选方案：

- `tokio::task::spawn_blocking` 把闭包挪到独立的阻塞线程池（默认最多 512 个线程）。
- `tokio::task::block_in_place` 把当前工作线程转换为阻塞线程（仅限多线程运行时）。
- 持续的 CPU 并行计算用 `rayon`，再通过 `oneshot` channel 把结果传回。

Tokio 维护者给出的经验法则：两个 `.await` 之间的代码不应运行超过大约 10–100 微秒。

### Future 体积

被 await 的 Future 是内联嵌入的，层层嵌套的异步代码可能产生几十 KB 的状态机，在装箱前被来回复制，debug 构建下甚至可能栈溢出。缓解办法：对大的内部 Future 使用 `Box::pin`（Clippy 的 `large_futures` lint 会标出它们）；避免把大数组作为跨 `.await` 的局部变量；用 `std::mem::size_of_val(&fut)` 实际测量。

出于同样的原因，递归需要装箱：一个类型不能包含它自己。从 Rust 1.77 起，只要递归调用被装箱（`Box::pin(recurse(n - 1)).await`），递归 `async fn` 就能编译通过。

### trait 与闭包中的 async

- trait 中的 `async fn` 自 Rust 1.75 起稳定。问题在于调用方很难要求返回的 Future 是 `Send`。变通办法有 `trait-variant` crate、写成 `fn f(&self) -> impl Future<Output = T> + Send`，或者用 `#[async_trait]`（会装箱）。
- 异步闭包（`async || { ... }` 以及 `AsyncFn*` trait）自 Rust 1.85 起稳定，解决了过去“闭包返回的 Future 借用闭包捕获变量”的难题。

### 可观测性

挂起的任务没有栈，所以在调试器里很难看懂异步调用栈。用 `tracing` 的 span（`#[instrument]`）跨 await 传递上下文，用 `tokio-console`（需开启 `tokio_unstable`）查看每个任务的 poll 耗时、唤醒次数，以及永远不会被唤醒的任务。

## 8. 对比

| | Rust（Tokio） | Go | JavaScript（Node.js） |
|---|---|---|---|
| 模型 | 无栈状态机，基于 poll | 有栈 goroutine，栈可增长 | Promise + 单线程事件循环 |
| 何时开始执行 | 惰性，被 poll/spawn 时 | `go` 时立即 | 创建时立即 |
| 抢占 | 协作式（加预算） | Go 1.14 起基于信号的异步抢占 | 无（运行到完成） |
| 单任务内存 | 状态机的确切大小 | 初始 2 KB 栈 | GC 堆上的闭包与 Promise 对象 |
| 取消 | drop Future | `context.Context`，手动检查 | `AbortSignal`，手动检查 |
| 函数着色 | 有（`async` 与同步） | 无 | 有 |

Rust 为这个模型付出了复杂度的代价（Pin、Send 约束、取消安全、函数着色），换来的是可预测的内存占用、无 GC、零成本组合，以及同一套 Future 既能跑在单片机上（Embassy），也能跑在 64 核服务器上（Tokio）。

## 要点总结

- `async fn` 是编译器生成状态机的语法糖，跨 `.await` 的局部变量变成字段。
- Pin 的存在是因为这些状态机是自引用的；一旦被固定，Future 就不会再移动。
- Waker 是叶子 I/O 与调度器之间唯一的纽带。丢失或过期的 waker 是手写 Future 的经典 bug。
- Tokio = 工作窃取调度器 + mio reactor + 分层时间轮 + 协作式预算。
- 取消就是 drop。在把操作放进 `select!` 之前，先弄清它是否取消安全。
- 不要阻塞工作线程，不要跨 `.await` 持有 `!Send` 的 guard，留意 Future 的体积。

## 参考资料

- [The Rust Async Book](https://rust-lang.github.io/async-book/)
- [`std::future::Future`](https://doc.rust-lang.org/std/future/trait.Future.html) 与 [`std::pin` 模块文档](https://doc.rust-lang.org/std/pin/index.html)
- Carl Lerche，[*Making the Tokio scheduler 10x faster*](https://tokio.rs/blog/2019-10-scheduler)，Tokio 博客，2019
- [*Reducing tail latencies with automatic cooperative task yielding*](https://tokio.rs/blog/2020-04-preemption)，Tokio 博客，2020
- [Tokio 教程：Async in depth](https://tokio.rs/tokio/tutorial/async) 与 [Select / 取消](https://tokio.rs/tokio/tutorial/select)
- Alice Ryhl，[*Async: What is blocking?*](https://ryhl.io/blog/async-what-is-blocking/)
- withoutboats，[*Pin*](https://without.boats/blog/pin/)
- [Announcing `async fn` and return-position `impl Trait` in traits](https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html)，Rust 博客，2023
- [Rust 1.85.0 and Rust 2024](https://blog.rust-lang.org/2025/02/20/Rust-1.85.0.html)（异步闭包）
- [GitHub 上的 tokio-rs/tokio](https://github.com/tokio-rs/tokio)
