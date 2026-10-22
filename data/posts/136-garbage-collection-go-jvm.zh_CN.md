---
title: "深入垃圾回收器：三色标记、写屏障，以及 Go 与 JVM 的不同取舍"
tag: performance
description: 现代追踪式垃圾回收器到底如何工作——可达性、标记清除与复制/整理、三色抽象及其不变式、Dijkstra 与 Yuasa 写屏障、Go 的混合写屏障、Pacer、GOGC 与 GOMEMLIMIT，JVM 的 G1 与 ZGC（记忆集、SATB、染色指针），逃逸分析，以及生产环境中诊断和调优 GC 的实用指南
date: "2026-10-22T11:10:00.000Z"
---

## 目标

"GC 太慢了"是后端工程里最常见、也最含糊的抱怨之一。它有时指停顿太长，有时指四分之一的 CPU 花在标记上，有时指容器因超出内存限制被杀掉。这些是不同的问题、需要不同的解法，而如果脑子里没有一个回收器如何工作的模型，你根本分不清它们。

本文从零搭建这个模型：先讲基础算法（引用计数、标记清除、复制、整理），再讲让**并发**回收成为可能的三色抽象，以及在程序持续修改堆的同时保证正确性的写屏障。有了这些基础，再看两个做出截然不同选择的生产级设计——Go 的不移动对象的并发回收器，和 JVM 基于 Region 的 G1 与 ZGC——最后给出在真实服务中度量和调优 GC 的实用方法。

## 回收器要回答的问题

一个对象只要程序还能访问到，就是**存活**的。可达性从一组**根**（全局变量、线程栈、CPU 寄存器）出发，沿指针传播；从根出发访问不到的一切都是垃圾。所有回收器设计都在回答四个问题：

1. **怎么找到垃圾？** 计数引用，或者从根开始追踪。
2. **空闲空间怎么处理？** 对象留在原地、记录空洞（清除），或者把存活对象挪到一起（复制/整理）。
3. **程序什么时候停下来？** 回收期间全程停止（Stop-The-World，STW）、只短暂停顿（并发）、或分小步进行（增量）。
4. **是否按对象年龄区别对待？** 分代或不分代。

你始终在三者间权衡：**吞吐量**（留给业务代码的 CPU 比例）、**延迟**（停顿多长、多频繁）和**内存占用**（回收器高效工作需要的额外堆空间）。没有哪种设计三项全优，这有时被称为 GC 的"不可能三角"。

## 基础算法

### 引用计数

每个对象带一个计数器：复制指针加一，覆盖指针减一，归零即释放。CPython、Swift（ARC）、Objective-C 以及 Rust 的 `Rc`/`Arc` 都是这么做的。

好处是及时、可预测：最后一个引用消失的瞬间内存就回来了，没有全局停顿。代价是每次指针写都要更新计数（多线程下需要原子操作，很贵），以及**循环引用**：互相指向的两个对象永远不会归零。CPython 额外配了一个检测循环的回收器；Swift 则要求你自己用 `weak`/`unowned` 打破循环。

### 标记-清除

追踪式回收器在指针写入时什么都不做。运行时，它先**标记**从根可达的所有对象，再**清除**整个堆，把未标记对象归还空闲链表。对象从不移动，指针始终有效，与 C 互操作很容易。缺点是**碎片化**：多轮之后空闲空间散落成许多空洞，分配时要在按大小分级的空闲链表里查找，而不能简单地移动一个指针。

### 复制与整理

复制式回收器把内存一分为二，从"from 空间"追踪存活对象并连续拷贝到"to 空间"，然后整体丢弃 from 空间。分配变成指针碰撞（bump pointer），开销与**存活**数据量成正比而非堆大小，碎片也消失了。代价是对象会移动——所有指向它的指针都要更新——朴素版本还会闲置一半内存。标记-整理在原地达到同样的紧凑效果，代价是多遍扫描堆。

### 分代

