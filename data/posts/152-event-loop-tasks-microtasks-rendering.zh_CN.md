---
title: "深入 JavaScript 事件循环：任务、微任务、渲染步骤、Node.js 阶段与主线程让出"
tag: javascript
description: 浏览器与 Node.js 中 JavaScript 事件循环的真实工作方式——HTML 处理模型、任务队列与微任务队列、requestAnimationFrame 与渲染所处的位置、定时器钳制、Node 的 libuv 阶段与 process.nextTick / setImmediate、微任务饥饿，以及拆分长任务的实用手段（setTimeout、MessageChannel、scheduler.postTask、scheduler.yield）与 INP 优化
date: "2026-11-07T10:30:00.000Z"
---

## Goal

「JavaScript 是单线程的，有一个事件循环」——每个前端工程师都知道这句话，但大多数解释也就停在这里。于是 `setTimeout`、`Promise.then`、`requestAnimationFrame` 的执行顺序题反复出现在面试里，更重要的是反复出现在线上问题里：永远画不出来的 loading、点击后迟钝的按钮、定时器漂移几百毫秒的 Node.js 服务。

本文讲清背后的真实机制：

1. HTML 事件循环处理模型：任务、微任务检查点，以及「更新渲染」步骤。
2. `requestAnimationFrame`、样式、布局、绘制在一帧中的位置。
3. 定时器语义，包括嵌套定时器钳制。
4. Node.js：libuv 各阶段、`process.nextTick`、`setImmediate`，以及与浏览器的差异。
5. 实测微任务饥饿。
6. 让出主线程的几种方式——`setTimeout`、`MessageChannel`、`scheduler.postTask`、`scheduler.yield`——以及 React 调度器的做法。
7. 这些机制如何对应到 Interaction to Next Paint（INP）。

下文所有 Node.js 输出均在 Node.js v20.19.2 上实际运行得到。

## 1. 引擎没有事件循环，宿主才有

