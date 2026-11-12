---
title: "深入理解 Hydration：全量、渐进、选择性注水、Islands 与 Resumability"
tag: javascript
description: 服务端渲染之后 hydration（注水）到底做了什么、为什么代价这么高——重复渲染问题、hydration 不匹配及 React、Vue、Solid 如何检测它、React 18 的选择性注水与事件重放、Vue 3.5 与 Angular 增量注水中的渐进/懒注水、Astro 的 Islands 架构、Qwik 的可恢复性（Resumability）、React Server Components 如何改变格局，以及一个可运行模型，统计每种策略实际做了多少工作
date: "2026-11-12T14:30:00.000Z"
---

## 目标

服务端渲染（SSR）让浏览器直接拿到真实的 HTML，文字和图片可以在 JavaScript 到达之前就绘制出来。但 SSR 输出的 HTML 是"死"的：在框架完成 hydration（注水）之前，按钮点了没有任何反应。对很多网站来说，"看起来好了"到"真正可用"之间的这段时间是整个用户体验里最糟糕的部分。过去五年前端框架的大部分创新——流式渲染、Suspense、Islands、Server Components、Resumability——本质上都在缩小这个窗口。

本文包括：

1. hydration 一步步做了什么，以及它为什么重复了服务端已经做过的工作。
2. Hydration 不匹配：从哪里来、框架如何检测、如何避免。
3. React 18 的选择性注水与事件重放。
4. 渐进式与懒注水（Vue 3.5、Angular 增量注水）。
5. Islands 架构（Astro、Fresh、Marko）。
6. 可恢复性（Qwik）及其代价。
7. React Server Components 处在什么位置。
8. 一个可运行的小模型，统计每种策略执行的工作量。
9. 选型指南。

## 1. Hydration 到底做了什么

一次典型的 SSR 请求经过以下阶段：

1. 服务端执行组件树，生成 HTML 字符串，并且通常会把渲染用到的数据序列化下来（例如一个带 JSON 的 `<script>` 标签，或 Next.js 的 flight payload）。
2. 浏览器解析 HTML 并绘制。页面*看起来*已经完成。
3. 浏览器下载、解析并编译整个路由的 JavaScript 包。
4. 框架在客户端用序列化数据**把整棵组件树重新执行一遍**，重建内部模型（虚拟 DOM、fiber 树、响应式依赖图、组件实例）。
5. 框架把这个模型和已有 DOM **同步遍历**，认领每个已存在的 DOM 节点而不是新建，并挂上事件监听、ref 和副作用。
6. 副作用执行，页面变为可交互。

第 3–5 步就是 hydration。关键在于第 4 步重复了服务端的渲染工作：客户端重新执行每一个组件，包括那些永远不会变化的组件，只为了重新"发现"服务端早已知道的状态。所以 hydration 的成本与**页面大小**成正比，而不是与**页面有多少交互**成正比。一篇 5000 字、只有一个"点赞"按钮的文章，要为这 5000 字付出两次渲染的代价。

具体到 React：

```jsx
// server
import { renderToPipeableStream } from 'react-dom/server';
renderToPipeableStream(<App data={data} />, { bootstrapScripts: ['/main.js'] }).pipe(res);

// client (main.js)
import { hydrateRoot } from 'react-dom/client';
hydrateRoot(document.getElementById('root'), <App data={window.__DATA__} />);
```

Vue 中：

```js
// client
import { createSSRApp } from 'vue';
const app = createSSRApp(App);
app.mount('#app'); // detects server-rendered markup and hydrates instead of re-creating
```

从首次绘制到 hydration 结束的这段时间有时被称为"恐怖谷"：页面能响应滚动（那是浏览器在处理），却不能响应点击（那需要框架）。在线上指标里它表现为较差的 **Interaction to Next Paint（INP）**，在实验室指标里表现为 **Total Blocking Time**，因为除非框架主动拆分，大型组件树的 hydration 就是主线程上的一个长任务。

## 2. Hydration 不匹配

Hydration 假设客户端渲染出的标记与服务端完全一致。一旦不一致，框架只有三种选择：修补差异、丢弃这棵子树并在客户端重新渲染、或者保留错误的 DOM。常见原因：

- **时间与随机数**：渲染期间调用 `new Date()`、`Math.random()`、`crypto.randomUUID()`。
- **环境判断**：`typeof window !== 'undefined'` 分支、`localStorage`、视口宽度、UA 嗅探。
- **语言区域与时区**：服务端在 UTC，浏览器在 UTC+8，`toLocaleString()` 结果不同。
- **非法的 HTML 嵌套**：`<p>` 里放 `<div>`，或者 `<table>` 下直接放 `<tr>` 而没有 `<tbody>`。HTML 解析器会悄悄"修正"这棵树，于是 DOM 和框架渲染的结构不再一致。
- **浏览器扩展和代理**在 hydration 之前注入属性或节点。
- **不确定的 ID**：服务端跨请求共享一个自增计数器。

