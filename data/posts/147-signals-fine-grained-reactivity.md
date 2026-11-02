---
title: "Signals and Fine-Grained Reactivity: Dependency Tracking, Push-Pull Propagation and Glitch-Free Updates"
tag: javascript
description: How signals work under the hood in Solid, Preact, Vue, Angular and Svelte 5, why a push-pull model with lazy computeds avoids glitches in diamond dependency graphs, how automatic dependency tracking, coloring and version counters are implemented, a working mini signal library in about 120 lines, and how signals compare with React's re-render-and-diff model and the TC39 Signals proposal
date: "2026-11-02T10:15:00.000Z"
---

## Goal

Over the last few years almost every major frontend framework except React has converged on the same primitive: the **signal**. Solid was built on it from day one, Preact added `@preact/signals` in 2022, Angular introduced `signal()` in v16, Vue's `ref`/`computed` have always been signals in all but name, Svelte 5 rebuilt its compiler around runes (`$state`, `$derived`, `$effect`), and a TC39 proposal to standardize signals in JavaScript reached Stage 1 in 2024.

The API surface is tiny: a readable/writable value, a derived value, and a side effect. The interesting part is the algorithm underneath. This article covers:

1. What problem fine-grained reactivity solves, compared with re-render-and-diff.
2. Automatic dependency tracking.
3. Push, pull and push-pull propagation, and the diamond "glitch" problem.
4. A complete mini signal library with lazy computeds, equality cutoff, batching and cleanup.
5. How real implementations optimize it: coloring, version counters, linked lists.
6. Framework comparison: Solid, Preact, Vue, Angular, Svelte 5, React.
7. The TC39 Signals proposal.
8. Pitfalls in production code.

## 1. Two ways to keep UI in sync with state

Every UI framework answers one question: *when state changes, which parts of the screen must update?*

**Coarse-grained (React).** A state change re-runs the component function that owns the state and all its descendants (unless memoized). The result is a new virtual tree, which is diffed against the previous one, and the minimal DOM mutations are applied. The framework does not know *which* values a component used; it re-executes and compares. This is simple and robust, but the cost is proportional to the size of the subtree, not to the size of the change. Hence `memo`, `useMemo`, `useCallback`, and now the React Compiler, which inserts memoization automatically.

**Fine-grained (signals).** Each piece of state is an observable cell. When a computation reads a cell, the runtime records the dependency. When the cell is written, only the computations that actually read it re-run. In Solid, a component function runs *once* to build the DOM; afterwards, a signal write updates exactly the text node or attribute bound to it. There is no virtual DOM and no diff.

```jsx
// Solid: the component body runs once.
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

The compiler turns `{count()}` into a tiny effect that writes to one text node. Clicking the button updates two text nodes and nothing else.

The idea is old. Knockout.js (2010) had observables and computed observables with automatic dependency tracking, MobX popularized it in the React world, and Adam Haile's S.js introduced many of the synchronous, glitch-free semantics Solid later built on. What changed recently is mostly the quality of the algorithms and the compiler integration.

## 2. Automatic dependency tracking

The trick that makes signals ergonomic is that you never declare dependencies. The runtime discovers them by observing reads:

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

Before running a computed or effect, the runtime sets `currentObserver` to it; every signal read during that run registers an edge. Because the global is saved and restored, nested computations work like a stack.

Two consequences matter in practice:

- **Dependencies are dynamic.** In `() => cond() ? a() : b()`, only one of `a` or `b` is a dependency at any time. Implementations clear (or diff) the dependency set on every re-run so stale edges don't cause useless updates.
- **Only synchronous reads are tracked.** A read after an `await` or inside `setTimeout` happens when `currentObserver` is no longer set, so it is invisible. This is the most common source of "my effect doesn't re-run" bugs.

## 3. Push, pull, and the diamond problem

Once we have a dependency graph, a write must propagate through it. There are three strategies.

**Pure push.** When a signal changes, eagerly re-run every observer, which in turn notifies its observers. Simple, but it has two problems: it does work for values nobody currently reads, and it produces **glitches**.

Consider the classic diamond:

```
        a
       / \
      b   c        b = a * 2, c = a + 1
       \ /
        d          d = b + c   (an effect that renders)
