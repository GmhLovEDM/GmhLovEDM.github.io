---
title: "CPython 自由线程与无 GIL：偏向引用计数、永生对象、对象锁与扩展迁移"
tag: python
description: CPython 自由线程构建（PEP 703）如何去掉全局解释器锁——GIL 的历史与存在理由、偏向引用计数与永生对象、延迟与每线程引用计数、每对象互斥与临界区、与特化自适应解释器的关系、自由线程构建何时更优何时更差，以及 C 扩展的实用迁移要点
date: "2026-11-06T10:30:00.000Z"
---

## Goal

过去三十多年，CPython 的全局解释器锁（GIL）意味着一个进程里同一时刻只有一个线程能执行 Python 字节码。这一设计让解释器实现简单、引用计数便宜，但也让 CPU 密集的多线程几乎没有收益：线程越多，纯 Python 循环往往*更慢*而不是更快。

PEP 703（Making the Global Interpreter Lock Optional in CPython）以及 3.13 起实验性提供的自由线程（free-threaded）构建改变了这一契约。`--disable-gil` / 自由线程解释器可以让 Python 线程在多个核上真正并行——代价是更大的对象头、更谨慎的引用计数，以及对 C 扩展的新规则。

本文关注让自由线程变得可行的机制，而不是停留在「去掉 GIL」的口号：

1. GIL 为何存在，它到底串行化了什么。
2. 在启用 GIL 的 3.13 构建上实测 CPU 密集多线程。
3. 偏向引用计数（BRC）、永生对象、延迟与每线程引用计数。
4. 每对象锁、临界区与容器线程安全。
5. 自由线程与特化自适应解释器（PEP 659）的互动。
6. 自由线程何时赢、何时输，以及内存代价（mimalloc、QSBR）。
7. C 扩展迁移要点：`Py_mod_gil`、借用引用与临界区宏。
8. 团队落地自由线程 CPython 的实用决策清单。

