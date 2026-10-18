---
title: "Linux I/O Multiplexing in Depth: From select and epoll to io_uring"
tag: performance
description: How Linux servers handle tens of thousands of connections — the evolution from select/poll to epoll, how epoll works inside the kernel, level- vs edge-triggered pitfalls, and why io_uring moves from readiness notification to completion-based, batched, shared-memory I/O
date: "2026-10-18T14:00:00.000Z"
---

## Goal

Nginx, Redis, Node.js (via libuv), Go's runtime netpoller, Netty and Tokio all solve the same problem: one process, very few threads, and tens of thousands of sockets that are idle most of the time. On Linux, the answer for two decades has been **epoll**. Since Linux 5.1 (2019) there has been a second answer, **io_uring**, which changes the model rather than just making it faster.

This article walks through the whole lineage — blocking I/O, `select`/`poll`, `epoll`, `io_uring` — explains what each kernel interface actually does, shows working code, and ends with practical guidance on which one to pick and what can go wrong.

## Background: Why Multiplexing Exists

### The C10K problem

In 1999 Dan Kegel's essay *The C10K problem* asked how a single server could handle ten thousand concurrent clients. The naive model — one thread (or process) per connection, each blocked in `read()` — breaks down for three reasons:

- **Memory**: every thread needs its own stack (commonly 8 MB of reserved virtual memory by default on Linux, with real pages committed as used), plus kernel structures.
- **Scheduling**: thousands of runnable threads means constant context switches and cache pollution.
- **Mostly idle work**: a typical connection spends nearly all its time waiting. Dedicating a thread to waiting is wasteful.

The alternative is to put sockets into **non-blocking** mode and ask the kernel a single question: *which of these file descriptors can I make progress on right now?* That question is I/O multiplexing.

### Three different things people call "async"

| Model | What the call does | Example |
|-------|--------------------|---------|
| Blocking | Sleeps until data is available, then copies it | `read()` on a blocking socket |
| Non-blocking + readiness | Returns `EAGAIN` immediately if nothing is there; a separate API tells you when to retry | `select`, `poll`, `epoll` |
| Completion-based | You submit "read into this buffer"; later the kernel tells you it is done and how many bytes landed | `io_uring`, Windows IOCP |

The readiness model leads to the **Reactor** pattern (wait for readiness, then do the I/O yourself). The completion model leads to the **Proactor** pattern (hand the I/O to the system, react to results). This distinction matters more than any benchmark number, because it shapes how you write the event loop.

## select and poll: The First Generation

```c
fd_set rfds;
FD_ZERO(&rfds);
for (int i = 0; i < nconns; i++)
    FD_SET(conns[i], &rfds);

int ready = select(maxfd + 1, &rfds, NULL, NULL, NULL);
for (int i = 0; i < nconns; i++)
    if (FD_ISSET(conns[i], &rfds))
        handle(conns[i]);
```

The problems are structural:

1. **The interest set is passed on every call.** The kernel copies the whole `fd_set` in, checks each descriptor, and copies the result back out.
2. **Linear scans on both sides.** The kernel walks every descriptor; user space then walks every descriptor again to find the ready ones. Cost is O(number watched), not O(number ready).
3. **`FD_SETSIZE` limit.** `select` uses a fixed-size bitmap, 1024 descriptors with glibc. Descriptors above that cannot be watched safely.

`poll()` replaces the bitmap with an array of `struct pollfd`, removing the 1024 cap, but keeps problems 1 and 2. With 10,000 mostly idle connections, each call does 10,000 units of work to find perhaps three active sockets.

## epoll: Stateful Readiness Notification

epoll (added in Linux 2.5.44, 2002) splits the job into two parts: **register interest once**, then **wait only for what is ready**.

```c
int epfd = epoll_create1(EPOLL_CLOEXEC);          // create an epoll instance

struct epoll_event ev = { .events = EPOLLIN, .data.fd = sock };
epoll_ctl(epfd, EPOLL_CTL_ADD, sock, &ev);        // register once

struct epoll_event events[256];
int n = epoll_wait(epfd, events, 256, timeout_ms); // returns only ready fds
```

### What happens inside the kernel

An epoll instance holds two main structures:

- **Interest set** — a red-black tree keyed by (file, fd). `epoll_ctl` inserts, modifies or removes entries in O(log n).
- **Ready list** — a linked list of entries whose files currently have events.