```

Set `a` from 1 to 2 with naive depth-first push: `a` notifies `b`, `b` recomputes to 4 and notifies `d`, and `d` runs with `b = 4` and the *old* `c = 2`, producing 6, a value that never corresponds to any consistent state. Then `c` updates to 3 and `d` runs again with the correct 7. The intermediate 6 is a glitch. In a UI it is a flicker at best; if `d` sends a request or throws on inconsistent data, it is a real bug.

**Pure pull.** Mark nothing on write; every read re-validates its whole dependency chain. Always consistent, but you have no way to know *when* to re-run effects, so you end up polling or re-rendering everything.

**Push-pull (what modern libraries do).** Split propagation into two phases:

1. **Push invalidation.** On write, walk the graph downstream and only *mark* nodes as stale. No user code runs. Effects reached by the walk are put into a queue.
2. **Pull re-evaluation.** Run the queued effects. When an effect (or anyone) reads a stale computed, the computed first makes sure its own sources are up to date, recursively, and recomputes only if one of them actually changed.

Because no user code runs until all marks are in place, and every read pulls fresh values, `d` sees `b` and `c` from the same consistent state and runs exactly once. Computeds also become lazy: a derived value that nobody reads is never recomputed.

### Coloring: CLEAN, CHECK, DIRTY

A refinement popularized by Milo's (modderme123) Reactively library (and used in similar forms by Solid and others) uses three states instead of a single "stale" bit:

- `DIRTY`: a direct source definitely changed; must recompute.
- `CHECK`: something further upstream changed; a source *might* have a new value.
- `CLEAN`: up to date.

A signal write marks its direct observers `DIRTY` and everything further downstream `CHECK`. When a `CHECK` node is read, it asks its sources to update first; if none of them produced a new value, it goes back to `CLEAN` without running its function. This gives **equality cutoff**: if `isEven = computed(() => n() % 2 === 0)` stays `true` when `n` goes from 2 to 4, nothing downstream of `isEven` re-runs.

## 4. A mini signal library

Here is a complete, working implementation of the ideas above: signals, lazy computeds with coloring and equality cutoff, effects with cleanup, and batching. It is about 120 lines and deliberately simple (Sets instead of linked lists).

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

Let's trace the diamond:

```js
const a = signal(1);
const b = computed(() => a.get() * 2);
const c = computed(() => a.get() + 1);
effect(() => console.log('d =', b.get() + c.get()));   // d = 4

a.set(2);                                                // d = 7 (once, no glitch)
```

1. `a.set(2)` marks `b` and `c` `DIRTY`. `b` was clean, so it marks the effect `CHECK`, which queues it. `c` tries to mark the effect `CHECK`, but it already is, so nothing happens.
2. `flush()` runs the effect. It is `CHECK`, so it pulls `b`: `b` recomputes to 4, the value changed, so the effect becomes `DIRTY` and the loop stops.
3. The effect re-runs. Reading `b` is free (clean). Reading `c` triggers its update to 3. Output: `d = 7`, once.

Equality cutoff in action:

```js
const n = signal(2);
const isEven = computed(() => n.get() % 2 === 0);
let runs = 0;
effect(() => { isEven.get(); runs++; });   // runs = 1

n.set(4);   // isEven recomputes to true again -> effect returns to CLEAN
console.log(runs);                          // 1
```

And batching, so that two writes produce one effect run:

```js
const first = signal('Ada'), last = signal('Lovelace');
const full = computed(() => `${first.get()} ${last.get()}`);
effect(() => console.log(full.get()));    // Ada Lovelace