主要来源：[PEP 703](https://peps.python.org/pep-0703/)、[PEP 683](https://peps.python.org/pep-0683/)（永生对象）、[PEP 659](https://peps.python.org/pep-0659/)（特化自适应解释器）、官方文档 [Python support for free threading](https://docs.python.org/3/howto/free-threading-python.html) 与 [C API Extension Support for Free Threading](https://docs.python.org/3/howto/free-threading-extensions.html)，以及 [py-free-threading.github.io](https://py-free-threading.github.io/tracking/) 与 [hugovk 的 free-threaded wheels 列表](https://hugovk.github.io/free-threaded-wheels/) 等跟踪站。

## 1. GIL 为何存在

CPython 的内存模型是引用计数加上循环垃圾回收。几乎每条触及 `PyObject*` 的字节码都会调整 `ob_refcnt`。在一把全局锁下，这些增减可以是普通的非原子读写，C 扩展作者也可以把「我持有 GIL」理解成「没有别的线程在改解释器」。

GIL 还掩盖了一长串共享结构：

- 小整数缓存与驻留字符串表
- 类型对象状态与方法解析相关簿记
- 与 import 相关的串行化以及模块字典
- 帧求值与 ceval 循环本身
- 无数把全局 C 指针裸放着、自己不加锁的扩展模块

历史上这是刻意的工程赌注。早期 CPython 跑在单处理器机器上；正确性与易用的 C API 比多核字节码更重要。其他运行时有过不同选择——Jython 与 IronPython 没有 GIL，因为它们坐在 JVM / CLR 的 GC 上；PyPy 尝试过 STM——但 CPython 的扩展生态体量巨大，任何去掉 GIL 的方案都必须让 `Py_INCREF` 形态的代码仍然可行。

GIL *并没有* 让 Python 在操作系统层面变成「单线程」。I/O 密集程序一直会在阻塞系统调用周围释放 GIL（`Py_BEGIN_ALLOW_THREADS` / `Py_END_ALLOW_THREADS`），所以大量等待套接字的服务仍能从线程中受益。做重计算的原生扩展也可以在内核期间释放 GIL。真正的痛点是 **CPU 密集** 的 Python：数值循环、解析器，以及用纯 Python 写的热路径业务逻辑——解释器几乎不会长时间放下锁让别的线程推进。

人们用了多年的两条出路：

| 途径 | 并行性 | 代价 |
|------|--------|------|
| `multiprocessing` | 真多进程 | pickle/IPC、内存翻倍 |
| 子解释器（PEP 684 时代） | 每解释器一把 GIL | 隔离限制、API 成熟度 |
| 自由线程构建（PEP 703） | 单进程内真多线程 | 引用计数/对象头/扩展改造 |

自由线程是第一条在 CPython 本体里同时保留共享内存线程 *与* 并行字节码的路径。

## 2. 实测：3.13 上受 GIL 束缚的 CPU 多线程

本机解释器是普通（启用 GIL）的 CPython 3.13.5：`sysconfig.get_config_var("Py_GIL_DISABLED")` 为 `0`，`sys._is_gil_enabled()` 返回 `True`。下面的片段测量纯 Python CPU 循环在 1、2、4 个线程下的耗时：

```python
import sys, sysconfig, threading, time

print(sys.version.split()[0])
print("Py_GIL_DISABLED:", sysconfig.get_config_var("Py_GIL_DISABLED"))
print("_is_gil_enabled:", sys._is_gil_enabled())

def cpu_bound(n=3_000_000):
    s = 0
    for i in range(n):
        s += i * i
    return s

def timed(n_threads):
    threads = [threading.Thread(target=cpu_bound) for _ in range(n_threads)]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return time.perf_counter() - t0

for n in (1, 2, 4):
    print(f"threads={n} elapsed={timed(n):.3f}s")
```

在本机（Asia/Shanghai，启用 GIL 的 3.13.5）观察到：

| 线程数 | 耗时 | 约相对 1 线程 |
|------:|-----:|-------------:|
| 1 | 0.084 s | 1.0× |
| 2 | 0.171 s | 2.0× |
| 4 | 0.345 s | 4.1× |

墙钟时间几乎随线程数线性上升。这是教科书式的 GIL 结果：线程轮流使用大约一个核的字节码额度，调度开销还会让 4 线程略差于干净的 4 倍。同样负载在自由线程构建上，才是并行加速真正出现的地方——前提是工作本身可并行，且没有被共享的 Python 对象重新串行化。

如何识别自由线程解释器：

- `python -VV` / `sys.version` 含有 `free-threading build`
- `sysconfig.get_config_var("Py_GIL_DISABLED") == 1`
- 若运行时 GIL 被重新打开（`PYTHON_GIL`、`-X gil`，或未标记扩展的 import），`sys._is_gil_enabled()` 仍可能返回 `True`

最后一点在生产中很重要：「我安装了自由线程二进制」不等于「此刻 GIL 是关着的」。

## 3. 偏向引用计数

去掉 GIL 却不改引用计数，会迫使每次 `Py_INCREF` / `Py_DECREF` 都走原子读改写。在当代 CPU 上，多核争用同一缓存行时原子操作很贵——而热点对象（驻留字符串、小整数、广泛共享的模块）会变成扩展性瓶颈。

PEP 703 采用 **偏向引用计数**（biased reference counting, BRC），这是 Jiho Choi、Thomas Shull 与 Josep Torrellas 在 2018 年提出的技术。观察是：即便在多线程程序里，大多数对象也只被一个线程触及——通常是创建它的那个线程。

每个对象大致携带：

```c
struct _object {
    uintptr_t ob_tid;          /* 所有者线程 id；0 = 无主 */
    /* padding / flags ... */
    uint8_t  ob_mutex;         /* PyMutex 存储 */
    uint8_t  ob_gc_bits;
    uint32_t ob_ref_local;     /* 本地引用计数 + 永生/延迟标志 */
    Py_ssize_t ob_ref_shared;  /* 共享引用计数（移位）+ BRC 状态 */
    PyTypeObject *ob_type;
};
```

（具体布局对应 CPython 中自由线程 `PyObject` 相关工作，例如 [gh-110481](https://github.com/python/cpython/issues/110481)；字段宽度按 PEP 703 设计理解即可。）

所有者线程用普通非原子操作更新 `ob_ref_local`；其他线程用原子操作更新 `ob_ref_shared`。所有权可以移交；慢路径会合并计数，并可能把对象排入队列，稍后在 eval-breaker 处释放。

与「到处使用原子 `Py_ssize_t`」相比，BRC 让单线程与线程本地对象流量保持便宜——而这正是常见情形——同时在对象跨线程时仍保持正确。

### 永生对象

有些对象伴随整个进程：`None`、`True`、`False`、小整数、许多类型对象，以及（在自由线程构建中）驻留字符串与代码常量。每个线程都去改它们的引用计数只会制造争用、毫无收益。

PEP 683 在 3.12 引入了永生对象。自由线程构建延续这一思路：永生对象在 `ob_ref_local` 中设置哨兵值（概念上是 `UINT32_MAX`），对它们的 `Py_INCREF` / `Py_DECREF` 变成空操作。

据 3.14 文档，自由线程下的永生化至少覆盖：

- 代码常量（数值 / 字符串 / 由常量组成的元组）
- 经过 `sys.intern()` 的字符串

重要行为变化：在默认构建中，驻留字符串在最后一个引用消失后仍可回收；在自由线程构建中，驻留字符串会活到解释器关闭。这避免了引用计数流量，但如果程序对无界的唯一字符串做 intern，内存可能持续上涨。

### 延迟引用计数与每线程引用计数

还有两种技术用于削减跨线程引用计数流量：

1. **延迟引用计数（deferred）** — 用于模块、模块级函数、类作用域中定义的方法、描述符，以及 `threading.local` 对象。来自 Python 帧栈的引用*不*计入引用计数。内部计数归零后，对象在下一轮 GC 中检查，而不是立刻释放。
2. **每线程引用计数** — 用于堆类型（Python 中创建的类）、代码对象以及模块 `__dict__`。每个线程维护按对象 id 索引的本地计数数组；真实计数是求和。由于必须在安全点（eval breaker）或线程退出时合并，对象往往活得更久。`gc.collect()` 会强制合并。

相对默认构建的净效果：对象常常活得更久，峰值 RSS 更高，「引用计数归零 ⇒ 立刻释放」不再适用于每一种类型。

```text
默认构建:     INCREF/DECREF → 归零时常常立刻释放
自由线程:     本地快路径 | 共享原子 | 排队/延迟/GC
             永生空操作 | 安全点合并每线程计数
```

## 4. 每对象锁与临界区

没有 GIL 之后，内建容器仍需要互斥。自由线程构建里每个 `PyObject` 增加 `ob_mutex`（`PyMutex`）。CPython 的 **临界区（critical section）** API（`Py_BEGIN_CRITICAL_SECTION` / `Py_END_CRITICAL_SECTION`，以及双对象版本 `...CRITICAL_SECTION2`）是获取该互斥量的受支持方式。

临界区不是普通的互斥量作用域：

- 每个线程维护一栈活动临界区。
- 若获取锁会阻塞，线程会 **挂起** 其活动临界区（释放那些互斥量），等待后再重新获取——精神上类似阻塞调用周围释放 GIL。
- 因此嵌套临界区*不能*可靠地在整个内层区间持有外层锁；最多用 `CRITICAL_SECTION2` 同时锁两个对象，否则需要重构。
- **不要** 在同一对象上既用 raw `PyMutex_Lock` 锁 `ob_mutex`，又走临界区 API——可能死锁。需要自有锁的扩展类型应另加一个 `PyMutex` 字段。

在 Python 层面，`dict`、`list`、`set` 会加内部锁，使并发修改的行为更接近旧的 GIL 串行世界。文档仍建议对应用级不变量使用显式的 `threading.Lock`（或等价物）：内部锁保护的是容器自身一致性，而不是你的上层协议。

```c
/* 示意：迭代时锁住 dict */
Py_BEGIN_CRITICAL_SECTION(dict);
PyObject *key, *value;
Py_ssize_t pos = 0;
while (PyDict_Next(dict, &pos, &key, &value)) {
    /* 使用 key/value；仍是借用对——临界区保持短小 */
}
Py_END_CRITICAL_SECTION();
```

自由线程 howto 中的已知锋利边缘：

- 不要读取正在另一线程执行的帧的 `frame.f_locals`——可能导致解释器崩溃。
- 多线程共享同一迭代器可能看到重复或遗漏的元素。
- 容器可能被并发修改时，优先使用返回强引用的 C API（`PyList_GetItemRef`、`PyDict_GetItemRef`、`PyDict_GetItemStringRef`、`PyWeakref_GetRef` 等）。
- 元组不可变，因此 `PyTuple_GetItem()` 相对安全；list 与 dict 才是风险点。

## 5. 自由线程下的特化自适应解释器

PEP 659 的特化自适应解释器会把热点字节码改写成类型特化指令（例如假定某种对象形态的属性加载）。特化依赖 **稳定的反馈**：类型上的版本标签、字典键版本，以及「观察到的类型/形态足够长时间保持有效」这一假设。

在 GIL 下，「另一线程在指令中途改了类型」大体被构造排除。自由线程让该假设更难成立：

- 另一线程可能在特化指令执行期间修改类型、类字典或实例形态。
- 运行时必须更小心地使特化失效或加守卫；某些特化会更保守，或需要在过去由 GIL「免费」提供的场景下加锁 / 做版本检查。
- 去优化路径更重要：错误推测必须被检测，且反馈元数据本身不能出现数据竞争。
- 因此即便从不启动第二个线程，自由线程单线程运行也会付出开销：更大的对象头、所有权不对时的原子慢路径、用 mimalloc 替代 pymalloc，以及更严格的特化。

官方 howto 引用 pyperformance：自由线程相对默认构建的平均开销大约从 **macOS aarch64 上约 1%** 到 **x86-64 Linux 上约 8%**，随负载变化。这是你为「可选地跨核扩展」付出的税。

Faster CPython 工作（Mark Shannon 及其合作者）与自由线程努力因此是耦合的：同一个想要激进特化的解释器，也必须在线程竞态改形态时保持正确。可以预期 `--disable-gil` 构建里哪些 opcode 特化得多激进，会持续调优。

## 6. 内存子系统：mimalloc、QSBR、更大的对象头

自由线程改变的不只是引用计数。若干分配器层选择会体现为更高的 RSS：

1. **更大的对象头** — 非 GC 对象的 GC 元数据并入普通对象头。文档举例自由线程 AMD64 上 `None` 为 32 字节，默认构建为 16 字节。受 GC 管理的对象（dict、list）在两种构建间尺寸更接近。
2. **mimalloc 替代 pymalloc** — 自由线程构建用 mimalloc 分配 Python 对象，常常跨多个堆（例如 GC 对象专用堆）。一个堆里的空闲空间不能满足另一堆的分配；有些堆通过 QSBR 释放页。
3. **QSBR（基于静止状态的回收）** — 无锁结构（尤其是 list 内部与 dict keys）会推迟回收后备内存，直到线程进入静止状态。`gc.collect()` 应释放 QSBR 持有的内存，但分配器仍可能不立刻把页还给操作系统。`MIMALLOC_PURGE_DELAY=0` 可缩短该延迟，但可能影响性能。
4. **更长的对象寿命** — BRC 排队状态、延迟引用计数、每线程计数，以及永生的驻留字符串都会推迟释放。

这些是刻意取舍：先正确与可扩展，再调分配器。迁到自由线程构建的团队应同时做 RSS 基线，而不是只看墙钟吞吐。

## 7. 自由线程构建何时赢、何时输

**更适合自由线程的情况：**

- 瓶颈是已经（或可以）拆成多线程的 CPU 密集 Python。
- 线程之间共享的可变 Python 状态很少——消息传递、分片本地对象或不可变输入。
- 依赖的扩展模块声明了自由线程支持（`Py_MOD_GIL_NOT_USED`）并发布带 `t` 后缀的 wheel。
- 能接受更高内存占用，以换多核机器上更高的墙钟吞吐。

**更适合默认 GIL 构建的情况：**

- 负载基本是单线程或由一条热线程主导：你主要在付自由线程的税。
- 瓶颈已在会释放 GIL 的原生代码里（NumPy ufunc、压缩、密码学）——线程或许已经能重叠，自由线程收益有限。
- 关键扩展仍会在 import 时重新启用 GIL（未标记的扩展加载时，CPython 会告警并打开 GIL）。
- 内存紧张：更大的对象头、永生的驻留字符串、延迟释放、QSBR 推迟，以及 mimalloc 多堆，都会推高 RSS。

**并发模型提醒：** 自由线程去掉的是解释器锁，并不为你的程序发明内存模型。共享 `list`/`dict` 上的竞态、先检查再行动的漏洞、扩展全局状态仍然是你的问题——而且往往比在 GIL 下更*显眼*，因为以前它们是潜伏的。

自由线程构建里还会改变的行为默认值（据 howto）：

- `thread_inherit_context` 默认为 true — 新的 `threading.Thread` 会复制调用方的 contextvars `Context`
- `context_aware_warnings` 默认为 true — `warnings.catch_warnings` 使用上下文变量，而不是进程全局过滤器列表

## 8. C 扩展迁移要点

来自 C API 自由线程 howto 的高信号清单：

1. **声明支持**，否则会把 GIL 重新打开：
   - 多相初始化：加入 `{Py_mod_gil, Py_MOD_GIL_NOT_USED}`（若需兼容旧版本，用 `PY_VERSION_HEX >= 0x030D0000` 守卫）。
   - 单相初始化：在 `#ifdef Py_GIL_DISABLED` 下调用 `PyUnstable_Module_SetGIL(m, Py_MOD_GIL_NOT_USED)`。
2. **探测构建**：C 里用 `Py_GIL_DISABLED`，Python 里用 `sysconfig.get_config_var("Py_GIL_DISABLED")`。
3. **停止依赖** 可能被并发修改的容器上的借用引用——改用 `*Ref` API；字典可能变化时用 `Py_BEGIN_CRITICAL_SECTION` 包住 `PyDict_Next`。
4. **正确分配：** 只有 Python 对象走 object 分配域；原始缓冲区用 `PyMem_Malloc`，不要用 `PyObject_Malloc`。
5. **继续使用** `Py_BEGIN_ALLOW_THREADS` / 线程状态 API 包裹阻塞工作，以便在 GIL 禁用时循环 GC 与其他线程仍能运行。
6. **保护扩展全局状态** 用自有锁或线程局部存储；GIL 不再替你串行化它们。缓存是常见陷阱——加锁，或在自由线程下若非关键路径则禁用。
7. **为自由线程 CPython 单独构建 wheel**（`t` ABI 标签，例如 `cp314t`）。目前自由线程构建不支持 Limited C API / stable ABI。`cibuildwheel` / manylinux 文档中有 `python3.14t` 一类标签。
8. **若需要加锁，在类型上增加专用 `PyMutex`**；不要自己去驱动 `ob_mutex`。

多相 slot 示意：

```c
static struct PyModuleDef_Slot module_slots[] = {
    /* ... 其他 slot ... */
#if PY_VERSION_HEX >= 0x030D0000
    {Py_mod_gil, Py_MOD_GIL_NOT_USED},
#endif
    {0, NULL}
};
```

生态就绪情况可跟踪 [py-free-threading tracking](https://py-free-threading.github.io/tracking/) 与 [free-threaded wheels](https://hugovk.github.io/free-threaded-wheels/)。Meta、Faster CPython 与自由线程工作组的文章有助于理解路线图；落地时仍以你所发布版本对应的 PEP 与 howto 为准。

## 9. 落地清单

在把服务切到自由线程解释器之前：

1. 确认二进制是自由线程的，并且在真实 import 集合下 `sys._is_gil_enabled()` 为 false。
2. 清点原生依赖；未标记模块会默默撤销迁移。
3. 用 1 对 N 线程重新测量 CPU 密集路径；同时重测单线程延迟。
4. 在接近生产的抖动下观察 RSS 与分配器环境变量（`MIMALLOC_PURGE_DELAY`）。
5. 审计共享可变 Python 容器；在不变量重要处加显式锁。
6. 对自有扩展：声明 `Py_mod_gil`，替换借用引用热路径，必要时加临界区，发布 `t` wheel。
7. 在 CI 中保留 GIL 启用构建，使只在自由线程下出现的回归能以差异形式可见——但不要在应用代码里继续把 GIL 当成正确性拐杖。

## 实践要点

- GIL 曾是解释器与 C API 的生产力特性；自由线程用偏向引用计数、永生 / 延迟 / 每线程计数方案，以及每对象临界区来取代那把全局锁。
- 在启用 GIL 的 3.13.5 上，纯 Python CPU 循环对 1 / 2 / 4 线程呈现约 1× / 2× / 4× 墙钟时间——这正是自由线程要解决的问题。
- 单线程开销（pyperformance 上几个百分点，某些 x86-64 Linux 上更高）与更高内存占用是真实的；自由线程不是免费午餐。
- 内建对象的 Python 级线程安全因内部锁而改善，但应用不变量仍需显式同步。
- 扩展作者必须显式选择加入（`Py_mod_gil`）、清理不安全的借用引用模式，并发布带 `t` 标签的产物。
- 在依赖栈就绪、负载为可并行的 CPU 密集 Python 时选择自由线程；当单线程延迟、内存或未标记原生模块占主导时，保留默认构建。

自由线程把「线程帮不了 CPU 密集 Python」从一条定律变成一项工程选择——它奖励为对象并行所有权而设计的程序，惩罚把 GIL 当作唯一锁的程序。
