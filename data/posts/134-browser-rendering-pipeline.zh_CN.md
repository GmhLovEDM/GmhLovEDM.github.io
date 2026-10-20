---
title: "从 DOM 到像素：深入浏览器渲染流水线（样式、布局、绘制、合成）"
tag: performance
description: 一次 DOM 改动到下一帧上屏之间浏览器做了什么——HTML 事件循环中的渲染步骤、Chromium RenderingNG 的各阶段与线程分工、强制同步布局、合成器动画、图层及其代价、content-visibility，以及如何用 INP 和 Long Animation Frames API 度量卡顿
date: "2026-10-20T13:30:00.000Z"
---

## 目标

大多数前端性能建议都是一串规则：用 `transform` 而不是 `left` 做动画、别在循环里读 `offsetHeight`、谨慎使用 `will-change`、长页面用 `content-visibility`。这些规则没错，但如果不知道它们*为什么*成立，遇到新场景时就很难举一反三。

本文跟着一次 DOM 改动一路走到像素：渲染在 HTML 事件循环中的位置、Chromium RenderingNG 流水线的各个阶段以及分别跑在哪个线程、为什么有些改动几乎免费而有些要付出一次完整布局的代价，以及如何在线上度量结果。文中以 Chromium 为主要参照，因为它的架构有详细的公开文档；"其他引擎"一节会说明哪些是共通的、哪些不同。

## 帧预算

60 Hz 显示器每 1000 / 60 ≈ 16.7 ms 显示一帧，120 Hz 约 8.3 ms 一帧。浏览器如果没能按时产出新帧，屏幕上就继续显示上一帧，用户看到的就是卡顿（jank）。web.dev 的渲染性能指南指出，浏览器自己在这个窗口里也有内务工作要做，因此建议在 60 Hz 下把你自己每帧的工作控制在约 **10 ms** 以内。

争抢这份预算的有两类工作：

- **你的 JavaScript**：事件处理函数、框架渲染、定时器、`requestAnimationFrame` 回调；
- **浏览器的渲染工作**：重算样式、布局、绘制、生成帧。

除非浏览器能把工作挪到别的线程，否则两者都跑在渲染进程的**主线程**上。本文的大多数技巧，要么是减少渲染工作量，要么是把工作移出主线程。

## 渲染在事件循环中的位置

HTML 规范把渲染定义为事件循环的一部分。一个任务（比如点击处理函数）及其微任务执行完之后，浏览器可能会为每个文档执行 **"update the rendering"（更新渲染）** 步骤。简化后的顺序是：

1. 执行 resize 和 scroll 步骤（派发 `resize`、`scroll` 事件）；
2. 评估媒体查询并通知变化；
3. 更新动画并派发动画事件；
4. 执行 **`requestAnimationFrame` 回调**；
5. **重算样式并更新布局**，然后派发 **`ResizeObserver`** 通知（如果观察者回调又改了东西，会再做一轮样式/布局）；
6. 更新 **`IntersectionObserver`** 的观察结果；
7. 绘制：让渲染结果反映当前状态。

这个顺序直接带来三个实际结论：

- `requestAnimationFrame` 恰好在**样式和布局之前**执行，所以它是为下一帧*写入*视觉变化的正确位置：你的写操作会被合并进那一次本来就要发生的样式/布局计算。
- 浏览器**不会**在每个任务之后都渲染。它在需要出帧时（通常对齐显示器的 vsync）且确实有变化时才渲染。一个任务里做一百次 DOM 修改，只付出一次样式/布局的代价——除非你强制它多做。
- 长任务会完全阻塞渲染。点击处理函数跑了 300 ms，这 300 ms 内就不可能出帧，而这正是 Interaction to Next Paint（INP）度量的东西。

## RenderingNG 流水线

Chromium 的 RenderingNG 架构文档把渲染拆成以下阶段：