When you add a socket, epoll registers a callback (`ep_poll_callback`) on that socket's wait queue. When a packet arrives and the TCP stack wakes the socket's waiters, the callback runs and appends the entry to the ready list. `epoll_wait` therefore does not scan anything: it sleeps until the ready list is non-empty, then copies out up to `maxevents` entries.

So the cost of `epoll_wait` is proportional to the number of **ready** descriptors, not the number watched. That single property is why epoll scales to very large numbers of idle connections.

### Level-triggered vs edge-triggered

- **Level-triggered (default)**: `epoll_wait` keeps reporting a descriptor as long as it is readable. If you read only part of the buffer, you will be told again. This behaves like a faster `poll` and is hard to misuse.
- **Edge-triggered (`EPOLLET`)**: you are notified when the state *changes* (for example, new data arrives). If you do not drain the socket until `read` returns `EAGAIN`, you may never be notified again for data that is already sitting in the buffer.

Edge-triggered mode reduces repeated wakeups, but it moves responsibility to you. A common, subtle bug: to keep things fair you cap reads at, say, 64 KB per connection per loop iteration — but under edge triggering, the remaining data generates no new event, so that connection silently stalls. If you cap work, you must keep your own "still has data" queue.

Other useful flags:

- `EPOLLONESHOT`: disable the descriptor after one event until you re-arm it with `EPOLL_CTL_MOD`. Handy when several threads share one epoll instance and you need exactly one of them to handle a given connection.
- `EPOLLEXCLUSIVE` (Linux 4.5): when several epoll instances wait on the same listening socket, wake only one of them, mitigating the **thundering herd**.
- `EPOLLRDHUP`: detect a peer half-close without an extra `read`.

### A complete edge-triggered echo server

Error handling is trimmed and partial writes are ignored for brevity; production code must buffer unwritten bytes and register `EPOLLOUT`.

```c
#define _GNU_SOURCE
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <errno.h>

int main(void) {
    int lfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
    int one = 1;
    setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(8080),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    bind(lfd, (struct sockaddr *)&addr, sizeof addr);
    listen(lfd, SOMAXCONN);

    int ep = epoll_create1(EPOLL_CLOEXEC);
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = lfd };
    epoll_ctl(ep, EPOLL_CTL_ADD, lfd, &ev);

    struct epoll_event events[256];
    char buf[4096];

    for (;;) {
        int n = epoll_wait(ep, events, 256, -1);
        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;
            if (fd == lfd) {
                for (;;) {                       /* accept everything pending */
                    int cfd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK);
                    if (cfd < 0) break;          /* EAGAIN: queue is empty */
                    struct epoll_event cev = { .events = EPOLLIN | EPOLLET, .data.fd = cfd };
                    epoll_ctl(ep, EPOLL_CTL_ADD, cfd, &cev);
                }
            } else {
                for (;;) {                       /* edge-triggered: drain until EAGAIN */
                    ssize_t r = read(fd, buf, sizeof buf);
                    if (r > 0) { write(fd, buf, r); continue; }
                    if (r < 0 && errno == EAGAIN) break;
                    close(fd);                   /* r == 0: peer closed, or a real error */
                    break;
                }
            }
        }
    }
}
```

Closing a descriptor removes it from every epoll interest set automatically — but only once *all* references to the underlying open file are gone. If the descriptor was `dup()`ed or inherited by a child process, the registration survives. This is one of the classic epoll gotchas described in `epoll(7)`.

### Where epoll stops helping

- **Regular files are always "ready."** `epoll_ctl` refuses regular files (`EPERM`), and `select`/`poll` report them as always readable, because a disk read can still block in the page cache path. That is why libuv runs file system operations on a thread pool, and why Go uses blocking system calls on separate OS threads for files.
- **Still one syscall per operation.** After epoll says "readable," you still call `read`, then `write`, then maybe `epoll_ctl`. Each crossing into the kernel has a cost, and since the Spectre/Meltdown mitigations (such as kernel page-table isolation) that cost has grown.
- **Readiness is a hint, not data.** A second round trip (wait, then read) is inherent to the model.

## io_uring: Completion-Based, Batched, Shared-Memory I/O

io_uring, designed by Jens Axboe and merged in Linux 5.1, replaces "tell me when I can read" with "please do this read and tell me when it is done" — for sockets *and* files, with a uniform interface.

### Two ring buffers

The application and kernel share two ring buffers mapped into user space:

- **Submission Queue (SQ)**: the application writes **SQEs** (submission queue entries) — opcode, fd, buffer address, length, offset, flags, and an opaque 64-bit `user_data`.
- **Completion Queue (CQ)**: the kernel writes **CQEs** — the same `user_data` plus `res` (the result: byte count or negative errno) and flags.

