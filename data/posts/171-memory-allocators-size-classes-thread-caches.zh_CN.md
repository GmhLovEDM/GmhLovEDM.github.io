---
title: "深入内存分配器：大小类、线程缓存，以及 Go、jemalloc 与 mimalloc 如何发放内存"
tag: performance
description: 现代分配器如何在快路径上不抢锁就把大小变成指针——大小类以及为什么要故意浪费几个字节，不能改尺寸再回收的 span，本地 / 中心 / 堆 / 操作系统这一层缓存结构，Go 的 per-P mcache 与 16 字节微型分配器，Go 1.27 新增的按大小特化 malloc 路径，glibc、jemalloc、tcmalloc 与 mimalloc 各自如何安置这套层次，何时该改用 arena，再加上一个可运行模型，衡量取整浪费、大小类隔离和缓存命中率
date: "2026-11-26T13:41:00.000Z"
---

## 目标

`malloc(24)` 看起来像一个已经做完的题目。你要 24 个字节，拿到一个指针，稍后再还回去。各语言和系统里已经放了几十年分配器：glibc 的 `malloc`、jemalloc、tcmalloc、mimalloc、Go 运行时、JVM 的 TLAB。人们很容易把它的实现当成一件不再需要关心的商品。

它并没有做完。真正有意思的不是那次向操作系统申请地址空间的系统调用，而是：怎样在很多线程上每秒服务数百万次小分配，快路径上还不抢锁；怎样不必把每次请求都向上取整到 2 的幂；怎样又不会把大量空闲内存攥在手里，让 RSS 再也掉不下来。从 Doug Lea 的分配器，到 Google 的 tcmalloc，再到今天各个运行时，反复出现的共同想法是 **大小类**（size class）：一个被取整过的尺寸，一页切成等大的槽位，再在加锁的中心结构前面放一个小缓存，让最常见的一次分配只是从当前线程已经拥有的结构里弹出一个槽位。

本文会讲到：

1. 分配器真正要解决的问题。
2. 大小类，以及为什么要故意浪费几个字节。
3. span、slab 与 page：为什么空闲的 24 字节槽不能满足 32 字节的请求。
4. 缓存层次：本地、中心、堆、操作系统。
5. Go 的分配器：`mcache`、`mcentral`、`mheap`，16 字节微型分配器，以及 Go 1.27 新增的按大小特化 malloc。
6. glibc、jemalloc、tcmalloc 与 mimalloc 如何安置同一套层次，以及它们的分歧在哪里。
7. 何时通用分配器并不是合适的工具。
8. 一个可运行模型，衡量取整浪费、大小类隔离、微型打包，以及缓存命中率。

## 1. malloc 要解决什么

分配器夹在程序和操作系统中间。操作系统按页发放内存——普通 Linux 进程上常见的是 4 KiB，Go 运行时自己的页大小则是 8 KiB——并且希望被调用的次数尽量少。程序发放的是 16、24、48 或 80 字节的对象，并且希望每一次都便宜、对齐正确，而且最终还能被再次使用。

这两种粒度对不上。分配器的工作就是把页切成对象，发出去，收回来，并决定一页空到什么程度就可以还回去。在此过程中，有四种互相拉扯的压力：

- **延迟。** 常见路径应当只有很少几条指令，不抢锁，也不进系统调用。
- **争用。** 许多线程同时分配时，不应该挤在同一把堆锁上。
- **内部碎片。** 如果 17 字节的请求占用了 32 字节的槽，就有 15 个字节付了钱却用不上。
- **外部碎片与复用。** 以 24 字节对象形式释放的内存，最好最终还能服务于别的请求，或者还给操作系统。把大量空闲对象留在缓存里，会让下一次分配很快，也会让 RSS 看起来一直下不来。

在一条空闲链表上做首次适配（first-fit），可以跨尺寸复用内存，因为相邻的空闲块可以合并成更大的一块。但随着堆变老，遍历往往会越走越远，而且一条链表就是一把锁。现代通用分配器在某些路径上仍保留合并（glibc 至今会合并相邻块），但在小对象的快路径上放弃了它——这条路径由大小类主导。

## 2. 大小类：用浪费换一条快路径

大小类就是一个被取整过的尺寸。17 字节的请求不会得到一块刚好 17 字节的内存。它会被抬到能装下它的最小类，然后从只包含该类对象的空闲链表（或空闲槽位图）里取出一块。

