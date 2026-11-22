---
title: "深入 View Transition API：快照、命名配对，以及浏览器真正在动画什么"
tag: javascript
description: View Transition API 如何在不必把两种状态同时留在 DOM 里的前提下，把一次文档更新变成视觉过渡——startViewTransition 的生命周期与 Promise、按 view-transition-name 捕获并配对、::view-transition 伪元素树与用户代理默认交叉淡入淡出、同文档与跨文档以及元素作用域过渡、React 19.3 的 ViewTransition 组件，再加上一个可运行模型，用来度量默认几何动画、绘制顺序、重名跳过与文档隐藏时的跳过
date: "2026-11-22T11:55:00.000Z"
---

## Goal

多年来，两种 UI 状态之间的平滑过渡，几乎都意味着这两种状态必须同时存在于 DOM 中。要把缩略图“飞”进大图，你得把元素从原来的容器里提出来、留下占位，再走一遍 FLIP（First、Last、Invert、Play）——或者把这些记账交给 Motion、GSAP 一类库。这个中间树会带来裁剪错误、焦点异常和可访问性缺口：辅助技术看到的结构，只是为了让一张图能移动才存在的。

View Transition API 换了一种切法。文档一次性切到新状态。浏览器捕获旧像素、再捕获新状态，然后把动画播放在一棵位于实况 DOM 之上的伪元素树上。真正的文档树从来不会处于“两种状态并存”的阶段。同文档过渡——`document.startViewTransition()` 加上 `view-transition-name`——在 Firefox 144 加入 Chromium 与 WebKit 之后，于 2025 年 10 月 14 日成为 Baseline Newly available。跨文档过渡与元素作用域过渡是更晚的扩展，引擎支持面更窄。

本文会讲到：

1. 为什么中间 DOM 状态代价高，以及这套 API 用什么取而代之。
2. `startViewTransition` 的生命周期，包括那些 Promise，以及“更新一定会执行”这条规则。
3. 快照如何被捕获，又如何按 `view-transition-name` 配对。
4. `::view-transition` 伪元素树，以及用户代理的默认动画。
5. 同文档、跨文档，以及元素作用域过渡。
6. React 19.3 的 `<ViewTransition>` 如何映射到平台 API。
7. 生产环境里真正会碰到的取舍。
8. 一个可运行模型：配对、默认运动、绘制顺序和跳过规则。

## 1. 把两种状态同时留在树里的问题

CSS transition 只能对“还存在的元素”插值 `transform` 和 `opacity`。若列表项从一个容器搬到另一个容器，或一次路由切换卸载了整页再挂上下一页，就没有一个可以拿来做过渡的单一元素。常见做法是在根级覆盖层里保留一份视觉克隆，测量 First 与 Last 的盒子，用 transform 把差值倒过来，再播回单位变换——也就是 FLIP。

这套办法是有效的，在你需要对实况文字做逐属性插值、或要跟手势驱动的弹簧时，它也仍然是合适的工具。但它强制引入一棵临时树。溢出裁剪和 `transform` 包含块属于原来的父级，克隆必须从中逃逸。键盘焦点和可访问性树会看到你留在原地的那些节点。如果用户希望减少动效，你不但要跳过动画，还得记得把克隆一并拿走。

View Transitions 把依赖反过来。DOM 更新是真相来源，并且立即发生。动画是从捕获结果绘制出的增强，捕获树也不会暴露给可访问性树。如果动画创建不了——重名、文档被隐藏、引擎尚未实现该 API——更新依然会发生。规范把这一点写成设计规则，而不是意外行为。

## 2. `startViewTransition` 的生命周期

同文档过渡只需要一次调用：

```javascript
function renderNextView() {
  // 路由切换、setState，或任何其他 DOM 变更
}

if (!document.startViewTransition) {
  renderNextView();
  return;
}

const transition = document.startViewTransition(() => {
  renderNextView();
});
```

Level 1 规范里，一次成功的过渡会经历这些阶段：

