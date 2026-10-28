---
title: "深入 V8：隐藏类、内联缓存与 Ignition / Sparkplug / Maglev / TurboFan 执行管线"
tag: javascript
description: V8 如何让一门动态类型语言跑得飞快——形状（Map）与转换树、内联缓存的单态 / 多态 / 超多态状态、反馈向量、从 Ignition 解释器到 Sparkplug、Maglev、TurboFan 的四级执行层、推测优化与去优化、元素种类（elements kinds）、Smi 与指针压缩，以及由此得出的日常编码习惯
date: "2026-10-28T11:30:00.000Z"
---

## 目标

JavaScript 对象看起来就像哈希表：你可以随时添加、删除属性，甚至改变属性值的类型。如果引擎真的把每次 `obj.x` 都实现成一次哈希查找，把每个 `a + b` 都实现成完整的类型分派，JavaScript 会比现在慢一个数量级。V8（Chrome、Node.js、Deno、Electron 的引擎）的做法是：**在运行时观察程序实际在做什么，并推测它会继续这样做。**

本文拆解这套推测机制背后的组件：

1. **隐藏类**（V8 内部叫 *Map*），为动态对象提供静态布局。
2. **内联缓存**和**反馈向量**，记录每个操作见过哪些布局和类型。
3. **分级执行管线**——Ignition、Sparkplug、Maglev、TurboFan——代码越热，投入的编译成本越高。
4. **去优化（deoptimization）**，让推测在出错时依然正确的安全网。
5. **元素种类**、**Smi** 与**指针压缩**，它们解释了许多"莫名其妙"的性能悬崖。

下文内容依据 V8 公开的设计文档和官方博客（文末附链接）。V8 迭代很快，参数名和分级阈值在不同版本间会变化，请把具体细节当作设计说明，而非固定契约。

## 第一部分：隐藏类（Map）

### 问题

看这段代码：

```js
function Point(x, y) {
  this.x = x;
  this.y = y;
}
const p = new Point(1, 2);
```

朴素的引擎会把 `p` 存成字典 `{ "x": 1, "y": 2 }`。每次访问都要对字符串求哈希、探测哈希表、比较键名；而且每个 `Point` 都重复保存一遍键名。

### V8 的做法

V8 把对象拆成两部分：

- **对象本身**只保存*值*，放在固定槽位里（对象内属性，必要时还有一个溢出的 properties 后备存储）。
- 一个共享的 **Map**（隐藏类 / 形状）描述*布局*：有哪些属性名、各自在哪个槽位偏移、属性特性（可写、可枚举、可配置），以及被跟踪的字段表示形式。

布局相同的对象共享同一个 Map，因此键名只存一份。

Map 之间通过**转换树（transition tree）**相连。从空对象的 Map 出发，添加 `x` 会沿着（或新建）一条转换到达 Map `{x}`，再添加 `y` 则转换到 Map `{x, y}`：

```text
Map0 {}  --添加 "x"-->  Map1 {x@0}  --添加 "y"-->  Map2 {x@0, y@1}
                   \
                    --添加 "y"-->  Map3 {y@0}  --添加 "x"-->  Map4 {y@0, x@1}
```

由此直接得出两个结论：

- **属性顺序很重要。** `{x, y}` 和 `{y, x}` 键相同，却会落到不同的 Map 上。
- **在构造函数里按相同顺序初始化所有字段**，所有实例就会共享一个 Map。事后再添加属性，会把对象"分叉"到转换树的另一条分支上。

### 亲眼看看

Node 通过 `--allow-natives-syntax` 暴露 V8 内部函数：

```js
// node --allow-natives-syntax maps.js
function Point(x, y) { this.x = x; this.y = y; }

const a = new Point(1, 2);
const b = new Point(3, 4);
console.log(%HaveSameMap(a, b)); // true

b.z = 5;                          // b 迁移到新的 Map
console.log(%HaveSameMap(a, b)); // false

const c = { y: 1, x: 2 };
const d = { x: 1, y: 2 };
console.log(%HaveSameMap(c, d)); // false：插入顺序不同
```

