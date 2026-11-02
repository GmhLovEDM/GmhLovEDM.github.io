---
title: "Signals 与细粒度响应式：依赖追踪、推拉结合传播与无毛刺更新"
tag: javascript
description: 深入 Solid、Preact、Vue、Angular 和 Svelte 5 中 signal 的底层实现：为什么"推送失效 + 惰性拉取"能在菱形依赖图中避免毛刺，自动依赖追踪、三色标记和版本号是如何实现的，一个约 120 行可运行的迷你 signal 库，以及 signal 与 React 重渲染加 diff 模型、TC39 Signals 提案的对比
date: "2026-11-02T10:15:00.000Z"
---

## 目标

这几年，除了 React，几乎所有主流前端框架都收敛到了同一个原语上：**signal（信号）**。Solid 从第一天就建立在它之上；Preact 在 2022 年推出了 `@preact/signals`；Angular 在 v16 引入了 `signal()`；Vue 的 `ref` / `computed` 本质上一直就是 signal；Svelte 5 围绕 runes（`$state`、`$derived`、`$effect`）重写了编译器；而把 signal 标准化进 JavaScript 的 TC39 提案也在 2024 年进入了 Stage 1。

它的 API 非常小：一个可读写的值、一个派生值、一个副作用。真正有意思的是底下的算法。本文内容：

1. 细粒度响应式要解决什么问题，和"重渲染 + diff"有何不同。
2. 自动依赖追踪。
3. 推、拉、推拉结合三种传播方式，以及菱形依赖的"毛刺"（glitch）问题。
4. 一个完整的迷你 signal 库：惰性 computed、相等性截断、批处理、清理函数。
5. 真实实现如何优化：三色标记、版本号、双向链表。
6. 框架对比：Solid、Preact、Vue、Angular、Svelte 5、React。
7. TC39 Signals 提案。
8. 生产环境中的常见坑。

## 1. 让 UI 与状态保持同步的两种方式

每个 UI 框架都在回答同一个问题：*状态变化时，屏幕上哪些部分需要更新？*

**粗粒度（React）。** 状态变化会重新执行拥有该状态的组件函数以及它的所有后代（除非做了 memo）。结果是一棵新的虚拟树，与上一棵做 diff，再把最小的 DOM 变更应用上去。框架并不知道组件*用到了哪些值*，它的做法是重新执行再比较。这种方式简单、健壮，但成本与子树大小成正比，而不是与变化的大小成正比。于是有了 `memo`、`useMemo`、`useCallback`，以及现在能自动插入记忆化的 React Compiler。

**细粒度（signal）。** 每一份状态都是一个可观察的单元。某个计算读取它时，运行时会记录这条依赖；它被写入时，只有真正读过它的计算会重新执行。在 Solid 中，组件函数只执行*一次*来构建 DOM；之后每次 signal 写入，只会更新绑定在它上面的那个文本节点或属性。没有虚拟 DOM，也没有 diff。

```jsx
// Solid：组件函数体只执行一次。
function Counter() {
  const [count, setCount] = createSignal(0);
  const double = createMemo(() => count() * 2);
  return (
    <button onClick={() => setCount(count() + 1)}>
      {count()} × 2 = {double()}
    </button>
  );
}
```

编译器会把 `{count()}` 变成一个只写一个文本节点的小 effect。点击按钮只会更新两个文本节点，别的什么都不动。

这个思想并不新。Knockout.js（2010）就有带自动依赖追踪的 observable 和 computed observable；MobX 在 React 生态中把它发扬光大；Adam Haile 的 S.js 提出了许多同步、无毛刺的语义，Solid 后来正是在此基础上构建的。近几年真正变化的，主要是算法质量和与编译器的结合。

## 2. 自动依赖追踪

让 signal 好用的关键在于：你永远不需要手动声明依赖，运行时通过观察"读取"自己发现它们：