batch(() => { first.set('Grace'); last.set('Hopper'); });  // Grace Hopper (once)
```

Without `batch`, the effect would run twice, once with the inconsistent "Grace Lovelace". That is not a graph glitch (each run sees a consistent snapshot of the signals) but it is still wasted work and an observable intermediate state, which is why frameworks batch inside event handlers automatically.

What this toy version leaves out:

- **Unobserved computeds leak.** A computed that is no longer read by anyone still sits in its sources' observer sets. Real libraries unsubscribe a computed from its sources when its last observer goes away, and resubscribe lazily.
- **Ownership.** Solid and Vue create effects inside an owner (component or effect scope) so that disposing a component disposes everything it created. Here you must call `dispose()` yourself.
- **Cycle and infinite-loop detection.** An effect that writes a signal it reads would loop forever. Libraries detect this and throw.
- **Error handling.** A computed that throws should cache the error and rethrow on read.

## 5. How real implementations make it fast

The algorithm is simple; the engineering is in memory layout and avoiding work.

**Version counters (Preact Signals, Vue 3.5).** Instead of (or in addition to) coloring, every signal carries a version number that increments on write. A computed records the version of each source it read. To validate, it compares versions: if all match, it is still valid without running anything. Preact also keeps a **global version**: if no signal anywhere has changed since a computed last validated, it can return its cached value in O(1) without even walking its sources. The Preact team described this design in their 2022 "Signal Boosting" post.

**Doubly linked lists instead of Sets.** Allocating a `Set` per node and an entry per edge is expensive. Preact and Vue 3.5 represent each dependency edge as a node that sits in two linked lists at once: the source's list of subscribers and the subscriber's list of dependencies. Re-tracking on each run can then *reuse* edges in order: if a computed reads the same sources in the same order as last time (by far the common case), no allocation happens at all. Vue's 3.5 release notes credit this refactor with a 56% reduction in memory usage for the reactivity system.

**Alien Signals.** Johnson Chu's `alien-signals` library pushed this design further, focusing on avoiding recursion and allocations in the propagation loop, and its algorithm has been adopted into Vue's reactivity core in the 3.6 development line.

**Compiler-assisted binding.** Solid, Svelte 5 and Vue Vapor Mode compile templates into direct DOM operations wrapped in fine-grained effects, so a signal change maps to one `textContent` or `setAttribute` call. The runtime work per update becomes proportional to the number of bindings that actually changed.

**Deep reactivity via proxies.** Vue's `reactive()` and Svelte 5's `$state` on objects wrap plain objects in `Proxy`, creating one signal per property lazily on first access. Solid offers the same through stores. This lets you mutate `state.todos[3].done = true` and update only what depends on that one field.

## 6. Framework comparison

| | Primitive | Derived | Effect | Component re-runs? | Notes |
|---|---|---|---|---|---|
| Solid | `createSignal` (getter/setter pair) | `createMemo` | `createEffect` | No, runs once | Compiler wires signals to DOM nodes |
| Preact | `signal()` with `.value` | `computed()` | `effect()` | Optional | Signals can be passed directly into JSX to skip component re-render |
| Vue | `ref`, `reactive` | `computed` | `watch`, `watchEffect` | Yes (VDOM), no in Vapor Mode | Template reads tracked per component render effect |
| Angular | `signal()`, called as `count()` | `computed()` | `effect()` | Change detection targeted by signals | Enables zoneless change detection without Zone.js |
| Svelte 5 | `$state` rune | `$derived` | `$effect` | No | Compiler rewrites runes into signal reads/writes |
| React | `useState` | `useMemo` / compiler | `useEffect` | Yes | Not signals; re-render + reconciliation, auto-memo via React Compiler |

**Why React has not adopted signals.** The React team's position is that the re-render model keeps rendering a pure function of state, which composes well with concurrent rendering, transitions and Suspense: React can render a new version of the tree in the background and throw it away. Mutable signals that update the DOM synchronously make that harder (see the "tearing" problem `useSyncExternalStore` was built to solve). The React Compiler attacks the performance side instead, by memoizing automatically so that re-renders skip unchanged subtrees. The trade-off is roughly this:

- **Signals:** update cost proportional to what changed; no memoization ceremony; but reactivity is a runtime concept you must respect (read inside tracking scopes, don't destructure away the reactivity, beware async).
- **Re-render + diff:** simpler mental model ("UI = f(state)"), easier to interrupt and replay; but cost proportional to subtree size, mitigated with memoization.

In practice both are fast enough for most apps. Signals shine in UIs with large, long-lived trees and frequent small updates: spreadsheets, editors, dashboards, real-time data.

## 7. The TC39 Signals proposal

In 2024 a group including authors of Angular, Vue, Solid, Preact, Svelte, Ember and MobX proposed adding signals to JavaScript itself. The proposal reached **Stage 1** in April 2024. It deliberately standardizes only the core graph, not effects or scheduling:

```js
const counter = new Signal.State(0);
const isEven = new Signal.Computed(() => (counter.get() & 1) === 0);
const parity = new Signal.Computed(() => (isEven.get() ? 'even' : 'odd'));