**弱分代假说**认为：大多数对象朝生夕死。分代回收器据此把新对象分配到一个小的年轻代，用复制算法频繁回收；因为其中大部分已死，拷贝少量幸存者很便宜。经过几次年轻代回收仍存活的对象晋升到老年代，老年代很少回收。

麻烦在于老对象指向年轻对象的指针。年轻代回收必须把它们当作根，但为了找它们而扫描整个老年代就失去了意义。于是运行时会插入**写屏障**，把老→新的指针写入记录在**卡表**或**记忆集（Remembered Set）**里。写屏障是贯穿本文的主线。

## 并发标记与三色抽象

STW 追踪一个 30 GB 的堆要好几秒。为避免这种停顿，现代回收器在应用线程（GC 文献中称为 *mutator*，赋值器）继续运行的同时**并发**标记。为了论证正确性，Dijkstra 等人在 1978 年提出了三色抽象：

- **白色**：尚未访问。标记结束时仍为白色的对象就是垃圾。
- **灰色**：已知可达，但其指出的指针还没扫描。灰色集合就是工作队列。
- **黑色**：可达且已扫描完毕。

标记从把根染灰开始，反复取出一个灰色对象、把它的白色子对象染灰、再把它染黑，直到没有灰色对象。

```go
// 一个玩具版三色标记器（STW 版本）
type Object struct {
    marked bool
    refs   []*Object
}

func mark(roots []*Object) {
    grey := append([]*Object(nil), roots...)
    for _, r := range roots {
        r.marked = true
    }
    for len(grey) > 0 {
        obj := grey[len(grey)-1]
        grey = grey[:len(grey)-1]       // obj 变黑
        for _, child := range obj.refs {
            if child != nil && !child.marked {
                child.marked = true      // 白 -> 灰
                grey = append(grey, child)
            }
        }
    }
}
```

### 并发如何破坏它

现在让赋值器在标记期间运行。一个对象被错误回收，当且仅当以下**两件事同时发生**：

1. 赋值器把指向白色对象的指针存进了黑色对象（黑色对象不会再被扫描，回收器看不到这条边）。
2. 从所有灰色对象到该白色对象的其他路径都被破坏。

具体来说：黑色的 `A` 已扫描完，灰色的 `B` 指向白色的 `C`。赋值器执行 `A.f = C`，然后 `B.g = nil`。现在 `C` 只能通过 `A` 访问，而回收器认为 `A` 已经处理完了。`C` 保持白色并被清除——在一门内存安全的语言里出现了 use-after-free。

由此得到两个不变式，满足其一即可保证正确：

- **强三色不变式**：黑色对象永远不指向白色对象。
- **弱三色不变式**：被黑色对象指向的白色对象，必须还能从某个灰色对象经由一条白色对象链到达。

### 写屏障

写屏障是标记期间编译器在指针写入处插入的一小段代码。两种经典设计分别破坏上面两个条件之一：

```text
// Dijkstra 插入屏障（1978）：维持强不变式
writePointer(slot, ptr):
    shade(ptr)          // 新目标不可能以白色躲在黑色对象后面
    *slot = ptr

// Yuasa 删除屏障（1990）："起始快照"（SATB）
writePointer(slot, ptr):
    shade(*slot)        // 保住旧目标，任何路径都不会丢失
    *slot = ptr
```

`shade` 的意思是"如果是白色就染灰"。Dijkstra 屏障很精确——只保留真正可达的对象——但栈通常不加屏障（每次局部变量写都走屏障太慢），栈可能变"黑"后又指向白色对象，所以标记结束时必须 STW **重新扫描栈**。Yuasa 屏障保留标记开始时可达的一切（即快照），不需要重扫，但会留下更多**浮动垃圾**：在本轮期间死亡的对象要等到下一轮才回收。

对移动式回收器还有一个对称概念：**读屏障**（或加载屏障），在指针*读取*时执行，确保赋值器永远看不到已被搬走对象的旧地址。后面讲 ZGC 时会看到。

## Go：并发、不移动、延迟优先