```js
let currentObserver = null;

function read(signal) {
  if (currentObserver) {
    currentObserver.sources.add(signal);
    signal.observers.add(currentObserver);
  }
  return signal.value;
}
```

在执行 computed 或 effect 之前，运行时把 `currentObserver` 设为它；执行期间每一次 signal 读取都会登记一条边。由于这个全局变量会被保存和恢复，嵌套计算就像一个栈一样工作。

实践中有两个重要推论：

- **依赖是动态的。** 在 `() => cond() ? a() : b()` 中，任一时刻只有 `a` 或 `b` 之一是依赖。实现会在每次重新执行时清空（或比对）依赖集合，避免过期的边导致无用更新。
- **只有同步读取会被追踪。** `await` 之后或 `setTimeout` 里的读取发生时 `currentObserver` 已经不在了，所以完全不可见。这是"我的 effect 怎么不重新执行"类 bug 最常见的来源。

## 3. 推、拉与菱形问题

有了依赖图，写入就必须沿图传播。有三种策略。

**纯推（push）。** signal 一变，立刻重新执行每个观察者，观察者再通知它的观察者。简单，但有两个问题：会为当前没人读的值做无用功，并且会产生**毛刺（glitch）**。

看经典的菱形依赖：

```
        a
       / \
      b   c        b = a * 2, c = a + 1
       \ /
        d          d = b + c   （负责渲染的 effect）
```

用朴素的深度优先推送把 `a` 从 1 改成 2：`a` 通知 `b`，`b` 重新计算为 4 并通知 `d`，`d` 用 `b = 4` 和*旧的* `c = 2` 执行，得到 6，这个值不对应任何一致的状态。随后 `c` 更新为 3，`d` 再以正确的 7 执行一次。中间的 6 就是毛刺。在 UI 里轻则闪一下；如果 `d` 会发请求或在数据不一致时抛错，就是真正的 bug。

**纯拉（pull）。** 写入时什么都不标记，每次读取都重新校验整条依赖链。结果总是一致的，但你没法知道*什么时候*该重新执行 effect，只能轮询或者全部重渲染。

**推拉结合（现代库的做法）。** 把传播拆成两个阶段：

1. **推送失效。** 写入时沿图向下游遍历，只*标记*节点为过期，不执行任何用户代码。遍历到的 effect 放入队列。
2. **拉取重算。** 执行队列中的 effect。当 effect（或任何人）读取一个过期的 computed 时，computed 先递归地确保自己的依赖是最新的，只有当某个依赖真的变了才重新计算。

因为在所有标记完成之前不会执行任何用户代码，而每次读取都会拉取最新值，`d` 看到的 `b` 和 `c` 一定来自同一个一致状态，并且只执行一次。computed 也因此是惰性的：没人读的派生值永远不会被重算。

### 三色标记：CLEAN、CHECK、DIRTY

Milo（modderme123）的 Reactively 库推广了一种改进（Solid 等库也用了类似的形式）：用三种状态代替单个"过期"位：

- `DIRTY`：某个直接依赖确定变了，必须重算。
- `CHECK`：更上游的东西变了，某个依赖*可能*有新值。
- `CLEAN`：已是最新。

signal 写入时，把直接观察者标为 `DIRTY`，更下游的全部标为 `CHECK`。读取一个 `CHECK` 节点时，它先让依赖更新；如果没有一个依赖产生新值，它直接回到 `CLEAN`，根本不执行自己的函数。这就是**相等性截断**：如果 `isEven = computed(() => n() % 2 === 0)` 在 `n` 从 2 变成 4 时仍为 `true`，`isEven` 下游的一切都不会重新执行。

## 4. 一个迷你 signal 库

下面是上述思想的完整可运行实现：signal、带三色标记和相等性截断的惰性 computed、带清理函数的 effect，以及批处理。大约 120 行，刻意保持简单（用 Set 而不是链表）。