Because both rings live in shared memory, filling SQEs and reaping CQEs are plain memory operations with head/tail indexes and memory barriers. Only `io_uring_enter()` crosses into the kernel, and a single call can submit hundreds of operations and wait for completions at the same time. With **SQPOLL** mode, a kernel thread polls the SQ, so a busy application can submit I/O with no syscalls at all (older kernels required elevated privileges for this mode, and the polling thread burns a CPU while active).

The three system calls are `io_uring_setup`, `io_uring_enter` and `io_uring_register`. In practice almost everyone uses **liburing**, Axboe's helper library.

### Reading a file

```c
#include <liburing.h>
#include <fcntl.h>
#include <stdio.h>

int main(void) {
    struct io_uring ring;
    io_uring_queue_init(64, &ring, 0);             /* 64-entry SQ */

    int fd = open("data.bin", O_RDONLY);
    static char buf[4096];

    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buf, sizeof buf, 0);
    io_uring_sqe_set_data64(sqe, 42);              /* our own tag */

    io_uring_submit(&ring);                        /* one io_uring_enter() */

    struct io_uring_cqe *cqe;
    io_uring_wait_cqe(&ring, &cqe);
    printf("tag=%llu bytes=%d\n", (unsigned long long)cqe->user_data, cqe->res);
    io_uring_cqe_seen(&ring, cqe);                 /* advance the CQ head */

    io_uring_queue_exit(&ring);
    return 0;
}
```

Note what is missing: no non-blocking flag, no readiness wait, no `EAGAIN` handling. The read is genuinely asynchronous even for a regular file.

### A network event loop, Proactor style

A sketch of the core loop of an io_uring echo server (buffer management and error paths omitted). Each operation's `user_data` encodes what it was and which connection it belongs to:

```c
enum { OP_ACCEPT = 1, OP_RECV, OP_SEND };
#define TAG(op, fd)  (((uint64_t)(op) << 32) | (uint32_t)(fd))

/* arm a multishot accept once: one SQE, one CQE per new connection */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_multishot_accept(sqe, lfd, NULL, NULL, 0);
io_uring_sqe_set_data64(sqe, TAG(OP_ACCEPT, lfd));

for (;;) {
    io_uring_submit_and_wait(&ring, 1);            /* submit + wait in one syscall */

    unsigned head, count = 0;
    struct io_uring_cqe *cqe;
    io_uring_for_each_cqe(&ring, head, cqe) {
        int op = cqe->user_data >> 32;
        int fd = (int)(uint32_t)cqe->user_data;

        if (op == OP_ACCEPT) {
            if (cqe->res >= 0) queue_recv(&ring, cqe->res);
            if (!(cqe->flags & IORING_CQE_F_MORE)) rearm_accept(&ring, lfd);
        } else if (op == OP_RECV) {
            if (cqe->res <= 0) close(fd);           /* peer closed or error */
            else queue_send(&ring, fd, cqe->res);   /* echo what we got */
        } else if (op == OP_SEND) {
            queue_recv(&ring, fd);                  /* next read */
        }
        count++;
    }
    io_uring_cq_advance(&ring, count);             /* mark all reaped CQEs seen */
}
```

Each iteration reaps a batch of completions, queues the next operations into the SQ, and submits them all with one `io_uring_submit_and_wait`. Under load, syscalls per operation drop well below one.

### Features that matter in real systems

- **Registered files and buffers** (`io_uring_register`): pre-register descriptors and memory so the kernel skips per-operation file reference counting and page pinning.
- **Provided buffers / buffer rings**: instead of dedicating a buffer to every pending `recv` (expensive with 100k idle connections), give the kernel a pool and let it pick a buffer only when data actually arrives. This recovers epoll's main memory advantage.
- **Multishot operations**: one SQE for accept or recv yields many CQEs, flagged with `IORING_CQE_F_MORE` while the request stays armed.
- **Linked SQEs** (`IOSQE_IO_LINK`): chain operations, for example "write, then fsync," or attach a timeout to a single operation with a linked timeout.
- **Broad opcode coverage**: beyond read/write it handles `openat`, `statx`, `fsync`, `send`/`recv`, `connect`, `splice`, timeouts and more, so an entire request path can run through one interface.

## Comparison