1. 调用方执行 `document.startViewTransition(updateCallback)`，得到一个 `ViewTransition` 对象。
2. 把当前状态捕获为**旧**状态。
3. 暂停渲染。
4. 运行 `updateCallback` 并更新文档。它返回的 Promise 兑现后，`viewTransition.updateCallbackDone` 兑现。
5. 把当前状态捕获为**新**状态。
6. 创建过渡伪元素。
7. 恢复渲染，露出这些伪元素，并且 `viewTransition.ready` 兑现。
8. 伪元素播放动画直至结束。
9. 移除伪元素，`viewTransition.finished` 兑现。

三个 Promise，对应三个时刻：

| Promise | 何时兑现 |
| --- | --- |
| `updateCallbackDone` | 更新回调已经结束（若没传回调，则会立即兑现） |
| `ready` | 伪元素树已经建好，动画即将开始 |
| `finished` | 动画结束，用户交互的是新视图 |

更新回调**一定会被调用**，即使视觉过渡将被跳过。在生命周期一开始就调用 `skipTransition()`，会丢掉快照和伪元素树，但不会丢掉回调。回调拒绝会跳过动画，并让相关 Promise 拒绝。若文档的可见性变成 `hidden`——窗口被最小化、前面是另一个标签页——进行中的过渡会以 `InvalidStateError` 被跳过。

因为从捕获旧状态到捕获新状态之间渲染是暂停的，回调若跑得慢，用户看到的就是旧状态的最后一帧被冻住。在回调里做状态切换即可，不要在那里发起网络请求再干等。

若你在 React 自己的渲染器旁边直接使用平台 API，回调必须在返回之前把新 DOM 呈现出来。React 18+ 里裸的 `setState` 是异步的，浏览器会把旧树当成“新”状态捕获，结果就是没有动画。围绕原始 `startViewTransition` 调用，`flushSync` 是常用的硬手段。下文会谈到的 React 19.3 内置组件会接管这一时序，在那棵树里你不应再自己调用 `startViewTransition`。

## 3. 捕获与配对

默认情况下，用户代理样式表会给文档元素设置 `view-transition-name: root`，因此每次过渡至少有一个整页分组。任何你希望单独做动画的元素，都需要一个名字：

```css
.hero-image {
  view-transition-name: hero;
}
```

这个名字是**配对键**，不是元素身份。旧树里名为 `hero` 的元素，与新树里另一个名为 `hero` 的元素，会被当成同一个概念对象的两种视觉状态，并共享一个 `::view-transition-group(hero)`。这也是缩略图能在路由切换中变形为大图的原因：两个节点不必是同一个对象，只要共享一个名字。

在每一种状态里，名字必须在**已渲染**元素之间唯一。若捕获时有两个已渲染元素计算出相同的 `view-transition-name`，捕获失败，`ready` 拒绝，视觉过渡被跳过。DOM 更新仍然保留。这是生产里最常见的踩坑——列表每一行都写 `view-transition-name: card`，或者上一个屏幕的名字泄漏到了当前屏幕。

按绘制顺序，捕获算法大致是：

1. 跳过扁平树祖先会跳过其内容的元素、未渲染的元素，以及名字为 `none` 的元素。
2. 跳过拥有多于一个盒子片段的元素。（行盒之间的行内折行是允许的；跨列或跨页的分段则不行。）
3. 若该名字在这一状态里已经用过，则整次过渡失败。
4. 记录边框盒、一个把该盒子从快照包含块原点映射过去的 transform，以及若干样式值（`writing-mode`、`direction`、`mix-blend-mode`、`backdrop-filter`、`color-scheme` 等）。
5. 绘制图像。对文档元素，快照是快照包含块——覆盖“可能显示页面内容”的矩形，包括移动端地址栏这类短暂的浏览器 UI，好让新旧根图像对齐。对其余元素，图像是该元素及其子孙的墨水溢出矩形。

几条渲染规则在实践中很要紧：

- 元素自身的 transform **不会**烤进位图，而是重新施加在 `::view-transition-group()` 上，好让分组去插值它。
- 元素及其子孙上的 filter 与 opacity 会被捕获；来自**祖先**的同样效果会被忽略，因为那些祖先未必属于这个分组。
- 自身带有 `view-transition-name` 的子孙会从祖先的图像里被省略，以免画两次。
- `view-transition-name` 不为 `none` 的元素会形成层叠上下文、在 3D 中被扁平化，并成为 backdrop root——**即使当前并没有正在进行的过渡**。给很大的子树起名并不是免费的。

