---
title: "Speculation Rules API：预取、预渲染、积极度，以及浏览器如何让下一页瞬间打开"
tag: performance
description: Speculation Rules API 如何让多页面站点在用户点击之前就加载好下一页——列表规则与文档规则，prefetch 与 prerender 各自做了什么，四档积极度以及 Chrome 对它们施加的 FIFO 上限，预渲染页面在激活前能做和不能做的事，安全与过期陷阱（GET 副作用、统计埋点、购物车、No-Vary-Search），跨源与 CSP 规则，如何衡量命中率和以激活时刻为起点的 Core Web Vitals，2026 年底 Safari 与 Firefox 的进展，再加上一个可运行模型，按被隐藏的延迟和浪费的字节比较各档积极度
date: "2026-11-27T10:38:00.000Z"
---

## 目标

大多数性能优化针对的是用户已经请求之后的页面：更小的包、更快的 TTFB、更好的 LCP 图片。但在多页面站点里，最昂贵的时刻往往是"用户点了链接"到"下一个文档画出来"之间的那段空白。DNS、TCP、TLS、服务端耗时、HTML 解析、CSS、字体和 JavaScript，每一毫秒都在点击之后串行地、完整地付出去。

**Speculation Rules API**（推测规则）把其中一部分工作挪到点击之前。页面用一小段 JSON 声明用户接下来可能访问哪些 URL、有多大把握；浏览器据此要么把下一个文档 **预取**（prefetch）到内存里，要么在一个看不见的标签页里把整页 **预渲染**（prerender）好，导航时直接换上。最好的情况下，激活后的 LCP 接近于零，因为页面早已画好。

这听起来像换了个名字的 `<link rel="prefetch">`，其实不是。什么时候动手由浏览器决定，而不是你的脚本；浏览器知道悬停、按下、视口位置、省电模式和内存压力；结果被当作一次导航而不是一条 HTTP 缓存记录；预渲染页面还要遵守一套规则，把打扰用户的 API 推迟到用户真正看到页面时才执行。

本文会讲到：

1. 为什么下一次导航是慢的那一段，以及推测规则之前的方案。
2. 规则语法：列表规则、文档规则，以及 `where` 背后的谓词。
3. prefetch 和 prerender 各自一步步做了什么。
4. 积极度：`immediate`、`eager`、`moderate`、`conservative`，以及 Chrome 的上限。
5. 预渲染页面里的生活：被推迟的 API、激活与存储。
6. 陷阱：GET 副作用、过期状态、统计埋点与 `No-Vary-Search`。
7. 跨源规则、隐私与内容安全策略。
8. 度量：激活时刻、Core Web Vitals 与命中率。
9. SPA、框架、CDN 与 WordPress。
10. 2026 年底各浏览器与规范的现状。
11. 一个比较各档积极度的可运行模型。

## 1. 为什么下一次导航是慢的那一段

冷启动的导航有一条关键路径，客户端再怎么优化也无法把它并行化。浏览器拿到引用样式表的 HTML 之前没法请求样式表，下载完水合脚本之前没法执行它，布局确定位置之前也没法绘制首屏大图。链上每一跳都要等前一跳。

Web 曾多次尝试让这条链早点开始：

- **`<link rel="prefetch">`** 让浏览器以低优先级把资源取进 HTTP 缓存。对子资源有效，但对文档有问题：带 `Cache-Control: no-store` 或很短 `max-age` 的响应，到导航时已经用不上；它也不知道这个资源是一次导航，所以跨站预取无法套用导航级别的隐私规则。
- **`<link rel="prerender">`** 是 Chrome 独有的提示，会渲染整页。它从未被广泛支持，作者也几乎无法控制它。Chrome 后来把它重新解释为 **NoState Prefetch**：取回文档和子资源，但不执行 JavaScript，也不渲染。
- **第三方库** 如 quicklink、instant.page 在悬停或链接滚入视口时注入 `<link rel="prefetch">`。它们证明了意图信号有用，但受限于 HTTP 缓存，也受限于脚本能观察到的东西。

Chrome 的预渲染指南说，现在的设计是用一个新的、表达力更强的机制把完整预渲染带回来，而不是复用旧的 `<link rel="prerender">` 语法，后者保留为 NoState Prefetch。这个新机制就是推测规则。

## 2. 规则语法

规则要么写在内联的 `<script type="speculationrules">` 元素里，要么放在一个外部 JSON 文件中，由响应头 `Speculation-Rules` 指向。JSON 里每种动作一个数组，目前是 `prefetch` 和 `prerender`，数组里每个元素是一条规则。

### 列表规则

**列表规则**（list rule）直接列出 URL：

```html
<script type="speculationrules">
{
  "prerender": [
    { "urls": ["/pricing", "/docs/getting-started"] }
  ],
  "prefetch": [
    { "urls": ["/blog/"], "referrer_policy": "strict-origin-when-cross-origin" }
  ]
}
</script>
```

当站点比链接布局更清楚下一步是什么时，适合用列表规则：系列文章的下一篇、结账流程第 2 步、URL 取决于用户输入的搜索结果页。列表规则默认积极度是 `immediate`。

### 文档规则

**文档规则**（document rule）用 `where` 匹配当前文档里已有的链接：

