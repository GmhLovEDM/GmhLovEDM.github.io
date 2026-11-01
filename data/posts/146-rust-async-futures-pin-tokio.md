---
title: "Rust Async Under the Hood: Futures, State Machines, Pin, Wakers and the Tokio Runtime"
tag: rust
description: How async/await in Rust compiles into poll-based state machines, why self-referential futures need Pin, how Wakers connect futures to an executor, how Tokio's work-stealing scheduler, I/O driver and timer wheel fit together, and the practical pitfalls around cancellation, Send bounds, blocking code and future size
date: "2026-11-01T10:15:00.000Z"
---

## Goal

Rust's async model looks familiar on the surface (`async fn`, `.await`), but underneath it is very different from JavaScript promises or Go goroutines. There is no built-in runtime, no garbage collector and no hidden heap allocation per call. Instead the compiler turns each `async fn` into a state machine, and a library (usually Tokio) drives it.

This article covers:

1. The `Future` trait and the poll model.
2. What the compiler generates for `async fn`.
3. Why `Pin` exists and what it actually guarantees.
4. Wakers, and a minimal executor in about 50 lines.
5. Inside Tokio: scheduler, I/O driver, timers, cooperative budgeting.
6. Cancellation and cancel safety.
7. `Send`, blocking code, future size and other production pitfalls.
8. How this compares with Go and JavaScript.

## 1. The Future trait

Everything rests on one trait in `std::future`:

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

The contract:

- An executor calls `poll`. The future makes as much progress as it can **without blocking**.
- If it finishes, it returns `Poll::Ready(value)`.
- If it cannot continue (a socket has no data, a timer has not fired), it returns `Poll::Pending` **and** arranges for `cx.waker()` to be woken when progress becomes possible.
- The executor should not poll it again until it is woken (polling early is allowed but wasteful).

Two properties follow and shape everything else:

- **Futures are lazy.** Calling an `async fn` does nothing except build a value. No work happens until something polls it. Compare with a JavaScript `Promise`, whose executor function runs immediately.
- **Futures are poll-based, not callback-based.** The executor pulls; the future never pushes its result into a continuation. This is what allows zero-allocation composition: `join`, `select` and nested `.await` are just structs that poll their children.

## 2. async fn is a state machine

Consider:

```rust
async fn fetch_len(client: &Client, url: String) -> usize {
    let resp = client.get(&url).await;      // suspension point 1
    let body = resp.text().await;           // suspension point 2
    body.len()
}
```

The compiler lowers this into an anonymous type roughly like the following (simplified; the real thing is generated as a coroutine):

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

Key consequences:

- **Local variables that live across an `.await` become fields** of the state machine. The future's size is roughly the size of its largest state (variants share storage like an enum).
- **No stack per task.** This is "stackless" concurrency: a suspended task is just this struct. A million idle connections cost a million structs, often a few hundred bytes to a few KB each.
- **Nesting composes by embedding.** If `fetch_len` awaits another `async fn`, that callee's state machine is a field inside the caller's. The whole call tree becomes one value, which the executor allocates once (e.g. one `Box` per `tokio::spawn`).

## 3. Why Pin

Look again at `AwaitGet`. `client.get(&url)` may hold a reference to `url`, which is stored **in the same struct**. That makes the future self-referential: a field points at another field of the same value.

If such a value were moved in memory (e.g. `mem::swap`, or moved into a `Vec` that reallocates), the internal pointer would dangle. Ordinary Rust references can't express this, so the borrow checker would normally forbid it. Async functions need it constantly.

`Pin<P>` is the solution. `Pin<&mut T>` is a pointer with a promise: **the pointee will not be moved again until it is dropped**. Since `poll` takes `self: Pin<&mut Self>`, a future can only be polled after it has been pinned, and from then on its address is stable, so internal references are sound.

Things worth knowing about `Pin`:

- `Unpin` is an auto trait meaning "moving me is fine even when pinned". Almost all ordinary types (`i32`, `String`, `Vec<T>`) are `Unpin`. Compiler-generated async state machines generally are not.
- For `T: Unpin`, `Pin<&mut T>` behaves like `&mut T`. Pin only restricts `!Unpin` types.
- Two ways to pin: on the heap with `Box::pin(fut)` (works anywhere, costs an allocation) or on the stack with `std::pin::pin!(fut)` (stable since Rust 1.68, no allocation, but cannot outlive the current scope).
- Pin is about **the pointee's memory location**, enforced through the API surface. Getting `&mut T` out of a `Pin<&mut T>` for a `!Unpin` type requires `unsafe` (`get_unchecked_mut`).
- When writing a manual future that wraps another future, you need "pin projection" to go from `Pin<&mut Outer>` to `Pin<&mut Inner>`. The `pin-project` / `pin-project-lite` crates generate this safely; Tokio uses `pin-project-lite` internally.

Typical day-to-day symptom: `select!` in a loop on a future you want to keep across iterations:

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

`&mut sleep` is only a `Future` because `Sleep` is pinned; without pinning, the compiler reports that `Sleep` does not implement `Unpin`.

## 4. Wakers and a minimal executor

`Context` mainly carries a `Waker`. A `Waker` is a type-erased handle (a data pointer plus a vtable of `clone`, `wake`, `wake_by_ref`, `drop`) that tells the executor "this task can make progress, poll it again". Leaf futures (sockets, timers, channels) store the waker; composite futures just pass `cx` down.

Here is a complete toy executor using only `std`. Each task is an `Arc`; waking it re-sends it to a run queue.

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

Every real runtime is an industrial version of this: the run queue becomes lock-free per-worker deques, the helper thread becomes an epoll/kqueue/IOCP reactor, and `Arc<Task>` becomes a hand-rolled task header with a reference count and state bits in a single atomic word.

Two correctness rules you can already see:

- **Store the waker on every `Pending`.** A future may be moved between tasks (e.g. inside `select!`), so the waker from an earlier poll can be stale. `Waker::will_wake` helps avoid needless clones.
- **No lost wake-ups.** Check readiness and register the waker under the same lock (or with careful atomics); otherwise the event can fire between "not ready" and "store waker".

## 5. Inside Tokio

Tokio is the most widely used runtime. Its multi-threaded flavor has four main parts.

### Scheduler

The design is described in the Tokio team's 2019 post *Making the Tokio scheduler 10x faster*:

- **One worker thread per core** by default, each with a **fixed-size local run queue** (256 tasks) that the owner pushes and pops without locks.
- A **global injection queue** for tasks spawned from outside the runtime and for overflow when a local queue is full.
- **Work stealing:** an idle worker steals half of another worker's local queue. The number of concurrently searching workers is limited to avoid a thundering herd of stealers.
- **LIFO slot:** when a task wakes another task (classic request/response through a channel), the woken task goes into a special slot and runs next on the same worker, while caches are warm. This greatly reduces message-passing latency.
- **Fairness:** workers periodically check the global queue even when their local queue is busy (the interval is tunable via `Builder::global_queue_interval`), so injected tasks don't starve.

There is also a `current_thread` flavor: one thread, no stealing, no `Send` requirement for `spawn_local` tasks (via `LocalSet`). It's a good fit for CLIs, small tools and thread-per-core designs.

### I/O driver

Built on `mio`, which wraps epoll (Linux), kqueue (BSD/macOS) and IOCP-style completion (Windows). Tokio registers sockets in **edge-triggered** mode and tracks readiness per resource. When `TcpStream::read` would return `WouldBlock`, the readiness bit is cleared, the waker is stored on the resource, and the future returns `Pending`. When the reactor sees an event it sets readiness and wakes the stored wakers.

The driver is not a dedicated thread: whichever worker has nothing to do parks on `epoll_wait`, so the reactor and scheduler share threads.

