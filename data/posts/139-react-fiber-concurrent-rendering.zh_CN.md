---
title: "深入 React Fiber：协调、Lanes、调度器与并发渲染"
tag: react
description: 一次 setState 到底是怎样变成 DOM 修改的——Fiber 数据结构与双缓冲树、可中断的 render 阶段与分三步的 commit 阶段、用位掩码表示优先级的 lanes、调度器的 5ms 时间切片，以及 transition、useDeferredValue、Suspense 和 useSyncExternalStore 是如何构建在其上的。最后总结工程上的实际影响，并与基于 signal 的框架做对比
date: "2026-10-25T14:20:00.000Z"
---

## 目标

大多数 React 性能建议（“包一层 `memo`”、“加个 key”、“把 state 往下移”）只有在理解底层机制后才用得准。从 React 16 开始，这套机制就是 **Fiber**：一个重新实现的协调器（reconciler），它把渲染拆成一个个小的工作单元，可以暂停、恢复、调整优先级，甚至整体丢弃。React 18 通过 `createRoot` 让所有人都用上了这种能力，React 19 又在其上构建了 Actions、`useOptimistic` 和异步 transition。

本文跟随一次更新走完 React 内部的路径：fiber 是什么，render 与 commit 两个阶段如何工作，lanes 如何编码优先级，调度器如何把主线程让还给浏览器，以及并发特性如何自然地从这套设计中长出来。下文出现的名字来自 React 源码（`packages/react-reconciler`、`packages/scheduler`），它们属于实现细节、会随版本变化，但整体架构自 React 18 以来一直稳定。

## 为什么需要 Fiber

React 16 之前的协调器（现在称为“栈协调器”）是递归渲染的：对一个组件调用 `render()`，就会在 JavaScript 调用栈上一路递归处理子节点，直到整棵树处理完。一次大更新可能占用主线程数百毫秒；而且工作状态都在调用栈上，没法做到“处理到一半先停下、响应一次按键、再回来继续”。

Fiber 的核心思想是**用堆上的链式数据结构取代调用栈**。如果每个“栈帧”都是 React 自己掌控的对象，React 就可以处理一个、看一眼时钟，再决定继续还是把主线程还给浏览器。优先级、中断、Suspense、transition——其余一切都建立在这一个改变之上。

## Fiber 节点

fiber 是一个普通的 JavaScript 对象，对应树中的一个组件实例、宿主元素或其他节点。简化后的关键字段如下：

```js
{
  tag,            // FunctionComponent、HostComponent（'div'）、SuspenseComponent……
  type, key,      // 渲染什么，以及在兄弟节点中的身份
  stateNode,      // 宿主组件对应的 DOM 节点

  return,         // 父 fiber
  child,          // 第一个子节点
  sibling,        // 下一个兄弟节点

  pendingProps,   // 本次渲染的 props
  memoizedProps,  // 上一次完成渲染时的 props
  memoizedState,  // 函数组件：hooks 组成的链表
  updateQueue,    // 待处理的状态更新 / effect 列表

  flags,          // 本节点的副作用：Placement、Update、Deletion……
  subtreeFlags,   // 子树 flags 的按位或，commit 时可跳过干净的子树
  lanes,          // 本节点上待处理的工作
  childLanes,     // 子树中某处待处理的工作

  alternate,      // 另一棵树中对应的 fiber
}
```

有三个设计选择很关键：

- **child/sibling/return 指针**把树变成可以只用一个“当前 fiber”变量迭代遍历的结构。暂停就只是记住这个指针。
- **Hooks 存在 fiber 上。**函数组件的 `memoizedState` 是一个链表，每次调用 hook 对应一个节点，顺序与调用顺序一致。这正是 Hooks 规则存在的全部原因：React 按位置把状态对应到 hook 上，条件调用的 hook 会让后面所有 hook 错位。
- **`lanes` 与 `childLanes`** 让 React 不必访问子树就能知道下面是否还有工作，这使得 bailout（跳过）非常便宜。

### 双缓冲

React 为每个节点最多保留两个 fiber：**current** 树（屏幕上显示的）和 **work-in-progress** 树（正在构建的），二者通过 `alternate` 互相指向。渲染时从 current 克隆出 work-in-progress，只修改 work-in-progress 上的副本，commit 时只需切换根节点的指针。由于渲染期间 current 树从不被修改，被中断或被丢弃的渲染不会让 UI 出现任何不一致——和图形学里的双缓冲是同一个思路。

## 阶段一：Render（可中断）

一次渲染从根节点出发，用两个函数深度优先地遍历树：

