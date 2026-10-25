---
title: "Inside React Fiber: Reconciliation, Lanes, the Scheduler, and Concurrent Rendering"
tag: react
description: How React actually turns a setState call into DOM changes — the Fiber data structure and double-buffered trees, the interruptible render phase and the three-step commit phase, lanes as a bitmask priority model, the Scheduler's 5 ms time slices, and how transitions, useDeferredValue, Suspense and useSyncExternalStore are built on top. Ends with the practical consequences and a comparison with signal-based frameworks
date: "2026-10-25T14:20:00.000Z"
---

## Goal

Most React performance advice ("wrap it in `memo`", "use a key", "move state down") is easier to apply when you know the machine underneath. Since React 16, that machine is **Fiber**: a reimplementation of the reconciler that splits rendering into small units of work which can be paused, resumed, reprioritized or thrown away. React 18 turned that capability on for everyone using `createRoot`, and React 19 built Actions, `useOptimistic` and async transitions on top of it.

This article walks the path of a single update through React's internals: what a fiber is, how the render and commit phases work, how lanes encode priority, how the Scheduler yields to the browser, and how concurrent features fall out of that design. Names below come from the React source (`packages/react-reconciler`, `packages/scheduler`); they are implementation details that change between versions, but the architecture has been stable since React 18.

## Why Fiber Exists

The pre-16 reconciler (now called the "stack reconciler") rendered recursively: calling `render()` on a component meant recursing into its children on the JavaScript call stack until the whole tree was processed. A large update could therefore occupy the main thread for hundreds of milliseconds, and because the work lived on the call stack, there was no way to stop halfway, handle a keystroke, and come back.

Fiber's core idea is to **replace the call stack with a linked data structure on the heap**. If every "stack frame" is an object React owns, React can process one, check the clock, and decide whether to continue or give the main thread back to the browser. Everything else — priorities, interruption, Suspense, transitions — is built on that one change.

## The Fiber Node

A fiber is a plain JavaScript object corresponding to one component instance, host element or other node in the tree. Simplified, the important fields are:

```js
{
  tag,            // FunctionComponent, HostComponent ('div'), SuspenseComponent, ...
  type, key,      // what to render and its identity among siblings
  stateNode,      // the DOM node for host components

  return,         // parent fiber
  child,          // first child
  sibling,        // next sibling

  pendingProps,   // props for this render
  memoizedProps,  // props from the last completed render
  memoizedState,  // for function components: a linked list of hooks
  updateQueue,    // pending state updates / effect list

  flags,          // side effects for this fiber: Placement, Update, Deletion, ...
  subtreeFlags,   // OR of flags in the subtree, so commit can skip clean subtrees
  lanes,          // pending work on this fiber
  childLanes,     // pending work somewhere below

  alternate,      // the corresponding fiber in the other tree
}
```

Three design choices matter:

- **Child/sibling/return pointers** turn the tree into something that can be traversed iteratively with a single "current fiber" variable. Pausing is just remembering that pointer.
- **Hooks live on the fiber.** `memoizedState` of a function component is a linked list with one node per hook call, in call order. That is the whole reason for the Rules of Hooks: React matches state to hooks by position, so a conditional hook shifts every later one.
- **`lanes` and `childLanes`** let React know, without visiting a subtree, whether anything below has work. This is what makes bailouts cheap.

### Double buffering

React keeps up to two fibers per node: the **current** tree (what is on screen) and the **work-in-progress** tree (what is being built), linked through `alternate`. A render clones fibers from current into work-in-progress, mutates only the work-in-progress copies, and at commit simply swaps the root's pointer. Because the current tree is never touched during render, an interrupted or abandoned render leaves the UI perfectly consistent — the same idea as double buffering in graphics.

## Phase 1: Render (Interruptible)

A render starts at the root and walks the tree depth-first with two functions:

- **`beginWork(fiber)`** — going down. Call the component (or compare props for a host element), reconcile the returned elements against the existing children, and return the first child to process next.
- **`completeWork(fiber)`** — coming back up. For host components, create or prepare DOM nodes and compute the props diff; bubble `flags` into the parent's `subtreeFlags`.