### Timers

`tokio::time` uses a **hierarchical timing wheel** with millisecond resolution: six levels of 64 slots each, where each level covers 64× the range of the one below. Inserting and cancelling are O(1); as time advances, timers cascade down to finer levels. This is why creating and dropping millions of timeouts is cheap.

### Cooperative budgeting

Because scheduling is cooperative, a task that always finds its resource ready (e.g. a hot channel) could loop forever without yielding. Since Tokio 0.2.14 every task gets a **budget per poll** (128 units). Each Tokio resource operation consumes one unit; when the budget is exhausted, resources return `Pending` and immediately wake the task, forcing it back to the queue. `tokio::task::consume_budget` and `tokio::task::unconstrained` let you opt in or out explicitly.

The budget does not help with pure CPU loops that never touch a Tokio resource. Those need `tokio::task::yield_now().await`, chunking, or moving the work elsewhere.

## 6. Cancellation and cancel safety

In Rust, **cancelling a future means dropping it**. There is no cancellation token baked into the language. `select!` (the losing branches), `tokio::time::timeout`, and `JoinHandle::abort()` all cancel by dropping the future at whatever `.await` it was suspended on. Note that merely dropping a `JoinHandle` does *not* cancel a spawned task; it detaches it.

This is powerful and dangerous:

```rust
loop {
    tokio::select! {
        // BAD: read_exact may have consumed part of the frame when the other branch wins.
        res = stream.read_exact(&mut header) => { /* ... */ }
        _ = shutdown.recv() => break,
    }
}
```

A method is **cancel safe** if dropping it before completion loses no data. Tokio's docs annotate this per method:

- Cancel safe: `mpsc::Receiver::recv`, `TcpListener::accept`, `AsyncReadExt::read`, `tokio::time::sleep`.
- Not cancel safe: `read_exact`, `read_to_end`, `write_all`, `Mutex::lock` (you lose your place in the fair queue), and most "do several steps" helpers.

Remedies: keep partial state outside the future (e.g. a `BytesMut` buffer and a framed codec such as `tokio_util::codec::FramedRead`), pin a single long-lived future and select on `&mut fut`, or move the work into a spawned task and communicate with channels. For structured shutdown, `tokio_util::sync::CancellationToken` plus `TaskTracker` is the common pattern.

Also note: there is no async `Drop`. Cleanup that needs `.await` (flushing, graceful close) must be done explicitly before the value is dropped.

## 7. Production pitfalls

### Send and the multi-thread runtime

`tokio::spawn` requires `F: Future + Send + 'static`, because the task may be resumed on a different worker. A future is `Send` only if **everything alive across an `.await`** is `Send`. The classic error:

```rust
let guard = std_mutex.lock().unwrap();   // std::sync::MutexGuard is !Send
do_io().await;                           // guard lives across await
drop(guard);
```

Fix by scoping the guard so it is dropped before the await, or use `tokio::sync::Mutex` when you truly need to hold a lock across I/O. Note that a `std::sync::Mutex` held for short, non-async critical sections is usually faster than the async mutex; Tokio's docs recommend it.

### Blocking the executor

Any blocking call (synchronous file I/O, `std::thread::sleep`, CPU-heavy hashing, a sync database driver) inside a task blocks the whole worker thread and every task queued on it. Options:

- `tokio::task::spawn_blocking` moves the closure to a separate blocking pool (up to 512 threads by default).
- `tokio::task::block_in_place` converts the current worker into a blocking one (multi-thread runtime only).
- For sustained CPU parallelism, use `rayon` and bridge results back with a `oneshot` channel.

A useful rule of thumb from Tokio's maintainers: code should not go more than about 10–100 microseconds between `.await` points.

### Future size