- **`beginWork(fiber)`**——向下走。调用组件（宿主元素则比较 props），把返回的元素与已有子节点做协调，并返回下一个要处理的子节点。
- **`completeWork(fiber)`**——向上回溯。对宿主组件创建或准备 DOM 节点、计算 props 差异；把 `flags` 冒泡到父节点的 `subtreeFlags`。

驱动它的循环非常小，并发版本和同步版本只差一个判断：

```js
function workLoopSync() {
  while (workInProgress !== null) performUnitOfWork(workInProgress);
}

function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}
```

如果 `shouldYield()` 返回 true，React 就退出循环，`workInProgress` 仍指向下一个要处理的 fiber，并安排一次续跑。此时还没有写入任何 DOM，浏览器可以在间隙中绘制和处理输入。

这个特性有一个必须遵守的代价：**render 可能执行不止一次，也可能被丢弃**。更高优先级的更新可以打断并重启一次渲染；一个 transition 也可能被整个放弃。这就是 render 函数必须是纯函数的原因，也是 `StrictMode` 在开发环境中故意把组件、初始化函数和 reducer 调用两次的原因——为了暴露那些依赖“render 只执行一次”的代码。

### 协调的启发式规则

在两棵任意树之间计算最小编辑脚本的复杂度是 O(n³)。React 采用的是一种早期就写进文档的 O(n) 启发式：

1. **元素类型不同，就是不同的子树。**把 `<div>` 换成 `<section>`，或把 `<UserCard>` 换成 `<AdminCard>`，会卸载旧子树（丢失其状态）并挂载新的。
2. **key 标识跨渲染的子节点身份。**在列表中，React 先按 `key` 匹配子节点；没有 key 时按下标匹配，一旦插入或重排就会把状态错配。

这两条规则在正确性之外也有实用价值：改变 key 是重置组件状态最干净的方式（`<Profile key={userId} />`）；而在另一个组件函数体内定义组件，会在每次渲染时产生新的类型，导致它每次都被重新挂载。

### Bailout

当 `beginWork` 遇到一个 props 引用相同、context 未变、自身 `lanes` 中没有待处理工作的 fiber 时，React 可以跳过对组件的调用。如果 `childLanes` 也为空，就跳过整棵子树；否则克隆子节点，继续向下找到有工作的地方。`React.memo` 把第一个条件从“props 对象相同”放宽为“props 浅比较相等”。React Compiler（2025 年发布 1.0 稳定版）在构建时自动对 JSX 和值做记忆化，使未变化的元素保持引用稳定，不必手写 `useMemo`/`useCallback` 也能触发 bailout。

## 阶段二：Commit（同步）

整棵 work-in-progress 树完成后，React 进行 commit。commit **永远不会被中断**，因为执行到一半的 DOM 修改会被用户看到。它分成几个子阶段，并借助 `subtreeFlags` 跳过无事可做的子树：

1. **Before mutation**——读取即将改变的 DOM 状态（如 `getSnapshotBeforeUpdate`）。
2. **Mutation**——插入、更新、删除 DOM 节点；解绑 ref；对被删除或更新的组件执行 layout effect 的清理函数。
3. **切换**——`root.current = finishedWork`，work-in-progress 树成为 current。
4. **Layout**——绑定 ref，执行 `useLayoutEffect` 与类组件生命周期（`componentDidMount/Update`）。它们在浏览器绘制之前同步执行，因此可以测量布局并调整而不闪烁——同时也会阻塞绘制，所以要尽量精简。

**Passive effect**（`useEffect`）被安排在 commit 之后执行，通常是在浏览器有机会绘制之后。有一个例外：如果更新来自点击这类离散的用户输入，React 会在 commit 结束时同步刷新 passive effect，保证一次点击的 effect 在处理下一次事件之前已经生效。

## Lanes：用位掩码表示优先级

每个更新都会被分配一个 **lane**，即 31 位整数中的一个比特位，位越低越紧急。主要分组如下：

| Lane | 典型来源 |
| --- | --- |
| `SyncLane` | 离散事件（click、keydown）、`flushSync` |
| `InputContinuousLane` | 连续事件（mousemove、scroll、拖拽） |
| `DefaultLane` | React 事件之外的更新：`setTimeout`、网络回调 |
| `TransitionLanes`（多条） | `startTransition`、`useTransition`、`useDeferredValue` |
| `RetryLanes` | 重试挂起的 Suspense 边界 |
| `IdleLane`、`OffscreenLane` | 空闲工作、隐藏的子树 |

用比特位而不是单个数字，集合运算就是免费的。每个 fiber 的 `lanes` 是其待处理更新的并集，`childLanes` 是其子树的并集，根节点则记录 `pendingLanes`、`suspendedLanes` 和 `pingedLanes`。React 选择下一步渲染什么时，会挑出优先级最高的一组 lanes（`getNextLanes`），把这些 lane 上的更新放在一起渲染——这就是**自动批处理**：同一 lane 上的多次 `setState` 合并为一次渲染，不论它们来自事件处理函数、promise 还是 timeout。