```html
<script type="speculationrules">
{
  "prerender": [{
    "where": {
      "and": [
        { "href_matches": "/*" },
        { "not": { "href_matches": "/logout" } },
        { "not": { "href_matches": "/*\\?*(^|&)add-to-cart=*" } },
        { "not": { "selector_matches": ".no-prerender" } },
        { "not": { "selector_matches": "[rel~=nofollow]" } }
      ]
    },
    "eagerness": "moderate"
  }]
}
</script>
```

叶子谓词有两种。`href_matches` 接受一个或多个 URL 模式，语法与 `new URLPattern()` 相同，所以 `/*` 表示"任意同源路径"，查询串也可以用模式匹配。`selector_matches` 接受 CSS 选择器，针对 `<a>` 或 `<area>` 元素本身求值。两者用 `and`、`or`、`not` 组合。文档规则默认积极度是 `conservative`，并且会随 DOM 变化持续生效：之后通过 `innerHTML` 插入的链接也会被已有规则匹配到。

上面是经典的"除了这些都推测"写法。排除项不是摆设：登出链接、加入购物车的 GET URL，恰恰是绝不能被推测性请求的导航。

### 可选字段

一条规则还可以带：

- **`eagerness`**：何时动手，见第 4 节。
- **`referrer_policy`**：只作用于推测请求的 referrer 策略，例如在预取跨站链接的规则上设 `"no-referrer"`，这样在用户决定前往之前，目标站点不会知道链接所在的具体页面。
- **`relative_to`**：设为 `"document"` 时，相对 URL 相对于文档解析，而不是相对于外部规则文件。
- **`requires`**：目前只有 `"anonymous-client-ip-when-cross-origin"`，要求跨源预取必须经过隐藏 IP 的代理，否则不预取。
- **`expects_no_vary_search`**：提示响应会带 `No-Vary-Search` 头，见第 6 节。
- **`target_hint`**：`"_blank"` 或 `"_self"`，让列表规则可以预渲染将在新标签页打开的页面（Chrome 138，仅 prerender）。
- **`tag`**：一个标签，通过请求头 `Sec-Speculation-Tags` 发给服务器（Chrome 136）。自行注入规则的 CDN 用它区分自己的推测请求和站点自己的。

HTML 标准的解析算法刻意从严："未知键或非法值通常会导致解析失败，因为什么都不做比误解一条推测规则更安全。"像 `"eagerniss"` 这样的拼写错误不会退化成默认值，而是让整条规则失效。Chrome DevTools 的 **Application → Speculative loads** 会显示解析错误。

### 投递方式

规则可以放在主框架的 `<head>` 或 `<body>`。iframe 里的规则会被忽略；本身正在预渲染的页面里的规则，要等激活后才生效。用 JavaScript 添加规则时，必须用 `document.createElement('script')` 创建并插入；通过 `innerHTML` 以标记形式插入的规则不会被注册。这一点对标签管理器同样重要。

```js
if (HTMLScriptElement.supports?.('speculationrules')) {
  const s = document.createElement('script');
  s.type = 'speculationrules';
  s.textContent = JSON.stringify({
    prefetch: [{ urls: ['/checkout/shipping'], eagerness: 'immediate' }],
  });
  document.head.append(s);
}
```

响应头方式不用改动文档，所以 CDN 喜欢它：

```http
Speculation-Rules: "/speculationrules.json"
```

`Speculation-Rules` 是结构化头，引号不能省。文件必须以 `application/speculationrules+json` 返回，跨源时还要通过 CORS。移除规则 `<script>` 会取消它发起的推测，这让 JavaScript 有办法撤回一个 `immediate` 列表。

## 3. prefetch 和 prerender 做了什么

### 预取

推测规则的预取会发出点击本来会发出的那个导航请求：同样的 URL、同样的凭据模式，外加请求头 `Sec-Purpose: prefetch`。响应体存放在 **按文档划分的内存** 预取缓存里，而不是 HTTP 缓存；子资源不会被取。用户导航到这个 URL 时，浏览器直接用存下的响应，省掉文档的网络往返；HTML 解析、子资源加载、脚本执行和绘制仍在点击之后发生。用户如果去了别处，当前页面离开时存下的响应就会被丢弃。

由于这块缓存专门服务导航，不可被 HTTP 缓存的文档也能被预取。对 HTML 页面来说，这是它与 `<link rel="prefetch">` 的决定性差别。

### 预渲染

预渲染在预取之后继续往下走。浏览器创建一个不可见的顶层浏览上下文，把文档加载进去，取回子资源，执行 JavaScript（包括 JavaScript 发起的数据请求），完成布局和绘制。请求带 `Sec-Purpose: prefetch;prerender`。导航时，浏览器 **激活**（activate）这个隐藏页面，把它换到当前标签页，而不是发起新导航。如果用户点击时预渲染还没加载完，页面以当前状态被激活并继续加载，因此不完整的预渲染也能省时间。

MDN 说一次预渲染的开销大约相当于渲染一个 `<iframe>`：要占内存、CPU，还要付出整页体积的带宽。MDN 的建议由此而来：广泛采用预取，谨慎使用预渲染，只用在导航概率高的地方。

### 预渲染到脚本为止