```js
const CLEAN = 0, CHECK = 1, DIRTY = 2;

let currentObserver = null;
let batchDepth = 0;
let flushing = false;
const pendingEffects = [];

function track(source) {
  if (currentObserver) {
    currentObserver.sources.add(source);
    source.observers.add(currentObserver);
  }
}

function untrackAll(node) {
  for (const s of node.sources) s.observers.delete(node);
  node.sources.clear();
}

function runTracked(node, fn) {
  const prev = currentObserver;
  currentObserver = node;
  try { return fn(); } finally { currentObserver = prev; }
}

// Bring a CHECK node up to date by pulling its sources first.
function pullSources(node) {
  for (const s of node.sources) {
    if (s instanceof Computed) s.update();   // may set node.state = DIRTY
    if (node.state === DIRTY) break;
  }
}

class Signal {
  constructor(value) { this.value = value; this.observers = new Set(); }
  get() { track(this); return this.value; }
  set(next) {
    if (Object.is(next, this.value)) return;     // equality cutoff at the source
    this.value = next;
    for (const o of [...this.observers]) o.mark(DIRTY);
    flush();
  }
}

class Computed {
  constructor(fn) {
    this.fn = fn;
    this.value = undefined;
    this.state = DIRTY;          // lazy: nothing runs until first read
    this.sources = new Set();
    this.observers = new Set();
  }
  mark(state) {
    if (this.state >= state) return;
    const wasClean = this.state === CLEAN;
    this.state = state;
    // Only the first invalidation needs to travel further downstream.
    if (wasClean) for (const o of [...this.observers]) o.mark(CHECK);
  }
  update() {
    if (this.state === CHECK) pullSources(this);
    if (this.state === DIRTY) {
      untrackAll(this);
      const next = runTracked(this, this.fn);
      if (!Object.is(next, this.value)) {
        this.value = next;
        // Observers currently in CHECK now know they must recompute.
        for (const o of this.observers) o.state = DIRTY;
      }
    }
    this.state = CLEAN;
  }
  get() { track(this); this.update(); return this.value; }
}

class Effect {
  constructor(fn) {
    this.fn = fn;
    this.state = DIRTY;
    this.sources = new Set();
    this.cleanup = null;
    this.disposed = false;
    this.run();
  }
  mark(state) {
    if (this.state === CLEAN) pendingEffects.push(this);
    if (this.state < state) this.state = state;
  }
  run() {
    if (this.disposed) return;
    if (this.state === CHECK) pullSources(this);
    if (this.state === DIRTY) {
      if (this.cleanup) this.cleanup();
      untrackAll(this);
      const result = runTracked(this, this.fn);
      this.cleanup = typeof result === 'function' ? result : null;
    }
    this.state = CLEAN;
  }
  dispose() {
    this.disposed = true;
    if (this.cleanup) this.cleanup();
    untrackAll(this);
  }
}

function flush() {
  if (batchDepth > 0 || flushing) return;
  flushing = true;
  try {
    while (pendingEffects.length) pendingEffects.shift().run();
  } finally {
    flushing = false;
  }
}

export function batch(fn) {
  batchDepth++;
  try { return fn(); } finally { batchDepth--; flush(); }
}

export const signal = (v) => new Signal(v);
export const computed = (fn) => new Computed(fn);
export const effect = (fn) => new Effect(fn);
```

来跟踪一下菱形依赖：

```js
const a = signal(1);
const b = computed(() => a.get() * 2);
const c = computed(() => a.get() + 1);
effect(() => console.log('d =', b.get() + c.get()));   // d = 4

a.set(2);                                                // d = 7（只执行一次，无毛刺）
```