| 阶段 | 做什么 | 运行位置 |
| --- | --- | --- |
| Animate（动画） | 应用声明式动画：随时间修改计算样式、变更属性树 | 主线程或合成器 |
| Style（样式） | 把 CSS 应用到 DOM，产出计算样式 | 主线程 |
| Layout（布局） | 计算盒子的尺寸与位置，生成不可变的 **fragment tree（片段树）** | 主线程 |
| Pre-paint（预绘制） | 计算 **property trees（属性树）**，按需使显示列表和 GPU 瓦片失效 | 主线程 |
| Scroll（滚动） | 通过修改属性树来更新滚动偏移 | 主线程或合成器 |
| Paint（绘制） | 生成 **display list（显示列表）**——绘制指令，而不是像素 | 主线程 |
| Commit（提交） | 把属性树和显示列表复制到合成器线程 | 主线程 → 合成器 |
| Layerize（分层） | 把显示列表拆成可独立光栅化、独立动画的合成图层 | 合成器 |
| Raster / decode / paint worklets | 把显示列表、编码图片和 paint worklet 代码变成 GPU 纹理瓦片 | 光栅线程 / GPU |
| Activate（激活） | 生成 **compositor frame（合成帧）**：如何绘制和摆放瓦片，以及视觉效果 | 合成器 |
| Aggregate（聚合） | 把所有可见帧（包括跨进程 iframe）和浏览器界面的合成帧合并成一个 | Viz（GPU）进程 |
| Draw（绘制上屏） | 在 GPU 上执行聚合后的合成帧，产出屏幕像素 | Viz（GPU）进程 |

文档里最关键的一句是：**不需要的阶段可以跳过**。视觉效果动画和滚动可以跳过布局、预绘制和绘制，这种情况下它们可以完全在合成器线程上运行，根本不碰主线程。

### 让"跳过"成为可能的数据结构

有两个中间产物特别值得关注，因为它们解释了成本模型：

- **属性树。** Chromium 不把 transform、clip、opacity 和滚动偏移烘焙进每条绘制指令，而是把它们分别放在四棵树里——transform、clip、effect、scroll。绘制块只引用这些树里的节点。当只有 transform 或 opacity 的值变化时，浏览器只更新一个树节点；显示列表依然有效，已经光栅化的瓦片可以复用。
- **显示列表与瓦片。** 绘制阶段记录的是"画这个矩形""画这段文字"之类的指令；光栅化把它们按瓦片转成 GPU 纹理。没变化的内容保留原有瓦片，滚动在很大程度上只是把已有瓦片画到新的偏移位置。

这就是那条熟悉规则背后的机制：在拥有独立合成图层的元素上修改 `transform` 或 `opacity`，只会修改一个属性树节点，合成器自己就能应用；而修改 `width` 会使布局失效，进而使绘制失效，再进而使受影响区域的光栅化失效。

## 各类改动的成本

一个好用的思维模型是：问一句"这个改动最先让哪个阶段失效"，它之后的所有阶段都得重跑。

| 改动 | 样式 | 布局 | 绘制 | 光栅 / 合成 |
| --- | --- | --- | --- | --- |
| `width`、`height`、`top`、`margin`、`font-size`、增删节点、修改文本 | 是 | 是 | 是 | 是 |
| `color`、`background-color`、`box-shadow`、`border-radius` | 是 | — | 是 | 是 |
| 在拥有独立合成图层的元素上改 `transform`、`opacity` | 是 | — | — | 仅合成 |

具体行为因引擎和版本而异（例如元素当时是否已经有独立图层），所以请把这张表当作模型，并用 DevTools 验证。但方向在各引擎之间是一致的：几何变化昂贵，纯视觉效果便宜。

样式计算本身也不是免费的。重算成本随"样式被失效的元素数量"和"需要与之匹配的选择器复杂度"增长。在 `<body>` 上切换一个类名可能让整个文档的样式失效；把类名切换在真正变化的组件上，失效范围就小得多。

## 强制同步布局与布局抖动

正常情况下布局是惰性的：你写样式，浏览器在下一个渲染时机统一布局一次。但有些 API *立刻*就需要最新的几何信息。在样式已"脏"的情况下读取 `offsetWidth`、`offsetTop`、`clientHeight`、`scrollTop`、`getBoundingClientRect()`、`getComputedStyle()` 中依赖布局的值、`innerText`，或者调用 `focus()`、`scrollIntoView()`，都会迫使浏览器在你的 JavaScript 执行中途同步完成样式和布局。Paul Irish 维护着一份被广泛引用的此类 API 清单。