Chrome 从 2026 年 1 月起为第三种动作 `prerender_until_script` 开展源试用（origin trial）。它取回文档和子资源并开始预渲染，但遇到第一个 `<script>` 就停下。静态页面，或者脚本都放在 `<body>` 末尾的页面，不用推测性地执行任何作者 JavaScript，也能拿到接近完整预渲染的收益；`<head>` 里有阻塞脚本的页面仍能拿到子资源预取的收益。

### 响应状态码

两种动作都要求重定向之后的最终响应是 2xx；预渲染还额外拒绝 204 和 205。所以想拒绝推测的服务器可以检查 `Sec-Purpose` 并返回 503。Chrome 的指南说这是阻止预渲染最可靠的办法，同时也说多数情况下不建议这么做：更好的做法通常是接受预渲染，再用 JavaScript 把副作用推迟到激活之后。

## 4. 积极度、启发式与上限

`eagerness` 告诉浏览器要有多强的证据才动手。HTML 标准把四个值定义为意图，而不是具体时间：

| 积极度 | 标准中的含义 | Chrome 的实现（据 Chrome 预渲染指南，2026 年 11 月 13 日更新） |
| --- | --- | --- |
| `immediate` | 很可能值得；尽快执行 | 一看到规则就执行 |
| `eager` | 哪怕只有一点意图迹象 | 桌面：悬停 10 ms。移动端：自 2026 年 1 月起，链接进入视口 50 ms 后 |
| `moderate` | 用户行为表明很快会导航 | 桌面：悬停 200 ms，或更早发生的按下。移动端：自 2025 年 8 月起，停止滚动 500 ms 后，对靠近上次按下位置的显眼链接使用视口启发式 |
| `conservative` | 用户已经开始与链接交互 | 指针按下或触摸开始 |

在 Chrome 143 之前，`eager` 的行为与 `immediate` 完全相同。列表规则默认 `immediate`，文档规则默认 `conservative`。

各档积极度利用的这段时间差很容易被低估。一次点击是按下再抬起，导航在 click 时才开始，所以即使 `conservative` 也能领先"按住按钮"那段时间。200 ms 的悬停阈值通常能把请求再提前几百毫秒，因为人们在按下之前往往会在链接上停一会儿。

Chrome 限制同时存活的推测数量：

| 积极度 | Prefetch | Prerender |
| --- | ---: | ---: |
| `immediate` | 50 | 10 |
| 移动端 `eager` / `moderate` | 6（FIFO） | 2（FIFO） |
| 桌面 `eager` / `moderate` | 2（FIFO） | 2（FIFO） |
| `conservative` | 2（FIFO） | 2（FIFO） |

由交互触发的这几档是先进先出：悬停到第三个链接时，两个存活预渲染中最老的那个会被取消。被取消的推测可以被再次悬停重新触发，它已经下载的可缓存内容还在 HTTP 缓存里，所以第二次更便宜。移动端预取上限在 Chrome 150 提高到 6，因为视口启发式不如悬停准确。`immediate` 的上限是动态的：移除一条列表规则就会释放它占用的名额。

在以下情况，Chrome 会完全跳过推测：开启 Save-Data，开启节能模式且电量低，内存紧张，用户关闭了 **预加载网页**（Preload pages）设置（uBlock Origin 等扩展会关掉它），以及页面位于后台标签页。规则只是提示。什么都没发生时，你的代码必须照常工作，指标也必须讲得通。

### 如何选择

- **静态、轻量的页面**（博客、文档）：文档规则配 `prerender` + `moderate`，就是 Chrome 指南所说"基础但强大"的起点。
- **重的或个性化的页面**：先用 `prefetch` + `moderate`，或 `conservative` 的 prerender，等统计数据显示命中率不错再说。
- **已知的下一步**（分页、引导流程、结账）：给一两个 URL 写 `immediate` 列表规则，其他链接交给 `moderate` 文档规则。
- **移动端**：没有悬停，`moderate` 和 `eager` 是在猜视口，精度更低，优先用 prefetch。

## 5. 预渲染页面里的生活

预渲染页面会执行代码，但用户看不到它，所以浏览器必须阻止它做出用户会察觉、或用户不会同意的事。Prerendering Revamped 规范和 MDN 的受限功能列表描述了几类行为。

**推迟到激活。** 许多异步 API 立即返回一个挂起的 promise，直到激活前什么都不做，激活后再正常执行：地理定位、`Notification.requestPermission()`、`getUserMedia()`、Web MIDI、Web Locks、Service Worker 注册、`BroadcastChannel.postMessage()` 等。`AudioContext` 无法启动，媒体播放位置也不会前进。专用和共享 Worker 的脚本会被加载，但执行要等到激活。`<a download>` 触发的下载会被挂起。跨源 iframe 默认要到激活后才加载；从 Chrome 159 起，嵌入页可以用 `Supports-Loading-Mode: prerender-cross-origin-frames` 选择预渲染它们。

**失败或不起作用。** 需要用户激活的 API（`window.open()`、`requestFullscreen()`、`PaymentRequest.show()`、`navigator.share()`）、需要焦点的 API（异步 Clipboard API）、需要可见文档的 API（Screen Wake Lock、没有用户激活时的画中画），在尚未激活的页面里都会失败。`alert()` 立即返回，`confirm()` 返回 `false`，`prompt()` 返回 `""`，`print()` 被忽略。