想看更多细节可以用 `%DebugPrint(obj)`，它会打印 Map 地址、描述符数组和元素种类。这些内部函数只用于探索，千万不要放进生产代码。

### Map 放弃的时候：字典模式

某些操作会让共享布局模型变得不划算，V8 会把对象切换到**字典（慢）模式**，属性存放在对象自己的哈希表中：

- `delete obj.someProperty`（删除最后添加的属性有时可以通过回滚转换撤销，但删除其他属性通常会让对象被规范化为字典模式）；
- 动态添加数量非常多的属性；
- 以某些不常见的特性调用 `Object.defineProperty`。

`%HasFastProperties(obj)` 可以告诉你对象处于哪种模式。对于真正的"映射"用途，字典模式本来就是正确选择；但如果你把对象当作记录（record）使用，请把字段设为 `undefined` 而不是删除它（真正动态的键请用 `Map`）。

## 第二部分：内联缓存与反馈向量

光有 Map 还不能让 `p.x` 变快——引擎仍需在 Map 的描述符里*查找* `x`。诀窍是每个调用点只查一次，然后把结果缓存起来。

### 内联缓存

字节码中的每个属性访问、调用或算术操作，都在函数的**反馈向量（feedback vector）**里有一个槽位。`p.x` 第一次执行时，V8 进行完整查找，然后记录"对于 Map2，`x` 在偏移 0"。下一次只需检查传入对象的 Map 是否为 Map2；是的话就直接从偏移 0 读取。这个"检查 + 读取"就是**内联缓存（Inline Cache，IC）**。

IC 随着见到的形状增多而迁移状态：

| 状态 | 见过的形状数 | 开销 |
|---|---|---|
| 未初始化 | 0 | 首次执行做完整查找 |
| **单态（monomorphic）** | 1 | 一次 Map 比较 + 直接读取——最快路径 |
| **多态（polymorphic）** | 2–4 | 在一个小 Map 列表上线性检查 |
| **超多态（megamorphic）** | 超过 4 | 退回全局 stub cache / 通用查找 |

"最多 4 个"是 V8 长期以来的默认值，具体数字属于实现细节。

```js
function getX(o) { return o.x; }

// 单态：每次调用都看到同一个 Map
for (let i = 0; i < 1e6; i++) getX({ x: i, y: 0 });

// 多态 -> 超多态：五种不同形状到达同一个调用点
const shapes = [
  { x: 1 }, { x: 1, a: 0 }, { x: 1, b: 0 }, { x: 1, c: 0 }, { x: 1, d: 0 },
];
for (let i = 0; i < 1e6; i++) getX(shapes[i % 5]);
```

第二个循环并没有"错"，但 `getX` 再也无法被编译成单次比较加读取，优化编译器能利用的信息少得多。

### 反馈不只是形状

反馈向量还会记录：

- **二元运算反馈**：`a + b` 是否只见过小整数？浮点数？字符串？还是混合？
- **调用反馈**：调用点实际调用的是哪个函数（为内联提供依据）。
- **比较反馈**、数组和对象字面量的**分配点（allocation site）**信息等等。

这份运行时画像是所有更高层级的原材料。

## 第三部分：分级执行管线

V8 需要平衡两种开销：编译耗时，以及运行慢代码的耗时。它的答案是一架层级阶梯，每往上一级，编译更慢、运行更快。

```text
源码 --解析--> AST --> Ignition 字节码
                          |
         （解释执行，收集反馈）          第 1 级：Ignition
                          |
                  温 --> Sparkplug       第 2 级：基线机器码
                          |
                  热 --> Maglev          第 3 级：快速优化 JIT
                          |
                很热 --> TurboFan        第 4 级：顶级优化 JIT
                          ^
         去优化 <---------+（退回 Ignition/Sparkplug 栈帧）
```