Level 2 与当前引擎还提供 `view-transition-name: match-element`，它按元素身份分配一个内部的、唯一的名字。这足以支撑同文档里对一份稳定列表的重新排序，因为排序前后是同一个节点。它不会把一条路由上的缩略图与下一条路由上的大图配在一起，因为那是不同的元素（在多页应用里，还是不同的文档）。共享元素变形仍然需要你显式起名。

## 4. 伪元素树与默认动画

两次捕获结束后，引擎会构建一棵遵守树结构的伪元素树，全部源出于文档元素：

```
::view-transition
├─ ::view-transition-group(name)
│  └─ ::view-transition-image-pair(name)
│     ├─ ::view-transition-old(name)
│     └─ ::view-transition-new(name)
└─ …other groups…
```

每个唯一的名字对应一个分组。某一侧没有捕获时，`::view-transition-old()` 或 `::view-transition-new()` 会被省略，因此仅退出的名字没有新图像，仅进入的名字没有旧图像。`::view-transition-new(hero):only-child` 是一个有用的选择器，用来表示“这个名字第一次出现”。

用户代理样式表做了三件重要的事：

- 把 `::view-transition` 放成快照包含块里的 `position: fixed; inset: 0`，每个分组则是 `position: absolute`，动画时长 **0.25s**，`animation-fill-mode: both`。
- 用 `@keyframes -ua-view-transition-fade-out`（opacity 到 0）作用在 `::view-transition-old(*)` 上，用 `-ua-view-transition-fade-in`（opacity 从 0 开始）作用在 `::view-transition-new(*)` 上，形成交叉淡入淡出。
- 在 `::view-transition-image-pair(*)` 上设置 `mix-blend-mode: plus-lighter`。对两个相同的像素，plus-lighter 在重叠期间会保持原来的颜色，也就是人们所说的“正确的”交叉淡入淡出。普通的 `opacity` 混合把同一颜色叠两份，中间会发灰。

对**成对**的名字，引擎还会给 `::view-transition-group(name)` 写一条动态规则，把 `width`、`height` 和 `transform` 设成新的边框盒（若新元素在动画期间移动，这些值会保持同步）。默认的分组动画会从旧盒子插值到新盒子。这就是变形：新旧图像坐在一个会移动、会缩放的盒子里，同时做交叉淡入淡出。

自定义的方式和自定义任何 CSS 动画一样：选中这些伪元素，改 `animation-name`、`animation-duration` 或 `animation-timing-function`，或者设 `animation: none`，在 `ready` 兑现之后用 Web Animations API 来驱动。

后面还有两个值得记住的样式钩子。`view-transition-class` 给多个分组挂上共享类，这样一条规则就能同时修饰它们。视图过渡的 **types**——通过 `document.startViewTransition({ update, types: ["forwards"] })` 传入，或写在 `transition.types` 上，或在跨文档导航的 `@view-transition` 里声明——让你可以这样写：

```css
html:active-view-transition-type(forwards) {
  &::view-transition-old(root) { animation-name: slide-out-to-left; }
  &::view-transition-new(root) { animation-name: slide-in-from-right; }
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation: none !important;
  }
}
```

无论是平台本身还是 React，都不会在用户要求减少动效时自动关掉动画。这条媒体查询需要你自己提供。

绘制顺序遵循捕获顺序。分组首先按绘制顺序由旧状态的名字创建；只存在于新状态的名字会被追加到末尾，因此**进入动画会画在**退出动画和成对变形**之上**。第 8 节的模型会复现这一顺序。

## 5. 同文档、跨文档，以及元素作用域

现在有三种启动过渡的方式，它们并不能互相替换。

**同文档（SPA）。** 调用 `document.startViewTransition(updateCallback)`。这是 2025 年 10 月 14 日起成为 Baseline Newly available 的核心：这个方法、`view-transition-name`、`view-transition-class`、`match-element`，以及 `:active-view-transition`。Firefox 144 的首次实现没有包含 transition types；若你依赖 types，请保留一条退路。

