---
title: "The JavaScript Event Loop in Depth: Tasks, Microtasks, Rendering Steps, Node.js Phases and Yielding to the Main Thread"
tag: javascript
description: How the JavaScript event loop really works in browsers and Node.js — the HTML processing model, task queues vs the microtask queue, where requestAnimationFrame and rendering fit, timer clamping, Node's libuv phases with process.nextTick and setImmediate, microtask starvation, and practical ways to break up long tasks (setTimeout, MessageChannel, scheduler.postTask, scheduler.yield) for better INP
date: "2026-11-07T10:30:00.000Z"
---

## Goal

"JavaScript is single-threaded and has an event loop" is the sentence every front-end engineer knows. It is also where most explanations stop, which is why ordering puzzles like `setTimeout` vs `Promise.then` vs `requestAnimationFrame` keep showing up in interviews and, more importantly, in production bugs: a spinner that never paints, a click handler that feels sluggish, a Node.js server whose timers drift by hundreds of milliseconds.

This article walks through the actual mechanisms:

1. The HTML event loop processing model: tasks, the microtask checkpoint, and the "update the rendering" step.
2. Where `requestAnimationFrame`, style, layout and paint fit in a frame.
3. Timer semantics, including the nested-timer clamp.
4. Node.js: libuv phases, `process.nextTick`, `setImmediate`, and how they differ from browsers.
5. Microtask starvation, measured.
6. Yielding strategies — `setTimeout`, `MessageChannel`, `scheduler.postTask`, `scheduler.yield` — and how React's scheduler does it.
7. How all of this maps to Interaction to Next Paint (INP).

All Node.js output shown below was produced on Node.js v20.19.2.

## 1. The engine has no event loop — the host does