1. `a.set(2)` 把 `b` 和 `c` 标为 `DIRTY`。`b` 原本是 CLEAN，于是把 effect 标为 `CHECK` 并入队。`c` 也尝试把 effect 标为 `CHECK`，但它已经是了，什么都不发生。
2. `flush()` 执行 effect。它处于 `CHECK`，于是先拉取 `b`：`b` 重算为 4，值变了，effect 变为 `DIRTY`，循环结束。
3. effect 重新执行。读 `b` 没有开销（已是 CLEAN）；读 `c` 触发它更新为 3。输出 `d = 7`，只有一次。

相等性截断：

```js
const n = signal(2);
const isEven = computed(() => n.get() % 2 === 0);
let runs = 0;
effect(() => { isEven.get(); runs++; });   // runs = 1

n.set(4);   // isEven 重算后仍为 true -> effect 回到 CLEAN
console.log(runs);                          // 1
```

批处理让两次写入只触发一次 effect：

```js
const first = signal('Ada'), last = signal('Lovelace');
const full = computed(() => `${first.get()} ${last.get()}`);
effect(() => console.log(full.get()));    // Ada Lovelace

batch(() => { first.set('Grace'); last.set('Hopper'); });  // Grace Hopper（一次）
```

不用 `batch` 的话 effect 会执行两次，其中一次输出不一致的 "Grace Lovelace"。这不算图层面的毛刺（每次执行看到的都是 signal 的一致快照），但仍然是浪费和可观察到的中间状态，所以框架会在事件处理函数里自动批处理。

这个玩具版本省略了：

- **无人观察的 computed 会泄漏。** 已经没人读的 computed 仍留在依赖的观察者集合里。真实的库会在最后一个观察者离开时把 computed 从依赖上取消订阅，需要时再惰性地重新订阅。
- **所有权。** Solid 和 Vue 会在某个 owner（组件或 effect scope）中创建 effect，销毁组件时一并销毁它创建的一切。这里你得自己调用 `dispose()`。
- **循环与死循环检测。** 一个写入自己读取的 signal 的 effect 会无限循环，库会检测并抛错。
- **错误处理。** 抛错的 computed 应缓存错误并在读取时重新抛出。

## 5. 真实实现如何做到快

算法本身很简单，工程功夫在于内存布局和避免多余工作。

**版本号（Preact Signals、Vue 3.5）。** 代替（或配合）三色标记，每个 signal 带一个写入时递增的版本号。computed 记下它读过的每个依赖的版本；校验时只比较版本，全部一致就无需执行任何东西即可确认有效。Preact 还维护一个**全局版本号**：如果自 computed 上次校验以来任何 signal 都没变过，它可以 O(1) 返回缓存值，连依赖都不用遍历。Preact 团队在 2022 年的 "Signal Boosting" 一文中介绍了这一设计。

**用双向链表代替 Set。** 每个节点一个 `Set`、每条边一个条目，分配开销很大。Preact 和 Vue 3.5 把每条依赖边表示为一个同时挂在两条链表上的节点：依赖源的订阅者链表和订阅者的依赖链表。每次重新执行时的重新追踪就可以按顺序*复用*这些边：如果 computed 和上次以相同顺序读取相同的依赖（这是绝大多数情况），完全不会发生内存分配。Vue 3.5 的发布说明称这次重构让响应式系统的内存占用降低了 56%。

**Alien Signals。** Johnson Chu 的 `alien-signals` 库把这一设计推得更远，重点是在传播循环中避免递归和内存分配；它的算法已被吸收进 Vue 3.6 开发线的响应式核心。

**编译器辅助绑定。** Solid、Svelte 5 和 Vue 的 Vapor Mode 把模板编译成直接的 DOM 操作，并包裹在细粒度 effect 中，于是一次 signal 变化只对应一次 `textContent` 或 `setAttribute` 调用。每次更新的运行时开销与真正变化的绑定数量成正比。

**基于 Proxy 的深层响应式。** Vue 的 `reactive()` 和 Svelte 5 中对象形式的 `$state` 用 `Proxy` 包装普通对象，在首次访问时为每个属性惰性创建 signal。Solid 通过 store 提供同样的能力。这样你可以直接 `state.todos[3].done = true`，只更新依赖这一个字段的地方。