**跨文档（MPA）。** 没有回调，因为导航本身就是那次更新。两份文档都必须声明加入：

```css
@view-transition {
  navigation: auto;
}
```

并且要同时满足：两份文档同源；导航没有跨源重定向；整个导航过程中页面保持可见；导航是一次 `traverse`（前进/后退），或一次用户参与不等于 `"browser UI"` 的 `push` / `replace`。在地址栏里键入 URL 不会启动视图过渡。旧文档可以通过 `pageswap` 事件来自定义或跳过过渡；新文档在 `pagereveal` 上看到它。因为没有作者回调来声明“新树已经就绪”，引擎借助渲染阻塞：关键样式和脚本上的 `blocking` 属性，或指向已知片段的 `expect` 链接，可以挡住动画直到新状态稳定。挡得太久，用户就只能盯着上一页的最后一帧。

截至撰文时，跨文档过渡还不是 Baseline。Safari 已经提供（自 18.2 起）；Firefox 在 144 前后只覆盖了同文档过渡。尚未实现这条规则的引擎会按普通方式导航，这正是“渐进增强”应有的样子。

**元素作用域。** Chrome 147（见 Chrome 于 2026 年 3 月 27 日的说明）增加了 `Element.startViewTransition()`，让一棵子树可以独自过渡。多个作用域可以同时进行，页面其余部分保持可交互——文档作用域的过渡做不到这一点，因为它会暂停整份文档的渲染。作用域根默认参与过渡，并使用嵌套分组以保留溢出裁剪；在过渡期间，引擎还会给作用域根加上 `contain: layout`。这一能力目前仍取决于特定引擎，不要把它写进只依赖 Baseline 的路径。

Level 2 还引入了用于**嵌套**分组的 `view-transition-group`，让被命名的子元素可以继续被命名祖先裁剪或过滤，而不是跳进扁平的、和视口一样大的 `::view-transition` 树。若一张卡片被圆角轮播裁剪，而你给两者都起了名，扁平树会让飞起来的卡片在动画中途逃出圆角；嵌套分组则能保住裁剪。

## 6. React 实际做了什么

React 19.3 提供了内置的 `<ViewTransition>` 组件（2026 年 9 月 9 日）。它在底层会在某个边界应当参与动画的那一刻，把 `view-transition-name` 赋给最近的 DOM 节点，然后自己调用 `startViewTransition`。公开文档写得很明确：在使用该组件的树里，你不应再自己调用 `startViewTransition`；同一文档上外来的过渡可能会被打断。

是否激活取决于**更新路径**，而不是“任何一次渲染”。普通的 `setState` 不会启动视图过渡。包在 `useTransition`、`<Suspense>` 的揭示，或 `useDeferredValue` 里的更新会。React 随后选择一种触发类型：

- `enter` / `exit` —— 该边界是这次 Transition 里第一个被插入或删除的组件
- `update` —— 边界内部发生了 DOM 变更，或边界自身的盒子因紧邻兄弟而改变
- `share` —— 在同一次 Transition 里，被删除子树中的命名边界，与被插入子树中具有相同 `name` 的命名边界

`name` 这个 prop 只留给共享元素这种情况。其余情况下 React 会生成唯一名字，思路与 `match-element` 相同：避免意外配对。

若若干次 React 视图过渡会重叠，React 会等进行中的那次结束，并把后续更新**合并**。一次被后续更新到 `C`、再更新到 `D` 打断的 `A → B` 动画会先播完，然后再做 `B → D`。`useLayoutEffect` 和布局测量在更新回调里执行；`useEffect` 会推迟到 `finished`，这样副作用就不太容易戳到动画。若在这一序列中间出现 `flushSync`，React 会跳过这次过渡，因为该序列依赖于同步完成。

这个组件产生的仍然是快照，而不是每个子节点各自的布局动画。包住整页的大边界会作为一张图像做交叉淡入淡出或变形。若内部的块应当自己走位，它们需要自己的边界——这和亲手选择 `view-transition-name` 是同一套纪律。

## 7. 取舍