各框架的处理方式：

- **React 18+**：在并发根节点中，出现不匹配时 React 会丢弃到最近一个 `<Suspense>` 边界为止的服务端 HTML，在客户端重新渲染这棵子树，并通过 `onRecoverableError` 上报；如果没有边界，则整个根节点回退到客户端渲染。React 19 改进了开发模式下的报错，会给出不匹配内容的 diff。`suppressHydrationWarning` 可以屏蔽单个元素的文本或属性不匹配，这是给时间戳这类场景准备的逃生口。
- **Vue 3**：开发模式下打印 hydration mismatch 警告，并把 DOM 修补成客户端的结果。Vue 3.5 新增了 `data-allow-mismatch` 属性（可限定为 `text`、`children`、`class`、`style` 或 `attribute`），用来声明预期内的差异。
- **Solid**：给服务端渲染的元素打上 hydration key（`data-hk`），按 key 认领节点，所以不匹配通常表现为找不到节点的错误，而不是静默修补。

避免不匹配的写法：

```jsx
// 1. Stable IDs across server and client (React 18+)
const id = useId();
<label htmlFor={id}>Email</label><input id={id} />

// 2. Client-only values: render the server value first, update after hydration
function LocalTime({ iso }) {
  const [text, setText] = useState(iso);           // identical on both sides
  useEffect(() => setText(new Date(iso).toLocaleString()), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

// 3. External stores: give React an explicit server snapshot
const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
```

第 2 种写法多一次渲染，但让 hydration 这一遍是确定的。原则很简单：**凡是影响客户端首次渲染的东西，都必须来自服务端序列化的数据**，而不能来自客户端环境。

## 3. React 18：流式渲染、选择性注水与事件重放

React 18 之前，hydration 是全有或全无的：客户端必须下载页面的全部代码，并在一次同步过程中注水整棵树。React 18 同时改变了三件事。

**流式 HTML。** 使用 `renderToPipeableStream`（Node）或 `renderToReadableStream`（Web Streams），服务端立即发送页面骨架，每个 `<Suspense>` 边界的数据就绪后，再以隐藏 HTML 加一小段内联脚本的形式流式发送并替换到位。

**选择性注水。** 每个 `<Suspense>` 边界成为独立的注水单元。如果它的代码（通过 `React.lazy`）或 HTML 还没到，React 先注水其他部分，稍后再回来。Hydration 也运行在并发调度器中，工作单元之间会让出主线程，而不是一口气阻塞整棵树。

**优先级与事件重放。** 如果用户点击了一个尚未注水的边界，React 会记录这个事件、提升该边界的优先级、抢在其他边界之前同步注水它，然后把这个离散事件重放给已经注水的组件。注水期间的点击不再丢失，这直接改善了 INP。

```jsx
<Layout>
  <Nav />
  <Suspense fallback={<Spinner />}>
    <Comments />          {/* can hydrate independently, and first if clicked */}
  </Suspense>
  <Suspense fallback={<Spinner />}>
    <Recommendations />
  </Suspense>
</Layout>
```

选择性注水**没有**改变的是：每个组件依然要把代码发到客户端，依然要在 hydration 时重新渲染。它改变的是工作的*顺序和粒度*，而不是工作的*总量*。

## 4. 渐进式与懒注水

渐进式注水更进一步：某些子树在触发条件满足之前完全不注水——进入视口、浏览器空闲、媒体查询匹配或首次交互。HTML 已经在屏幕上，被推迟的只是 JavaScript 和注水遍历。

**Vue 3.5** 通过异步组件提供这一能力：

```js
import { defineAsyncComponent, hydrateOnVisible, hydrateOnIdle, hydrateOnInteraction } from 'vue';

const Comments = defineAsyncComponent({
  loader: () => import('./Comments.vue'),
  hydrate: hydrateOnVisible({ rootMargin: '200px' }),
});
const Chat = defineAsyncComponent({
  loader: () => import('./Chat.vue'),
  hydrate: hydrateOnInteraction(['click', 'focus']),
});
```