### Ignition——解释器（2016–2017 年起）

Ignition 把 AST 编译成紧凑的**基于寄存器的字节码**并解释执行。字节码比 V8 早年急切生成的机器码小得多，这对手机上的内存占用意义重大。每条能受益的字节码都会更新反馈向量。

可以用 `node --print-bytecode --print-bytecode-filter=getX file.js` 查看字节码。

### Sparkplug——非优化的基线编译器（Chrome 91，2021 年）

Sparkplug **单遍线性地**把字节码编译成机器码，**不构建任何中间表示（IR）**。每条字节码变成一小段机器指令，大多是调用与解释器相同的内建函数（builtins）。它沿用解释器的栈帧布局，因此 Ignition 与 Sparkplug 之间的切换几乎没有成本（包括在循环中途进行栈上替换）。

Sparkplug 不做推测也不做优化，只是去掉解释器的分派开销。V8 团队报告它在真实浏览场景的基准上带来了可观的提升，因为 Web 上大量时间花在"温"代码而非"热"代码上。

### Maglev——中间层优化编译器（Chrome 117，2023 年底）

过去 Sparkplug 和 TurboFan 之间有一道很大的鸿沟：TurboFan 生成的代码极好，但编译很慢，导致许多函数在未优化状态下运行太久。Maglev 填补了这个空白。它直接从字节码加反馈构建基于 SSA 的图，进行推测特化（例如"这个 `+` 只见过 Smi"、"这次读取只见过 Map2"）和一组适度的优化，编译速度比 TurboFan 快大约一个数量级。

### TurboFan——顶级优化编译器

TurboFan 在反馈驱动的推测之上施加激进优化：内联、逃逸分析（把对象分配在栈上或彻底消除）、冗余读取消除、边界检查消除、循环优化，以及精细的指令选择和寄存器分配。它的后端已逐步迁移到一个新的基于控制流图（CFG）的 IR——**Turboshaft**，V8 也公开撰文介绍了放弃最初使用的"节点之海（sea of nodes）"表示的过程。

### 代码如何爬上阶梯

V8 使用基于预算的启发式：函数运行时（调用、循环回边）会消耗"中断预算"，预算耗尽时 V8 考虑升级层级。热循环可以通过**栈上替换（OSR）**在运行中途被优化。TurboFan 的优化编译主要在后台线程进行，主线程在优化代码就绪前继续执行较慢的版本。

可以用 `--trace-opt` 和 `--trace-deopt` 观察这些决策：

```bash
node --trace-opt --trace-deopt app.js 2>&1 | grep -E "optimiz|deoptimiz" | head
```

## 第四部分：推测与去优化

优化层编译出的代码只有在**反馈得出的假设仍然成立时**才是正确的。每个假设都有一个廉价的检查守护：

```text
// 概念上 function getX(o) { return o.x; } 的优化代码
  if (o 不是堆对象)           -> 去优化
  if (o.map != Map2)          -> 去优化
  return load(o + x 的偏移)
```

检查失败时，V8 执行**去优化**：从优化栈帧重建解释器（或基线）栈帧——把被逃逸分析消除的值重新物化出来——然后在未优化代码中继续执行。函数会收集新的反馈，之后可能以更宽泛的假设重新优化。

单次去优化本身很正常、开销也不大。真正伤性能的是**去优化循环**：代码反复被优化、作废、再优化；或者反馈变得过于泛化（超多态、数字与字符串混合运算），以致优化器生成的代码比基线好不了多少。

一个经典诱因：

```js
function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

sum([1, 2, 3]);           // Smi 反馈
for (let i = 0; i < 1e5; i++) sum([1, 2, 3]); // 按 Smi 加法优化
sum([1.5, 2.5]);          // 浮点数：守护失败 -> 去优化，反馈放宽
sum(["a", "b"]);          // 字符串：反馈再次放宽
```

## 第五部分：数字、Smi 与指针压缩