View Transitions 是一套捕获图像的 API。这既是它的能力，也是它的限制。

- **位图的缩放就像位图。** 一张 160×100 的缩略图插值到 640×400 的大图，在大部分 250 ms 里都是把一张捕获图像放大 4 倍。短变形可以接受；时长更长或缩放跨度更大时，就会发虚。捕获里的实况文字并不是活的：你不能选中它，屏幕阅读器也不会去看它，因为它不在可访问性树里。真正的 DOM 已经前进了。
- **重名会中止整场视觉过渡。** 不存在“只跳过这一个分组”。列表行需要唯一名字，或使用 `match-element` / React 生成的名字，或者干脆不起名。
- **起名有持续成本。** 非 `none` 的 `view-transition-name` 即使在空闲时也会创建层叠上下文和 backdrop root。把它用在你打算变形的元素上，而不是给每个节点“先挂上以防万一”。
- **动画是增强，不是前提。** 隐藏的标签页、超出实现定义上限的快照、被分段的盒子，或缺失的 API，都不应当成为“新路由是否渲染”的决定因素。先写好退路：没有 `startViewTransition` 时直接做更新，并把 `ready` 的拒绝当成“新状态已经在屏幕上”。
- **文档作用域的过渡会冻住页面。** 旧帧会被一直拿着，直到回调结束。Chrome 147 的元素作用域过渡，部分原因就是为了让界面其余部分保持活动。
- **减少动效的偏好不会默认生效。** 请自己提供 `prefers-reduced-motion`。
- **在同文档核心之外，引擎覆盖并不整齐。** types、跨文档加入、嵌套分组、分层捕获，以及元素作用域过渡，应当被当成层层递进的增强，而不是一份单一的 Baseline 捆包。

和 FLIP 库相比，你放弃了对实况属性的逐项控制，以及手势中途改目标的能力，换来的是浏览器原生的快照、多页导航的现成故事，以及始终只处于一种状态的 DOM。不少代码库会两者并用：路由级和共享元素变形交给 View Transitions，指针驱动的运动交给库。

## 8. 一个可运行模型

下面的脚本就是本节所有数字的来源。它不是像素级精确的 Chromium、Firefox 或 WebKit，也不会栅格化任何东西。它实现了配对规则、“更新一定执行”的跳过策略、默认 0.25 s 时长，以及 Level 1 的绘制顺序：先按绘制顺序放入旧名字，只存在于新状态的名字追加在末尾。

每次运行都使用一个名为 `root` 的 1280×800 根元素。行程是新旧边框盒中心之间的欧氏距离。缩放是各轴上的 `新尺寸 / 旧尺寸`，只对成对的名字有意义。

**仅有根元素的导航。** 内容盒子发生了移动和缩放，但它没有名字，因此被折进根快照。这次过渡只有一个分组。根盒子没有移动。用户看到的是整页 250 ms 的交叉淡入淡出。

| 分组 | 类型 | 行程 | 缩放 |
| --- | --- | ---: | --- |
| `root` | 成对 | 0.0 px | 1.00×1.00 |

**共享主图。** 位于 `(24, 120)`、尺寸 160×100 的缩略图被命名为 `hero`，变形为位于 `(80, 80)`、尺寸 640×400 的大图。缩略图周围的卡片是仅退出；包裹大图的文章是仅进入。

| 分组 | 类型 | 旧盒子 `(x,y,w,h)` | 新盒子 | 行程 | 缩放 |
| --- | --- | --- | --- | ---: | --- |
| `root` | 成对 | `(0,0,1280,800)` | `(0,0,1280,800)` | 0.0 px | 1.00×1.00 |
| `card` | 退出 | `(24,120,400,280)` | — | — | — |
| `hero` | 成对 | `(24,120,160,100)` | `(80,80,640,400)` | 315.8 px | 4.00×4.00 |
| `article` | 进入 | — | `(80,80,1120,640)` | — | — |

主图中心从 `(104, 170)` 走到 `(400, 280)`，距离 315.8 px，同时分组在两轴上都缩放 4 倍。绘制顺序是 `root`、`card`、`hero`、`article`：仅进入的 article 在最后，因此叠在退出的卡片和正在变形的主图之上，这正是 Level 1 里“仅新状态的名字被追加”的规则。

