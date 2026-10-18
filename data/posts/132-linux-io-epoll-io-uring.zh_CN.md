---
title: "深入 Linux I/O 多路复用：从 select、epoll 到 io_uring"
tag: performance
description: Linux 服务器如何同时处理数万连接——从 select/poll 到 epoll 的演进、epoll 在内核中的工作机制、水平触发与边缘触发的坑，以及 io_uring 为何从"就绪通知"转向基于完成事件、批量提交、共享内存的 I/O 模型
date: "2026-10-18T14:00:00.000Z"
---

## 目标

Nginx、Redis、Node.js（通过 libuv）、Go 运行时的 netpoller、Netty 和 Tokio 解决的是同一个问题：一个进程、很少的线程，以及成千上万条大部分时间都处于空闲的 socket。在 Linux 上，这个问题二十年来的答案是 **epoll**。从 Linux 5.1（2019 年）开始出现了第二个答案 **io_uring**——它改变的是模型本身，而不只是让旧模型更快。

本文完整梳理这条演进路线——阻塞 I/O、`select`/`poll`、`epoll`、`io_uring`——讲清每个内核接口到底做了什么，给出可运行的代码，最后给出选型建议和常见陷阱。

## 背景：为什么需要多路复用

### C10K 问题

1999 年 Dan Kegel 在《The C10K problem》中提出：单台服务器如何同时服务一万个客户端？最朴素的模型——每个连接一个线程（或进程），各自阻塞在 `read()` 上——会因为三个原因崩溃：

- **内存**：每个线程都需要独立的栈（Linux 上默认通常预留 8 MB 虚拟内存，实际按需分配物理页），外加内核数据结构。
- **调度**：成千上万个可运行线程意味着持续的上下文切换和缓存污染。
- **绝大多数时间在等待**：典型连接几乎一直在等数据，专门用一个线程去"等"是一种浪费。

替代方案是把 socket 设为**非阻塞**，然后只问内核一个问题：*这些文件描述符里，哪些现在可以推进？* 这就是 I/O 多路复用。

### 人们口中三种不同的"异步"

| 模型 | 调用做了什么 | 例子 |
|------|------------|------|
| 阻塞 | 睡眠直到有数据，然后拷贝 | 阻塞 socket 上的 `read()` |
| 非阻塞 + 就绪通知 | 没数据立即返回 `EAGAIN`，由另一个 API 告诉你何时重试 | `select`、`poll`、`epoll` |
| 基于完成 | 你提交"把数据读进这个缓冲区"，之后内核告诉你已完成以及读了多少字节 | `io_uring`、Windows IOCP |

就绪模型对应 **Reactor** 模式（等待就绪，再自己做 I/O）；完成模型对应 **Proactor** 模式（把 I/O 交给系统，对结果做出反应）。这个区别比任何 benchmark 数字都重要，因为它决定了事件循环的写法。

## select 与 poll：第一代方案

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

问题是结构性的：

1. **每次调用都要传入完整的关注集合。** 内核把整个 `fd_set` 拷进去，逐个检查，再把结果拷回来。
2. **两侧都是线性扫描。** 内核遍历所有描述符，用户态再遍历一遍找出就绪的。开销是 O(被监视数量)，而不是 O(就绪数量)。
3. **`FD_SETSIZE` 上限。** `select` 使用固定大小的位图，glibc 下为 1024 个描述符，超过这个值的描述符无法安全监视。

`poll()` 用 `struct pollfd` 数组替代位图，去掉了 1024 的上限，但问题 1 和 2 依然存在。面对一万条大多空闲的连接，每次调用要做一万份工作，只为找出可能三个活跃 socket。

## epoll：有状态的就绪通知

epoll（Linux 2.5.44，2002 年引入）把工作拆成两部分：**一次性注册关注**，然后**只等待已就绪的**。

```c
int epfd = epoll_create1(EPOLL_CLOEXEC);          // 创建 epoll 实例

struct epoll_event ev = { .events = EPOLLIN, .data.fd = sock };
epoll_ctl(epfd, EPOLL_CTL_ADD, sock, &ev);        // 只注册一次

struct epoll_event events[256];
int n = epoll_wait(epfd, events, 256, timeout_ms); // 只返回就绪的 fd
```

### 内核里发生了什么

一个 epoll 实例主要包含两个结构：

- **关注集合**——以 (file, fd) 为键的红黑树，`epoll_ctl` 以 O(log n) 插入、修改或删除。
- **就绪链表**——当前有事件的条目组成的链表。

添加 socket 时，epoll 会在该 socket 的等待队列上注册一个回调（`ep_poll_callback`）。当数据包到达、TCP 协议栈唤醒 socket 的等待者时，回调执行，把条目追加到就绪链表。因此 `epoll_wait` 不扫描任何东西：它睡眠直到就绪链表非空，然后拷出最多 `maxevents` 个条目。