在 hook 的更新队列中，不属于本次渲染 lanes 的更新会被**跳过但保留**。React 先处理其余更新，之后再按原顺序重放被跳过的更新，所以最终状态与按顺序依次应用所有更新完全一致。正因如此，一次紧急的按键可以立即显示，而更早的 transition 更新仍在等待，两者都不会丢失。

这个模型也能防止饥饿：某条 lane 等待过久时，React 会把它标记为过期并同步渲染。

## 调度器：与浏览器协作

`scheduler` 包是一个小巧独立的协作式任务调度器。它用**按过期时间排序的最小堆**保存任务，五种优先级（Immediate、UserBlocking、Normal、Low、Idle）各自对应一个超时时长。任务就是一个回调；如果回调返回一个函数，那个函数就是同一任务的续跑。

有两个细节解释了它的行为：

- **时间切片。**当前切片运行约 **5ms** 后（源码中的 `frameYieldMs`），`shouldYield()` 就返回 true。短切片让主线程能及时响应输入，而且不需要知道显示器的帧率。
- **用 `MessageChannel` 让出。**让出后要继续执行时，调度器会给自己 post 一条消息。`setTimeout(fn, 0)` 在嵌套后会被浏览器钳制到至少 4ms，而 message 事件几乎立刻作为新的宏任务执行，同时仍允许浏览器在中间渲染和处理输入。`requestIdleCallback` 曾被考虑过，但因触发太少、太不可预测而被放弃。

React 调度根节点时会把 lanes 映射到调度器优先级。同步工作根本不走调度器的时间切片：它在微任务中被刷新，因此离散事件一定能得到同步渲染。

## 并发特性是如何构建的

有了可中断渲染、双缓冲和 lanes，面向用户的特性其实都只是很薄的一层。

### Transition

```jsx
function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(initial);
  const [isPending, startTransition] = useTransition();

  function onChange(e) {
    setQuery(e.target.value);                      // SyncLane：输入保持流畅
    startTransition(() => {
      setResults(filterLargeList(e.target.value)); // TransitionLane：可中断
    });
  }
  return (
    <>
      <input value={query} onChange={onChange} />
      {isPending && <Spinner />}
      <ResultList items={results} />
    </>
  );
}
```

`startTransition` 只改变更新被分配到哪条 lane。transition lane 用 `workLoopConcurrent` 渲染，所以新的按键（同步 lane）会打断正在进行的列表渲染；React 丢弃 work-in-progress 树，先处理按键，再用最新的值重启 transition。`isPending` 本身是一个更高优先级 lane 上的状态更新，会先被渲染。在 React 19 中，回调可以是 async 的，这就是 **Actions** 的基础：`useActionState`、`<form action>` 和 `useOptimistic` 都通过 transition 追踪进行中的异步工作。

### `useDeferredValue`

`useDeferredValue(value)` 在紧急渲染中返回旧值，同时在 transition lane 上用新值安排第二次渲染。当你拿到的是一个 prop、控制不了对应的 `setState` 调用时，它就是作用在“值”上的 transition。记得给昂贵的子组件加 `memo`，否则紧急渲染照样会重新渲染它。

### Suspense

当组件读取尚未就绪的数据（通过 `use(promise)` 或支持 Suspense 的库）时，它会**抛出**——在 React 19 中，`use` 会抛出一个包装了 promise 的特殊异常。render 阶段在最近的 `<Suspense>` 边界捕获它，为该边界渲染 fallback，并在 promise 上挂一个监听。promise resolve 后，根节点被 “ping”，React 在 retry lane 上重试这个边界。由于 commit 之前 render 没有任何副作用，丢弃挂起的子树是安全的。

transition 会改变这一策略：如果一次 transition 会把已经可见的内容替换成 fallback，React 会继续显示旧 UI（current 树），让 transition 保持 pending。这就是用 `startTransition` 包裹的导航不会闪出 loading 的原因。

### 撕裂与 `useSyncExternalStore`

可中断渲染带来了一种新的故障模式。如果组件从可变的外部 store（Redux store、模块级变量、`window.location`）读取数据，而 store 恰好在 React 渲染中途让出时发生变化，那么让出前后渲染的组件会在同一次 commit 中显示不同的值——这就是**撕裂（tearing）**。`useSyncExternalStore(subscribe, getSnapshot)` 在 commit 之前再次检查快照，如果变了就同步重新渲染，从而解决这个问题。Redux（通过 `react-redux`）和 Zustand 等状态库内部都用它；如果你自己写 store，也应该用它。

## 工程上的实际影响