V8 用带标记（tagged）的字表示值。小整数以 **Smi**（small integer）形式带一个标记位**内联**存储，无需堆分配；其他一切（对象、字符串、以及以 `HeapNumber` 表示的非 Smi 数字）都是指向堆的指针。

从 V8 8.0（Chrome 80，2020 年）起，64 位 Chrome 启用了**指针压缩**：堆中的标记值宽 32 位，解释为相对 4 GB "笼子（cage）"内某个基址的偏移。这在真实网站上显著缩小了 V8 堆（V8 团队报告最多约 43%），性能代价可忽略。副作用是在这类构建中 Smi 为 31 位，超出大约 ±10 亿的值会变成 HeapNumber。Node.js 的构建历来默认*不*开启指针压缩，因此细节有所不同，请以你的构建为准。

实践含义：热点数值代码要么一直是整数，要么一直是浮点数。在 Smi 和 double 之间来回切换的字段，会迫使 Map 的字段表示形式被泛化。

## 第六部分：元素种类——数组也有形状

索引属性（数组元素）与命名属性分开存放，V8 为每个数组跟踪一个**元素种类（elements kind）**。最常见的几种构成一个格（lattice），转换只会**向下**（更通用）进行，永不回退：

```text
PACKED_SMI_ELEMENTS  ->  PACKED_DOUBLE_ELEMENTS  ->  PACKED_ELEMENTS
        |                         |                         |
        v                         v                         v
HOLEY_SMI_ELEMENTS   ->  HOLEY_DOUBLE_ELEMENTS   ->  HOLEY_ELEMENTS
```

- *SMI* 数组只含小整数；*DOUBLE* 数组存放未装箱的浮点数；普通 *ELEMENTS* 可存任意值。
- *HOLEY* 数组可能含有空洞，因此每次读取都要检查空洞，并可能沿原型链查找。

```js
const a = [1, 2, 3];      // PACKED_SMI_ELEMENTS
a.push(4.5);              // -> PACKED_DOUBLE_ELEMENTS（永久）
a.push("x");              // -> PACKED_ELEMENTS（永久）

const b = new Array(3);   // HOLEY_SMI_ELEMENTS：创建时就有空洞
b[0] = 1; b[1] = 2; b[2] = 3; // 即使填满也仍是 HOLEY

const c = [1, 2, 3];
c[10] = 4;                // 越过末尾写入产生空洞 -> HOLEY
```

此外，不要把 `NaN`/`Infinity`/`-0` 放进你希望保持为 Smi 的数组（它们会迫使数组变为 double），也不要读取超出 `length` 的位置，那会走原型链慢路径。需要同构数值缓冲区时，**类型化数组**（`Float64Array`、`Int32Array`）提供固定的表示，完全没有元素种类转换。

## 第七部分：跨引擎对比

V8 并非孤例，这些思想源自 1980 年代末到 1990 年代 Self 与 Smalltalk 的研究。

| 引擎 | 形状 | 层级（简化） |
|---|---|---|
| V8（Chrome、Node、Deno） | Map | Ignition → Sparkplug → Maglev → TurboFan |
| SpiderMonkey（Firefox） | Shape | 解释器 → 基线解释器 → 基线 JIT → WarpMonkey（Ion） |
| JavaScriptCore（Safari、Bun） | Structure | LLInt → 基线 JIT → DFG → FTL |

这种趋同很能说明问题：所有主流引擎都走到了"隐藏类 + 内联缓存 + 多级层次 + 去优化"这一设计。差别在于层级数量、各层编译速度，以及推测的激进程度。

驱动层级设计的取舍：

- **启动 vs. 峰值**：解释器立即可用、内存占用小；优化 JIT 吞吐最高，却要付出编译时间和内存。短生命周期的页面偏向低层级，长时间运行的服务端偏向顶层。
- **推测 vs. 稳定**：激进推测代码更快，但去优化风险更高。像 Maglev 这样的中间层以更低的编译成本做推测，猜错的代价更小。
- **安全**：JIT 编译器是浏览器漏洞的常见来源，因此 iOS 锁定模式、Edge 的"增强安全"等环境可以关闭 JIT 层级，用速度换取更小的攻击面。