Go 的回收器是并发的三色标记-清除回收器，**不分代**、**不移动对象**（不整理）。这些选择乍看令人意外，但结合语言其他部分就说得通了：Go 有值类型、内部指针，以及会做逃逸分析的编译器，大量短命值留在栈上，促使分代 GC 出现的"年轻对象压力"比 Java 低得多。不移动对象也让 cgo 互操作和运行时更简单。

### 一个 GC 周期

Go 的一轮 GC 分四个阶段：

1. **清除终止**（短暂 STW）：完成剩余清除工作，然后开启写屏障。
2. **并发标记**：后台 worker 占用约 25% 的 `GOMAXPROCS` 扫描根和堆。标记期间分配内存的 goroutine 会被征召做**标记辅助（mark assist）**——必须按自己的分配量承担相应的标记工作，防止分配过快的程序跑赢回收器。
3. **标记终止**（短暂 STW）：清空剩余工作，关闭写屏障。
4. **并发清除**：span 在后台以及分配需要空间时被惰性清除。

### 混合写屏障

Go 1.8 之前使用 Dijkstra 风格屏障，并在标记终止时付出重扫栈的代价；goroutine 很多的程序会出现几十毫秒的停顿。提案 17503（Austin Clements 与 Rick Hudson）引入了结合 Yuasa 与 Dijkstra 的**混合写屏障**：

```text
writePointer(slot, ptr):
    shade(*slot)                     // Yuasa：保护被删除的引用
    if 当前栈是灰色:
        shade(ptr)                   // Dijkstra：保护新插入的引用
    *slot = ptr
```

配合"每个 goroutine 栈只扫描一次并直接染黑"，栈重扫被彻底消除，典型的 STW 停顿降到远低于 1 毫秒。（实际实现无条件地对两个指针都着色，因为跟踪栈颜色比多着色一次更贵。）

### 何时启动一轮？GOGC、Pacer 与 GOMEMLIMIT

Go 基本只有两个旋钮。

**GOGC**（默认 `100`）设定堆增长目标：下一轮应在堆达到 `存活堆 + (存活堆 + GC 根) × GOGC/100` 时完成。存活数据 1 GB、默认配置下，回收器的目标大约是 2 GB 时完成。把 `GOGC` 翻倍，GC 的 CPU 开销大致减半，代价是更多内存——这是吞吐量与内存占用最纯粹的交换。从 Go 1.18 起，Pacer 也把 goroutine 栈和全局变量计入工作量。

**Pacer** 根据前几轮观测到的分配速度和标记速度，决定何时*开始*标记，使其恰好在目标处完成。

**GOMEMLIMIT**（Go 1.19+）是软内存上限。当运行时总内存接近它时，无论 `GOGC` 如何，回收器都会更频繁地运行。它解决了经典的容器问题：只有 `GOGC` 时，一次堆尖峰就可能让内存翻倍、进程被 OOM Kill。常见的生产配置是：

```bash
# 让堆用满容器的大部分空间：空间充裕时少回收，接近上限时才加力
GOMEMLIMIT=3600MiB GOGC=200 ./server        # 4 GiB 容器
# 如果服务本身就是内存受限型：
GOMEMLIMIT=3600MiB GOGC=off ./server
```

`GOGC=off` 加上限很强大但也锋利：如果存活堆本身逼近上限，运行时会持续不断地回收——GC CPU 的**死亡螺旋**。运行时在内存上限下会把 GC CPU 限制在约 50%，保证程序还能推进，但你仍应留出余量并设置告警。

在 `GOMEMLIMIT` 出现之前，团队会用各种技巧：Twitch 介绍过"内存压舱石（memory ballast）"——分配一块不使用的大内存来抬高堆目标，从而减少 GC 次数；Uber 介绍过按服务动态调节 `GOGC`。如今这些变通基本都过时了。

另一个历史坑：即使堆没有增长，运行时也至少每两分钟强制 GC 一次。Discord 2020 年那篇把 "Read States" 服务从 Go 迁到 Rust 的文章，把周期性延迟尖刺归因于此——再加上一个巨大的、几乎不变的 LRU 缓存，每次强制回收都得扫描它。

### Green Tea：让标记对内存更友好