**列表重排。** 五行 1232×48、间隙 8 px、名字唯一的行，从 `[a, b, c, d, e]` 变成 `[c, a, e, b, d]`。行距是 56 px。

| 分组 | 旧 y | 新 y | 行程 |
| --- | ---: | ---: | ---: |
| `item-a` | 80 | 136 | 56.0 px |
| `item-b` | 136 | 248 | 112.0 px |
| `item-c` | 192 | 80 | 112.0 px |
| `item-d` | 248 | 304 | 56.0 px |
| `item-e` | 304 | 192 | 112.0 px |
| 合计（含静止的 root） |  |  | 448.0 px |

同样的重排若不起行内名字，就只剩一个 `root` 分组，行程是 **0 px**。行的位置确实变了，但用户只看到整页交叉淡入淡出。名字，就是“各行滑动”和“整页闪一下”之间的差别。

**进入与退出。** 去掉 `item-a`，追加 `item-f`，剩下的行各自上移一个行距（56 px），合计行程 224.0 px。`item-f` 是仅进入，且位于绘制顺序末尾，因此新进来的行叠在正在退出的那一行上面。

**跳过。** 旧树或新树里有两个已渲染元素都叫 `card`，就会跳过视觉过渡，但更新仍然生效。文档被隐藏时同样如此，原因是 `document hidden`。每一次跳过，模型都仍报告 `update_applied=True`。