**取消预渲染。** 导航到其他站点，或者顶层 URL 是 `javascript:`、`data:`、`blob:`、`about:blank` 之类，会在请求发出前直接丢弃预渲染。

**存储。** `sessionStorage` 按标签页划分，正常情况下同一个标签页里不会同时存活两个文档。所以预渲染页面一开始拿到的是标签页 session storage 的一份克隆；激活时克隆被丢弃，换成标签页真正的存储。`localStorage`、IndexedDB 和 cookie 照常共享，这也正是会出现过期状态的原因。

有三个 API 让页面知道自己处在生命周期的哪一步：

```js
// 页面处于隐藏的预渲染上下文时为 true
document.prerendering;

// 预渲染页面变成可见标签页时触发一次
document.addEventListener('prerenderingchange', onActivate, { once: true });

// 激活后大于 0：从预渲染开始到激活的毫秒数
performance.getEntriesByType('navigation')[0].activationStart;
```

一个小工具函数同时覆盖预渲染和与之相关的"在后台标签页打开"的情况：

```js
export const whenActivated = new Promise((resolve) => {
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', () => resolve(), { once: true });
  } else {
    resolve();
  }
});

export const whenFirstVisible = new Promise((resolve) => {
  if (document.hidden) {
    document.addEventListener('visibilitychange', () => resolve(), { once: true });
  } else {
    resolve();
  }
});
```

对这类导航，`PerformanceNavigationTiming.type` **不会** 报告 `prerender`，那个值属于旧的 `<link rel="prerender">`。应改用 `document.prerendering` 和 `activationStart`。

## 6. 陷阱

### GET 的副作用

推测请求就是一个带 cookie 的普通 GET。如果 `/cart/add?id=42`、`/logout`、`/unsubscribe?token=…`、`/notifications/mark-read` 在 GET 时改变服务端状态，现在一次悬停就可能触发它。正确的修法还是老办法：状态变更应该用 POST。务实的修法是在规则里加 `not` 谓词，给这类链接加 `.no-prerender` 类，并让服务器对带 `Sec-Purpose` 的动作 URL 请求返回非 2xx。

### 服务端计数与日志

浏览量计数、实验分桶、"最近浏览"列表、库存预占、限流器都会看到推测请求。如果某个服务端动作只能在真实浏览时发生，要么把它挪到激活后的客户端调用里，要么在带 `Sec-Purpose` 时跳过。

### 客户端统计

预渲染的 JavaScript 会执行。一个在加载时上报浏览量的统计脚本，会把没人看过的页面也算进去。Chrome 的指南提到 Google Analytics、Google Publisher Tag 和 AdSense 已经会等待激活；其他脚本需要你自己用 `whenActivated` 把关：

```js
async function initAnalytics() {
  await whenActivated;
  analytics.init();
  analytics.page({ prerendered: performance.getEntriesByType('navigation')[0].activationStart > 0 });
}
```

### 过期的个性化状态

20 秒前预渲染的商品页，购物车角标也是 20 秒前的。如果用户在这期间在当前页加了一件商品，预渲染页面在展示的那一刻就是错的。有三种工具，大致按优先顺序：

1. 在 `prerenderingchange` 时刷新易变的 UI（`visibilitychange` 时也要刷新，因为往返缓存和后台标签页有同样的问题）。
2. 用 `BroadcastChannel` 把当前页的变化广播给预渲染页面。
3. 在改变状态的接口（加入购物车、登录、登出）响应里返回 `Clear-Site-Data: "prefetchCache", "prerenderCache"`。Chrome 138 支持这两个指令，它们会整批取消推测。

### `No-Vary-Search`

很多 URL 只在服务器忽略的参数上不同（如 `utm_*`），或者只在客户端代码读取的参数上不同（如客户端渲染商品页上的 `?id=`）。响应头 `No-Vary-Search` 告诉浏览器哪些参数不影响响应，这样对 `/products` 的预取就能服务对 `/products?id=123` 的导航。Chrome 从 141 起对导航推测支持它。规则一侧的 `expects_no_vary_search` 只是一个提示，让浏览器等待进行中的预取而不是重复发请求；服务器仍然必须发送这个头。

```html
<script type="speculationrules">
{ "prefetch": [{ "urls": ["/products"], "expects_no_vary_search": "params=(\"id\")" }] }
</script>
```

对预渲染来说这个注意事项是真实存在的：页面可能是用不同参数（或不带参数）预渲染的。激活前 `location.href` 显示的是预渲染时的 URL，激活后才切换成最终 URL。任何根据查询参数渲染的代码，都必须在激活后执行或重新执行。

## 7. 跨源、隐私与 CSP

**预渲染** 默认只限同源。同站跨源页面（例如从 `www.example.com` 预渲染 `app.example.com`）只有在目标页通过 `Supports-Loading-Mode: credentialed-prerender` 选择加入时才能预渲染。跨站预渲染目前不可用。

**预取** 在同站跨源时没有限制。跨站预取只在用户没有目标站点 cookie 时才生效，否则一次预取就能让一个站点在另一个用户可能永远不会访问的站点上触发带凭据的请求，也就是一条与 cookie 关联的日志。配合 `requires: ["anonymous-client-ip-when-cross-origin"]`，Chrome 可以通过它的私有预取代理转发请求，如果发现存在 cookie 就丢弃响应，于是页面和代理都无法得知用户在别处有没有账号。一个常见且安全的组合是"同源预渲染，其余预取"：