经典的图标记在整个堆上从一个对象跳到另一个对象，对 CPU 缓存和内存带宽极不友好。Go 的 **Green Tea** 回收器在 Go 1.25 中作为实验特性出现，并在 Go 1.26 中默认启用。它把工作单位从单个对象改为整个内存页（小对象的 span）：按 span 累积待标记的工作并批量扫描，局部性好得多。Go 团队报告称，对 GC 密集型程序，GC 开销降低了 10%–40%，并且在开始利用向量指令后还有更大提升空间。这很好地说明了：在现代硬件上，内存访问模式往往比算法复杂度更重要。

### 逃逸分析：最便宜的垃圾是从未产生的垃圾

Go 编译器会判断每个值能否放在栈上（函数返回时免费释放），还是必须"逃逸"到堆上。你可以直接问它：

```go
package main

type Point struct{ X, Y int }

func sum(p Point) int  { return p.X + p.Y }  // 值传递：留在栈上
func newPoint() *Point { return &Point{1, 2} } // 指针比栈帧活得久：逃逸

func main() {
    _ = sum(Point{1, 2})
    _ = newPoint()
}
```

```bash
$ go build -gcflags=-m .
./main.go:6:25: &Point{...} escapes to heap
```

常见的逃逸原因有：返回指针、把值存入接口（`fmt.Println(x)` 会把 `x` 装箱）、闭包捕获变量、编译期大小未知的切片。减少分配——大块可复用缓冲用 `sync.Pool`、切片和 map 预分配容量、热路径上避免接口装箱——通常比任何 GC 参数都管用。

## JVM：分代、移动、可配置

HotSpot JVM 走了另一条路：对象密集的 Java 代码（历史上没有值类型，一切都装箱成堆对象）非常符合分代假说，而移动式回收器带来了快速的指针碰撞分配且没有碎片。HotSpot 提供多种回收器，主要有：

| 回收器 | 模型 | 停顿 | 适用场景 |
| --- | --- | --- | --- |
| Serial | 单线程、分代、STW | 长 | 小堆、单核容器 |
| Parallel | 多线程、分代、STW | 长但高效 | 批处理、追求极致吞吐 |
| G1 | 基于 Region、分代、大部分并发 | 以目标为准（默认 200 ms） | JDK 9 起的通用默认 |
| ZGC | 并发、基于 Region、整理，JDK 21 起支持分代 | 通常低于 1 ms | 大堆、延迟敏感服务 |
| Shenandoah | 并发整理（OpenJDK 构建中提供，并非所有发行版） | 低 | 与 ZGC 类似 |

### G1：Region、记忆集与停顿目标

G1（Garbage-First，JEP 248 使其自 JDK 9 起成为默认）把堆切分成大小相等的 **Region**（1–32 MB），动态标记为 Eden、Survivor、Old 或 Humongous。年轻代回收在 STW 停顿中把 Eden 和 Survivor 里的存活对象疏散（复制）出去。老年代标记并发进行，使用 **SATB**（起始快照）屏障——也就是上文的 Yuasa 设计。标记完成后，**混合回收（Mixed GC）**会疏散年轻代 Region 以及垃圾最多的老年代 Region：这就是"垃圾优先"。

G1 控制停顿的关键在于：它可以选择一次停顿里疏散*多少*个 Region，以满足 `-XX:MaxGCPauseMillis`。为了在不扫描全堆的情况下疏散某个 Region，每个 Region 维护一个记录跨 Region 入向指针的**记忆集**，由弄脏卡片的后置写屏障维护。所以 G1 的一次指针写会带两个屏障：标记期间的 SATB 前置屏障，以及始终存在的卡片标记后置屏障。这些屏障和记忆集簿记，就是低停顿所付出的吞吐代价的一部分。

### ZGC：染色指针与加载屏障

ZGC 的目标是让停顿不随堆大小或存活集大小增长。它**并发地标记和搬迁**对象，这意味着应用可能读到一个正在被移动的对象的指针。ZGC 用**染色指针**（把元数据位存进 64 位指针里）加上每次引用读取时的**加载屏障**来处理：