## 6. 框架对比

| | 原语 | 派生 | 副作用 | 组件会重新执行？ | 说明 |
|---|---|---|---|---|---|
| Solid | `createSignal`（getter/setter 对） | `createMemo` | `createEffect` | 否，只执行一次 | 编译器把 signal 直接连到 DOM 节点 |
| Preact | `signal()`，通过 `.value` 访问 | `computed()` | `effect()` | 可选 | 直接把 signal 放进 JSX 可跳过组件重渲染 |
| Vue | `ref`、`reactive` | `computed` | `watch`、`watchEffect` | 是（VDOM），Vapor Mode 下否 | 模板读取在每个组件的渲染 effect 中追踪 |
| Angular | `signal()`，以 `count()` 读取 | `computed()` | `effect()` | 由 signal 精确驱动变更检测 | 使不依赖 Zone.js 的 zoneless 变更检测成为可能 |
| Svelte 5 | `$state` rune | `$derived` | `$effect` | 否 | 编译器把 runes 改写成 signal 读写 |
| React | `useState` | `useMemo` / 编译器 | `useEffect` | 是 | 不是 signal；重渲染 + 协调，React Compiler 自动记忆化 |

**React 为什么没有采用 signal。** React 团队的立场是：重渲染模型让渲染始终是状态的纯函数，这与并发渲染、transition 和 Suspense 配合得很好，React 可以在后台渲染一棵新树然后随时丢弃。同步更新 DOM 的可变 signal 让这件事变难（参见 `useSyncExternalStore` 为解决"撕裂"问题而诞生）。React Compiler 转而从性能侧入手，自动记忆化，让重渲染跳过没变的子树。大致的取舍是：

- **Signal：** 更新成本与变化量成正比，没有记忆化的仪式感；但响应式是一个你必须遵守的运行时概念（在追踪作用域内读取、别用解构丢掉响应性、小心异步）。
- **重渲染 + diff：** 心智模型更简单（"UI = f(state)"），更容易中断和重放；但成本与子树大小成正比，需要靠记忆化缓解。

实践中两者对大多数应用都够快。signal 在大型、长生命周期的树加上频繁小更新的场景中最有优势：表格、编辑器、仪表盘、实时数据。

## 7. TC39 Signals 提案

2024 年，一群来自 Angular、Vue、Solid、Preact、Svelte、Ember、MobX 的作者提议把 signal 加入 JavaScript 本身。该提案在 2024 年 4 月进入 **Stage 1**。它有意只标准化核心依赖图，不包含 effect 和调度：

```js
const counter = new Signal.State(0);
const isEven = new Signal.Computed(() => (counter.get() & 1) === 0);
const parity = new Signal.Computed(() => (isEven.get() ? 'even' : 'odd'));

// effect 由框架基于底层的 Watcher 构建。
const w = new Signal.subtle.Watcher(() => {
  // 当被观察的 signal 可能变脏时同步调用。
  // 这里不能读写 signal，只能安排后续工作。
  queueMicrotask(processPending);
});
w.watch(parity);
```