The loop that drives it is tiny. The concurrent version differs from the synchronous one by a single check:

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

If `shouldYield()` returns true, React returns from the loop with `workInProgress` still pointing at the next fiber, and schedules a continuation. Nothing has been written to the DOM yet, so the browser can paint and handle input in between.

That property has a cost you must respect: **render may run more than once, or be discarded**. A higher-priority update can interrupt and restart a render; a transition can be abandoned entirely. This is why render functions must be pure, and why `StrictMode` deliberately invokes components, initializers and reducers twice in development — to surface code that relies on render running exactly once.

### Reconciliation heuristics

Computing a minimal edit script between two arbitrary trees is O(n³). React instead uses an O(n) heuristic documented since its early days:

1. **Different element type means a different subtree.** Changing `<div>` to `<section>`, or `<UserCard>` to `<AdminCard>`, unmounts the old subtree (losing its state) and mounts a new one.
2. **Keys identify children across renders.** Within a list, React matches children by `key` first; without keys it matches by index, which breaks state when items are inserted or reordered.

Both rules have practical uses beyond correctness. Changing a key is the cleanest way to reset a component's state (`<Profile key={userId} />`), and defining a component inside another component's body creates a new type on every render, which remounts it every time.

### Bailouts

When `beginWork` reaches a fiber whose props are referentially the same, whose context has not changed, and which has no pending work in its own `lanes`, React can skip calling the component. If `childLanes` is also empty, it skips the entire subtree; otherwise it clones the children and continues down to where the work is. `React.memo` widens the first condition from "same props object" to "shallowly equal props". The React Compiler (stable since its 1.0 release in 2025) automates this by memoizing JSX and values at build time, so that unchanged elements are referentially stable and bailouts happen without hand-written `useMemo`/`useCallback`.

## Phase 2: Commit (Synchronous)

Once the whole work-in-progress tree is complete, React commits it. Commit is **never interrupted**, because a half-applied DOM mutation would be visible. It runs in sub-phases, using `subtreeFlags` to skip subtrees with nothing to do:

1. **Before mutation** — read DOM state that is about to change (e.g. `getSnapshotBeforeUpdate`).
2. **Mutation** — insert, update and remove DOM nodes; detach refs; run cleanups of layout effects for removed or updated components.
3. **Swap** — `root.current = finishedWork`. The work-in-progress tree is now current.
4. **Layout** — attach refs, run `useLayoutEffect` and class lifecycle methods (`componentDidMount/Update`). These run synchronously before the browser paints, so they can measure layout and adjust without flicker — and they block paint, so keep them small.

**Passive effects** (`useEffect`) are scheduled to run after commit, normally after the browser has had a chance to paint. One exception: if the update came from a discrete user input such as a click, React flushes the passive effects synchronously at the end of the commit, so that the effects of one click are observed before the next event is handled.

## Lanes: Priority as a Bitmask

Every update is assigned a **lane**, a bit in a 31-bit integer. Lower bits are more urgent. The main groups are:

| Lane | Typical source |
| --- | --- |
| `SyncLane` | Discrete events (click, keydown), `flushSync` |
| `InputContinuousLane` | Continuous events (mousemove, scroll, pointer drag) |
| `DefaultLane` | Updates outside React events: `setTimeout`, network callbacks |
| `TransitionLanes` (several) | `startTransition`, `useTransition`, `useDeferredValue` |
| `RetryLanes` | Retrying a suspended Suspense boundary |
| `IdleLane`, `OffscreenLane` | Idle work, hidden trees |

Using bits instead of a single number buys set operations for free. Each fiber's `lanes` is the union of its pending updates, `childLanes` is the union of its subtree, and the root tracks `pendingLanes`, `suspendedLanes` and `pingedLanes`. When React picks what to render next, it selects the highest-priority set of lanes (`getNextLanes`) and renders all updates in those lanes together — this is what **automatic batching** is: several `setState` calls in the same lane become one render, regardless of whether they came from an event handler, a promise or a timeout.