```text
// ZGC 加载屏障（概念示意）
ref = *field
if ref 的颜色对当前阶段是"坏"的:   // 快路径：一次位检查 + 分支
    ref = slow_path(ref)        // 标记它，或查找/执行搬迁
    *field = ref                // 自愈：下次读取直接走快路径
use(ref)
```

由于屏障会修复字段，每个过期指针在每个阶段最多走一次慢路径。STW 停顿只处理根和阶段切换，在从几百 MB 到数 TB 的堆上通常远低于 1 毫秒。ZGC 在 JDK 15 达到生产可用（JEP 377）；**分代 ZGC** 在 JDK 21 引入（JEP 439），JDK 23 成为 ZGC 的默认模式（JEP 474），JDK 24 移除了非分代模式（JEP 490）。引入分代主要是为了吞吐量和内存：原先单代的 ZGC 需要大量余量才能跟上高分配速率。

它的开销画像与 G1 互为镜像：几乎没有停顿，但读取（远比写入频繁）上有屏障，更多并发 GC 线程与业务争抢 CPU，原始吞吐量略低。

## Go 与 JVM：同一个问题，不同的赌注

| 方面 | Go | JVM（G1 / ZGC） |
| --- | --- | --- |
| 分代 | 否 | 是（ZGC 自 JDK 21） |
| 移动对象 | 否 | 是（疏散 / 并发搬迁） |
| 屏障 | 混合写屏障，仅标记期间开启 | G1：SATB 前置写 + 卡片后置写；ZGC：加载屏障 |
| 分配 | 按大小分级的空闲链表、每个 P 的缓存（`mcache`） | 线程本地指针碰撞缓冲（TLAB） |
| 碎片 | 可能出现，靠大小分级缓解 | 被整理消除 |
| 调优面 | `GOGC`、`GOMEMLIMIT` | 几十个参数；堆大小和回收器选择最关键 |
| 典型停顿 | 亚毫秒 | G1：几十到几百毫秒目标；ZGC：亚毫秒 |
| 理念 | 旋钮少、延迟稳定、依赖逃逸分析 | 按负载选择合适的回收器 |

两者没有绝对优劣。Go 押注编译器和值类型能把分配率压得足够低，让一个简单的不移动回收器够用，换来简单和可预测；JVM 押注精巧的运行时机制让大量分配变得廉价，并把控制权交给运维。两者也收敛到同一个认识：停顿问题已基本解决，剩下的前沿是 **CPU 与内存开销**——这正是 Go 投入 Green Tea、Java 投入分代 ZGC 的原因。

## 生产环境中的 GC 诊断

先给症状命名，因为每种症状的解法不同。

**1. GC 占用 CPU 过多。** 在 Go 中用 `GODEBUG=gctrace=1` 运行：

```text
gc 42 @12.031s 6%: 0.021+3.4+0.030 ms clock, 0.17+1.2/6.6/12+0.24 ms cpu, 412->420->205 MB, 418 MB goal, 0 MB stacks, 0 MB globals, 8 P
```

`6%` 是自启动以来 GC 的累计 CPU 占比；`412->420->205 MB` 分别是开始时的堆、结束时的堆和标记后的存活堆；三个 clock 数字依次是 STW 清除终止、并发标记、STW 标记终止的耗时。占比高而存活堆稳定，说明回收太频繁：内存允许就调高 `GOGC`，更好的做法是减少分配。用 `go tool pprof -alloc_space http://host/debug/pprof/heap` 找出分配热点。

Java 则开启统一 GC 日志：

```bash
java -Xlog:gc*:file=gc.log:time,uptime,level,tags -XX:+UseG1GC -Xms8g -Xmx8g -jar app.jar
```

关注停顿时间占比和并发周期频率。如果在 G1 中频繁出现 Full GC 或 "to-space exhausted"，说明对当前分配速率或存活集而言堆太小。