```html
<script type="speculationrules">
{
  "prerender": [{ "where": { "href_matches": "/*" }, "eagerness": "moderate" }],
  "prefetch":  [{ "where": { "not": { "href_matches": "/*" } }, "eagerness": "moderate" }]
}
</script>
```

HTML 标准还约束了 `moderate` 和 `eager` 背后的启发式。服务器能观察到推测是否发生，所以用户代理只能依据源本来就能知道的信息做决定：作者给出的积极度、链接顺序、是否在视口内、光标是否靠近、链接尺寸。任何持久状态（比如"用户经常点这些链接"）都必须在用户清除站点数据时一并清除。

**CSP。** `<script type="speculationrules">` 仍然是一个 script 元素。设置了 `script-src` 的站点必须通过 hash、nonce，或 `'inline-speculation-rules'` 源关键字允许它。这个关键字覆盖的是由带 hash 或 nonce 的脚本注入的规则，而不是写在初始 HTML 里的规则。

## 8. 度量

**激活才是起跑线。** 对预渲染导航来说，用户的等待从激活开始，而不是从最初的导航开始。Chrome 的真实用户数据（CrUX）以 `activationStart` 为基准计算 Core Web Vitals，所以完整预渲染的页面常常报告 LCP 为 0。`web-vitals` 库从 3.1.0 起做法相同，并对这类导航报告 `navigationType: 'prerender'`。如果自研 RUM 脚本从 `navigationStart` 计算 LCP，就会把用户从未经历过的预渲染时间算到账上。

**预渲染改善的不只是 LCP。** 加载期间的布局偏移发生在页面展示之前，CLS 因此下降；加载期的工作通常在首次交互前已完成，这有利于 INP。

**给数据分组。** 在每次浏览上记录 `activationStart > 0`（预取则记录 `deliveryType === 'navigational-prefetch'`）作为维度。没有它，变好的平均值可能掩盖了变慢的一组用户。

**度量命中率。** 页面插入规则时（先检查 `HTMLScriptElement.supports('speculationrules')`）上报一个事件，激活时再上报一个。两者之比近似于被用上的推测所占比例。请求了的预渲染可能根本没有启动，所以这个比例是浏览器精度的下界，而不是精确计数。

**在 DevTools 里调试。** **Application → Speculative loads** 列出每个规则集、解析错误、每个候选 URL 的状态，以及每个未完成推测的失败原因。服务端可以借助 `Sec-Purpose` 单独统计推测请求。

**真实世界的信号。** WordPress 6.8 的开发说明提到，根据 HTTP Archive 和 CrUX，使用 Speculative Loading 插件的 5 万多个站点，LCP 达标率中位数提升了约 1.9%；截至 2025 年 3 月，超过 8% 的 Chrome 导航用到了推测规则。这些是生态层面的数字，你能拿到多少取决于自己的页面体积、服务端耗时和流量形态。

## 9. SPA、框架、CDN 与 WordPress

**SPA。** 推测规则只作用于浏览器管理的文档导航。客户端路由切换（"软导航"）是在当前文档内取数据、替换 DOM，没有东西可以预渲染。框架路由保留各自的预取机制：Next.js 的 `<Link>`、Nuxt 的链接预取、React Router 的 loader、TanStack Router 的 `preload`。推测规则仍然可以从营销页预渲染 SPA 的 **入口文档**，抵消应用庞大的首次加载，而那往往是它最贵的时刻。

**MPA 与群岛架构。** 推测规则在服务端渲染的多页面站点上效果最好，包括 Astro 这样的群岛架构，那里每个链接都是真实导航。再配合跨文档 View Transitions（`@view-transition { navigation: auto; }`），一个预渲染的 MPA 不需要客户端路由也能有 SPA 般的手感。

**CDN。** Cloudflare 的 Speed Brain 在边缘注入 conservative 的预取规则。`Speculation-Rules` 头和 `Sec-Speculation-Tags` 很大程度上就是为这类部署准备的：CDN 不改 HTML 就能加规则，再识别出自己发起的推测请求，拒绝那些会未命中缓存、打到源站的请求。

**WordPress。** WordPress 6.8 在核心里为所有前台默认开启推测加载，但已登录用户或未启用固定链接（pretty permalinks）的站点除外。默认是 `prefetch` + `conservative`，与 Cloudflare 的默认一致。此前的功能插件默认是 `prerender` + `moderate`；核心考虑到 WordPress 的规模选了更稳妥的默认值，部分原因是一些插件会使用 GET 形式的"动作 URL"。

## 10. 浏览器与规范的现状