Inside a hook's update queue, updates with lanes not included in the current render are **skipped but kept**. React processes the rest, then replays the skipped updates later in order, so the final state is the same as if everything had been applied sequentially. That is how an urgent keystroke can be shown immediately while an older transition update is still pending, without losing either.

The model also protects against starvation: if a lane waits too long, React marks it expired and renders it synchronously.

## The Scheduler: Cooperating with the Browser

The `scheduler` package is a small, standalone cooperative task scheduler. It keeps tasks in a **min-heap ordered by expiration time**, where each of its five priorities (Immediate, UserBlocking, Normal, Low, Idle) maps to a timeout. A task is just a callback; if the callback returns a function, that function is the continuation of the same task.

Two details explain its behavior:

- **Time slicing.** `shouldYield()` returns true once the current slice has run for about **5 ms** (`frameYieldMs` in the source). Short slices keep the main thread responsive to input without needing to know the display's frame rate.
- **Yielding with `MessageChannel`.** To continue after yielding, the Scheduler posts a message to itself. Unlike `setTimeout(fn, 0)`, which browsers clamp to at least 4 ms once timers are nested, a message event runs as a new macrotask almost immediately while still letting the browser render and handle input in between. `requestIdleCallback` was considered and rejected because it fires too rarely and unpredictably.

React maps lanes to Scheduler priorities when it schedules a root. Sync work does not go through the Scheduler's time slicing at all: it is flushed in a microtask, so discrete events get a guaranteed synchronous render.

## How Concurrent Features Are Built

With interruptible rendering, double buffering and lanes in place, the user-facing features are surprisingly thin layers.

### Transitions