一次强制布局有时无法避免，真正的问题是**布局抖动（layout thrashing）**：读写交替进行，导致每次读取都触发一次新的布局。

```js
// 布局抖动：每轮先写，下一轮的读就会再次强制布局
function resizeCardsSlow(container, cards) {
  for (const card of cards) {
    const width = container.offsetWidth;       // 读 -> 强制布局（第一次写之后）
    card.style.width = `${width / 3}px`;        // 写 -> 使布局失效
  }
}

// 批处理：一次读，然后全部写；布局只在下一帧执行一次
function resizeCardsFast(container, cards) {
  const width = container.offsetWidth;          // 只读一次
  for (const card of cards) {
    card.style.width = `${width / 3}px`;        // 只写
  }
}
```

有 500 张卡片时，第一种写法可能在一个任务里做 500 次布局，第二种只做一次。在大型代码库里，读和写分散在不同组件中，所以通常要从结构上解决：

- **读写分阶段。** 先统一测量（或者放在 `ResizeObserver` 回调里，它在布局之后给出尺寸，不会额外强制布局），再把写操作安排进 `requestAnimationFrame`。
- **让 CSS 来布局。** 一个 `grid-template-columns: repeat(3, 1fr)` 的网格就能用零行 JavaScript 替代上面整个循环。
- **留意框架的"逃生舱"。** React 的 `useLayoutEffect` 等钩子在 DOM 变更后同步执行；在里面测量没问题，但如果许多组件在其中反复"写—测"，就又造出了布局抖动。

## 在合成器上做动画

当动画只改变 `transform` 或 `opacity`，并且通过 CSS 动画、CSS 过渡或 Web Animations API 声明时，Chromium 可以把整个动画交给合成器线程。这样即使主线程正忙着执行 JavaScript，动画依然流畅。相比之下，每帧在 `requestAnimationFrame` 里设置 `style.left` 的循环，每帧都既需要主线程，*又*需要一次布局。

想给布局变化做动画、同时又留在合成器上，经典做法是 **FLIP**（First、Last、Invert、Play）：先测量起始位置，应用最终布局，再测一次，然后用 transform 从旧位置动画回零。

```js
// FLIP：只用 transform 为布局变化做动画
function flip(el, applyLayoutChange) {
  const first = el.getBoundingClientRect();     // First
  applyLayoutChange();                          // 例如把 el 移到另一列
  const last = el.getBoundingClientRect();      // Last（一次有意为之的强制布局）

  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = first.width / last.width;
  const sy = first.height / last.height;

  el.style.transformOrigin = 'top left';
  el.animate(                                   // Invert + Play
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transform: 'none' },
    ],
    { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
  );
}
```

View Transitions API 在平台层面实现了同样的思路：它给新旧状态拍快照，并用对合成器友好的效果在两者之间过渡，于是你不用自己算数学就能得到 FLIP 式的过渡效果。

滚动也是同样的逻辑。除非有东西迫使它先问主线程，Chromium 会在合成器线程上滚动。最常见的"元凶"是非 passive 的 `touchstart`、`touchmove` 或 `wheel` 监听器，因为浏览器必须等着看处理函数会不会调用 `preventDefault()`。把监听器声明为 passive 就能去掉这次等待：

```js
window.addEventListener('wheel', onWheel, { passive: true });
```

Chrome 已经默认把 `window`、`document`、`body` 上的这类监听器当作 passive；其他元素上的监听器仍需显式声明。与滚动联动的效果更适合用 CSS 滚动驱动动画（`animation-timeline: scroll()` / `view()`）来表达——对于合成器友好的属性，Chromium 可以把它们放到主线程之外运行——而不是写一个在 `scroll` 事件里改样式的处理函数。

## 图层：有用，但不免费

合成图层让合成器可以移动或淡入淡出内容而无需重绘。元素获得独立图层有显式原因——正在进行的 `transform`/`opacity` 动画、`will-change: transform`、video、canvas、某些情况下的 fixed 定位——也有隐式原因，例如与另一个合成图层重叠。

每个图层都有代价：瓦片占用的 GPU 内存，以及合成器里的簿记开销。web.dev 的建议是只提升那些你真的要做动画的元素，避免"以防万一"地提升大量元素。实践规则：