- **Chromium**（Chrome、Edge、Opera）在 Chrome 109 通过推测规则上线预渲染，Chrome 110 上线预取。之后陆续加入：121 的积极度和响应头，136 的 `tag`，138 的 `target_hint` 与 `Clear-Site-Data` 指令，141 的 `No-Vary-Search`，143 的新版 `eager`，159 的跨源 iframe 选择加入。
- **Safari**：MDN 浏览器兼容数据在 2026 年 11 月 12 日记录，"SpeculationRules prefetch" 开关在 Safari 27.3 beta 中默认开启。它覆盖的是预取，不包括预渲染。
- **Firefox**：`urls` 列表 + `immediate` 积极度的预取、`moderate` 积极度、`Speculation-Rules` 头都已实现，受 `dom.speculation_rules.enabled` 控制。按 Firefox 160 的开发者说明（2026 年 11 月 10 日），它们在 Nightly 中默认开启，正式版尚未默认开启。
- **规范**：HTML 标准现在包含推测规则语法和导航预取。它的解析器接受 `prerender`，但可以"选择性地"把它当作 prefetch 处理；预渲染本身仍在 WICG 的 **Prerendering Revamped** 规范里。所以在只支持预取的浏览器上，prerender 规则应当退化为预取。

实践上的结论：规则写一次，用 `document.prerendering` 给副作用把关，各个引擎就会执行自己支持的那部分。不支持的引擎会忽略未知类型的 `<script>`。

## 11. 权衡

| 方案 | 点击之后还要做什么 | 没用上时的代价 | 主要风险 |
| --- | --- | --- | --- |
| 不做推测 | 完整的网络 + 渲染路径 | 无 | — |
| `<link rel="prefetch">` | 渲染路径；文档仅在可被 HTTP 缓存时省掉 | 一次下载进 HTTP 缓存 | `no-store` 文档白取；没有导航级隐私模型 |
| 规则 `prefetch` | 渲染路径（文档已在内存） | 一次文档下载 | GET 副作用；服务端计数 |
| 规则 `prerender_until_script` | 脚本及之后的工作 | 文档 + 子资源 + 部分渲染 | 仅限源试用 |
| 规则 `prerender` | 激活切换 | 整页加载、内存、CPU | 以上全部，加上统计、过期 UI、依赖查询参数的渲染 |
| 路由预取（SPA） | 数据或拆分代码块可能已就绪 | 取决于框架 | 重复数据、缓存失效 |

一个简短的决策流程：

1. 让 GET 幂等，并在规则里排除例外。
2. 把统计、广告和"已浏览"类副作用推迟到激活之后。
3. 从 `prefetch` / `moderate` 文档规则开始，度量命中率。
4. 对命中率高、内容稳定的页面类型升级为 `prerender`。
5. 为产品流程已经能预测的步骤加一个短的 `immediate` 列表。
6. 在状态变化会让推测失效的地方加 `Clear-Site-Data` 或 `BroadcastChannel`。

## 12. 一个可运行模型

下面的脚本模拟推测何时开始、能隐藏多少导航时间，以及每种策略会发出多少没用上的推测。本节每个数字都来自运行它的结果。它 **不是** 对浏览器的测量，而是把假设写成了代码，所有假设都放在文件顶部：文档获取 400 ms，之后的子资源、脚本和绘制 600 ms，按下到 click 间隔 80 ms，HTML 60 KB、整页 1,200 KB，40 个链接按 Zipf 分布受欢迎程度，点击目标之前随手掠过 0–4 个链接，悬停停留时间服从指数分布。悬停阈值（10 ms 和 200 ms）、桌面端 FIFO 上限 2、`conservative` 由按下触发，都遵循 Chrome 文档描述的行为。`immediate` 被建模为一条在页面加载时列出最受欢迎 5 个链接的列表规则。

在这个模型里，预取隐藏 `min(lead, 400)` ms，预渲染隐藏 `min(lead, 1000)` ms，其中 *lead* 是推测开始到点击之间的时间。

