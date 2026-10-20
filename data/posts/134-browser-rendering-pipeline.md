---
title: "From DOM to Pixels: Inside the Browser Rendering Pipeline (Style, Layout, Paint, Composite)"
tag: performance
description: What a browser does between a DOM change and the next frame on screen — the HTML event loop's rendering steps, Chromium's RenderingNG stages and threads, forced synchronous layout, compositor-only animation, layers and their costs, content-visibility, and how to measure jank with INP and the Long Animation Frames API
date: "2026-10-20T13:30:00.000Z"
---

## Goal

Most frontend performance advice comes as a list of rules: animate `transform` instead of `left`, don't read `offsetHeight` in a loop, add `will-change` carefully, use `content-visibility` for long pages. The rules are right, but they are hard to apply to a new situation unless you know *why* they hold.

This article follows a single DOM change all the way to pixels. It covers where rendering sits in the HTML event loop, the stages of Chromium's RenderingNG pipeline and which thread runs each one, why some changes are almost free while others cost a full layout, and how to measure the result in production. Chromium is used as the main reference because its architecture is publicly documented in detail; the section on other engines shows what is shared and what differs.

## The Frame Budget

A 60 Hz display shows a new frame every 1000 / 60 ≈ 16.7 ms; a 120 Hz display every ≈ 8.3 ms. If the browser cannot produce a frame in time, the previous one stays on screen and the user perceives a stutter (jank). web.dev's rendering performance guide points out that the browser has its own housekeeping inside that window, so it recommends keeping your own per-frame work to roughly **10 ms** at 60 Hz.

Two kinds of work compete for that budget:

- **Your JavaScript**: event handlers, framework rendering, timers, `requestAnimationFrame` callbacks.
- **The browser's rendering work**: recalculating styles, layout, paint, and producing the frame.

Both run on the renderer's **main thread** unless the browser can push work to another thread. Most of the techniques in this article are ways of either doing less rendering work or moving it off the main thread.

## Where Rendering Happens in the Event Loop

The HTML specification defines rendering as part of the event loop. After a task (for example a click handler) and its microtasks finish, the browser may run the **"update the rendering"** steps for each document. Simplified, the order is:

1. Run resize and scroll steps (fire `resize` and `scroll` events).
2. Evaluate media queries and report changes.
3. Update animations and send animation events.
4. Run **`requestAnimationFrame` callbacks**.
5. **Recalculate styles and update layout**, then deliver **`ResizeObserver`** notifications (and repeat style/layout if those observers changed something).
6. Update **`IntersectionObserver`** observations.
7. Paint: update the rendering to reflect the current state.

Three practical consequences follow directly from this order:

- `requestAnimationFrame` runs **right before style and layout**, which makes it the right place to *write* visual changes for the next frame: your writes are batched into the one style/layout pass that is going to happen anyway.
- The browser does **not** render after every task. It renders when a frame is due (typically aligned with the display's vsync) and only if something changed. A hundred DOM mutations in one task cost one style/layout pass — unless you force more.
- A long task blocks rendering entirely. If a click handler runs for 300 ms, no frame can be produced during those 300 ms, which is exactly what Interaction to Next Paint (INP) measures.

## The RenderingNG Pipeline

Chromium's RenderingNG architecture documentation splits rendering into these stages:

| Stage | What it does | Where it runs |
| --- | --- | --- |
| Animate | Applies declarative animations: changes computed styles and mutates property trees over time | Main thread or compositor |
| Style | Applies CSS to the DOM and produces computed styles | Main thread |
| Layout | Computes size and position of boxes, producing an immutable **fragment tree** | Main thread |
| Pre-paint | Computes **property trees** and invalidates display lists and GPU tiles as needed | Main thread |
| Scroll | Updates scroll offsets by mutating property trees | Main thread or compositor |
| Paint | Produces a **display list** — drawing commands, not pixels | Main thread |
| Commit | Copies property trees and display list to the compositor thread | Main → compositor |
| Layerize | Splits the display list into composited layers that can be rasterized and animated independently | Compositor |
| Raster / decode / paint worklets | Turns display lists, encoded images and paint worklet code into GPU texture tiles | Raster threads / GPU |
| Activate | Builds a **compositor frame**: how to draw and position tiles, plus visual effects | Compositor |
| Aggregate | Combines compositor frames from all visible frames (including cross-process iframes) and browser UI into one | Viz (GPU) process |
| Draw | Executes the aggregated frame on the GPU to produce pixels | Viz (GPU) process |

The key sentence in that documentation is that **stages can be skipped when they are not needed**: animations of visual effects and scrolling can skip layout, pre-paint and paint, and in that case can run entirely on the compositor thread without touching the main thread.

### The data structures that make skipping possible

Two of the artifacts deserve attention because they explain the cost model:

- **Property trees.** Instead of baking transforms, clips, opacity and scroll offsets into every drawing command, Chromium keeps them in four separate trees — transform, clip, effect and scroll. A paint chunk references nodes in those trees. When only a transform or opacity value changes, the browser updates one tree node; the display list stays valid and the rasterized tiles can be reused.
- **Display lists and tiles.** Paint records commands such as "draw this rect" and "draw this text run". Raster converts them into GPU textures in tiles. Content that did not change keeps its tiles; scrolling mostly means drawing existing tiles at a new offset.

This is the mechanism behind the familiar rule. Changing `transform` or `opacity` on a composited layer only mutates a property tree node, which the compositor can apply by itself. Changing `width` invalidates layout, which invalidates paint, which invalidates raster for the affected area.

## What Each Kind of Change Costs

A useful mental model is to ask which is the *first* stage a change invalidates; everything after it has to run again.

| Change | Style | Layout | Paint | Raster / composite |
| --- | --- | --- | --- | --- |
| `width`, `height`, `top`, `margin`, `font-size`, adding/removing nodes, changing text | yes | yes | yes | yes |
| `color`, `background-color`, `box-shadow`, `border-radius` | yes | — | yes | yes |
| `transform`, `opacity` on an element with its own composited layer | yes | — | — | composite only |

Exact behaviour varies between engines and versions (for example, whether an element already has its own layer), so treat the table as a model and confirm with DevTools. The direction is stable across engines, though: geometry is expensive, pure visual effects are cheap.

Style itself is not free either. Recalculation cost grows with the number of elements whose style is invalidated and the complexity of the selectors that must be matched against them. Toggling a class on `<body>` can invalidate styles for the entire document; toggling it on the component that actually changes keeps the invalidation small.

## Forced Synchronous Layout and Layout Thrashing

Normally layout is lazy: you write styles, and the browser lays out once, at the next rendering opportunity. But some APIs need up-to-date geometry *now*. Reading `offsetWidth`, `offsetTop`, `clientHeight`, `scrollTop`, `getBoundingClientRect()`, layout-dependent values from `getComputedStyle()`, `innerText`, or calling `focus()` and `scrollIntoView()` while styles are dirty forces the browser to run style and layout synchronously, in the middle of your JavaScript. Paul Irish maintains a widely referenced list of these APIs.

One forced layout is sometimes unavoidable. The real problem is **layout thrashing**: interleaving reads and writes so that every read forces a new layout.

```js
// Layout thrashing: each iteration writes, then the next read forces layout again
function resizeCardsSlow(container, cards) {
  for (const card of cards) {
    const width = container.offsetWidth;       // read  -> forced layout (after the 1st write)
    card.style.width = `${width / 3}px`;        // write -> invalidates layout
  }
}

// Batched: one read, then all writes; layout runs once, at the next frame
function resizeCardsFast(container, cards) {
  const width = container.offsetWidth;          // single read
  for (const card of cards) {
    card.style.width = `${width / 3}px`;        // writes only
  }
}
```

With 500 cards, the first version can run 500 layouts in one task; the second runs one. In larger codebases reads and writes live in different components, so the usual fix is structural:

- **Read in one phase, write in another.** Do measurements first (or in a `ResizeObserver` callback, which gives you sizes after layout without forcing an extra one), and schedule writes inside `requestAnimationFrame`.
- **Let CSS do the layout.** A grid with `grid-template-columns: repeat(3, 1fr)` replaces the whole loop above with zero JavaScript.
- **Watch frameworks' escape hatches.** `useLayoutEffect` in React and similar hooks run synchronously after DOM mutation; measuring there is fine, but writing and measuring repeatedly across many components recreates thrashing.

## Animating on the Compositor

When an animation only changes `transform` or `opacity` and is declared with CSS animations, CSS transitions or the Web Animations API, Chromium can hand the whole animation to the compositor thread. It then keeps running smoothly even while the main thread is busy executing JavaScript. A `requestAnimationFrame` loop that sets `style.left` every frame, by contrast, needs the main thread *and* a layout every frame.

A classic way to animate a layout change while staying on the compositor is **FLIP** (First, Last, Invert, Play): measure the start position, apply the final layout, measure again, then animate a transform from the old position back to zero.

```js
// FLIP: animate a layout change using only transform
function flip(el, applyLayoutChange) {
  const first = el.getBoundingClientRect();     // First
  applyLayoutChange();                          // e.g. move el into another column
  const last = el.getBoundingClientRect();      // Last (one deliberate forced layout)

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

The View Transitions API builds on the same idea at the platform level: it snapshots the old and new states and animates between them with compositor-friendly effects, so you get FLIP-style transitions without writing the math.

Scrolling follows the same logic. Chromium scrolls on the compositor thread unless something forces it to ask the main thread first. The most common culprit is a non-passive `touchstart`, `touchmove` or `wheel` listener, because the browser must wait to see whether the handler calls `preventDefault()`. Declaring listeners passive removes that wait:

```js
window.addEventListener('wheel', onWheel, { passive: true });
```

Chrome already treats such listeners on `window`, `document` and `body` as passive by default; listeners on other elements still need the flag. Scroll-driven effects are better expressed with CSS scroll-driven animations (`animation-timeline: scroll()` / `view()`), which Chromium can run off the main thread for compositor-friendly properties, rather than a `scroll` handler that writes styles.

## Layers: Useful, But Not Free

A composited layer is what lets the compositor move or fade content without repainting it. Elements get their own layer for explicit reasons — an active `transform`/`opacity` animation, `will-change: transform`, video, canvas, fixed positioning in some cases — and for implicit ones, such as overlapping another composited layer.

Each layer has a cost: GPU memory for its tiles, and bookkeeping in the compositor. web.dev's guidance is to promote elements that you are actually about to animate, and to avoid promoting large numbers of elements "just in case". Practical rules:

- Add `will-change` shortly before an animation starts (or keep it only on a small number of elements that animate constantly), not on every card in a list.
- Watch for **layer explosion**: one promoted element low in the stacking order can cause many elements that overlap it to be promoted too.
- Use DevTools' **Layers** panel and the **Rendering → Layer borders / Paint flashing** options to see what is actually promoted and repainted.

## Doing Less Work: Containment and `content-visibility`

The cheapest rendering work is the work the browser can prove it does not need. CSS containment gives it that proof.

- `contain: layout` tells the engine that the element's internal layout does not affect anything outside it, so a change inside it does not require re-laying out the rest of the page.
- `contain: paint` clips descendants to the element's box, so off-screen descendants never need painting.
- `contain: size` says the element's size does not depend on its children.

`content-visibility: auto` combines these and goes further: for elements that are far from the viewport, the browser **skips style, layout and paint for their subtree entirely** until they approach the screen. For long documents, feeds and chat histories this can cut initial rendering work dramatically. Because a skipped subtree has no layout, give it a placeholder size so the scrollbar does not jump:

```css
.feed-item {
  content-visibility: auto;
  /* "auto" remembers the last rendered size; 600px is only the first guess */
  contain-intrinsic-size: auto 600px;
}
```

Trade-offs to keep in mind: skipped content is still in the DOM and accessible, but find-in-page and anchor navigation make the browser render it on demand, and a poor `contain-intrinsic-size` estimate causes scrollbar movement as items render. For lists with tens of thousands of items, virtualization (rendering only visible rows) still wins because the DOM nodes themselves cost memory.

## Breaking Up Long Tasks

Rendering cannot happen while a task is running, so the other half of smooth UI is keeping JavaScript tasks short. A long task is conventionally anything over 50 ms. The main tool is **yielding**: split work into chunks and give the browser a chance to render and handle input in between.

```js
function yieldToMain() {
  if (globalThis.scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function processAll(items, handle) {
  let deadline = performance.now() + 8;          // stay well under one frame
  for (const item of items) {
    handle(item);
    if (performance.now() > deadline) {
      await yieldToMain();                       // let the browser render / handle input
      deadline = performance.now() + 8;
    }
  }
}
```

`scheduler.yield()` is preferable to `setTimeout` where available because its continuation is scheduled ahead of other queued tasks of the same priority, so yielding does not send your work to the back of the line. For interactions, a common pattern is to apply the immediate visual feedback first (toggle a pressed state), yield so that the next paint can happen, and then do the expensive part.

## Measuring It

Lab profiling and field measurement answer different questions; you need both.

- **DevTools Performance panel.** A trace shows tasks on the main thread with purple (style/layout) and green (paint) blocks. Forced layouts are flagged with a warning and a stack trace pointing to the line of JavaScript that read geometry.
- **INP (Interaction to Next Paint).** The Core Web Vital for responsiveness: the time from an interaction to the next frame being presented, which includes input delay, handler time and rendering. "Good" is 200 ms or less; above 500 ms is "poor".
- **Long Animation Frames API (LoAF).** Where the older Long Tasks API only said "a task took long", LoAF reports frames whose total work exceeded 50 ms and attributes time to individual scripts — including how much of each script's time was spent in forced style and layout.

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

Sending this data to your RUM pipeline (in aggregated form) tells you which scripts cause layout thrashing on real devices, which are usually far slower than a developer laptop.

## Other Engines

The overall shape — style, layout, paint into a display list, then rasterize and composite on the GPU — is shared by all modern engines, but the split of work differs:

- **Chromium (Blink + cc + Viz)** uses property trees, a compositor thread per renderer, and a separate Viz process that aggregates frames from site-isolated iframes and browser UI.
- **Firefox (Gecko + WebRender)** builds a display list on the main thread and hands it to WebRender, which renders it on the GPU much like a game engine draws a scene each frame. Mozilla's introduction of WebRender describes the goal as removing the separate "decide what to put in layers" problem as a source of jank.
- **WebKit (Safari)** also composites with layers (backed by Core Animation on Apple platforms), and runs accelerated animations and scrolling off the main thread.

The performance rules in this article hold across all three because they come from the same underlying fact: geometry changes ripple through every later stage, while transform, opacity and scroll can be applied to already-rendered content.

## A Checklist

1. Keep each task short; yield inside long loops and after giving immediate feedback for interactions.
2. Never interleave geometry reads and style writes; read first, write in `requestAnimationFrame`.
3. Animate `transform` and `opacity` with CSS or the Web Animations API; use FLIP or View Transitions for layout changes.
4. Make scroll and touch listeners passive; prefer CSS scroll-driven animations to scroll handlers.
5. Promote layers deliberately and inspect them in DevTools.
6. Use `contain` and `content-visibility: auto` for independent, off-screen sections; virtualize very long lists.
7. Measure INP and collect LoAF attribution from real users.

## Summary

A frame is the output of a pipeline: the event loop gives rendering a slot after tasks, style and layout turn DOM and CSS into a fragment tree, paint records a display list, and the compositor and GPU turn tiles and property trees into pixels. Every rendering rule of thumb is a statement about that pipeline. Geometry changes invalidate the early stages and everything after them; transform, opacity and scroll touch only property trees and can run on the compositor; forced synchronous layout drags the pipeline into the middle of your JavaScript; containment lets the browser skip work it can prove is unnecessary. Once you can say which stage a change invalidates and which thread has to do the work, you can predict its cost before you profile it — and use the profiler to confirm.

## References

- Chrome for Developers, [RenderingNG overview](https://developer.chrome.com/docs/chromium/renderingng)
- Chrome for Developers, [RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)
- Chrome for Developers, [Key data structures in RenderingNG](https://developer.chrome.com/docs/chromium/renderingng-data-structures)
- Chrome for Developers, [Inside look at modern web browser (part 3)](https://developer.chrome.com/blog/inside-browser-part3)
- WHATWG HTML Standard, [Event loops and the "update the rendering" steps](https://html.spec.whatwg.org/multipage/webappapis.html)
- web.dev, [Rendering performance](https://web.dev/articles/rendering-performance)
- web.dev, [Avoid large, complex layouts and layout thrashing](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)
- web.dev, [Stick to compositor-only properties and manage layer count](https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count)
- web.dev, [content-visibility: the new CSS property that boosts your rendering performance](https://web.dev/articles/content-visibility)
- MDN, [contain](https://developer.mozilla.org/en-US/docs/Web/CSS/contain)
- Paul Irish, [What forces layout / reflow](https://gist.github.com/paulirish/5d52fb081b3570c81e3a)
- web.dev, [Interaction to Next Paint (INP)](https://web.dev/articles/inp)
- Chrome for Developers, [Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- Chrome for Developers, [Use scheduler.yield() to break up long tasks](https://developer.chrome.com/blog/use-scheduler-yield)
- Mozilla Hacks, [The whole web at maximum FPS: How WebRender gets rid of jank](https://hacks.mozilla.org/2017/10/the-whole-web-at-maximum-fps-how-webrender-gets-rid-of-jank/)