A common misconception is that V8 (or SpiderMonkey, or JavaScriptCore) "has an event loop". It doesn't. The ECMAScript specification defines *jobs* and *job queues* (Promise reactions are jobs), but deciding *when* to run them is left to the **host**. Browsers implement the loop described in the [HTML Standard's event loop section](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops); Node.js implements its own loop on top of [libuv](https://docs.libuv.org/en/v1.x/design.html).

The engine provides one thing the loop relies on: a single **call stack**. While any JavaScript frame is on the stack, nothing else in that realm can run. Every scheduling API is ultimately a way of saying "run this later, after the stack is empty".

## 2. The browser processing model

Simplified from the HTML Standard, each iteration of a window event loop does this:

```text
loop:
  1. Pick ONE runnable task from one of the task queues
     (the browser chooses which queue; e.g. input may be favoured)
  2. Run it to completion
  3. Perform a microtask checkpoint:
       while microtask queue not empty: run the oldest microtask
  4. If this is a rendering opportunity ("update the rendering"):
       - run resize / scroll events
       - evaluate media queries, run animations
       - run requestAnimationFrame callbacks
       - recalc style, layout
       - run ResizeObserver / IntersectionObserver steps
       - paint (hand a frame to the compositor)
  5. If idle time remains before the next frame: requestIdleCallback
```

Several details matter:

- **There are multiple task queues.** Timers, DOM events, network callbacks and `postMessage` are all *tasks*, but the spec lets the browser keep them in separate queues and choose between them. Chromium, for instance, can prioritise input. You can rely on ordering *within* a single source (two `setTimeout(fn, 0)` calls run in order) but not *across* sources.
- **Only one task per iteration, but all microtasks.** After each task the microtask queue is drained completely, including microtasks enqueued by other microtasks.
- **Rendering is not every iteration.** "Update the rendering" happens only at rendering opportunities, typically aligned with the display refresh (about 16.7 ms at 60 Hz), and browsers may skip it for background tabs. This is why a `while` loop that changes `element.style` a thousand times only ever paints the final state.

### What counts as a task vs a microtask

| Kind | Examples |
| --- | --- |
| Task (macrotask) | `setTimeout`/`setInterval` callbacks, DOM event dispatch from user input, `MessageChannel`/`postMessage`, `XMLHttpRequest` load events, `scheduler.postTask` |
| Microtask | Promise reactions (`.then`, `await` continuations), `queueMicrotask`, `MutationObserver` callbacks |
| Rendering step | `requestAnimationFrame`, `ResizeObserver`, style/layout/paint |
| Idle | `requestIdleCallback` |

`await x` is sugar for "suspend, and resume in a Promise reaction job". So the code *after* an `await` always runs as a microtask, even when `x` is not a Promise.

## 3. A frame in practice: why the spinner never shows

```js
button.addEventListener('click', () => {
  spinner.hidden = false;      // DOM change
  const result = heavyCompute(); // 400 ms of synchronous work
  spinner.hidden = true;
  render(result);
});
```

The user never sees the spinner. The click handler is one task; rendering can only occur *after* the task (and its microtasks) finish, and by then `hidden` is `true` again. Moving the work into a Promise doesn't help either:

```js
spinner.hidden = false;
await Promise.resolve();        // still a microtask: runs before rendering
heavyCompute();
```

Microtasks run *before* the rendering step, so this is equivalent to doing it synchronously. To let a frame paint you must yield to a **task** boundary (or a `requestAnimationFrame` + task combination), which section 7 covers.

### requestAnimationFrame is not a timer

`requestAnimationFrame(cb)` schedules `cb` to run in the next "update the rendering" step, right before style and layout. That makes it the right place for visual writes (you get one write per frame, synchronised with paint), and the wrong place for "run this soon" logic — in a hidden tab rAF callbacks may not run at all.

A useful idiom for "run after the next paint" is:

```js
function afterNextPaint(fn) {
  requestAnimationFrame(() => {
    // We are now just before style/layout/paint of this frame.
    // A task posted here will run after that paint.
    setTimeout(fn, 0);
  });
}
```

## 4. Timers: "0 ms" is a minimum, not a promise

`setTimeout(fn, delay)` queues a task *no earlier than* `delay` milliseconds later. Three effects make it later:

1. **The loop must be free.** If the main thread is busy for 200 ms, a 0 ms timer waits 200 ms.
2. **Nested-timer clamping.** The HTML Standard's [timer initialization steps](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers) say that once the timer nesting level exceeds 5, a timeout below 4 ms is raised to 4 ms. A chain of `setTimeout(f, 0)` calls therefore slows to roughly 4 ms per hop after the first few in browsers.
3. **Background throttling.** Browsers throttle timers in hidden tabs, in Chromium [down to once per second, and more aggressively for long-hidden pages](https://developer.chrome.com/blog/timer-throttling-in-chrome-88).

Node.js does not implement the HTML 4 ms clamp. It instead coerces delays below 1 ms to 1 ms. Measuring a chain of ten nested `setTimeout(f, 0)` calls:

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

Every hop costs about 1 ms in Node.js — cheap, but still a real delay compared to a microtask or `setImmediate`. In a browser the same chain would show the 4 ms clamp from the sixth hop on.

## 5. Node.js: libuv phases

Node.js runs a different loop. libuv iterates through a fixed sequence of phases, documented in the [Node.js event loop guide](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick):

```text
   ┌───────────────────────────┐
┌─>│           timers          │  setTimeout / setInterval callbacks
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │     pending callbacks     │  some deferred system callbacks (e.g. TCP errors)
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │       idle, prepare       │  internal
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           poll            │  wait for I/O, run I/O callbacks
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
│  │           check           │  setImmediate callbacks
│  └─────────────┬─────────────┘
│  ┌─────────────┴─────────────┐
└──┤      close callbacks      │  'close' events
   └───────────────────────────┘
```

On top of the phases, Node.js has two queues that are drained **between every callback** (not only between phases, since Node.js 11):

1. The `process.nextTick` queue.
2. The Promise microtask queue (`then`, `await`, `queueMicrotask`).

The nextTick queue is drained first. Here is an ordering check:

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

Things to note:

- The body of an `async` function runs synchronously until its first `await`.
- `nextTick` beats all Promise microtasks even though it was scheduled after the first `.then`.
- The three Promise-queue entries run in FIFO order of enqueueing.
- `immediate` vs `timeout` **from the main module is not deterministic.** It depends on whether the 1 ms timer has already expired when the loop enters the timers phase. Don't rely on it.

Inside an I/O callback, however, the order *is* deterministic, because after the poll phase the loop always reaches the check phase before wrapping around to timers:

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

That is why the Node.js docs recommend `setImmediate` over `setTimeout(fn, 0)` for "run after the current I/O": it is both earlier and predictable.

### Browser vs Node.js at a glance

| Concern | Browser | Node.js |
| --- | --- | --- |
| Loop defined by | HTML Standard | libuv phases + Node.js internals |
| Highest priority deferral | microtasks | `process.nextTick`, then microtasks |
| "Run after I/O / next task" | `MessageChannel`, `scheduler.postTask` | `setImmediate` |
| Minimum timer delay | 4 ms after nesting level 5 | 1 ms |
| Rendering step | yes (rAF, style, layout, paint) | none |
| Threads for blocking work | Web Workers | libuv thread pool (fs, dns.lookup, crypto, zlib), `worker_threads` |

## 6. Microtask starvation

Because the microtask queue is drained until empty, a microtask that keeps enqueueing microtasks prevents *any* task from running — timers, I/O, and in a browser, rendering and input.

```js
let n = 0, t0 = Date.now();
setTimeout(() => console.log(`timer fired after ${Date.now() - t0}ms, microtasks run: ${n}`), 0);
function spin() { if (++n < 1e6) queueMicrotask(spin); }
spin();
```

```text
timer fired after 97ms, microtasks run: 1000000
```

The 0 ms timer waited for all one million microtasks. With an unbounded recursion it would never fire. The same applies to recursive `process.nextTick`, which the Node.js docs explicitly warn can "starve your I/O". Real-world versions of this bug include a stream consumer that resolves promises in a tight loop or a reactive library that flushes updates recursively.

The lesson: microtasks are for *finishing* a unit of work consistently (e.g. batching state updates before anyone observes them), not for *spreading* work out. For spreading work, you need tasks.

## 7. Yielding to the main thread

A long task is any task over 50 ms, per the [Long Tasks API](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongTaskTiming). While it runs, input events queue up and frames are dropped. The fix is to break the work into chunks and yield between them. The difference is easy to see even in Node.js, where a 1 ms `setInterval` stands in for "other work that wants to run":

```js
function work(ms) { const e = performance.now() + ms; while (performance.now() < e); }
// chunked: 40 chunks of 5 ms, yielding with setImmediate between chunks
// monolithic: one 200 ms busy loop
```

```text
chunked: 40x5ms work, interval ticks during=39, total=205ms
monolithic: 200ms work, interval ticks during=1, total=202ms
```

Same total time, but in the chunked version other callbacks got 39 chances to run instead of one. In a browser those chances are where clicks get handled and frames get painted.

### Options in the browser

**`setTimeout(fn, 0)`** — universally supported, but subject to the 4 ms clamp after nesting and to background throttling. The continuation goes to the *back* of the timer queue, behind anything else scheduled.

**`MessageChannel`** — posting a message to yourself creates a task without timer clamping:

```js
const channel = new MessageChannel();
const queue = [];
channel.port1.onmessage = () => queue.shift()();
function postTaskFallback(fn) { queue.push(fn); channel.port2.postMessage(null); }
```

This is exactly the trick React's scheduler uses in browsers: its `Scheduler` package schedules work with a `MessageChannel` and yields after a short time slice (the `frameYieldMs` setting, 5 ms by default in [the scheduler source](https://github.com/facebook/react/blob/main/packages/scheduler/src/forks/Scheduler.js)), checking `shouldYield()` between units of work. That is how concurrent rendering in React keeps input responsive while rendering large trees.

**`scheduler.postTask(fn, { priority })`** — part of the [Prioritized Task Scheduling API](https://wicg.github.io/scheduling-apis/). Priorities are `user-blocking`, `user-visible` (default) and `background`, and tasks can be cancelled with an `AbortSignal` via `TaskController`.

**`scheduler.yield()`** — returns a Promise that resolves in a new task, and the continuation is *prioritised ahead of* ordinary tasks of the same priority, so your work doesn't lose its place to unrelated third-party scripts. It shipped in [Chrome 129](https://developer.chrome.com/release-notes/129) (September 2024), and per [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) is also available in Firefox 142+, but not in Safari, so feature-detect it:

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

Yielding on a time budget rather than every N items keeps the overhead low: each yield costs at least one task hop (and with the `setTimeout` fallback, possibly 4 ms).

**`requestIdleCallback`** — for genuinely deferrable work (analytics, prefetching). It runs only when the loop has idle time before the next frame and passes a `deadline` with `timeRemaining()`. Don't put user-visible work here; on a busy page it may be delayed indefinitely unless you pass a `timeout`.

**Web Workers** — when the work doesn't need the DOM, moving it off the main thread beats any amount of yielding. The cost is serialisation via structured clone (or zero-copy with transferable `ArrayBuffer`s).

### Choosing among them

| Need | Best fit |
| --- | --- |
| Finish a state update consistently before anyone observes it | microtask (`queueMicrotask`, Promise) |
| Visual update synchronised with paint | `requestAnimationFrame` |
| Break up a long task, keep my place in line | `scheduler.yield()` with `setTimeout` fallback |
| Schedule independent work with a priority, cancellable | `scheduler.postTask` |
| Low-priority deferred work | `requestIdleCallback` with a `timeout` |
| CPU-heavy, DOM-free computation | Web Worker |
| Node.js: run after current I/O callbacks | `setImmediate` |

## 8. Connecting to INP

Since March 2024, [Interaction to Next Paint (INP)](https://web.dev/articles/inp) is a Core Web Vital, replacing First Input Delay. INP measures, for an interaction, the time from input to the next frame being presented, and splits it into three parts, each of which maps directly to the event loop:

1. **Input delay** — the input event task is waiting because another task is running. Fix: break up long tasks elsewhere on the page (third-party scripts, hydration).
2. **Processing time** — your event handlers run. Fix: do the minimum needed for visual feedback, then yield and do the rest.
3. **Presentation delay** — style, layout and paint after the handlers. Fix: smaller DOM updates, avoid forced synchronous layout, use `content-visibility` for offscreen content.

A good threshold is INP at or below 200 ms at the 75th percentile. The pattern that most often fixes poor INP is "update the UI first, then yield":

```js
button.addEventListener('click', async () => {
  showPressedState();     // cheap, visible
  await yieldToMain();    // let the browser paint the feedback
  await saveAndRecompute(); // the expensive part
});
```

The [Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames) (LoAF, shipped in Chrome 123) is the diagnostic companion: it reports frames whose work exceeded 50 ms, with script attribution, which is much more useful than the older Long Tasks entries for finding which script caused input delay.

## 9. Engineering checklist

- Know which queue your callback lands in: task, microtask, rendering step, or idle.
- Never assume `setTimeout(fn, 0)` runs "immediately"; in browsers it is clamped and throttled.
- Don't use recursive microtasks or `process.nextTick` to process unbounded work.
- In Node.js, prefer `setImmediate` for deferral, and remember that CPU-bound work in a callback blocks *every* request on that process — offload it to `worker_threads` or another service.
- In browsers, give feedback first and yield before heavy work; use `scheduler.yield()` where available.
- Use `requestAnimationFrame` for DOM writes that should line up with frames, and batch reads before writes to avoid layout thrashing.
- Measure with the Performance panel, LoAF, and field INP data rather than guessing.

## References

- [HTML Standard — Event loops](https://html.spec.whatwg.org/multipage/webappapis.html#event-loops)
- [HTML Standard — Timers](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers)
- [Node.js — The Node.js Event Loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [libuv — Design overview](https://docs.libuv.org/en/v1.x/design.html)
- [MDN — Scheduler.yield()](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield)
- [WICG — Prioritized Task Scheduling](https://wicg.github.io/scheduling-apis/)
- [web.dev — Interaction to Next Paint](https://web.dev/articles/inp)
- [Chrome for Developers — Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames)
- [React scheduler source](https://github.com/facebook/react/blob/main/packages/scheduler/src/forks/Scheduler.js)
- Jake Archibald, [Tasks, microtasks, queues and schedules](https://jakearchibald.com/2015/tasks-microtasks-queues-and-schedules/)