- **保持 render 纯净、廉价。**它可能执行多次、也可能被丢弃。副作用应放在事件处理函数或 effect 中。
- **把昂贵且不紧急的更新放进 transition**（过滤、切换 tab、导航），文本输入的状态保持紧急。transition 只在成本来自渲染时有效；它无法拆分一次 200ms 的同步函数调用——那需要优化、分块或挪到 Worker 中。
- **有意识地利用 bailout。**稳定的 props（或 React Compiler）、让状态尽量靠近使用它的地方、按更新频率拆分 context，都能让 `childLanes` 剪掉更多的树。
- **用 key 表示身份，不要用下标**；需要时主动改变 key 来重置状态。
- **优先用 `useEffect` 而不是 `useLayoutEffect`**，除非必须在绘制前测量或修改布局；layout effect 会阻塞这一帧。
- **用 React DevTools Profiler 和 Performance 面板测量。**React 19.2 在 Chrome DevTools 的 Performance 面板中加入了 React 专属轨道（Scheduler 与 Components），可以直接把 lanes 与 render/commit 耗时和浏览器自身的长任务、INP 数据放在一起看。

## Fiber 与细粒度响应式的对比

React 的模型是“重新执行组件、对输出做 diff”：易于推理，工作量与重新渲染的子树成正比，借助 bailout 和调度来控制成本。基于 signal 的框架走的是相反的路线：

| | React（Fiber） | Vue 3 | Solid / Svelte 5 runes / Preact Signals |
| --- | --- | --- | --- |
| 变化检测 | 重新渲染组件子树，diff 虚拟 DOM | 按组件做响应式依赖追踪，再 diff 虚拟 DOM（编译器优化） | signal 依赖图，只更新绑定的 DOM 节点 |
| 重新执行的单位 | 组件函数 | 组件 render 函数 | 单个 effect / 绑定 |
| 调度 | Lanes、可中断渲染、时间切片 | 批量异步队列（微任务），不可中断 | 基本同步传播，批量处理 |
| 优势 | 一致的快照，优先级，Suspense/transition 是一等公民 | 精确更新，模板熟悉易用 | 每次变化工作量最小，运行时极小 |
| 代价 | 不做记忆化会有多余渲染 | 响应式的坑（解构、Proxy） | 没有内置优先级，并发特性难以后补 |

两种路线都不是在所有场景下都更快。细粒度系统避免了 React 需要调度的大部分工作；React 则为此付出成本，换来把每次渲染都当作一个不可变快照来对待——可以排优先级、可以暂停、可以丢弃——而这恰恰是 transition 和 Suspense 所需要的。

## 总结

Fiber 把渲染变成对堆上工作单元的循环，于是 React 能在任意两个组件之间停下。双缓冲树保证工作进行中屏幕始终一致；render 阶段纯净且可重启，commit 阶段短小且原子。Lanes 用位掩码中的一个比特为每个更新标记优先级，让批处理、跳过与重放更新都变成廉价的集合运算；调度器把并发工作切成约 5ms 的小片，穿插在浏览器任务之间。Transition、`useDeferredValue`、Suspense 和 Actions 都只是这些机制之上的薄薄一层策略——而 React 要求你遵守的几乎每一条规则，从纯净的 render、稳定的 key 到 `useSyncExternalStore`，都是为了让这套机制保持正确。

## 参考资料

- React 文档：[Render and Commit](https://react.dev/learn/render-and-commit)、[Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state)、[useTransition](https://react.dev/reference/react/useTransition)、[useDeferredValue](https://react.dev/reference/react/useDeferredValue)、[useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)、[Suspense](https://react.dev/reference/react/Suspense)
- React 博客：[React v18.0](https://react.dev/blog/2022/03/29/react-v18)、[React v19](https://react.dev/blog/2024/12/05/react-19)、[React 19.2](https://react.dev/blog/2025/10/01/react-19-2)、[React Compiler v1.0](https://react.dev/blog/2025/10/07/react-compiler-1)
- React 源码：[react-reconciler](https://github.com/facebook/react/tree/main/packages/react-reconciler)（`ReactFiberWorkLoop`、`ReactFiberLane`、`ReactFiberBeginWork`、`ReactFiberCommitWork`）与 [scheduler](https://github.com/facebook/react/tree/main/packages/scheduler)
- Andrew Clark，[React Fiber Architecture](https://github.com/acdlite/react-fiber-architecture)（2016）
- React 18 工作组：[What happened to concurrent "mode"?](https://github.com/reactwg/react-18/discussions/64) 与 [What is tearing?](https://github.com/reactwg/react-18/discussions/69)
- React 旧版文档，[Reconciliation](https://legacy.reactjs.org/docs/reconciliation.html)