所以 `epoll_wait` 的开销与**就绪**描述符数量成正比，而不是被监视的数量。正是这一点让 epoll 能扩展到海量空闲连接。

### 水平触发与边缘触发

- **水平触发（默认）**：只要描述符可读，`epoll_wait` 就会持续报告。只读了一部分也会再次通知。行为像一个更快的 `poll`，不容易用错。
- **边缘触发（`EPOLLET`）**：只在状态*变化*时通知（例如新数据到达）。如果你没有一直读到 `read` 返回 `EAGAIN`，缓冲区里已有的数据可能再也不会触发通知。

边缘触发减少了重复唤醒，但把责任转移给了你。一个常见又隐蔽的 bug：为了公平，你限制每个连接每轮最多读 64 KB——但在边缘触发下，剩下的数据不会产生新事件，这个连接就会悄无声息地卡住。如果要限制单轮工作量，就必须自己维护一个"仍有数据"的队列。

其他有用的标志：

- `EPOLLONESHOT`：一次事件后禁用该描述符，直到用 `EPOLL_CTL_MOD` 重新启用。多个线程共享一个 epoll 实例、需要保证某个连接只被一个线程处理时很方便。
- `EPOLLEXCLUSIVE`（Linux 4.5）：多个 epoll 实例等待同一个监听 socket 时只唤醒其中一个，缓解**惊群效应**。
- `EPOLLRDHUP`：无需额外 `read` 即可检测对端半关闭。

### 一个完整的边缘触发 echo 服务器

为简洁起见省略了错误处理并忽略部分写入；生产代码需要缓存未写完的数据并注册 `EPOLLOUT`。

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
                for (;;) {                       /* 接受所有待处理连接 */
                    int cfd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK);
                    if (cfd < 0) break;          /* EAGAIN：队列已空 */
                    struct epoll_event cev = { .events = EPOLLIN | EPOLLET, .data.fd = cfd };
                    epoll_ctl(ep, EPOLL_CTL_ADD, cfd, &cev);
                }
            } else {
                for (;;) {                       /* 边缘触发：读到 EAGAIN 为止 */
                    ssize_t r = read(fd, buf, sizeof buf);
                    if (r > 0) { write(fd, buf, r); continue; }
                    if (r < 0 && errno == EAGAIN) break;
                    close(fd);                   /* r == 0：对端关闭，或真实错误 */
                    break;
                }
            }
        }
    }
}
```

关闭描述符会自动把它从所有 epoll 关注集合中移除——但前提是底层打开文件的*所有*引用都已消失。如果描述符被 `dup()` 过或被子进程继承，注册依然存在。这是 `epoll(7)` 里记录的经典陷阱之一。

### epoll 力所不及的地方

- **普通文件永远"就绪"。** `epoll_ctl` 拒绝普通文件（返回 `EPERM`），`select`/`poll` 则总是报告其可读，因为磁盘读取仍可能在页缓存路径上阻塞。这就是 libuv 用线程池执行文件系统操作、Go 在独立 OS 线程上用阻塞系统调用处理文件的原因。
- **每次操作仍需一次系统调用。** epoll 告诉你"可读"之后，你还要调用 `read`、`write`，可能还有 `epoll_ctl`。每次陷入内核都有开销，而在 Spectre/Meltdown 缓解措施（如内核页表隔离）之后，这个开销变得更大。
- **就绪只是提示，不是数据。** "先等待、再读取"的两步往返是该模型固有的。

## io_uring：基于完成、批量提交、共享内存的 I/O

io_uring 由 Jens Axboe 设计，合入 Linux 5.1。它把"告诉我什么时候能读"换成"请帮我完成这次读取，做完告诉我"——对 socket *和*文件使用统一的接口。

### 两个环形缓冲区

应用和内核共享两个映射到用户空间的环形缓冲区：

- **提交队列（SQ）**：应用写入 **SQE**（提交队列条目）——操作码、fd、缓冲区地址、长度、偏移、标志，以及一个不透明的 64 位 `user_data`。
- **完成队列（CQ）**：内核写入 **CQE**——同样的 `user_data`，加上 `res`（结果：字节数或负的 errno）和标志。

由于两个环都在共享内存中，填写 SQE、收取 CQE 都只是带有头尾索引和内存屏障的普通内存操作。只有 `io_uring_enter()` 会进入内核，而且一次调用可以同时提交数百个操作并等待完成。在 **SQPOLL** 模式下，一个内核线程轮询 SQ，繁忙的应用甚至可以完全不发起系统调用就提交 I/O（老内核要求该模式具备更高权限，并且轮询线程活跃时会占满一个 CPU）。

三个系统调用分别是 `io_uring_setup`、`io_uring_enter` 和 `io_uring_register`。实践中几乎所有人都使用 Axboe 的辅助库 **liburing**。

### 读取文件

```c
#include <liburing.h>
#include <fcntl.h>
#include <stdio.h>