- 在动画开始前不久再加 `will-change`（或只保留在少量持续动画的元素上），而不是给列表里每张卡片都加；
- 警惕**图层爆炸**：层叠顺序靠下的一个被提升元素，可能导致许多与它重叠的元素也被提升；
- 用 DevTools 的 **Layers** 面板以及 **Rendering → Layer borders / Paint flashing** 选项，查看实际被提升和重绘的内容。

## 少做工作：containment 与 `content-visibility`

最便宜的渲染工作，是浏览器能证明不需要做的工作。CSS containment 就是给浏览器的证明。

- `contain: layout` 告诉引擎该元素内部的布局不会影响外部，内部变化不需要重新布局页面其余部分；
- `contain: paint` 把后代裁剪在元素盒子内，屏幕外的后代永远不需要绘制；
- `contain: size` 声明元素尺寸不依赖其子元素。

`content-visibility: auto` 组合了这些能力并更进一步：对于远离视口的元素，浏览器会**完全跳过其子树的样式、布局和绘制**，直到它们接近屏幕。对于长文档、信息流和聊天记录，这能大幅削减首次渲染的工作量。由于被跳过的子树没有布局，需要给它一个占位尺寸，避免滚动条跳动：

```css
.feed-item {
  content-visibility: auto;
  /* "auto" 会记住上次渲染的真实尺寸；600px 只是首次的估计值 */
  contain-intrinsic-size: auto 600px;
}
```

需要注意的取舍：被跳过的内容仍在 DOM 中、仍可被无障碍技术访问，但页内查找和锚点跳转会让浏览器按需渲染它们；`contain-intrinsic-size` 估得不准，会导致元素渲染时滚动条移动。对于上万条数据的列表，虚拟化（只渲染可见行）依然更优，因为 DOM 节点本身就占内存。

## 拆分长任务

任务运行期间无法渲染，所以流畅 UI 的另一半是让 JavaScript 任务保持短小。按惯例，超过 50 ms 的任务就是长任务。主要手段是**让出主线程（yield）**：把工作切成小块，在块与块之间给浏览器渲染和处理输入的机会。

```js
function yieldToMain() {
  if (globalThis.scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function processAll(items, handle) {
  let deadline = performance.now() + 8;          // 远低于一帧的时长
  for (const item of items) {
    handle(item);
    if (performance.now() > deadline) {
      await yieldToMain();                       // 让浏览器渲染、处理输入
      deadline = performance.now() + 8;
    }
  }
}
```

在可用时，`scheduler.yield()` 优于 `setTimeout`，因为它的后续执行会排在同优先级的其他排队任务之前，让出主线程不会把你的工作送到队尾。对于交互，常见模式是先给出即时视觉反馈（比如切换按下状态），让出主线程以便下一次绘制发生，然后再做耗时的部分。

## 如何度量

实验室分析和线上度量回答的是不同问题，两者都需要。

- **DevTools Performance 面板。** 性能记录里能看到主线程上的任务，紫色块是样式/布局，绿色块是绘制。强制布局会被标出警告，并附带指向读取几何信息那行 JavaScript 的调用栈。
- **INP（Interaction to Next Paint）。** 衡量响应性的 Core Web Vital：从一次交互到下一帧呈现的时间，包含输入延迟、处理函数耗时和渲染。200 ms 及以内为"良好"，超过 500 ms 为"差"。
- **Long Animation Frames API（LoAF）。** 旧的 Long Tasks API 只能告诉你"某个任务很长"；LoAF 会报告总工作量超过 50 ms 的帧，并把时间归因到具体脚本——包括每个脚本有多少时间花在强制样式与布局上。

```js
new PerformanceObserver((list) => {
  for (const frame of list.getEntries()) {
    for (const script of frame.scripts) {
      if (script.forcedStyleAndLayoutDuration > 10) {
        console.warn('Forced layout', {
          source: script.sourceURL,
          fn: script.sourceFunctionName,
          invoker: script.invoker,
          ms: Math.round(script.forcedStyleAndLayoutDuration),
        });
      }
    }
  }
}).observe({ type: 'long-animation-frame', buffered: true });
```