**Angular** 把它建立在可延迟视图（deferrable views）之上。启用增量注水后（`provideClientHydration(withIncrementalHydration())`，Angular 19 中为开发者预览，Angular 20 转为稳定），`@defer` 块可以声明注水触发条件；Angular 的事件重放——源自 Google 内部 Wiz 框架的 `jsaction` 机制——会捕获落在未注水区域的事件，在该块注水后重放：

```html
@defer (hydrate on viewport) {
  <product-reviews [id]="productId" />
}
@defer (hydrate on interaction) {
  <size-picker />
}
@defer (hydrate never) {
  <legal-footer />   <!-- stays static HTML forever -->
}
```

渐进式注水的代价在于未注水区域的**首次交互**：必须先拉取代码并注水子树，处理函数才能执行。框架的缓解手段是在空闲或悬停时预取，以及重放事件而不是丢弃。另外，被推迟的子树依然处在应用组件树*内部*，它的父组件代码仍然要下发并注水。

## 5. Islands 架构

Islands 的思路把默认值反了过来：页面是静态 HTML，只有显式标记的组件才下发 JavaScript 并注水，每个组件作为拥有独立根节点的迷你应用。这个术语由 Etsy 的 Katie Sylor-Miller 提出，Jason Miller 在 2020 年的文章《Islands Architecture》中使其广为人知。

在 **Astro** 中，组件默认渲染成零 JavaScript 的 HTML，除非加上 client 指令：

```astro
---
import Header from '../components/Header.astro';   // static, no JS
import Search from '../components/Search.jsx';
import Cart from '../components/Cart.vue';
import Chart from '../components/Chart.svelte';
---
<Header />
<Search client:load />                      <!-- hydrate immediately -->
<Cart client:idle />                        <!-- after requestIdleCallback -->
<Chart client:visible />                    <!-- when it scrolls into view -->
<MobileMenu client:media="(max-width: 768px)" />
<Map client:only="react" />                 <!-- skip SSR, render only on client -->
```

每个 island 渲染在一个 `<astro-island>` 自定义元素里，元素上携带序列化后的 props 和组件 chunk 的 URL；触发条件满足时，它导入对应框架的渲染器，只注水这一棵子树。Astro 5 新增了 **server islands**（`server:defer`），把同样的思路用在另一个方向：个性化片段稍后在服务端渲染并流式插入，让页面其余部分可以被缓存。

其他实现：**Fresh**（Deno，基于 Preact）把 `islands/` 目录下的组件视为可交互组件；**Marko**（eBay）从 Marko 4 起就支持自动部分注水，由编译器判断哪些组件需要客户端代码。

Islands 的优势：

- JavaScript 成本取决于 **island 的数量和大小**，而不是整个页面。
- Island 之间相互隔离，一个很慢的图表不会阻塞搜索框。
- 不同 island 甚至可以用不同框架。

代价：

- **Island 之间共享状态**不再是免费的。不同 island 里的组件无法共享 React context 或 Vue 的 `provide/inject`，需要框架无关的状态库（Astro 中常用 Nano Stores）、自定义事件或 URL 状态。
- **客户端路由**更难：默认情况下点链接就是整页加载。Astro 的 View Transitions / `<ClientRouter />` 能缓解，但高度应用化的体验（仪表盘、编辑器）会和这个模型较劲。
- 跨越 island 边界的 props 必须**可序列化**：不能是函数、类实例或循环结构。

Islands 最适合内容为主、少量交互组件的页面：文档、博客、营销站点、电商商品页。

## 6. 可恢复性（Resumability）

到目前为止的所有方案，仍然要*在客户端执行组件*来重建状态。Qwik 实现的 **Resumability** 目标是彻底跳过这一步。服务端不仅序列化数据，还序列化框架自身的状态：组件边界、响应式订阅关系、事件处理函数的引用。客户端从这份快照"恢复"，而不是重放渲染。

机制如下：

- Qwik optimizer 在每个 `$` 边界（`component$`、`onClick$`、`useTask$` 等）处切分代码，把每个闭包变成可单独导入的 symbol。
- 服务端输出的 HTML 中，监听器是指向这些 symbol 的属性，大致形如 `on:click="q-chunk.js#Counter_onClick_xyz"`，再加上一份应用状态的 JSON。
- 一段很小的全局脚本（**qwikloader**，约 1 KB）在 document 上为每种事件类型只注册一个监听器。点击发生时，它从目标元素向上查找 `on:click` 属性，导入那一个 chunk，反序列化处理函数捕获的状态并执行。

```tsx
import { component$, useSignal } from '@builder.io/qwik';

export const Counter = component$(() => {
  const count = useSignal(0);
  return <button onClick$={() => count.value++}>count: {count.value}</button>;
});
```