// Effects are built by frameworks on top of a low-level Watcher.
const w = new Signal.subtle.Watcher(() => {
  // Called synchronously when a watched signal becomes possibly-dirty.
  // You may not read or write signals here; schedule work instead.
  queueMicrotask(processPending);
});
w.watch(parity);
```

The design follows the push-pull model above: `Computed` is lazy and memoized, notifications are push-only (`Watcher` is told "something may have changed"), and actual values are pulled. Scheduling is left to the framework because every framework batches differently. The goals are interoperability (a signal created by one library can be tracked by another's effects) and the opportunity for engines and DevTools to optimize and visualize the graph. A [polyfill](https://github.com/proposal-signals/signal-polyfill) exists for experimentation; the API may still change.

## 8. Production pitfalls

**Losing reactivity by destructuring.** In Solid, `const { name } = props` reads `props.name` once outside any tracking scope. In Vue, destructuring a `reactive()` object gives you plain values. Use getters, `toRefs`, or `splitProps`.

**Async boundaries.** Reads after `await` are not tracked:

```js
effect(async () => {
  const id = userId.get();          // tracked
  const user = await fetchUser(id);
  if (showDetails.get()) { /* NOT tracked: read after await */ }
});
```

Read everything you depend on before the first `await`, or use the framework's resource/async primitives.

**Writing signals inside computeds.** A computed should be pure. Writing state from a derived value breaks the graph's ordering guarantees; most libraries throw or warn.

**Effects as derived state.** Using an effect to copy one signal into another (`effect(() => b.set(a.get() * 2))`) introduces an extra update pass and a moment where `b` is stale. Use `computed`. Effects are for synchronizing with the outside world: DOM APIs, network, storage, logging.

**Forgetting cleanup.** Effects that add listeners, timers or subscriptions must return or register a cleanup, or every re-run leaks another one.

**Object identity and equality.** `Object.is` equality means mutating an array in place and setting the same reference does not notify. Either replace immutably or use the library's deep/proxy stores.

**Huge fan-out.** A single signal read by 10,000 rows will notify 10,000 observers. For selection state, use a keyed selector pattern (Solid's `createSelector`) so a change only notifies the two rows whose "selected" status actually changed.

## Takeaways

- Signals are observable cells with automatic dependency tracking; updates cost proportional to what changed, not to component tree size.
- Pure push causes glitches in diamond graphs. Push invalidation plus lazy pull re-evaluation gives glitch-free, minimal updates.
- Three-state coloring or version counters give equality cutoff, so unchanged derived values stop propagation.
- Modern libraries win on memory layout: linked-list edges reused across runs, global versions, compiler-generated DOM bindings.
- Only synchronous reads inside a tracking scope are dependencies; most bugs come from async gaps, destructuring and effects used as derivations.
- React chose re-render plus automatic memoization instead; the TC39 proposal aims to give everyone else a shared, interoperable core.

## References

- [TC39 Signals proposal](https://github.com/tc39/proposal-signals) and the [signal-polyfill](https://github.com/proposal-signals/signal-polyfill)
- Rob Eisenberg, [*A TC39 Proposal for Signals*](https://eisenbergeffect.medium.com/a-tc39-proposal-for-signals-f0bedd37a335), 2024
- Ryan Carniato, [*A Hands-on Introduction to Fine-Grained Reactivity*](https://dev.to/ryansolid/a-hands-on-introduction-to-fine-grained-reactivity-3ndf)
- Milo (modderme123), [*Super Charging Fine-Grained Reactive Performance*](https://dev.to/modderme123/super-charging-fine-grained-reactive-performance-47ph) (the Reactively coloring algorithm)
- Preact team, [*Introducing Signals*](https://preactjs.com/blog/introducing-signals/) and [*Signal Boosting*](https://preactjs.com/blog/signal-boosting/)
- [Announcing Vue 3.5](https://blog.vuejs.org/posts/vue-3-5) (reactivity refactor) and [Vue: Reactivity in Depth](https://vuejs.org/guide/extras/reactivity-in-depth.html)
- [stackblitz/alien-signals on GitHub](https://github.com/stackblitz/alien-signals)
- [Angular Signals guide](https://angular.dev/guide/signals)
- [Svelte 5 runes documentation](https://svelte.dev/docs/svelte/what-are-runes)
- [SolidJS: Fine-grained reactivity](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity)
- [React Compiler documentation](https://react.dev/learn/react-compiler)
- [adamhaile/S on GitHub](https://github.com/adamhaile/S)