int main(void) {
    struct io_uring ring;
    io_uring_queue_init(64, &ring, 0);             /* 64 项的 SQ */

    int fd = open("data.bin", O_RDONLY);
    static char buf[4096];

    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buf, sizeof buf, 0);
    io_uring_sqe_set_data64(sqe, 42);              /* 自定义标记 */

    io_uring_submit(&ring);                        /* 一次 io_uring_enter() */

    struct io_uring_cqe *cqe;
    io_uring_wait_cqe(&ring, &cqe);
    printf("tag=%llu bytes=%d\n", (unsigned long long)cqe->user_data, cqe->res);
    io_uring_cqe_seen(&ring, cqe);                 /* 推进 CQ 头指针 */

    io_uring_queue_exit(&ring);
    return 0;
}
```

注意少了什么：没有非阻塞标志，没有就绪等待，没有 `EAGAIN` 处理。即便是普通文件，这次读取也是真正异步的。

### Proactor 风格的网络事件循环

下面是 io_uring echo 服务器核心循环的示意（省略缓冲区管理和错误路径）。每个操作的 `user_data` 编码了操作类型和所属连接：

```c
enum { OP_ACCEPT = 1, OP_RECV, OP_SEND };
#define TAG(op, fd)  (((uint64_t)(op) << 32) | (uint32_t)(fd))

/* 只需挂一次 multishot accept：一个 SQE，每个新连接产生一个 CQE */
struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
io_uring_prep_multishot_accept(sqe, lfd, NULL, NULL, 0);
io_uring_sqe_set_data64(sqe, TAG(OP_ACCEPT, lfd));