页面加载时几乎没有框架工作：不遍历树，不执行组件。某个处理函数的代码只在对应交互发生时才加载，Qwik 还会（通过 service worker 或 modulepreload）预取可能用到的 chunk，避免首次点击等待网络。

代价：

- **所有被 `$` 闭包捕获的东西都必须可序列化。** 这和 island props 的约束相同，但适用于所有地方，并会影响组件的写法。
- **首次交互延迟**取决于预取是否有效；冷缓存加慢网络时，第一次点击要付出一次请求的代价。
- **序列化状态会增加 HTML 体积。**
- 生态比 React、Vue 小，心智模型也需要适应。

## 7. React Server Components 的位置

React Server Components（RSC）换了一个角度：不是让 hydration 更便宜，而是**把组件从注水集合中移除**。Server Component 只在服务端运行，代码不会发到客户端，也不会被注水。只有标记了 `'use client'` 的组件（以及它们导入的一切）进入客户端包并被注水。

```tsx
// app/post/[slug]/page.tsx — Server Component: no client JS
export default async function Post({ params }) {
  const post = await db.post.find(params.slug);
  return (
    <article>
      <Markdown source={post.body} />     {/* heavy parser stays on the server */}
      <LikeButton postId={post.id} />     {/* the only hydrated part */}
    </article>
  );
}

// LikeButton.tsx
'use client';
export function LikeButton({ postId }) { /* useState, onClick ... */ }
```

这相当于在*同一棵* React 树里实现了 islands：客户端组件是岛屿，服务端组件是静态的海洋；与经典 islands 不同，它们仍然可以共享放在上层的客户端 Provider 提供的 context，客户端导航也可以通过拉取新的 RSC payload 实现。代价是实实在在的复杂度：`'use client'` 边界很容易放得太高（把大片子树拖进客户端包），跨边界的 props 必须可序列化，而且 RSC payload 是在 HTML 之外额外发送的。

## 8. 一个可运行的工作量模型

为了让差异更直观，下面是一个纯 Node.js 的小模型。"页面"是一篇有 200 个段落的文章，外加两个可交互的计数按钮。服务端把它渲染成类 DOM 树，然后用三种方式让它可交互，并统计每种策略在加载时触及多少节点。

```js
const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat() });

function Counter({ id, start }) {
  return h('button', { id, onClick: s => s.count++, 'data-island': 'Counter' }, `count: ${start}`);
}
function App({ now }) {
  const paras = Array.from({ length: 200 }, (_, i) => h('p', null, `paragraph ${i}`));
  return h('main', null,
    h('header', null, h('h1', null, 'Hydration'), h('time', null, now)),
    h('article', null, ...paras),
    Counter({ id: 'a', start: 0 }),
    Counter({ id: 'b', start: 5 }));
}

// Server output as the browser would parse it: no listeners, just markup.
const toDom = v => typeof v === 'string'
  ? { text: v }
  : { tag: v.tag, attrs: Object.fromEntries(Object.entries(v.props).filter(([k]) => !k.startsWith('on'))),
      children: v.children.map(toDom), listeners: {} };

// 1. Full hydration: re-run the whole tree, walk vnode and DOM in lockstep.
function hydrate(vnode, dom, stats) {
  stats.visited++;
  if (typeof vnode === 'string') {
    if (dom.text !== vnode) stats.mismatches.push(`text "${dom.text}" vs "${vnode}"`);
    return;
  }
  if (dom.tag !== vnode.tag) { stats.mismatches.push(`tag ${dom.tag} vs ${vnode.tag}`); return; }
  for (const [k, fn] of Object.entries(vnode.props))
    if (k.startsWith('on')) { dom.listeners[k] = fn; stats.listeners++; }
  vnode.children.forEach((c, i) => hydrate(c, dom.children[i], stats));
}

// 2. Islands: hydrate only marked subtrees, each from its own serialized props.
function hydrateIslands(dom, registry, stats) {
  const walk = node => {
    if (node.attrs?.['data-island']) {
      const start = Number(node.children[0].text.split(': ')[1]);
      hydrate(registry[node.attrs['data-island']]({ id: node.attrs.id, start }), node, stats);
      return;
    }
    node.children?.forEach(walk); // real frameworks locate islands without a full scan
  };
  walk(dom);
}

// 3. Resumability: nothing runs at load; a global dispatcher resolves the handler lazily.
function resume(dom, stats, lazyImport) {
  return targetId => {
    const find = n => n.attrs?.id === targetId ? n : n.children?.map(find).find(Boolean);
    const handler = lazyImport(find(dom).attrs['data-island']);
    stats.loadedOnDemand++;
    return handler;
  };
}
```