把这些数据（以聚合形式）上报到你的 RUM 系统，就能知道在真实设备上是哪些脚本造成了布局抖动——真实设备通常比开发者的笔记本慢得多。

## 其他引擎

整体形态——样式、布局、绘制成显示列表，然后在 GPU 上光栅化和合成——是所有现代引擎共通的，但工作的划分方式不同：

- **Chromium（Blink + cc + Viz）** 使用属性树，每个渲染进程有一个合成器线程，并由独立的 Viz 进程聚合来自站点隔离 iframe 和浏览器界面的帧；
- **Firefox（Gecko + WebRender）** 在主线程构建显示列表，交给 WebRender 在 GPU 上渲染，方式很像游戏引擎每帧绘制一个场景。Mozilla 介绍 WebRender 的文章把目标描述为：消除"决定哪些内容放进图层"这一卡顿来源；
- **WebKit（Safari）** 同样基于图层合成（在苹果平台上由 Core Animation 支撑），并在主线程之外运行加速动画和滚动。

本文的性能规则在三者中都成立，因为它们源自同一个事实：几何变化会波及后续每个阶段，而 transform、opacity 和滚动可以直接作用在已经渲染好的内容上。

## 检查清单

1. 让每个任务保持短小；在长循环中、在为交互提供即时反馈之后让出主线程。
2. 永远不要交替读取几何信息和写入样式；先读，在 `requestAnimationFrame` 里写。
3. 用 CSS 或 Web Animations API 对 `transform` 和 `opacity` 做动画；布局变化用 FLIP 或 View Transitions。
4. 把滚动和触摸监听器设为 passive；优先用 CSS 滚动驱动动画替代 scroll 处理函数。
5. 有意识地提升图层，并在 DevTools 里检查。
6. 对独立的、屏幕外的区块使用 `contain` 和 `content-visibility: auto`；超长列表使用虚拟化。
7. 度量 INP，并从真实用户那里收集 LoAF 归因数据。

## 总结

一帧画面是一条流水线的产物：事件循环在任务之后给渲染留出时机，样式和布局把 DOM 与 CSS 变成片段树，绘制记录显示列表，合成器和 GPU 再把瓦片与属性树变成像素。每一条渲染经验法则，都是关于这条流水线的陈述：几何变化会使早期阶段及其后所有阶段失效；transform、opacity 和滚动只触及属性树，可以在合成器上运行；强制同步布局把流水线拖进你的 JavaScript 中间；containment 让浏览器跳过它能证明不必要的工作。一旦你能说清某个改动让哪个阶段失效、哪个线程需要干活，就能在分析之前预估它的成本——再用性能分析工具去验证。

## 参考资料

- Chrome for Developers，[RenderingNG overview](https://developer.chrome.com/docs/chromium/renderingng)
- Chrome for Developers，[RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)
- Chrome for Developers，[Key data structures in RenderingNG](https://developer.chrome.com/docs/chromium/renderingng-data-structures)
- Chrome for Developers，[Inside look at modern web browser (part 3)](https://developer.chrome.com/blog/inside-browser-part3)
- WHATWG HTML 标准，[Event loops 与 "update the rendering" 步骤](https://html.spec.whatwg.org/multipage/webappapis.html)
- web.dev，[Rendering performance](https://web.dev/articles/rendering-performance)
- web.dev，[Avoid large, complex layouts and layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)
- web.dev，[Stick to compositor-only properties and manage layer count](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)
- web.dev，[content-visibility: the new CSS property that boosts your rendering performance](https://web.dev/articles/content-visibility)
- MDN，[contain](https://developer.mozilla.org/en-US/docs/Web/CSS/contain)
- Paul Irish，[What forces layout / reflow](https://gist.github.com/paulirish/5d52fb081b3570c81e3a)
- web.dev，[Interaction to Next Paint (INP)](https://web.dev/articles/inp)
- Chrome for Developers，[Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- Chrome for Developers，[Use scheduler.yield() to break up long tasks](https://developer.chrome.com/blog/use-scheduler-yield)
- Mozilla Hacks，[The whole web at maximum FPS: How WebRender gets rid of jank](https://hacks.mozilla.org/2017/10/the-whole-web-at-maximum-fps-how-webrender-gets-rid-of-jank/)