## 第八部分：对日常代码意味着什么

大多数应用代码的瓶颈在 I/O、DOM 和网络，而不在属性访问，所以先做性能剖析。但在热点路径上——解析器、序列化器、渲染循环、游戏逻辑、Node 中的数据处理——这些习惯是值得的：

1. **在构造函数（或类字段声明）中以一致的顺序初始化所有字段。** 用 `null`/`undefined` 占位，而不是事后添加属性。
2. **让热点函数保持单态。** 如果一个函数接收多种无关形状，考虑按类型拆分。
3. **不要对记录型对象 `delete` 属性。** 设为 `undefined`，或者对动态键使用 `Map`。
4. **保持数组紧凑（packed）且同构。** 小数组优先使用字面量或 `push`，而不是 `new Array(n)`；避免在同一个热点数组里混合数字、字符串和对象；数值缓冲区用类型化数组。
5. **保持数值类型稳定。** 不要在同一个算术点混用整数、浮点数和数字字符串。
6. **不要盲目微优化。** 先用 Chrome DevTools 的 Performance 面板、`node --cpu-prof`、`--trace-deopt`，以及 [Deopt Explorer](https://github.com/microsoft/deoptexplorer-vscode) 等工具确认热点，再重构代码。

一个改造前后的对比：

```js
// 改造前：形状取决于输入，属性事后添加
function makeUser(row) {
  const u = {};
  u.id = row.id;
  if (row.email) u.email = row.email;
  if (row.admin) u.role = "admin";
  return u;
}

// 改造后：所有用户共享一个形状
class User {
  constructor(row) {
    this.id = row.id;
    this.email = row.email ?? null;
    this.role = row.admin ? "admin" : "member";
  }
}
```

现在每个 `User` 都共享同一个 Map，所有读取 `user.email` 的调用点都能保持单态。

## 总结

- V8 通过 **Map** 和转换树为动态对象提供静态布局；属性顺序和初始化方式决定了对象落在哪个 Map 上。
- **内联缓存**和**反馈向量**记录每个操作见过的东西；单态调用点开销最低，超多态调用点开销最高。
- 代码随热度从 **Ignition**（字节码解释器）攀升到 **Sparkplug**（基线代码）、**Maglev**（快速优化 JIT）和 **TurboFan**（峰值优化 JIT）。
- 优化代码是**推测性的**并带有守护检查；假设失效时，**去优化**会安全回退。
- **Smi**、**指针压缩**和**元素种类**解释了许多与数字、数组相关的性能悬崖。
- 实践上：稳定的形状、同构的数组、稳定的数值类型——并且先测量再优化。

## 参考资料

- V8 博客，"Firing up the Ignition interpreter"：https://v8.dev/blog/ignition-interpreter
- V8 博客，"Sparkplug — a non-optimizing JavaScript compiler"：https://v8.dev/blog/sparkplug
- V8 博客，Maglev 发布文章：https://v8.dev/blog/maglev
- V8 博客，"Land ahoy: leaving the Sea of Nodes"：https://v8.dev/blog/leaving-the-sea-of-nodes
- V8 博客，"Fast properties in V8"：https://v8.dev/blog/fast-properties
- V8 博客，"Elements kinds in V8"：https://v8.dev/blog/elements-kinds
- V8 博客，"Pointer compression in V8"：https://v8.dev/blog/pointer-compression
- Mathias Bynens 与 Benedikt Meurer，"JavaScript engine fundamentals: Shapes and Inline Caches"：https://mathiasbynens.be/notes/shapes-ics
- Chambers、Ungar 与 Lee，"An Efficient Implementation of SELF"（OOPSLA 1989）——Map / 隐藏类的起源