```jsx
function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(initial);
  const [isPending, startTransition] = useTransition();

  function onChange(e) {
    setQuery(e.target.value);                   // SyncLane: input stays responsive
    startTransition(() => {
      setResults(filterLargeList(e.target.value)); // TransitionLane: interruptible
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

`startTransition` only changes which lane the updates get. Because transition lanes are rendered with `workLoopConcurrent`, a new keystroke (a sync lane) interrupts the in-progress list render; React throws away the work-in-progress tree, handles the keystroke, then restarts the transition with the newest value. `isPending` is itself a state update in a higher lane, rendered first. In React 19 the callback may be async, which is the basis of **Actions**: `useActionState`, `<form action>` and `useOptimistic` all track pending async work through transitions.

### `useDeferredValue`

`useDeferredValue(value)` returns the old value during the urgent render and schedules a second render in a transition lane with the new value. It is a transition you can apply to a value you receive as a prop, when you do not control the `setState` call. Pair it with `memo` on the expensive child, otherwise the urgent render re-renders the child anyway.

### Suspense

When a component reads data that is not ready (via `use(promise)` or a Suspense-enabled library), it **throws** — in React 19, `use` throws a special exception wrapping the promise. The render phase catches it at the nearest `<Suspense>` boundary, renders the fallback for that boundary instead, and attaches a listener to the promise. When the promise resolves, the root is "pinged" and React retries the boundary in a retry lane. Because render has no side effects until commit, abandoning the suspended subtree is safe.

Transitions change the policy: if a transition would replace already-visible content with a fallback, React instead keeps showing the old UI (the current tree) and leaves the transition pending. That is why navigations wrapped in `startTransition` do not flash spinners.

### Tearing and `useSyncExternalStore`

Interruptible rendering creates a new failure mode. If a component reads from a mutable external store (a Redux store, a module-level variable, `window.location`) and the store changes while React has yielded mid-render, components rendered before and after the yield can show different values in the same commit — **tearing**. `useSyncExternalStore(subscribe, getSnapshot)` fixes this by checking the snapshot again before commit and, if it changed, re-rendering synchronously. State libraries such as Redux (via `react-redux`) and Zustand use it internally; if you write your own store, so should you.

## Practical Consequences

- **Keep render pure and cheap.** It may run many times and be discarded. Side effects belong in event handlers or effects.
- **Use transitions for expensive, non-urgent updates** (filtering, tab switches, navigation), and leave text input state urgent. Transitions help when the cost is rendering; they cannot split a single 200 ms synchronous function call — that still needs to be made cheaper, chunked or moved to a worker.
- **Lean on bailouts deliberately.** Stable props (or the React Compiler), state colocated close to where it is used, and context split by update frequency all let `childLanes` prune more of the tree.
- **Use keys for identity, not indices**, and use key changes to reset state on purpose.
- **Prefer `useEffect` over `useLayoutEffect`** unless you must measure or mutate layout before paint; layout effects block the frame.
- **Measure with the React DevTools Profiler and the Performance panel.** React 19.2 added React-specific tracks (Scheduler and Components) to Chrome DevTools' Performance panel, which show lanes and render/commit timing directly next to the browser's own long tasks and INP data.

## Fiber vs. Fine-Grained Reactivity

React's model is "re-run components, diff the output": simple to reason about, with work proportional to the subtree that re-renders, made affordable by bailouts and scheduling. Signal-based frameworks take the opposite approach:

| | React (Fiber) | Vue 3 | Solid / Svelte 5 runes / Preact Signals |
| --- | --- | --- | --- |
| Change detection | Re-render component subtree, diff virtual DOM | Reactive dependency tracking per component, then virtual DOM diff (compiler-optimized) | Dependency graph of signals; update exactly the bound DOM nodes |
| Unit of re-execution | Component function | Component render function | Individual effect / binding |
| Scheduling | Lanes, interruptible render, time slicing | Batched async queue (microtask), not interruptible | Mostly synchronous propagation, batched |
| Strength | Consistent snapshots, priorities, Suspense/transitions as first-class | Precise updates with familiar templates | Minimal work per change, very small runtime |
| Cost | Wasted renders without memoization | Reactivity caveats (destructuring, proxies) | No built-in prioritization; concurrency features are harder to retrofit |

Neither approach is universally faster. Fine-grained systems avoid most of the work React has to schedule; React's design pays that cost in exchange for treating every render as an immutable snapshot that can be prioritized, paused and discarded — which is exactly what transitions and Suspense need.

## Summary

Fiber turns rendering into a loop over heap-allocated work units, so React can stop between any two components. Double-buffered trees keep the screen consistent while work is in flight; the render phase is pure and restartable, the commit phase is short and atomic. Lanes give every update a priority as a bit in a mask, making batching, skipping and rebasing updates cheap set operations, and the Scheduler slices concurrent work into roughly 5 ms chunks between browser tasks. Transitions, `useDeferredValue`, Suspense and Actions are all thin policies on top of those mechanisms — and nearly every rule React asks you to follow, from pure renders to stable keys to `useSyncExternalStore`, exists to keep that machinery correct.

## References

- React documentation: [Render and Commit](https://react.dev/learn/render-and-commit), [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state), [useTransition](https://react.dev/reference/react/useTransition), [useDeferredValue](https://react.dev/reference/react/useDeferredValue), [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore), [Suspense](https://react.dev/reference/react/Suspense)
- React blog: [React v18.0](https://react.dev/blog/2022/03/29/react-v18), [React v19](https://react.dev/blog/2024/12/05/react-19), [React 19.2](https://react.dev/blog/2025/10/01/react-19-2), [React Compiler v1.0](https://react.dev/blog/2025/10/07/react-compiler-1)
- React source: [react-reconciler](https://github.com/facebook/react/tree/main/packages/react-reconciler) (`ReactFiberWorkLoop`, `ReactFiberLane`, `ReactFiberBeginWork`, `ReactFiberCommitWork`) and [scheduler](https://github.com/facebook/react/tree/main/packages/scheduler)
- Andrew Clark, [React Fiber Architecture](https://github.com/acdlite/react-fiber-architecture) (2016)
- React Working Group, [What happened to concurrent "mode"?](https://github.com/reactwg/react-18/discussions/64) and [What is tearing?](https://github.com/reactwg/react-18/discussions/69)
- Legacy React docs, [Reconciliation](https://legacy.reactjs.org/docs/reconciliation.html)