| | select / poll | epoll | io_uring |
|---|---|---|---|
| Model | Readiness | Readiness | Completion |
| Interest set | Passed every call | Kernel-side, registered once | Per-operation submissions |
| Cost per wait | O(watched) | O(ready) | Batched; may need zero syscalls |
| Regular files | Always "ready" | Not supported | Truly asynchronous |
| Syscalls per I/O | ≥ 2 | ≥ 2 (wait + read/write) | Amortized below 1 under load |
| Buffer ownership | Yours until you call `read` | Yours until you call `read` | Kernel's until the CQE arrives |
| Portability | POSIX | Linux only | Linux 5.1+, features vary by version |
| Maturity / security record | Very mature | Very mature | Younger; large attack surface |

## Engineering Trade-offs

### Buffer lifetime becomes your problem

With epoll, the buffer only matters during the `read` call. With io_uring, once you submit an SQE the kernel may write into that buffer at any point until the CQE arrives. Freeing or reusing it early is a use-after-free that the compiler cannot catch. This is why Rust async runtimes built on io_uring (for example `tokio-uring` and `glommio`) pass **owned** buffers into each operation and hand them back with the result, instead of borrowing `&mut [u8]` the way Tokio's epoll-based API does. Cancellation is subtle for the same reason: dropping a future does not stop the kernel from finishing the operation.

### Security posture

io_uring gives user space a large, fast-moving path into the kernel. In June 2023 Google's security team reported that, over the preceding year, 60% of the submissions to its kCTF vulnerability reward program exploited io_uring, and that io_uring was disabled on ChromeOS, made unreachable to Android apps through a seccomp-bpf filter, and disabled on Google's production servers. Linux 6.6 added the `kernel.io_uring_disabled` sysctl so administrators can turn it off system-wide or limit it to a group, and container runtimes have tightened their default seccomp profiles around the io_uring system calls. Before betting on io_uring, check that it is actually available in the kernels and sandboxes where you deploy.

### Kernel version fragmentation

Many of the features that make io_uring compelling for networking (multishot accept and recv, ring-mapped provided buffers, zero-copy send) arrived years after 5.1. Code that works on a developer's 6.x laptop may fail on an LTS distribution kernel. Probe for features at runtime (`io_uring_get_probe`) and keep an epoll fallback.

### Who uses what today

- **epoll**: Nginx, Redis, libuv (sockets), Go's netpoller, Java NIO's `Selector` on Linux, Netty's native transport, Tokio via `mio`.
- **io_uring**: storage engines and databases chasing disk throughput, high-performance proxies, libuv (file operations, added in 1.45), Netty's io_uring transport, and runtimes such as `tokio-uring` and `glommio`.

## Choosing in Practice

1. **Using a framework or runtime?** Stay on its default. The event loop is the runtime's job, and the defaults are proven in production.
2. **Network service with many idle connections on mixed kernels?** epoll, level-triggered unless you have measured a reason to use edge-triggered.
3. **Heavy file or disk I/O, or syscall overhead dominating your profiles?** io_uring is the strongest option on Linux, with registered buffers and batching.
4. **Locked-down environments (containers with strict seccomp, hardened hosts)?** Verify io_uring is permitted before designing around it, and keep a fallback path.
5. **Always measure.** Use `perf`, `strace -c` and `bpftrace` to see whether time goes into syscalls, copies or your own code before changing the I/O layer.

## Summary

- `select`/`poll` re-send and re-scan the entire interest set on every call: O(watched).
- `epoll` keeps the interest set in the kernel and uses wait-queue callbacks to build a ready list: O(ready). Edge-triggered mode requires draining to `EAGAIN`, and fairness logic must account for missed edges.
- `io_uring` changes the contract from readiness to completion, shares submission and completion rings with the kernel, batches work across a single syscall (or none with SQPOLL), and finally makes regular-file I/O asynchronous.
- The price is buffer-lifetime complexity, kernel-version dependence and a security record that has led some operators to disable it.

## References

- `epoll(7)`, `select(2)`, `poll(2)` and `io_uring(7)` — Linux man pages, [man7.org](https://man7.org/linux/man-pages/man7/epoll.7.html)
- Jens Axboe, [Efficient IO with io_uring](https://kernel.dk/io_uring.pdf)
- [liburing](https://github.com/axboe/liburing) — the reference user-space library
- Dan Kegel, [The C10K problem](http://www.kegel.com/c10k.html)
- Google Security Blog, [Learnings from kCTF VRP's 42 Linux kernel exploits submissions](https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html) (June 2023)
- Jonathan Corbet, "Ringing in a new asynchronous I/O API", LWN.net (2019)