**2. 延迟尖刺。** 把 p99 延迟与 GC 事件对齐。在 Go 中，亚毫秒级的 STW 很少是元凶；更该看的是**标记辅助**——它会在一轮 GC 期间拖慢正在分配的 goroutine（可在 `go tool trace` 中看到），以及 GC worker 带来的调度干扰。在 Java 的 G1 上，年轻代停顿长通常意味着要复制的幸存者太多或记忆集太大；如果停顿占据了延迟预算的大头且 CPU 有余量，可以考虑 ZGC。

**3. 内存增长或被 OOM Kill。** 区分**存活堆**在增长（泄漏：无上限的缓存、泄漏的 goroutine 持有引用、从未移除的监听器）还是**堆目标**本身大（在当前 `GOGC` 下属正常行为）。在容器里，一定要设置 `GOMEMLIMIT`，Java 则显式设置 `-Xmx` 或 `-XX:MaxRAMPercentage`，并低于 cgroup 上限，给非堆内存留出空间（goroutine 栈、Metaspace、线程栈、直接缓冲区、cgo 分配）。

**4. 大而长寿的缓存。** 追踪式回收器每一轮都要扫描存活数据中的每个指针。一个装满富指针值的数 GB map 会让每次标记都很昂贵。可选方案：存储不含指针的值（Go 不会扫描无指针的 span——`map[uint64][32]byte` 的标记成本远低于 `map[string]*Item`）、把数据移到堆外（`mmap`、Java 的 `ByteBuffer.allocateDirect` 或 FFM API），或者使用外部缓存。

## 总结

每个垃圾回收器都是吞吐量、延迟和内存之间谈判出来的折中。从根追踪找到垃圾；三色不变式及维护它们的写屏障或读屏障让并发追踪变得安全；分代和整理以移动对象、维护记忆集为代价换来廉价分配。Go 选择了不移动、不分代、带混合写屏障的回收器和两个简单旋钮，依靠逃逸分析减少垃圾；JVM 选择了分代、移动式回收器，让你在 G1 的均衡停顿目标与 ZGC 近乎无停顿的并发搬迁之间取舍。实践中最大的收益很少来自参数：它来自更少的分配、为容器正确设定内存上限，以及在改动任何东西之前先用 `gctrace`、pprof 和 GC 日志测量。

## 参考资料

- E. W. Dijkstra, L. Lamport, A. J. Martin, C. S. Scholten, E. F. M. Steffens, "On-the-fly garbage collection: an exercise in cooperation", *Communications of the ACM* (1978)
- T. Yuasa, "Real-time garbage collection on general-purpose machines", *Journal of Systems and Software* (1990)
- Richard Jones, Antony Hosking, Eliot Moss, *The Garbage Collection Handbook*，第 2 版 (2023)
- Austin Clements, Rick Hudson, [Proposal: Eliminate STW stack re-scanning](https://github.com/golang/proposal/blob/master/design/17503-eliminate-rescan.md)（Go issue 17503）
- [A Guide to the Go Garbage Collector](https://go.dev/doc/gc-guide)——GOGC、GOMEMLIMIT 与 gctrace 的官方文档
- Go Blog, [The Green Tea Garbage Collector](https://go.dev/blog/greenteagc) (2025)
- Rick Hudson, [Getting to Go: The Journey of Go's Garbage Collector](https://go.dev/blog/ismmkeynote)（ISMM 2018 主题演讲）
- [JEP 248: Make G1 the Default Garbage Collector](https://openjdk.org/jeps/248)、[JEP 377: ZGC (Production)](https://openjdk.org/jeps/377)、[JEP 439: Generational ZGC](https://openjdk.org/jeps/439)、[JEP 474: ZGC: Generational Mode by Default](https://openjdk.org/jeps/474)、[JEP 490: ZGC: Remove the Non-Generational Mode](https://openjdk.org/jeps/490)
- Oracle, [HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/)
- Discord Engineering, [Why Discord is switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust) (2020)
- Twitch Engineering, [Go memory ballast: How I learnt to stop worrying and love the heap](https://blog.twitch.tv/en/2019/04/10/go-memory-ballast-how-i-learnt-to-stop-worrying-and-love-the-heap/) (2019)