最粗的策略是向上取整到 2 的幂：17 变成 32，33 变成 64。实现简单，浪费也大。更细的一种策略，也是 jemalloc 采用的，是 **每翻一倍设置四个大小类**。jemalloc 手册写明，除了最小的那些类之外，这样可以把内部碎片限制在大约 20%。在 64 位、16 字节量子、4 KiB 页的系统上，手册 Table 1 从 8 字节开始，然后是 16、32、48、64，依此类推——没有 24 字节这一类。因此 17 字节的请求会占用 32 字节。

Go 在小尺寸这一端更紧。[`src/internal/runtime/gc/sizeclasses.go`](https://go.dev/src/internal/runtime/gc/sizeclasses.go) 里生成的表目前列出 67 个类，从 8 字节到 32 KiB（`MaxSmallSize`）。运行时常量 `NumSizeClasses` 是 68。最前面几行是 8、16、24、32、48、64、80，所以在 Go 里，17 字节的请求占用的是 24 字节，而不是 32。这张表还记录了每个类的 span 大小、能放多少个对象、尾部剩多少字节、最大浪费，以及最小对齐。第 3 类是 24 字节，使用 8,192 字节的 span，放下 341 个对象，尾部剩 8 字节；注释里的最大浪费是 29.24%。

tcmalloc 描述的是同一件事：小对象映射到 60 到 80 个大小类之一，12 字节的请求会被取整到 16。当 `__STDCPP_DEFAULT_NEW_ALIGNMENT__` 不超过 8 时，tcmalloc 还会为 `operator new` 提供按 8 字节对齐的类，这样 24、40 这类常见尺寸就不必被抬到 16 的倍数。

浪费是设计的一部分，不是事故。一旦一页里每个对象都一样大，分配就变成“在这一页里找一个空槽”，释放就变成“把这个槽放回去”。快路径上不必搜索“刚好够大”的块，也不必拆分或合并。

模型的第一组运行会依次请求 1 到 256 字节的每一种大小，然后再依次请求 1 到 32,768 字节的每一种大小，并比较三种策略：按 2 的幂取整、jemalloc 公布的大小类（含 Table 1 中直到 32 KiB 的大类），以及 Go 的表。这不是一段程序的真实分配轨迹——它会过度代表真实程序根本不会申请的奇数尺寸——但可以把取整策略本身看清楚：

| 范围 | 策略 | 实际发放相对请求 |
| --- | --- | ---: |
| 1–256 字节 | 2 的幂 | +32.88% |
| 1–256 | jemalloc 大小类 | +8.75% |
| 1–256 | Go 大小类 | +5.45% |
| 1–32,768 | 2 的幂 | +33.33% |
| 1–32,768 | jemalloc 大小类 | +8.33% |
| 1–32,768 | Go 大小类 | +5.34% |

1 字节的请求在三种策略下都占用 8 字节（Go 的最小堆对齐就是 8 字节）。有意思的差别出在中间：17 和 24 字节在 Go 里停留在 24，在 jemalloc 和 2 的幂取整下跳到 32；33 字节在 Go 和 jemalloc 里变成 48，若只按 2 的幂取整则是 64；80 字节在 Go 和 jemalloc 里都是恰好一类，按 2 的幂则要占用 128。

## 3. 单一大小类的 span，以及它们为什么不能混用

承载同一类对象的单元在各分配器里名字不同——Go 里叫 **span**，jemalloc 里叫 **slab**，mimalloc 里则是只含一个大小类的 **page**——想法是一样的。连续若干页被专门分给一个类。Go 的页大小是 8,192 字节（`PageShift = 13`）。因此 24 字节类在一页里能放 341 个对象，尾部剩 8 字节；32 字节类能放 256 个，没有剩余。

空闲槽只能再被同一个类的请求使用。这就是快路径的代价。曾经作为 24 字节对象分配、随后被释放的内存，仍然是 24 字节的内存。后来一波 32 字节的请求，既不能把这些槽重新切开，也不能把两个 24 字节槽粘成一个 32 字节对象。会合并的分配器可以：相邻块一旦都空了就会并在一起，更大的请求可以从合并结果里切出来。

模型的第二组运行会分配 2,000 个 24 字节对象，再全部释放，然后在 **不再向操作系统申请内存** 的前提下，试图分配 2,000 个 32 字节对象：

| 分配器 | 2,000 次 24 字节分配后的预留 | 从这块内存里满足的 32 字节分配 |
| --- | ---: | ---: |
| 首次适配，并合并相邻块 | 68,096 字节 | 2,000 里的 1,702 |
| Go 风格大小类，8 KiB 页 | 49,152 字节（6 页） | 2,000 里的 0 |

合并型堆一开始占用更多，因为模型给每个块加了 8 字节的边界标签头，并且预留了一小块裕量。即使如此，它仍能从同一块预留里满足 1,702 次 32 字节请求（每次含头部一共需要 40 字节；68,096 / 40 = 1,702）。大小类堆在第一波里用得更少——2,000 个 24 字节对象加上页尾浪费，刚好装进 6 个 8 KiB 页——然后从这些页里 **一次都满足不了** 32 字节请求。如果允许它扩张，它会为 32 字节类再取 8 页，预留从 49,152 增加到 114,688 字节。那 6 页 24 字节的内存空着，却派不上新尺寸的用场。

这并不是在为首次适配辩护。同一组运行也说明了原因：朴素地遍历一条空闲链表，平均每次分配要访问大约 1,000 个块，而这正是 glibc 及其前辈按尺寸把块放进 **bin**、而不是扫描整个堆的原因。它说明的是：大小类用放弃跨类复用，换来了对空闲槽位的 O(1) 操作；复用问题必须在别处解决——把空页还给页堆（以便重新切成别的类），或者还给操作系统。

## 4. 缓存层次

对象按类放进 span 之后，剩下的问题是：谁可以碰哪一块 span。常见答案是一套层次：

1. **本地缓存**，归一条线程、一个 Go 的处理器（`P`），或一颗 CPU 所有。在这个缓存上分配和释放都不抢锁，因为同一时刻只有一个执行上下文在用它。
2. **每个大小类的中心结构**，用锁或精心设计的原子操作保护。本地缓存从这里补充，一次拿整段 span，或一批对象，从而把锁分摊到许多对象上。
3. **页堆**，发放连续若干页，并收回空页，必要时把它们改切成别的类。
4. **操作系统**，通过 `mmap` 或等价接口。分配器会一次取足够大的块来摊掉系统调用——Go 运行时的注释里写的是至少 1 MiB——并且只在更大一片区域都不再使用时才还回去。

本地缓存是分配能随线程数扩展的原因，也是进程在一阵分配之后看起来很吃内存的原因：每个缓存都被允许持有数量有限的空闲对象，这些对象在被刷回之前对其他线程是不可见的。各分配器的分歧在于，“本地”究竟是指每条线程、每颗 CPU，还是每个调度上下文，以及它们归还未使用页时有多积极。接下来四节就是这些分歧的细节。

## 5. Go：per-P 缓存、微型分配器，以及按大小特化的 malloc

Go 运行时的分配器最初基于 tcmalloc，后来已经分道扬镳。[`src/runtime/malloc.go`](https://go.dev/src/runtime/malloc.go) 文件开头的概述仍然是最合适的地图。不超过 32 KiB 的小分配会被取整到某个大小类，并从等大槽位的 span 里发放。大分配绕过缓存，直接走页堆。

缓存是 **按 P 的**，不是按 goroutine 的。`P` 是内核线程（`M`）要运行 goroutine（`G`）时必须持有的调度上下文。一个 `mcache` 除了别的字段，还包含一组按 **span class** 索引的当前 span。span class 同时编码大小类以及对象里是否含有指针：Go 1.27 的博文把它写成 `sizeClass<<1 | noPointers`。同一大小、有指针和无指针的对象住在不同的 span 里，因为垃圾回收器对两者的记账不同。

一次小分配沿着 `malloc.go` 里描述的层次向上走：

1. 把大小取整到某个类，在这个 P 的 `mcache` span 里查找。扫描该 span 的空闲位图来找槽位，不需要加锁。
2. 如果 span 已经满了，就从对应的 `mcentral` 取一个还有空位的 span。一次取整段 span，用来摊掉 `mcentral` 的锁。
3. 如果 `mcentral` 没有这样的 span，就从 `mheap` 取一段连续的页。
4. 如果 `mheap` 也满足不了，就向操作系统至少申请 1 MiB。

`mcentral` 本身给 span 保留了两种角色——部分空闲（还有空对象）和已满——并且在每个 GC 周期里，交换哪一组算已清扫、哪一组算未清扫，从而让清扫器和分配器共同承担让 span 重新可用的工作。空 span 回到 `mheap`，它的页可以被改用于另一个类。

堆按 **arena** 映射。在除 Windows、iOS/arm64 和 OpenBSD/arm64 之外的 64 位平台上，一个 arena 是 64 MiB；在 Windows、32 位平台以及上面那些更小的 64 位目标上是 4 MiB，在 Wasm 上是 512 KiB。`malloc.go` 里的注释解释了 Windows 和 Wasm 使用更小 arena 的原因：Windows 即使尚未触碰，也会把已提交的内存计入进程；Wasm 程序的堆往往很小。

### 微型分配器

小于 16 字节、且不含指针的分配，不会各自占用一个 8 字节或 16 字节的槽。**微型分配器**（tiny allocator）在 `mallocgcTiny` 的注释里有完整说明：它会把若干个这样的请求合并进同一个 16 字节块（`TinySize = 16`，也就是大小类 2）。只有当块里每一个子对象都不可达时，这个块才会被释放。这些对象必须是 noscan（没有指针）；正是这条限制让可能的浪费有上界。

同一段注释把 16 字节这个选择讲得很清楚。8 字节的块在只剩一个子对象可达时不会浪费，但能合并的请求更少。32 字节的块能合并得更多，最坏情况下却可能浪费 4 倍。16 字节对应 2 倍的最坏浪费。无论块有多大，最好情况下都能赢到 8 倍。微型分配器得到的对象不能被显式释放；`SetFinalizer` 有一个特例，允许把终结器挂到块内部的某个字节上。注释里写明的目标是小字符串，以及逃逸到堆上的独立变量；运行时注释还写到，在一个 JSON 基准里，该分配器把分配次数减少了约 12%，把堆大小减少了约 20%。

有一个最近的例外值得知道：goroutine 处于 secret 模式时做的分配会跳过微型分配器，以便在释放时把这块内存清零（Go issue 76356）。

模型的第三组运行用与 `mallocgcTiny` 相同的 2/4/8 字节对齐抬升，把一组重复的 1、2、3、4、8 字节 noscan 对象——共 2,000 个，请求 7,200 字节——打进 16 字节的块里。如果按 Go 的大小类一对一占槽，它们会占用 16,000 字节（比请求多 122.2%，因为 1–4 字节的对象都占用 8 字节槽）。打进 16 字节微型块之后，601 个块占用 9,616 字节，比请求多 33.6%，是大小类总量的 0.601。相比之下，2,000 个 8 字节对象无论哪种方式都占用 16,000 字节：每个微型块刚好放下两个，打包不会缩小总量，只会减少垃圾回收器需要追踪的堆对象个数。

### Go 1.27：按大小特化的 malloc

上面这条路径是通用路径：编译器生成对 `newobject` 的调用，由它取出大小以及类型是否包含指针，再交给 `mallocgc` 按这些事实分支。Go 1.27 在表的小尺寸一端增加了一族 **按大小特化** 的分配函数，并且在编译期已经知道 span class 时，由编译器直接调用它们。

Michael Matloob 在 2026 年 9 月 16 日的 [博文](https://go.dev/blog/size-specialized-allocations) 里把设计讲了一遍。大小类 1 到 7 分别覆盖 1–8、9–16、17–24、25–32、33–48、49–64 和 65–80 字节。每个 span class 都会生成一个特化函数——例如 `mallocgcSmallNoScanSC3` 负责分配第 3 类（17–24 字节）的无指针对象。因为大小和 span class 都是常量，编译器可以把清零槽位变成直接的存储指令，而不必调用 `memclrNoHeapPointers`，也可以跳过计算 span class 的工作，并把不常见的情况（GC 正在运行、调试开关打开）留在慢路径上。这些特化函数本身也是用 AST 内联器从同一份 Go 源码生成的，避免手写副本逐渐走样。

[Go 1.27 发行说明](https://go.dev/doc/go1.27) 给出了公布的数字：某些小于 80 字节的小分配，成本最多可降低 30%；在真实的、分配很重的程序里，整体改善预计约为 1%；二进制大约增大 60 KB，与工作负载无关。截止到 80 字节是有意的。再往上，清零会占主导，而且每多一个特化函数都要占用指令缓存，那些空间本来可以留给那一份共享的 `mallocgc`，或留给用户自己的代码。当编译器不知道大小时——博文里的例子是长度要到运行时才算出来的切片——`mallocgc` 本身仍可能分派到某个特化函数，所以这个函数必须快到足以付得起一次间接调用。

退出开关是在构建时设置 `GOEXPERIMENT=nosizespecializedmalloc`。发行说明写明，这个选项预计会在 Go 1.28 里去掉。

## 6. glibc：arena、合并，以及每线程缓存

GNU C 库的 `malloc` 源自 ptmalloc（pthreads malloc），而 ptmalloc 又源自 dlmalloc（Doug Lea malloc）。[官方手册](https://sourceware.org/glibc/manual/latest/html_node/The-GNU-Allocator.html) 里有一个对本文很重要的对比：**glibc 不会把块大小取整到 2 的幂**，并且无论块有多大，`free` 时都可以与相邻块合并。这就是第 3 节里的合并模型，再加上按尺寸分的 bin，这样分配器就不必为了找到合适的块而走遍整个堆。

为了在多线程下扩展，glibc 维护多个 **arena**——彼此独立的连续区域，块从里面切出来——从而让线程可以并行分配，而不挤在同一把堆锁上。非常大的块用 `mmap` 分配，`free` 时可以立刻还给系统，因此大块不会被夹在小块中间退不出去。默认的 `mmap` 阈值是 131,072 字节（128 KiB），并会按程序的分配模式动态调整；一旦设置了 `glibc.malloc.mmap_threshold`，阈值就变成静态的，动态调整也会关掉。

在 arena 前面是 **每线程缓存**（tcache）。手册的可调参数写明了默认值：64 位系统上 `glibc.malloc.tcache_max` 是 1,032 字节，32 位系统上是 516 字节（在当前手册里，这两个数字既是默认值也是最大值），`glibc.malloc.tcache_count` 则是每种大小缓存 16 个块。大约的最大开销是 bin 的数量乘以每个 bin 的个数、再乘以块大小。更早的 “fastbins” 路径已经没有了：文档写明 `mxfast` 这个可调参数不再有效，因为 fastbins 已被移除。

在典型的 Linux 用户态程序里，如果没有链上 jemalloc 或 tcmalloc，用的就是 glibc。它的合并行为也最接近模型隔离运行里首次适配的那一侧；它的线程缓存则是本文描述的缓存里最保守的——每个 bin 只有一千出头字节，而不是 32 KiB。

## 7. jemalloc：arena、extent 与衰减

[jemalloc](https://jemalloc.net/jemalloc.3.html) 最初由 Jason Evans 为 FreeBSD 编写，现在被广泛当作可替换的分配器使用，也包括一些大型服务部署，以及作为 `LD_PRELOAD`。它的手册在实现说明里用不同的名字描述了同一套层次。

内存被拆成 **extent**，并且总是按页大小的倍数对齐。小对象住在一个 extent 里的 **slab** 中，用位图记录哪些区域在使用；每个大对象都有自己的 extent。大小类遵循前面已经引用过的“每翻一倍四个类”的规则，64 位系统上量子是 16 字节；不超过半个量子的请求，会被取整到至少为 `sizeof(double)` 的最近 2 的幂。小类止于页大小的四倍之前；大类从那里开始，一直延伸到不超过 `PTRDIFF_MAX` 的最大一类。

**Arena** 用来降低锁争用。默认的 `opt.narenas` 是 CPU 数量的四倍；如果只有一颗 CPU，则为 1。Arena 之间彼此独立管理内存，手册也指出这会带来少量固定的碎片；把 arena 数量设得远高于默认值，“不太可能改善性能，主要是因为缓存性能下降”。在 arena 前面，默认启用 **线程缓存**（tcache）。默认的 `opt.tcache_max` 是 32 KiB——比 glibc 的 tcache 大得多——并且最高可以调到 8 MiB。

未使用的页不会一次性还给操作系统，而是会衰减。`opt.dirty_decay_ms` 表示从一组未使用的脏页出现，到同等数量的脏页被清理掉——如果操作系统支持，就用 `madvise(..., MADV_FREE)` 变成 “muzzy”，否则变成 clean——大约要经过的时间，默认是 10 秒。衰减时间为 0 表示立刻清理；为 `-1` 则禁用清理。`opt.muzzy_decay_ms` 再控制 muzzy 页在被彻底归还之前会停留多久。这就是 jemalloc 对 RSS 问题的回答：让最近释放的页留得够久以便复用，然后沿着一条曲线还回去，而不是在下一次 `free` 时立刻归还。

## 8. tcmalloc：per-CPU 缓存与可重启序列

Google 的 [tcmalloc](https://google.github.io/tcmalloc/design.html) 是 Go 最初借鉴的设计，而现在的这套库还在继续演进。公开的设计把分配器拆成 **前端**（为应用程序服务的缓存）、**中端**（`CentralFreeList` 与 `TransferCache`，按批给前端补充）和 **后端**（`PageHeap`，与操作系统打交道）。小对象作为大小类走前端；大于 `kMaxSize` 的对象直接去页堆，并且不会被缓存。

最初的前端是按线程的，这也是 Thread-Caching Malloc 这个名字的来历。设计文档对后来出问题的原因写得很直白：内存占用会随线程数上升，而现代应用程序的线程可以多到让这些缓存要么合计非常大，要么每条线程都小得可怜。当前的默认是 **per-CPU 模式**。每个逻辑 CPU——在 x86 上就是一个超线程——都有一块存放元数据和各大小类空闲对象指针的 slab。每个 CPU 能缓存的内存量由 `MallocExtension::SetMaxPerCpuCacheSize` 限制，因此总缓存随活跃 CPU 数扩展，而不是随线程数扩展。

让 per-CPU 缓存在不加锁的情况下仍然安全的办法，是 **可重启序列**（restartable sequence，`rseq(2)`）。可重启序列是一段短指令，不允许留下部分更新；如果线程在序列执行到一半时被迁移或抢占，内核会从开头重新执行。tcmalloc 用它在当前 CPU 的数组上压入或弹出一个指针。要么这次更新在那颗 CPU 上完整完成，要么序列被重启；成功路径上不需要锁，也不需要原子操作。

## 9. mimalloc：分片的空闲链表

微软研究院的 [mimalloc](https://microsoft.github.io/mimalloc/) 围绕一个被作者称为 **空闲链表分片**（free list sharding）的想法构建。一个 mimalloc 页里只放一个大小类的块，在 64 位系统上通常是 64 KiB。它不是为每个类维护一条很大的空闲链表，而是让每个页都有自己的链表，这样在时间上邻近分配的对象，在内存里也往往邻近，并且空页可以被及时发现、积极地还给操作系统。

项目自己的描述里，所谓 “big idea” 是 **多重分片**：每个页既有一条线程本地的空闲链表，也有一条并发空闲链表。来自其他线程的释放，只是一次指向并发链表的比较并交换，不需要双方协同交接。争用被分散到成千上万条链表上，而不是集中在一把中心锁上。公开设计声称最坏分配时间有上界（直到操作系统原语为止），元数据开销大约 0.2%，并且内部没有必须用超过原子操作才能应对的争用点。

mimalloc 还把 **heap** 当作一等对象：一块 heap 可以一次性销毁，而不必逐个释放对象，也就是把 arena 模式做成了库功能。第 3 版是目前推荐的产品线；它简化了更早的无锁设计，更积极地在线程之间共享内存，也是 CPython 自由线程构建用来分配 Python 对象的那个版本。

## 10. 何时通用分配器并不是合适的工具

上面讲的都是一个 **共享的** 分配器：它必须在进程的一生中，从许多线程上，服务于事先不知道的尺寸组合。很多程序面对的问题更窄，更窄的分配器会赢。

- **Arena（碰撞分配器）。** 如果一大组对象会在同一时刻死去——一次请求、一次解析、一步模拟——你可以在一大块内存里向前推进指针，并在最后一次性释放整块。没有按对象的释放，没有大小类，也没有需要调节的缓存。代价是不能更早地复用单个对象，并且必须保证在 arena 被重置之后，不再持有指向其中的指针。
- **固定大小的池。** 如果你永远只分配一种尺寸，你就可以做单个大小类已经在做的事，而不需要整套层次，而且往往可以放在预先留好的一块内存上。
- **根本不分配。** 在 Go 里，逃逸分析仍然是最便宜的分配器：一个永不离开栈的值不是堆对象，不属于某个大小类，也不是 GC 根。Go 1.27 的特化 malloc 路径只会让那些确实逃逸的值更便宜；它不会改变哪些值会逃逸。

当你无法做出这些更窄的承诺时，本文里的缓存和大小类是合适的默认选择。当你能做出这些承诺时，它们就不再是。

下面这些实践说明来自设计本身，而不是传闻。如果一阵分配之后 RSS 仍然很高，先看缓存和清理策略，再假设是泄漏：jemalloc 的脏页衰减默认是 10 秒，glibc 的 tcache 每个 bin 持有 16 个块，而一个有几百条线程的进程里，每线程缓存加在一起可能看起来像泄漏，直到你量清楚这些字节属于哪一层缓存。如果两条线程把热点对象存得太近、共享了同一缓存行，jemalloc 自己的手册也警告过紧密排布可能导致缓存行共享，并建议向上取整到缓存行的倍数，或在分配时请求缓存行对齐。如果在 Go 里，分析器把开销指到 `mallocgc`，而且对象又小、尺寸在编译期就已知，那么 Go 1.27 的特化路径正是冲着这种情况去的；如果指出的是只有运行时才知道大小的分配，编译器就无法发出直接调用，更大的收益仍然是减少堆对象的数量。

## 11. 一个可运行模型

下面的脚本就是本节所有数字的来源。它不是 glibc、jemalloc、tcmalloc、mimalloc 或 Go 运行时的墙钟时间对比。它在一组固定的策略下统计发放的字节、预留的页、链表遍历次数、span 命中次数和锁获取次数。这些策略包括：Go 公布的大小类表、jemalloc 公布的直到 32 KiB 的大小类、按 2 的幂取整、带 8 字节头部且会合并相邻块的首次适配链表、单一大小类的 8 KiB 页、带有 Go 那种对齐抬升的 16 字节微型打包器，以及位于中心链表和页堆之前的 per-P 当前 span 缓存。

取整和隔离两组运行已在第 2、3 节讨论，微型打包那一组在第 5 节。最后一组是缓存层次的计数。八个处理器对 16、24、32、48、64、80 和 96 字节的对象做 40,000 次操作（大约 60% 是分配，其余是释放该处理器上一个仍存活的对象）。一侧为每个处理器的每个类保存一个当前 span，从中心链表补充，只在中心链表为空时才从页堆取一个 8 KiB 页。另一侧为每个类使用一条加锁的空闲链表，因此每次分配和每次释放都会获取那把锁。

| 分配器 | 分配次数 | 命中或加锁行为 | 预留的页 |
| --- | ---: | --- | ---: |
| per-P 当前 span | 23,975 | 98.7% 的 span 命中；300 次补充；72 次从页堆取页；每次分配 0.013 次中心锁 | 72 页（589,824 字节） |
| 加锁空闲链表 | 23,975 | 40,000 次加锁（每次分配 1.668 次） | 53 页（434,176 字节） |

有三件事很突出。

第一，**本地 span 吃掉了几乎每一次分配**。98.7% 的命中率意味着当前 span 里还有空槽。只有这 300 次补充会付一次中心锁的代价，而且其中 228 次是由一段后来又被释放、送回中心链表的 span 满足的。只有 72 次是页堆新发出一页。

第二，**加锁链表在每一次操作上都会加锁**，而不仅仅是每一次分配。16,025 次释放加上 23,975 次分配，是 40,000 次加锁，也就是每次分配 1.668 次锁。这正是缓存层次存在要避免的成本，也是为什么“只用一条空闲链表”并不是多线程分配器的完整设计。

第三，**缓存会占用更多内存**。72 页对 53 页，就是让八个处理器各自持有每个热类的当前 span，再加上中心链表里那些只是部分空闲的 span 的代价。这个差别不是泄漏；它就是 jemalloc 手册对 tcache 和 arena 陈述的同一项取舍，也是把 tcmalloc 从每线程缓存推向带有明确 per-CPU 字节预算的 per-CPU 缓存的那项取舍。

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

## 小结

- 现代分配器从 **大小类** 发放小对象：请求被取整到某个类，一页等大的槽位用空闲位图或空闲链表管理。取整会浪费几个字节，换来快路径上不必搜索、拆分或合并。对 1 到 32,768 字节的每一种大小，Go 公布的表比请求多发放了 5.34%；jemalloc 公布的大小类多发放了 8.33%；按 2 的幂取整多发放了 33.33%。
- 空闲槽属于它自己的类。在模型里，2,000 个已释放的 24 字节对象，无法从同一组页里满足哪怕一次 32 字节请求；会合并的首次适配链表从同一块预留里满足了 2,000 次里的 1,702 次。空页必须先回到页堆（或操作系统），这块内存才能被重新切开。
- **本地缓存**——Go 里按 P，jemalloc 和 glibc 里按线程，现代 tcmalloc 里按 CPU——让常见分配不必加锁。中心结构按 span 或按批给它补充。在模型里，per-P 当前 span 命中了 98.7% 的分配，每次分配只付 0.013 次中心锁，代价是 72 页而不是 53 页。
- Go 的分配器最初基于 tcmalloc。小对象走 `mcache` → `mcentral` → `mheap`；大对象直接到 `mheap`。小于 16 字节的无指针分配，由微型分配器打进 16 字节的块。Go 1.27 为不超过 80 字节的对象增加了按大小特化的分配函数，把其中一些分配的成本最多降低 30%，并使二进制大约增大 60 KB。
- glibc 至今会合并相邻块，并且不按 2 的幂取整；它的每线程缓存默认在 64 位系统上每种大小最多 16 个、每个不超过 1,032 字节的块。jemalloc 每翻一倍设置四个大小类，默认每颗 CPU 四个 arena，tcache 为 32 KiB，脏页衰减为 10 秒。tcmalloc 把前端缓存从线程改到了 CPU，并用可重启序列更新它。mimalloc 按页对空闲链表分片，再分成线程本地链表和并发链表，因此来自其他线程的释放只是一次比较并交换。
- 当一组对象会一同死去时，arena 或固定大小的池是比通用分配器更好的工具。当一个值根本不必成为堆对象时，不分配仍然比更快的 `malloc` 更便宜。

## 参考资料

- The Go Programming Language, [`src/runtime/malloc.go`](https://go.dev/src/runtime/malloc.go)（分配器概述、层次、arena 大小、微型分配器注释）
- The Go Programming Language, [`src/internal/runtime/gc/sizeclasses.go`](https://go.dev/src/internal/runtime/gc/sizeclasses.go)（67 个大小类，`MaxSmallSize = 32768`，`NumSizeClasses = 68`，`TinySize = 16`，`PageShift = 13`）
- The Go Programming Language, [`src/runtime/mcache.go`](https://go.dev/src/runtime/mcache.go) 与 [`src/runtime/mcentral.go`](https://go.dev/src/runtime/mcentral.go)
- Michael Matloob, [Size-Specialized Memory Allocation](https://go.dev/blog/size-specialized-allocations)，2026 年 9 月 16 日
- The Go Programming Language, [Go 1.27 Release Notes](https://go.dev/doc/go1.27)（更快的内存分配，`GOEXPERIMENT=nosizespecializedmalloc`）
- The GNU C Library, [The GNU Allocator](https://sourceware.org/glibc/manual/latest/html_node/The-GNU-Allocator.html)
- The GNU C Library, [Memory Allocation Tunables](https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html)（`tcache_max`、`tcache_count`、`mmap_threshold`，以及 fastbins 的移除）
- jemalloc, [jemalloc(3)](https://jemalloc.net/jemalloc.3.html)（大小类表、arena、tcache、脏页与 muzzy 衰减）
- Jason Evans, [A Scalable Concurrent malloc(3) Implementation for FreeBSD](https://papers.freebsd.org/2006/bsdcan/evans-jemalloc/)，BSDCan 2006
- Google, [tcmalloc Design](https://google.github.io/tcmalloc/design.html)（前端、中端、后端，per-CPU 缓存，可重启序列）
- Daan Leijen、Ben Zorn 与 Leonardo de Moura, [Mimalloc: Free List Sharding in Action](https://www.microsoft.com/en-us/research/publication/mimalloc-free-list-sharding-in-action/)，Microsoft Research MSR-TR-2019-18，2019 年 6 月
- mimalloc, [项目文档](https://microsoft.github.io/mimalloc/)（空闲链表分片、多重分片、一等 heap、v3）