```python
#!/usr/bin/env python3
"""A compact model of CSS View Transition capture, pairing, and default motion.

This is an algorithmic model of the pairing and default-animation rules in
CSS View Transitions Module Level 1, not a pixel-accurate browser. It detects
duplicate names, applies the hidden-document skip, pairs captures by
view-transition-name, records paint order (entry-only names land on top),
and measures the default 250 ms group geometry animation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


DURATION_MS = 250


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


@dataclass(frozen=True)
class Element:
    name: str
    box: Box
    paint_order: int
    rendered: bool = True


@dataclass
class Capture:
    name: str
    old: Optional[Box] = None
    new: Optional[Box] = None
    old_paint: Optional[int] = None
    new_paint: Optional[int] = None

    @property
    def kind(self) -> str:
        if self.old is not None and self.new is not None:
            return "paired"
        if self.old is not None:
            return "exit"
        return "entry"

    def travel(self) -> float:
        if self.old is None or self.new is None:
            return 0.0
        dx = self.new.cx - self.old.cx
        dy = self.new.cy - self.old.cy
        return (dx * dx + dy * dy) ** 0.5

    def scale(self) -> tuple[float, float]:
        if self.old is None or self.new is None:
            return (1.0, 1.0)
        sx = self.new.w / self.old.w if self.old.w else float("inf")
        sy = self.new.h / self.old.h if self.old.h else float("inf")
        return (sx, sy)


@dataclass
class TransitionResult:
    skipped: bool
    reason: str
    update_applied: bool
    groups: list[Capture]
    paint_order: list[str]


def capture_state(elements: list[Element]) -> tuple[Optional[dict[str, Element]], str]:
    used: set[str] = set()
    named: dict[str, Element] = {}
    for el in sorted(elements, key=lambda e: e.paint_order):
        if not el.rendered or el.name == "none":
            continue
        if el.name in used:
            return None, f"duplicate name {el.name!r}"
        used.add(el.name)
        named[el.name] = el
    return named, ""


def start_view_transition(
    old_elements: list[Element],
    new_elements: list[Element],
    *,
    hidden: bool = False,
) -> TransitionResult:
    # The update callback always runs, even when the visual transition is skipped.
    update_applied = True
    if hidden:
        return TransitionResult(True, "document hidden", update_applied, [], [])

    old_named, err = capture_state(old_elements)
    if old_named is None:
        return TransitionResult(True, err, update_applied, [], [])

    new_named, err = capture_state(new_elements)
    if new_named is None:
        return TransitionResult(True, err, update_applied, [], [])

    groups: dict[str, Capture] = {}
    # Old captures first, in paint order. This is the initial DOM order of groups.
    for name, el in old_named.items():
        groups[name] = Capture(name=name, old=el.box, old_paint=el.paint_order)

    # Names that exist only in the new tree are appended, so they paint on top
    # of exit-only and paired names, matching the Level 1 capture-the-new-state note.
    for name, el in new_named.items():
        if name in groups:
            groups[name].new = el.box
            groups[name].new_paint = el.paint_order
        else:
            groups[name] = Capture(name=name, new=el.box, new_paint=el.paint_order)

    paint_order = list(groups.keys())
    return TransitionResult(False, "", update_applied, list(groups.values()), paint_order)


def fmt_box(b: Optional[Box]) -> str:
    if b is None:
        return "    —"
    return f"({b.x:g},{b.y:g},{b.w:g},{b.h:g})"


def report(title: str, result: TransitionResult) -> None:
    print(f"\n== {title} ==")
    print(
        f"skipped={result.skipped}  reason={result.reason or '—'}  "
        f"update_applied={result.update_applied}"
    )
    if result.skipped:
        return
    print(f"{'name':<10} {'kind':<7} {'old box':<22} {'new box':<22} {'travel':>8} {'scale':>11}")
    total_travel = 0.0
    paired = exit_n = entry_n = 0
    for g in result.groups:
        sx, sy = g.scale()
        travel = g.travel()
        total_travel += travel
        if g.kind == "paired":
            paired += 1
        elif g.kind == "exit":
            exit_n += 1
        else:
            entry_n += 1
        scale = f"{sx:.2f}x{sy:.2f}" if g.kind == "paired" else "—"
        print(
            f"{g.name:<10} {g.kind:<7} {fmt_box(g.old):<22} {fmt_box(g.new):<22} "
            f"{travel:8.1f} {scale:>11}"
        )
    print(
        f"paint_order={result.paint_order}  "
        f"groups={len(result.groups)} (paired={paired} exit={exit_n} entry={entry_n})  "
        f"total_travel={total_travel:.1f}px  duration={DURATION_MS}ms"
    )


def root(w: float = 1280, h: float = 800) -> Element:
    return Element("root", Box(0, 0, w, h), paint_order=0)


def main() -> None:
    # 1. Root-only navigation: the whole viewport cross-fades, nothing morphs.
    report(
        "root-only navigation",
        start_view_transition(
            [root(), Element("none", Box(24, 80, 640, 400), 1)],
            [root(), Element("none", Box(80, 40, 1120, 640), 1)],
        ),
    )

    # 2. Shared hero: a thumbnail morphs into a large figure.
    hero_old = Element("hero", Box(24, 120, 160, 100), 2)
    hero_new = Element("hero", Box(80, 80, 640, 400), 2)
    report(
        "shared hero (thumbnail to figure)",
        start_view_transition(
            [root(), Element("card", Box(24, 120, 400, 280), 1), hero_old],
            [root(), Element("article", Box(80, 80, 1120, 640), 1), hero_new],
        ),
    )

    # 3. List reorder with unique names versus root-only.
    def list_items(order: list[str], y0: float = 80, h: float = 48, gap: float = 8) -> list[Element]:
        items = [root()]
        for i, name in enumerate(order):
            items.append(Element(name, Box(24, y0 + i * (h + gap), 1232, h), paint_order=i + 1))
        return items

    order_a = ["item-a", "item-b", "item-c", "item-d", "item-e"]
    order_b = ["item-c", "item-a", "item-e", "item-b", "item-d"]
    report("list reorder with unique names", start_view_transition(list_items(order_a), list_items(order_b)))
    report(
        "same reorder, root-only (no item names)",
        start_view_transition(
            [root()] + [Element("none", Box(24, 80 + i * 56, 1232, 48), i + 1) for i in range(5)],
            [root()] + [Element("none", Box(24, 80 + i * 56, 1232, 48), i + 1) for i in range(5)],
        ),
    )

    # 4. Entry and exit in a list: remove item-a, append item-f, others shift up.
    order_c = ["item-b", "item-c", "item-d", "item-e", "item-f"]
    report("list entry and exit", start_view_transition(list_items(order_a), list_items(order_c)))

    # 5. Duplicate names skip the visual transition; the DOM update still applies.
    report(
        "duplicate name in the old tree",
        start_view_transition(
            [root(), Element("card", Box(0, 0, 100, 80), 1), Element("card", Box(120, 0, 100, 80), 2)],
            [root(), Element("card", Box(0, 0, 200, 80), 1)],
        ),
    )
    report(
        "duplicate name in the new tree",
        start_view_transition(
            [root(), Element("card", Box(0, 0, 100, 80), 1)],
            [root(), Element("card", Box(0, 0, 100, 80), 1), Element("card", Box(120, 0, 100, 80), 2)],
        ),
    )

    # 6. A hidden document skips the animation; the update still applies.
    report(
        "hidden document",
        start_view_transition([root()], [root()], hidden=True),
    )


if __name__ == "__main__":
    main()
```