一个常见误解是 V8（或 SpiderMonkey、JavaScriptCore）「自带事件循环」。其实没有。ECMAScript 规范只定义了 *job* 和 *job 队列*（Promise 回调就是 job），*何时*执行它们由**宿主**决定。浏览器实现的是 [HTML 标准中的事件循环](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops)；Node.js 则在 [libuv](https://docs.libuv.org/en/v1.x/design.html) 之上实现自己的循环。

引擎为循环提供的关键东西只有一个：唯一的**调用栈**。只要栈上还有 JavaScript 帧，该 realm 里其他任何代码都无法运行。所有调度 API 本质上都是在说「等栈空了再跑这个」。

## 2. 浏览器处理模型

按 HTML 标准简化，窗口事件循环每一轮做这些事：

```text
loop:
  1. 从某个任务队列中取出「一个」可运行任务
     （由浏览器选择队列，例如可以优先输入事件）
  2. 运行至完成
  3. 执行微任务检查点：
       只要微任务队列非空，就运行最早的微任务
  4. 如果是渲染时机（"update the rendering"）：
       - 触发 resize / scroll 事件
       - 计算媒体查询、推进动画
       - 运行 requestAnimationFrame 回调
       - 重新计算样式、布局
       - 运行 ResizeObserver / IntersectionObserver 相关步骤
       - 绘制（把一帧交给合成器）
  5. 若下一帧前还有空闲：requestIdleCallback
```

有几个细节很关键：

- **任务队列不止一个。** 定时器、DOM 事件、网络回调、`postMessage` 都是*任务*，但规范允许浏览器把它们放在不同队列并自行挑选。比如 Chromium 可以优先处理输入。你能依赖*同一来源内*的顺序（两个 `setTimeout(fn, 0)` 按序执行），但不能依赖*跨来源*的顺序。
- **每轮只跑一个任务，却清空所有微任务。** 每个任务之后都会把微任务队列彻底清空，包括微任务里新加入的微任务。
- **不是每轮都渲染。** 「更新渲染」只在渲染时机发生，通常与屏幕刷新对齐（60 Hz 下约 16.7 ms），后台标签页还可能直接跳过。所以一个 `while` 循环里改一千次 `element.style`，最终只会画出最后的状态。

### 任务与微任务的划分

| 类型 | 例子 |
| --- | --- |
| 任务（宏任务） | `setTimeout`/`setInterval` 回调、用户输入触发的 DOM 事件、`MessageChannel`/`postMessage`、`XMLHttpRequest` 的 load 事件、`scheduler.postTask` |
| 微任务 | Promise 回调（`.then`、`await` 之后的续体）、`queueMicrotask`、`MutationObserver` 回调 |
| 渲染步骤 | `requestAnimationFrame`、`ResizeObserver`、样式/布局/绘制 |
| 空闲 | `requestIdleCallback` |

`await x` 是「挂起，并在 Promise 回调 job 中恢复」的语法糖。所以 `await` *之后*的代码总是以微任务形式运行，即使 `x` 根本不是 Promise。

## 3. 一帧的实际情况：为什么 loading 不显示

```js
button.addEventListener('click', () => {
  spinner.hidden = false;      // 改 DOM
  const result = heavyCompute(); // 400 ms 同步计算
  spinner.hidden = true;
  render(result);
});
```

用户永远看不到 loading。点击处理函数是一个任务，渲染只能在任务（及其微任务）结束*之后*发生，而那时 `hidden` 已经又变回 `true`。把计算挪进 Promise 也没用：

```js
spinner.hidden = false;
await Promise.resolve();        // 仍是微任务：在渲染之前运行
heavyCompute();
```

微任务在渲染步骤*之前*执行，这和同步执行没有区别。要让一帧画出来，必须让出到**任务**边界（或 `requestAnimationFrame` 加任务的组合），第 7 节会展开。

### requestAnimationFrame 不是定时器

`requestAnimationFrame(cb)` 会在下一次「更新渲染」中、样式与布局计算之前执行 `cb`。因此它适合做视觉写入（每帧一次、与绘制同步），却不适合「尽快执行」的逻辑——在隐藏标签页中 rAF 回调可能根本不执行。

「在下一次绘制之后执行」的常用写法：

```js
function afterNextPaint(fn) {
  requestAnimationFrame(() => {
    // 此刻处于本帧样式/布局/绘制之前
    // 这里投递的任务会在这次绘制之后运行
    setTimeout(fn, 0);
  });
}
```

## 4. 定时器：「0 ms」是下限而非承诺

`setTimeout(fn, delay)` 会在*不早于* `delay` 毫秒之后排入一个任务。有三个因素让它更晚：

1. **循环必须空闲。** 主线程忙 200 ms，0 ms 定时器就要等 200 ms。
2. **嵌套定时器钳制。** HTML 标准的[定时器初始化步骤](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers)规定：嵌套层级超过 5 后，小于 4 ms 的超时会被提升到 4 ms。所以浏览器里一串 `setTimeout(f, 0)` 在前几跳之后会慢到每跳约 4 ms。
3. **后台节流。** 浏览器会对隐藏标签页的定时器节流，Chromium 中[可降到每秒一次，长时间隐藏的页面更严格](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)。

Node.js 没有实现 HTML 的 4 ms 钳制，而是把小于 1 ms 的延迟统一当作 1 ms。实测十层嵌套的 `setTimeout(f, 0)`：

```js
let depth = 0, last = performance.now(); const d = [];
function f() {
  const now = performance.now();
  d.push((now - last).toFixed(2)); last = now;
  if (++depth < 10) setTimeout(f, 0); else console.log('gaps ms:', d.join(' '));
}
setTimeout(f, 0);
```

```text
gaps ms: 1.54 1.17 1.08 1.08 1.14 1.08 1.07 1.07 1.08 1.13
```

在 Node.js 中每跳约 1 ms——不贵，但相比微任务或 `setImmediate` 仍是真实延迟。同样的链在浏览器里从第六跳起会出现 4 ms 钳制。

## 5. Node.js：libuv 的各个阶段

Node.js 运行的是另一套循环。libuv 按固定顺序遍历各阶段，见 [Node.js 事件循环指南](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)：

```text
   ┌───────────────────────────┐
┌─>│           timers          │  setTimeout / setInterval 回调
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │     pending callbacks     │  部分延后的系统回调（如 TCP 错误）
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │       idle, prepare       │  内部使用
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           poll            │  等待 I/O，执行 I/O 回调
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           check           │  setImmediate 回调
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
└──┤      close callbacks      │  'close' 事件
   └───────────────────────────┘
```

在阶段之上，Node.js 还有两个队列，会在**每个回调之间**被清空（自 Node.js 11 起，而不仅是阶段之间）：

1. `process.nextTick` 队列。
2. Promise 微任务队列（`then`、`await`、`queueMicrotask`）。

nextTick 队列先清空。下面验证执行顺序：

```js
const log = [];
setTimeout(() => log.push('timeout'), 0);
setImmediate(() => log.push('immediate'));
Promise.resolve().then(() => log.push('promise'));
process.nextTick(() => log.push('nextTick'));
queueMicrotask(() => log.push('queueMicrotask'));
(async () => { log.push('async-sync-part'); await null; log.push('after-await'); })();
log.push('sync');
setTimeout(() => console.log(log.join(' -> ')), 20);
```

```text
async-sync-part -> sync -> nextTick -> promise -> queueMicrotask -> after-await -> immediate -> timeout
```

要点：

- `async` 函数体在第一个 `await` 之前同步执行。
- `nextTick` 虽然在第一个 `.then` 之后才注册，却先于所有 Promise 微任务执行。
- 三个 Promise 队列项按入队顺序 FIFO 执行。
- **在主模块中，`immediate` 与 `timeout` 的先后不确定。** 取决于循环进入 timers 阶段时 1 ms 定时器是否已到期，不要依赖它。

但在 I/O 回调内部，顺序*是*确定的，因为 poll 阶段之后循环一定先到 check 阶段，再绕回 timers：

```js
const fs = require('fs');
fs.readFile(__filename, () => {
  const o = [];
  setTimeout(() => o.push('timeout'), 0);
  setImmediate(() => o.push('immediate'));
  setTimeout(() => console.log('inside I/O callback:', o.join(' -> ')), 10);
});
```

```text
inside I/O callback: immediate -> timeout
```

这就是 Node.js 文档推荐用 `setImmediate` 而非 `setTimeout(fn, 0)` 实现「在当前 I/O 之后执行」的原因：更早，也可预测。

### 浏览器与 Node.js 对比

| 关注点 | 浏览器 | Node.js |
| --- | --- | --- |
| 循环定义来源 | HTML 标准 | libuv 阶段 + Node.js 内部实现 |
| 最高优先级的延后 | 微任务 | `process.nextTick`，然后微任务 |
| 「在 I/O / 下个任务之后执行」 | `MessageChannel`、`scheduler.postTask` | `setImmediate` |
| 定时器最小延迟 | 嵌套 5 层后 4 ms | 1 ms |
| 渲染步骤 | 有（rAF、样式、布局、绘制） | 无 |
| 阻塞型工作的线程 | Web Worker | libuv 线程池（fs、dns.lookup、crypto、zlib）、`worker_threads` |

## 6. 微任务饥饿

微任务队列会一直清空到空为止，所以一个不断入队新微任务的微任务会让*任何*任务都无法运行——定时器、I/O，在浏览器里还包括渲染和输入。

```js
let n = 0, t0 = Date.now();
setTimeout(() => console.log(`timer fired after ${Date.now() - t0}ms, microtasks run: ${n}`), 0);
function spin() { if (++n < 1e6) queueMicrotask(spin); }
spin();
```

```text
timer fired after 97ms, microtasks run: 1000000
```

0 ms 定时器等完了全部一百万个微任务；如果递归没有上限，它永远不会触发。递归 `process.nextTick` 同理，Node.js 文档明确警告它会「饿死 I/O」。现实中的例子包括在紧凑循环里 resolve Promise 的流消费者，或递归刷新更新的响应式库。

结论：微任务用于*一致地完成*一个工作单元（例如在被观察前合并状态更新），而不是用来*摊开*工作。摊开工作需要任务。

## 7. 让出主线程

按 [Long Tasks API](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming)，超过 50 ms 的任务就是长任务。它运行期间，输入事件排队、帧被丢弃。解决办法是把工作切块并在块之间让出。即使在 Node.js 中也很容易看到差别，这里用 1 ms 的 `setInterval` 代表「其他想运行的工作」：

```js
function work(ms) { const e = performance.now() + ms; while (performance.now() < e); }
// 切块：40 块 × 5 ms，每块之间用 setImmediate 让出
// 整块：一次 200 ms 忙循环
```

```text
chunked: 40x5ms work, interval ticks during=39, total=205ms
monolithic: 200ms work, interval ticks during=1, total=202ms
```

总耗时相同，但切块版本让其他回调获得了 39 次运行机会，而不是 1 次。在浏览器里，这些机会就是处理点击、绘制帧的时机。

### 浏览器中的可选方案

**`setTimeout(fn, 0)`**——兼容性最好，但受嵌套 4 ms 钳制与后台节流影响。续体会排到定时器队列*末尾*，排在其他已调度工作之后。

**`MessageChannel`**——给自己 post 消息即可创建一个不受定时器钳制的任务：

```js
const channel = new MessageChannel();
const queue = [];
channel.port1.onmessage = () => queue.shift()();
function postTaskFallback(fn) { queue.push(fn); channel.port2.postMessage(null); }
```

这正是 React 调度器在浏览器中的做法：`Scheduler` 包用 `MessageChannel` 调度工作，并在短时间片后让出（`frameYieldMs` 配置，[源码](https://github.com/facebook/react/blob/main/packages/scheduler/src/forks/Scheduler.js)中默认 5 ms），在工作单元之间检查 `shouldYield()`。React 并发渲染正是借此在渲染大型组件树时保持输入响应。

**`scheduler.postTask(fn, { priority })`**——属于 [Prioritized Task Scheduling API](https://wicg.github.io/scheduling-apis/)。优先级有 `user-blocking`、`user-visible`（默认）和 `background`，可以通过 `TaskController` 的 `AbortSignal` 取消。

**`scheduler.yield()`**——返回一个在新任务中 resolve 的 Promise，且续体会*优先于*同优先级的普通任务，因此你的工作不会被无关的第三方脚本插队。它在 [Chrome 129](https://developer.chrome.com/release-notes/129)（2024 年 9 月）上线，据 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) Firefox 142+ 也已支持，但 Safari 尚不支持，所以要做特性检测：

```js
function yieldToMain() {
  if (globalThis.scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function processAll(items, handle) {
  let deadline = performance.now() + 50;
  for (const item of items) {
    handle(item);
    if (performance.now() >= deadline) {
      await yieldToMain();
      deadline = performance.now() + 50;
    }
  }
}
```

按时间预算而不是每 N 项让出，可以压低开销：每次让出至少一次任务跳转（用 `setTimeout` 兜底时可能还有 4 ms）。

**`requestIdleCallback`**——用于真正可延后的工作（埋点、预取）。它只在下一帧前有空闲时运行，并传入带 `timeRemaining()` 的 `deadline`。不要放用户可见的工作；在繁忙页面上，不传 `timeout` 可能被无限推迟。

**Web Worker**——如果工作不需要 DOM，搬离主线程比任何让出都有效。代价是结构化克隆的序列化开销（可用可转移的 `ArrayBuffer` 实现零拷贝）。

### 如何选择

| 需求 | 最佳选择 |
| --- | --- |
| 在被观察前一致地完成状态更新 | 微任务（`queueMicrotask`、Promise） |
| 与绘制同步的视觉更新 | `requestAnimationFrame` |
| 拆分长任务并保持队列位置 | `scheduler.yield()` + `setTimeout` 兜底 |
| 带优先级、可取消的独立任务 | `scheduler.postTask` |
| 低优先级延后工作 | 带 `timeout` 的 `requestIdleCallback` |
| CPU 密集、不涉及 DOM 的计算 | Web Worker |
| Node.js：在当前 I/O 回调之后执行 | `setImmediate` |

## 8. 与 INP 的联系

自 2024 年 3 月起，[Interaction to Next Paint（INP）](https://web.dev/articles/inp)取代 First Input Delay 成为 Core Web Vital。INP 衡量一次交互从输入到下一帧呈现的时间，并拆成三段，每段都直接对应事件循环：

1. **输入延迟**——输入事件任务在等待，因为别的任务正在跑。对策：拆分页面上其他地方的长任务（第三方脚本、hydration）。
2. **处理时间**——你的事件处理函数在执行。对策：只做视觉反馈必需的最少工作，然后让出，再做其余部分。
3. **呈现延迟**——处理函数之后的样式、布局、绘制。对策：缩小 DOM 更新、避免强制同步布局、对屏幕外内容使用 `content-visibility`。

良好阈值是第 75 百分位 INP 不超过 200 ms。最常见的有效修复模式是「先更新 UI，再让出」：

```js
button.addEventListener('click', async () => {
  showPressedState();       // 便宜且可见
  await yieldToMain();      // 让浏览器先把反馈画出来
  await saveAndRecompute(); // 昂贵部分
});
```

[Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)（LoAF，Chrome 123 上线）是配套的诊断工具：它上报工作超过 50 ms 的帧并附带脚本归因，比旧的 Long Tasks 条目更能定位是哪个脚本造成了输入延迟。

## 9. 工程清单

- 清楚你的回调进入哪个队列：任务、微任务、渲染步骤还是空闲。
- 永远不要假设 `setTimeout(fn, 0)` 会「立即」执行；在浏览器中它会被钳制和节流。
- 不要用递归微任务或 `process.nextTick` 处理无上限的工作。
- 在 Node.js 中优先用 `setImmediate` 做延后；记住回调里的 CPU 密集工作会阻塞该进程上的*所有*请求——把它交给 `worker_threads` 或其他服务。
- 在浏览器中先给反馈再做重活；条件允许时用 `scheduler.yield()`。
- 需要与帧对齐的 DOM 写入用 `requestAnimationFrame`，并先读后写以避免布局抖动。
- 用 Performance 面板、LoAF 和真实用户 INP 数据来度量，而不是靠猜。

## References

- [HTML Standard — Event loops](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops)
- [HTML Standard — Timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers)
- [Node.js — The Node.js Event Loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [libuv — Design overview](https://docs.libuv.org/en/v1.x/design.html)
- [MDN — Scheduler.yield()](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield)
- [WICG — Prioritized Task Scheduling](https://wicg.github.io/scheduling-apis/)
- [web.dev — Interaction to Next Paint](https://web.dev/articles/inp)
- [Chrome for Developers — Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- [React scheduler 源码](https://github.com/facebook/react/blob/main/packages/scheduler/src/forks/Scheduler.js)
- Jake Archibald，[Tasks, microtasks, queues and schedules](https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/)