for (;;) {
    io_uring_submit_and_wait(&ring, 1);            /* 一次系统调用完成提交 + 等待 */

    unsigned head, count = 0;
    struct io_uring_cqe *cqe;
    io_uring_for_each_cqe(&ring, head, cqe) {
        int op = cqe->user_data >> 32;
        int fd = (int)(uint32_t)cqe->user_data;

        if (op == OP_ACCEPT) {
            if (cqe->res >= 0) queue_recv(&ring, cqe->res);
            if (!(cqe->flags & IORING_CQE_F_MORE)) rearm_accept(&ring, lfd);
        } else if (op == OP_RECV) {
            if (cqe->res <= 0) close(fd);           /* 对端关闭或出错 */
            else queue_send(&ring, fd, cqe->res);   /* 原样回写 */
        } else if (op == OP_SEND) {
            queue_recv(&ring, fd);                  /* 发起下一次读 */
        }
        count++;
    }
    io_uring_cq_advance(&ring, count);             /* 一次性标记已收取的 CQE */
}
```

每轮循环收取一批完成事件，把后续操作放进 SQ，再用一次 `io_uring_submit_and_wait` 全部提交。高负载下，平均每次操作的系统调用次数会远低于一次。

### 真实系统中重要的特性

- **注册文件与缓冲区**（`io_uring_register`）：预先注册描述符和内存，内核就能跳过每次操作的文件引用计数和页面锁定。
- **提供缓冲区 / 缓冲区环**：不必为每个挂起的 `recv` 预留专属缓冲区（10 万空闲连接时代价很高），而是交给内核一个缓冲池，数据真正到达时才挑选缓冲区。这找回了 epoll 在内存上的主要优势。
- **Multishot 操作**：一个 accept 或 recv 的 SQE 产生多个 CQE，请求保持挂起期间 CQE 带有 `IORING_CQE_F_MORE` 标志。
- **链接 SQE**（`IOSQE_IO_LINK`）：串联操作，例如"先 write 再 fsync"，或通过 linked timeout 给单个操作加超时。
- **广泛的操作码覆盖**：除读写外还支持 `openat`、`statx`、`fsync`、`send`/`recv`、`connect`、`splice`、超时等，整个请求路径都可以走同一个接口。

## 对比

| | select / poll | epoll | io_uring |
|---|---|---|---|
| 模型 | 就绪 | 就绪 | 完成 |
| 关注集合 | 每次调用都传入 | 内核侧维护，注册一次 | 按操作提交 |
| 每次等待的开销 | O(被监视数) | O(就绪数) | 批量；可做到零系统调用 |
| 普通文件 | 永远"就绪" | 不支持 | 真正异步 |
| 每次 I/O 的系统调用 | ≥ 2 | ≥ 2（等待 + 读写） | 高负载下均摊低于 1 |
| 缓冲区归属 | 调用 `read` 前归你 | 调用 `read` 前归你 | CQE 到达前归内核 |
| 可移植性 | POSIX | 仅 Linux | Linux 5.1+，特性随版本而异 |
| 成熟度 / 安全记录 | 非常成熟 | 非常成熟 | 较年轻；攻击面大 |

## 工程取舍

### 缓冲区生命周期成了你的问题

用 epoll 时，缓冲区只在 `read` 调用期间有意义。用 io_uring 时，SQE 一旦提交，内核在 CQE 到达前的任意时刻都可能写入该缓冲区。提前释放或复用就是编译器抓不到的 use-after-free。这就是基于 io_uring 的 Rust 异步运行时（如 `tokio-uring`、`glommio`）把**拥有所有权的**缓冲区传给每个操作、并随结果一起归还的原因，而不像 Tokio 基于 epoll 的 API 那样借用 `&mut [u8]`。取消操作同样微妙：drop 一个 future 并不能阻止内核完成这次操作。

### 安全态势

io_uring 给了用户态一条庞大且快速演进的内核路径。2023 年 6 月，Google 安全团队披露：过去一年提交到其 kCTF 漏洞奖励计划的漏洞利用中，有 60% 利用的是 io_uring；Google 已在 ChromeOS 上禁用 io_uring，通过 seccomp-bpf 过滤器让 Android 应用无法调用它，并在 Google 生产服务器上禁用了它。Linux 6.6 新增了 `kernel.io_uring_disabled` sysctl，管理员可以在全系统禁用或仅允许特定用户组使用；容器运行时也收紧了默认 seccomp 配置中对 io_uring 系统调用的放行。在押注 io_uring 之前，先确认你部署的内核和沙箱里它确实可用。

### 内核版本碎片化

许多让 io_uring 在网络场景下有吸引力的特性（multishot accept 与 recv、环形映射的提供缓冲区、零拷贝发送）都是在 5.1 之后数年才加入的。在开发者 6.x 笔记本上能跑的代码，可能在 LTS 发行版内核上失败。运行时探测特性（`io_uring_get_probe`），并保留 epoll 回退路径。

### 现状：谁在用什么

- **epoll**：Nginx、Redis、libuv（socket 部分）、Go netpoller、Linux 上 Java NIO 的 `Selector`、Netty 原生传输、通过 `mio` 的 Tokio。
- **io_uring**：追求磁盘吞吐的存储引擎和数据库、高性能代理、libuv（文件操作，1.45 版本加入）、Netty 的 io_uring 传输，以及 `tokio-uring`、`glommio` 等运行时。

## 实践中的选择

1. **在用框架或运行时？** 保持默认。事件循环是运行时的职责，默认实现经过了大量生产验证。
2. **大量空闲连接的网络服务、内核版本不统一？** 用 epoll，除非有实测理由，否则使用水平触发。
3. **文件或磁盘 I/O 繁重，或系统调用开销在 profile 中占主导？** io_uring 配合注册缓冲区和批量提交，是 Linux 上最强的选项。
4. **受限环境（严格 seccomp 的容器、加固主机）？** 设计前先确认 io_uring 被允许，并保留回退路径。
5. **永远先度量。** 改动 I/O 层之前，先用 `perf`、`strace -c` 和 `bpftrace` 看清时间花在系统调用、数据拷贝还是你自己的代码上。

## 总结

- `select`/`poll` 每次调用都重新传入并扫描整个关注集合：O(被监视数)。
- `epoll` 在内核中维护关注集合，借助等待队列回调构建就绪链表：O(就绪数)。边缘触发要求读到 `EAGAIN`，公平性逻辑必须考虑错过的边沿。
- `io_uring` 把契约从"就绪"改为"完成"，与内核共享提交和完成两个环，用一次系统调用（SQPOLL 下甚至零次）批量处理工作，并终于让普通文件 I/O 实现了异步。
- 代价是缓冲区生命周期的复杂性、对内核版本的依赖，以及让部分运维方选择禁用它的安全记录。

## 参考资料

- `epoll(7)`、`select(2)`、`poll(2)` 与 `io_uring(7)`——Linux man pages，[man7.org](https://man7.org/linux/man-pages/man7/epoll.7.html)
- Jens Axboe，[Efficient IO with io_uring](https://kernel.dk/io_uring.pdf)
- [liburing](https://github.com/axboe/liburing)——官方用户态库
- Dan Kegel，[The C10K problem](http://www.kegel.com/c10k.html)
- Google Security Blog，[Learnings from kCTF VRP's 42 Linux kernel exploits submissions](https://security.googleblog.com/2023/06/learnings-from-kctf-vrps-42-linux.html)（2023 年 6 月）
- Jonathan Corbet，"Ringing in a new asynchronous I/O API"，LWN.net（2019）