```python
#!/usr/bin/env python3
"""Toy model of Speculation Rules eagerness: when does a speculation start,
how much navigation latency does it hide, and how much does it waste?
All timing and size inputs are assumptions of the model, not measurements."""
import random
import statistics

FETCH_MS = 400        # time to fetch the HTML document
RENDER_MS = 600       # subresources, script and first paint after the HTML arrives
FULL_MS = FETCH_MS + RENDER_MS
DOC_KB = 60           # HTML document size (prefetch cost)
PAGE_KB = 1200        # full page weight incl. subresources (prerender cost)
PRESS_MS = 80         # pointerdown -> click; navigation starts on click
LINKS = 40            # links on the page, popularity follows a Zipf curve
LIST_URLS = 5         # "immediate" list rule names the 5 most popular links
SESSIONS = 20000
HOVER_LIMIT = 2       # Chrome's FIFO limit for eager/moderate/conservative on desktop
HOVER_THRESHOLD = {"eager": 10, "moderate": 200, "conservative": None}


def zipf_weights(n, s=1.1):
    w = [1 / (i + 1) ** s for i in range(n)]
    total = sum(w)
    return [x / total for x in w]


WEIGHTS = zipf_weights(LINKS)


def session(rng):
    """One page view: some links skimmed, then a dwell and a press on the target."""
    target = rng.choices(range(LINKS), WEIGHTS)[0]
    hovers, t = [], rng.uniform(1500, 6000)   # reading time before the first hover
    for _ in range(rng.randint(0, 4)):         # links skimmed but not clicked
        hovers.append((rng.randrange(LINKS), t, rng.expovariate(1 / 250)))
        t += hovers[-1][2] + rng.uniform(100, 800)
    dwell = rng.expovariate(1 / 350)
    hovers.append((target, t, dwell))
    pointerdown = t + dwell
    return hovers, target, pointerdown, pointerdown + PRESS_MS


def hover_rule(policy, hovers, target, pointerdown):
    """Return ({link: start_ms} still alive at click time, set of URLs ever speculated)."""
    th = HOVER_THRESHOLD[policy]
    alive, ever = [], set()
    for link, start, dwell in hovers:
        if th is None:                      # conservative: pointerdown only
            if link != target:
                continue
            fire = pointerdown
        elif dwell >= th:
            fire = start + th
        elif link == target:
            fire = pointerdown              # pointerdown fires before the threshold
        else:
            continue
        if any(l == link for l, _ in alive):
            continue
        ever.add(link)
        alive.append((link, fire))
        if len(alive) > HOVER_LIMIT:
            alive.pop(0)                    # FIFO: the oldest speculation is cancelled
    return dict(alive), ever


def remaining(kind, lead):
    if lead is None:
        return FULL_MS
    if kind == "prefetch":
        return max(0.0, FETCH_MS - lead) + RENDER_MS
    return max(0.0, FULL_MS - lead)


def run(policy, kind, rng):
    rows = []
    for _ in range(SESSIONS):
        hovers, target, pointerdown, click = session(rng)
        alive, ever = {}, set()
        if policy in ("immediate", "immediate+moderate"):
            alive = {i: 0.0 for i in range(LIST_URLS)}   # issued at page load
            ever = set(alive)
        if policy != "immediate":
            h_alive, h_ever = hover_rule(policy.split("+")[-1], hovers, target, pointerdown)
            for link, start in h_alive.items():
                alive.setdefault(link, start)
            ever |= h_ever
        lead = click - alive[target] if target in alive else None
        rows.append((lead is not None, remaining(kind, lead), len(ever) - (lead is not None)))
    lat = sorted(r[1] for r in rows)
    waste = statistics.mean(r[2] for r in rows)
    kb = DOC_KB if kind == "prefetch" else PAGE_KB
    return (sum(r[0] for r in rows) / len(rows), statistics.mean(lat),
            lat[len(lat) // 2], waste, waste * kb)


def main():
    print(f"assumptions: fetch={FETCH_MS}ms render={RENDER_MS}ms press={PRESS_MS}ms "
          f"links={LINKS} list_urls={LIST_URLS} sessions={SESSIONS}")
    print(f"{'kind':9} {'eagerness':19} {'hit':>6} {'mean ms':>8} {'p50 ms':>7} "
          f"{'waste/nav':>9} {'waste KB':>9}")
    for kind in ("prefetch", "prerender"):
        for policy in ("conservative", "moderate", "eager", "immediate", "immediate+moderate"):
            h, mean, p50, w, kb = run(policy, kind, random.Random(172))
            print(f"{kind:9} {policy:19} {h:6.1%} {mean:8.0f} {p50:7.0f} {w:9.2f} {kb:9.0f}")
    print(f"no speculation: every navigation pays {FULL_MS} ms")


if __name__ == "__main__":
    main()
```

输出（`python3 model.py`）：

```text
assumptions: fetch=400ms render=600ms press=80ms links=40 list_urls=5 sessions=20000
kind      eagerness              hit  mean ms  p50 ms waste/nav  waste KB
prefetch  conservative        100.0%      920     920      0.00         0
prefetch  moderate            100.0%      801     881      0.86        52
prefetch  eager               100.0%      713     677      1.83       110
prefetch  immediate            58.5%      766     600      4.42       265
prefetch  immediate+moderate  100.0%      684     600      5.18       311
prerender conservative        100.0%      920     920      0.00         0
prerender moderate            100.0%      728     881      0.86      1036
prerender eager               100.0%      588     677      1.83      2202
prerender immediate            58.5%      415       0      4.42      5298
prerender immediate+moderate  100.0%      303       0      5.18      6220
no speculation: every navigation pays 1000 ms
```

这张表可以归纳为四个结论。

**在桌面端，基于悬停的几档在这个模型里从不落空，区别在于提前量。** 每次会话都以在目标链接上悬停并按下结束，而且即使没到悬停阈值，按下也会触发推测，所以 `conservative`、`moderate`、`eager` 的命中率都是 100%。变化的是开始得有多早。`conservative` 只拿到 80 ms 的按压时间，节省 80 ms（1000 → 920）。`moderate` 把预渲染均值降到 728 ms，`eager` 降到 588 ms。`moderate` 的 p50 仍是 881 ms，因为模型里停留时间的中位数（约 243 ms）只比 200 ms 阈值高一点，典型会话只多出约 120 ms。在链接上停得更久的真实用户收益更大。这个结论依赖悬停假设：移动端没有悬停，视口启发式靠猜，就可能落空。

**预取有下限。** 没有一行预取低于 600 ms，因为预取只省掉文档获取，600 ms 的渲染工作仍在点击之后。预渲染可以把它全部藏起来。`immediate` 预渲染的中位数是 0 ms：当前 5 名列表包含目标时，页面早在点击前就已就绪。

**浪费随积极度增长，预渲染会把它放大。** `moderate` 每次导航对 0.86 个用不上的 URL 发起推测，`eager` 是 1.83 个，因为越过阈值的掠过链接也算在内。FIFO 上限 2 限制的是同时存活的数量，而不是总共发起的数量。每个没用上的预取浪费一个 60 KB 的文档，每个没用上的预渲染浪费一个 1,200 KB 的页面。同样 1.83 个没用上的推测，作为预取是 110 KB，作为预渲染是 2,202 KB。