设计遵循前文的推拉模型：`Computed` 惰性且带缓存；通知只推送（`Watcher` 只被告知"某些东西可能变了"）；真实值靠拉取。调度留给框架，因为每个框架的批处理方式都不一样。目标是互操作性（一个库创建的 signal 能被另一个库的 effect 追踪），并让引擎和 DevTools 有机会优化与可视化依赖图。已有 [polyfill](https://github.com/proposal-signals/signal-polyfill) 可供尝试，API 仍可能变化。

## 8. 生产环境中的坑

**解构导致丢失响应性。** 在 Solid 中，`const { name } = props` 在任何追踪作用域之外读了一次 `props.name`。在 Vue 中，解构 `reactive()` 对象得到的是普通值。应使用 getter、`toRefs` 或 `splitProps`。

**异步边界。** `await` 之后的读取不会被追踪：

```js
effect(async () => {
  const id = userId.get();          // 被追踪
  const user = await fetchUser(id);
  if (showDetails.get()) { /* 不会被追踪：在 await 之后读取 */ }
});
```

在第一个 `await` 之前读取所有依赖，或使用框架提供的 resource / 异步原语。

**在 computed 里写 signal。** computed 应当是纯的。从派生值里写状态会破坏依赖图的顺序保证，大多数库会抛错或警告。

**用 effect 做派生状态。** 用 effect 把一个 signal 复制到另一个（`effect(() => b.set(a.get() * 2))`）会多出一轮更新，并存在 `b` 过期的时间窗口。应该用 `computed`。effect 用于与外部世界同步：DOM API、网络、存储、日志。

**忘记清理。** 添加监听器、定时器或订阅的 effect 必须返回或注册清理函数，否则每次重新执行都会多泄漏一个。

**对象身份与相等性。** 由于使用 `Object.is` 判断相等，原地修改数组再设置同一个引用不会触发通知。要么不可变地替换，要么使用库提供的深层 / Proxy store。

**巨大的扇出。** 一个被 10,000 行读取的 signal 变化时会通知 10,000 个观察者。对于"选中"状态，使用按 key 的选择器模式（如 Solid 的 `createSelector`），一次变化只通知选中状态真正改变的那两行。

## 要点总结

- signal 是带自动依赖追踪的可观察单元，更新成本与变化量成正比，而不是与组件树大小成正比。
- 纯推送会在菱形依赖图中产生毛刺；推送失效加惰性拉取重算，能做到无毛刺且最小化的更新。
- 三色标记或版本号带来相等性截断，没变的派生值会阻止继续传播。
- 现代库胜在内存布局：跨执行复用的链表边、全局版本号、编译器生成的 DOM 绑定。
- 只有追踪作用域内的同步读取才是依赖；大多数 bug 来自异步间隙、解构以及把 effect 当派生用。
- React 选择了重渲染加自动记忆化；TC39 提案则希望给其他框架一个共享、可互操作的核心。

## 参考资料

- [TC39 Signals 提案](https://github.com/tc39/proposal-signals) 及 [signal-polyfill](https://github.com/proposal-signals/signal-polyfill)
- Rob Eisenberg，[*A TC39 Proposal for Signals*](https://eisenbergeffect.medium.com/a-tc39-proposal-for-signals-f0bedd37a335)，2024
- Ryan Carniato，[*A Hands-on Introduction to Fine-Grained Reactivity*](https://dev.to/ryansolid/a-hands-on-introduction-to-fine-grained-reactivity-3ndf)
- Milo（modderme123），[*Super Charging Fine-Grained Reactive Performance*](https://dev.to/modderme123/super-charging-fine-grained-reactive-performance-47ph)（Reactively 三色标记算法）
- Preact 团队，[*Introducing Signals*](https://preactjs.com/blog/introducing-signals/) 与 [*Signal Boosting*](https://preactjs.com/blog/signal-boosting/)
- [Announcing Vue 3.5](https://blog.vuejs.org/posts/vue-3-5)（响应式重构）与 [Vue：深入响应式系统](https://vuejs.org/guide/extras/reactivity-in-depth.html)
- [GitHub 上的 stackblitz/alien-signals](https://github.com/stackblitz/alien-signals)
- [Angular Signals 指南](https://angular.dev/guide/signals)
- [Svelte 5 runes 文档](https://svelte.dev/docs/svelte/what-are-runes)
- [SolidJS：细粒度响应式](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity)
- [React Compiler 文档](https://react.dev/learn/react-compiler)
- [GitHub 上的 adamhaile/S](https://github.com/adamhaile/S)