## Summary

- View Transitions 把 DOM 更新与视觉插值分开。文档跳到新状态；浏览器用旧捕获和新捕获建起一棵伪元素树来做动画。可访问性树不会看到一份中间文档，动画失败也不会取消这次更新。
- `view-transition-name` 是配对键。文档元素默认名为 `root`。两个不同元素只要共享一个名字，就会变成一个正在变形的分组。任一状态里出现重名，就会跳过视觉过渡。`match-element`（以及 React 生成的名字）适用于同一对象、同一文档的情形；共享元素变形仍然需要显式名字。
- 默认动画持续 0.25 s：新旧图像在 `mix-blend-mode: plus-lighter` 下交叉淡入淡出，成对分组的 `width`、`height` 和 `transform` 从旧边框盒插值到新边框盒。仅进入的分组画在仅退出和成对分组之上。
- 同文档过渡自 2025 年 10 月 14 日起成为 Baseline Newly available。跨文档过渡需要两份同源文档都写 `@view-transition { navigation: auto; }`，目前还不是 Baseline。元素作用域过渡 `Element.startViewTransition()` 在 Chrome 147 提供，可以并发进行，并且不会冻住页面其余部分。
- React 19.3 的 `<ViewTransition>` 会替你调用平台 API，只在 Transition / Suspense / `useDeferredValue` 更新上激活，并且只在共享元素时使用 `name`。它本身并不会响应 `prefers-reduced-motion`。
- 文中的模型是操作级的配对模型，不是栅格化器。一张命名为 160×100 的缩略图变形到 640×400 的大图，行程 315.8 px，缩放 4 倍。同样的五行重排，起了唯一名字时合计行程 448 px；不起名则是 0 px——一次普通的交叉淡入淡出。重名和隐藏文档会跳过动画，但仍然应用更新。

## References

- CSS View Transitions Module Level 1, W3C, [https://www.w3.org/TR/css-view-transitions-1/](https://www.w3.org/TR/css-view-transitions-1/)（生命周期、`view-transition-name`、伪元素树、用户代理样式表、捕获与跳过算法）
- CSS View Transitions Module Level 2, W3C, [https://www.w3.org/TR/css-view-transitions-2/](https://www.w3.org/TR/css-view-transitions-2/)（跨文档 `@view-transition`、types、`view-transition-class`、自动命名、嵌套分组）
- MDN, [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
- MDN, [`Document.startViewTransition()`](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition)
- MDN, [`view-transition-name`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-name)（`match-element`、唯一性）
- MDN, [`@view-transition`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@view-transition)
- Chrome Developers, [View Transitions API](https://developer.chrome.com/docs/web-platform/view-transitions)
- Bramus, [Same-document view transitions are now Baseline Newly available](https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available), 2025 年 10 月 16 日（Firefox 144、2025 年 10 月 14 日的 Baseline 日期、Interop 2025）
- Bramus, [Element-scoped view transitions](https://developer.chrome.com/blog/element-scoped-view-transitions), 2026 年 3 月 27 日（Chrome 147、`Element.startViewTransition()`）
- React, [`<ViewTransition>`](https://react.dev/reference/react/ViewTransition)
- React, [React 19.3](https://react.dev/blog/2026/09/09/react-19-3), 2026 年 9 月 9 日