**列表规则单次命中收益最大，但每次落空都要付钱。** 在这个 Zipf 分布下，前 5 名的 `immediate` 列表覆盖 58.5% 的点击。这部分导航瞬间完成，另外 41.5% 付全价，均值 415 ms，每次导航有 4.42 个没用上的整页预渲染（5,298 KB）。再加一条 `moderate` 文档规则补上其余部分：命中率 100%，均值 303 ms，每次导航浪费 6,220 KB。这笔交易是否可接受取决于流量费用和设备内存，这也是 Chrome 把 `immediate` 预渲染限制在 10 个、并在 Save-Data 下关闭所有推测的原因。

模型没有考虑的东西：只有部分可缓存的页面、服务端花在推测请求上的时间、预渲染与当前页面之间的资源争用、按下链接又取消的用户（这会让 `conservative` 也产生浪费），以及浏览器施加的各种取消原因。把你自己的获取时间、渲染时间和页面体积代进去，同样的方法就能告诉你下一步该用 `prefetch`、`prerender`，还是更长的停留阈值。

## 总结

- 推测规则用 JSON 声明可能的下一次导航。**列表规则** 直接列出 URL，默认 `immediate`；**文档规则** 用 `href_matches`（URL Pattern）和 `selector_matches`（CSS）匹配页面中的链接，以 `and`、`or`、`not` 组合，默认 `conservative`。未知键或非法值会让规则失效，而不是被忽略。
- **预取** 把下一个文档的响应存进按文档划分的内存缓存，省掉网络往返；**预渲染** 在隐藏上下文里加载、执行并绘制页面，激活时换上。请求带 `Sec-Purpose: prefetch` 或 `prefetch;prerender`，非 2xx 响应会取消它们。
- **积极度** 表达的是意图：`immediate`、`eager`、`moderate`、`conservative`。在桌面端，Chrome 把它们分别映射为"一看到规则就执行"、悬停 10 ms、悬停 200 ms 或按下、按下；移动端用视口启发式。交互触发的推测共享 FIFO 上限 2（移动端预取为 6），`immediate` 允许 50 个预取和 10 个预渲染。
- 预渲染页面会执行 JavaScript，但打扰用户的 API 会被推迟到激活或直接失败。用 `document.prerendering` 和 `prerenderingchange` 给统计和副作用把关，激活时刷新易变 UI，状态变化时用 `Clear-Site-Data: "prefetchCache", "prerenderCache"` 使推测失效。
- 预渲染只限同源，除非目标页发送 `Supports-Loading-Mode: credentialed-prerender`；跨站预取要求用户没有目标站点的 cookie；CSP 必须通过 hash、nonce 或 `'inline-speculation-rules'` 允许规则脚本。
- 像 CrUX 和 `web-vitals` 3.1.0+ 那样从 `activationStart` 开始度量，给预渲染浏览单独分组，并跟踪命中率。在本文的模型里，基于悬停的几档在桌面端每次都命中，区别在提前量；预取无法低于 600 ms 的渲染下限；`immediate` 前 5 名预渲染列表让 58.5% 的导航瞬间完成，代价是每次导航 4.42 个没用上的整页。

## 参考资料

- HTML Standard，[Speculative loading](https://html.spec.whatwg.org/multipage/speculative-loading.html)（规则语法、积极度定义、严格解析、启发式的隐私考量）
- WICG，[Prerendering Revamped](https://wicg.github.io/nav-speculation/prerendering.html) 与 [Speculation Rules](https://wicg.github.io/nav-speculation/speculation-rules.html)
- MDN，[Speculation Rules API](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API)（预取与预渲染行为、`Sec-Purpose`、不安全条件、被推迟和受限的功能、session storage 克隆）
- MDN，[`<script type="speculationrules">`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/speculationrules)
- Barry Pollard，[Prerender pages in Chrome for instant page navigations](https://developer.chrome.com/docs/web-platform/prerender-pages)，Chrome for Developers，2026 年 11 月 13 日更新（积极度启发式、上限、响应头、tag、`target_hint`、`No-Vary-Search`、`prerender_until_script`、跨源规则、CSP、统计与度量）
- Chrome for Developers，[Guide to implementing speculation rules for more complex sites](https://developer.chrome.com/docs/web-platform/implementing-speculation-rules)
- Chrome for Developers，[Debugging speculation rules](https://developer.chrome.com/docs/devtools/application/debugging-speculation-rules)
- Felix Arntz，[Speculative Loading in 6.8](https://make.wordpress.org/core/2025/03/06/speculative-loading-in-6-8/)，Make WordPress Core，2025 年 3 月 6 日（核心默认值、LCP 达标率中位数提升约 1.9%、超过 8% 的 Chrome 导航）
- MDN browser-compat-data，[Safari 27.3 enables speculation rules](https://github.com/mdn/browser-compat-data/pull/31113)，2026 年 11 月 12 日
- MDN，[Firefox 160 release notes for developers](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/160) 与 [Experimental features in Firefox](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features)（`dom.speculation_rules.enabled`）