Since awaited futures are embedded inline, deeply nested async code can produce state machines of tens of KB, which then get copied around before being boxed and can even overflow the stack in debug builds. Mitigations: `Box::pin` large inner futures (Clippy's `large_futures` lint flags them), avoid big arrays as locals across `.await`, and measure with `std::mem::size_of_val(&fut)`.

Recursion requires boxing for the same reason: a type cannot contain itself. Since Rust 1.77, a recursive `async fn` compiles as long as the recursive call is boxed (`Box::pin(recurse(n - 1)).await`).

### async in traits and closures

- `async fn` in traits is stable since Rust 1.75. The catch: callers cannot easily require that the returned future is `Send`. Workarounds are the `trait-variant` crate, writing `fn f(&self) -> impl Future<Output = T> + Send`, or `#[async_trait]` (which boxes).
- Async closures (`async || { ... }` with the `AsyncFn*` traits) are stable since Rust 1.85, fixing the old "closure returning a future that borrows its captures" problem.

### Observability

Async stacks are hard to read in a debugger because suspended tasks have no stack. Use `tracing` spans (`#[instrument]`) to carry context across awaits, and `tokio-console` (with `tokio_unstable`) to see per-task poll times, wake counts and tasks that are never woken.

## 8. Comparison

| | Rust (Tokio) | Go | JavaScript (Node.js) |
|---|---|---|---|
| Model | Stackless state machines, poll-based | Stackful goroutines, growable stacks | Promises + single-threaded event loop |
| Starts running | Lazily, when polled/spawned | Immediately on `go` | Eagerly on creation |
| Preemption | Cooperative (+ budget) | Async preemption via signals since Go 1.14 | None (run to completion) |
| Per-task memory | Exact size of state machine | Starts at a 2 KB stack | Closure + promise objects on GC heap |
| Cancellation | Drop the future | `context.Context`, manual checks | `AbortSignal`, manual checks |
| Function coloring | Yes (`async` vs sync) | No | Yes |

Rust pays for its model with complexity (Pin, Send bounds, cancel safety, colored functions) and gets predictable memory usage, no GC, zero-cost composition and the ability to run the same futures on a microcontroller (Embassy) or a 64-core server (Tokio).

## Takeaways

- `async fn` is sugar for a compiler-generated state machine; locals across `.await` become fields.
- Pin exists because those state machines are self-referential; once pinned, a future never moves.
- Wakers are the only link between leaf I/O and the scheduler. Lost or stale wakers are the classic bug in hand-written futures.
- Tokio = work-stealing scheduler + mio reactor + hierarchical timer wheel + cooperative budget.
- Cancellation is dropping. Know which operations are cancel safe before you put them in `select!`.
- Don't block workers, don't hold `!Send` guards across `.await`, and keep an eye on future size.

## References

- [The Rust Async Book](https://rust-lang.github.io/async-book/)
- [`std::future::Future`](https://doc.rust-lang.org/std/future/trait.Future.html) and [`std::pin` module docs](https://doc.rust-lang.org/std/pin/index.html)
- Carl Lerche, [*Making the Tokio scheduler 10x faster*](https://tokio.rs/blog/2019-10-scheduler), Tokio blog, 2019
- [*Reducing tail latencies with automatic cooperative task yielding*](https://tokio.rs/blog/2020-04-preemption), Tokio blog, 2020
- [Tokio tutorial: Async in depth](https://tokio.rs/tokio/tutorial/async) and [Select / cancellation](https://tokio.rs/tokio/tutorial/select)
- Alice Ryhl, [*Async: What is blocking?*](https://ryhl.io/blog/async-what-is-blocking/)
- withoutboats, [*Pin*](https://without.boats/blog/pin/)
- [Announcing `async fn` and return-position `impl Trait` in traits](https://blog.rust-lang.org/2023/12/21/async-fn-rpit-in-traits.html), Rust blog, 2023
- [Rust 1.85.0 and Rust 2024](https://blog.rust-lang.org/2025/02/20/Rust-1.85.0.html) (async closures)
- [tokio-rs/tokio on GitHub](https://github.com/tokio-rs/tokio)