运行（Node.js 24）输出：

```text
full hydration      : { visited: 411, listeners: 2, mismatches: 0 }
full, clock mismatch: {
  visited: 411,
  mismatches: [ 'text "2026-11-12T14:00:00Z" vs "2026-11-12T14:00:07Z"' ]
}
islands             : { visited: 4, listeners: 2, mismatches: 0 }
resumable at load   : { loadedOnDemand: 0 }
resumable after click: { loadedOnDemand: 1 }
```

这些数字来自这个玩具模型，并不是任何框架的性能基准，但形态说明了问题：

- 全量注水为了挂上 **2** 个监听器，触及了全部 411 个节点（200 个段落及其文本节点占了大头）。
- 当客户端渲染的时间戳比服务端晚 7 秒时，遍历发现了文本不匹配——正是第 2 节中 `new Date()` 的问题。
- Islands 只触及 4 个节点：两个按钮及其文本。工作量与交互程度成正比。
- Resumability 在加载时什么都不碰，只在用户真正点击时加载一个处理函数。

## 9. 对比与选型指南

| 策略 | 下发的客户端 JS | 加载时工作量 | 首次交互 | 典型工具 |
| --- | --- | --- | --- | --- |
| 全量注水 | 整个路由 | 重新渲染整棵树 | 注水后快；注水前丢失或延迟 | React/Vue/Svelte 传统 SSR |
| 选择性注水（React 18） | 整个路由，按边界拆分 | 整棵树，分块并按优先级 | 被点击的边界先注水，事件重放 | Next.js、Remix/React Router |
| 渐进 / 懒注水 | 按子树推迟 | 只有已注水的子树 | 触发时拉取并注水，事件重放 | Vue 3.5、Angular `@defer` |
| Islands | 只有 islands | 只有 islands | island 内很快；island 外无交互 | Astro、Fresh、Marko |
| Server Components | 只有客户端组件 | 只有客户端组件 | 与普通 React 相同 | Next.js App Router |
| Resumability | 按处理函数按需加载 | 接近零 | 懒加载一个处理函数（有预取） | Qwik |

实践建议：

- **内容为主的站点**（文档、博客、营销页、商品页）：用 Islands 或 RSC，页面的大部分根本不应该注水。
- **登录后的高交互应用**（仪表盘、编辑器）：SSR 的重要性较低，客户端渲染的 SPA 或配合良好代码分割的全量注水往往更简单且足够。
- **已有的大型 React 应用**：先引入流式渲染，并在相互独立的区域外包 `<Suspense>` 边界以获得选择性注水，再把非交互部分迁移为 Server Components，把 `'use client'` 边界往叶子节点下推。
- **已有的 Vue 或 Angular 应用**：对首屏以下的区域使用懒注水（`hydrateOnVisible`、`@defer (hydrate on viewport)`），风险低、收益明确。
- **大型页面对可交互时间有极致要求**：值得评估 Resumability，并接受它的序列化约束。

无论选哪种策略：

- 保持客户端首次渲染的确定性；把时间、随机数和环境判断移到副作用里。
- 校验 HTML 嵌套——解析器的自动修正是不匹配的隐蔽来源。
- 在中端移动设备上测量 INP 和 Total Blocking Time，用 Performance 面板实际查看 hydration 任务，而不是凭感觉。
- 关注序列化数据的体积；内嵌在 HTML 中的注水数据可能悄悄超过标记本身。

## 参考资料

- [React — hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot)
- [React 18 工作组 — New Suspense SSR architecture](https://github.com/reactwg/react-18/discussions/37)
- [React — useId](https://react.dev/reference/react/useId)
- [React — Server Components](https://react.dev/reference/rsc/server-components)
- [Vue — SSR 指南：激活不匹配](https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch)
- [Vue — 异步组件的惰性激活](https://vuejs.org/guide/components/async.html#lazy-hydration)
- [Angular — Incremental hydration](https://angular.dev/guide/incremental-hydration)
- [Astro — Islands architecture](https://docs.astro.build/en/concepts/islands/)
- [Astro — 模板指令（client:*）](https://docs.astro.build/en/reference/directives-reference/)
- [Qwik — Resumable vs. hydration](https://qwik.dev/docs/concepts/resumable/)
- Jason Miller，[Islands Architecture](https://jasonformat.com/islands-architecture/)
- [web.dev — Rendering on the Web](https://web.dev/articles/rendering-on-the-web)
- [web.dev — Interaction to Next Paint](https://web.dev/articles/inp)
