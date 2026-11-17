---
title: "React Compiler in Depth: Automatic Memoization, HIR Analysis and What It Still Will Not Do"
tag: javascript
description: How React Compiler turns the Rules of React into build-time memoization — why identity breaks useMemo and useCallback, the CFG-based HIR and mutability analysis, cache slots and conditional memoization after an early return, incremental adoption with "use memo" and "use no memo", how this differs from signals and from React.memo, and a runnable model that counts re-renders under naive, manual, and compiler-style strategies
date: "2026-11-17T14:50:00.000Z"
---

## Goal

React's contract is simple: a component is a function of props, state and context, and when any of those change, React calls the function again and diffs the result. That model is easy to reason about and, for a surprisingly long time, fast enough. It is also the reason a heartbeat in a parent can make a list of two hundred cards do real work, even though none of their props changed. For years the escape hatch was manual memoization — `React.memo`, `useMemo`, `useCallback` — and for years the same identity bugs kept undoing it.

**React Compiler** (the project that was internally called Forget) is a build-time optimizing compiler that writes that memoization for you. It is not a new runtime and it is not a new reactivity model. It reads your existing components and hooks, decides which intermediate values and JSX elements can be reused, and emits cache checks that skip the work when their inputs are the same. React Compiler 1.0 shipped as a stable release on 7 October 2025; it is used in production on major apps at Meta, and Expo SDK 54 enables it by default for new projects.

This article covers:

1. Why re-renders are expensive, and why the expensive part is often *identity*, not computation.
2. The bugs that show up once you start writing `useMemo` and `useCallback` by hand.
3. What the compiler actually is: a Babel-fronted pipeline that lowers the AST into a CFG-based HIR and analyses data flow and mutability.
4. Cache slots, and the conditional memoization that hooks cannot express.
5. Adoption: compilation modes, `"use memo"` / `"use no memo"`, lint, and what to do with existing memoization.
6. How this compares with signals and with "just wrap it in `memo`".
7. What the compiler will not do for you.
8. A runnable model that counts component work under four strategies.

## 1. The re-render tax, and why memoization is about identity

When a component's state changes, React re-invokes that component *and, by default, every component it returns*. The child does not have to have changed. It only has to have been *rendered by a parent that changed*. Two consequences follow.

First, any work the child does during render — filtering a list, merging a theme, allocating a new object to pass down — runs again. Second, even a cheap child becomes expensive once it is a list, because each row allocates new props objects and new closures, and those new identities make the next layer of memoization miss.

That is the part people underestimate. `React.memo(FriendCard)` does a shallow compare of props. If one prop is `onSelect={() => select(friend.id)}`, the comparison is a comparison of function identities, and the identity is new on every parent render. The memo is correct, and it never hits. The official React Compiler documentation uses almost this example: wrapping `handleClick` in `useCallback` is not enough if the JSX still does `onClick={() => handleClick(item)}`.

So memoization in React is not primarily "is this calculation heavy?". It is "is this *value* the same value as last time, by reference?". The compiler's job is to make that true for the values that matter, including the JSX elements themselves.

## 2. Manual memoization and the holes in it

A carefully memoized list usually needs all of the following at once:

- `useMemo` for the filtered / sorted derived array, otherwise a new array identity invalidates every child.
- `useCallback` for handlers that go into memoized children, with a dependency list that is itself stable.
- `React.memo` on the children, and on any chrome (a badge, a button, a sidebar) that should not care about the parent's other state.
- No accidental new object or array literals in the props that cross a memo boundary.
- No "I'll just add a wrapper arrow in the map", which quietly allocates a new function per row per render.

Hooks add a structural constraint that is easy to forget when you are reaching for memoization. **Hooks must be called unconditionally, in the same order, at the top of the function.** `useMemo` is a hook. It cannot sit after `if (!items.length) return <Empty />`. If a non-trivial computation naturally lives on only one side of a branch, you either lift it above the branch (and pay for it on the path that does not need it) or you leave it unmemoized.

That last hole is not a style issue. It is a rule the runtime relies on. A compiler that emits ordinary `if` checks against cache slots is not bound by it, and can memoize a value on only one side of an early return. The 1.0 announcement uses this as a headline capability: React Compiler can memoize code *after* a conditional return, which `useMemo` / `useCallback` cannot.

There is a second, quieter hole. `useMemo` and `useCallback` take a dependency array you wrote. Miss a dependency and you replay a stale value. List a dependency that changes identity every render and you never reuse the value. Optional chaining and array indices as dependencies were already awkward to write by hand; the 1.0 release added first-class support for both in the compiler's own dependency inference.

## 3. What the compiler actually is

The public package is `babel-plugin-react-compiler`, and it must run **first** in the Babel plugin list so that it sees the original source, not some other transform's output. The plugin is a thin wrapper. The compiler itself is decoupled from Babel: it takes an AST, lowers it into its own **high-level intermediate representation** (HIR) arranged as a **control-flow graph** (CFG), and runs a series of analysis and codegen passes over that HIR.

That architecture is the result of a long path. The React team's first compiler exploration was Prepack, in 2017; Prepack was eventually shut down, but the work informed the design of Hooks, which were shaped with a future compiler in mind. In 2021 Xuan Huang showed a first prototype of a new React Compiler. That prototype was rewritten. Joe Savona, Sathya Gunasekaran, Mofei Zhang and Lauren Tan moved the architecture onto the CFG-based HIR, which made precise data-flow analysis and limited type inference tractable. Several further rewrites followed, each informed by the last. The 1.0 announcement is explicit about this history, and about the fact that 1.0 is a starting point, not a frozen code generator.

What the passes have to answer is, roughly:

1. Which functions are components or hooks (naming conventions, JSX, hook calls, plus the `"use memo"` directive)?
2. Which values flow into which other values? This is ordinary data-flow, including through branches, loops, optional chains and array indices.
3. Which operations *mutate*, and what they alias. If the compiler cannot prove that a value is not mutated, it cannot reuse it, because reuse would observably change later reads.
4. Where are the **reactive scopes** — groups of instructions that should share one cache slot — and what are their inputs?
5. Does this function obey the [Rules of React](https://react.dev/reference/rules)? If the answer is no, the safe choice is to leave it alone and, preferably, to say why.

The Rules of React are the semantic foundation, not a style guide. Components and hooks must be **idempotent**: the same inputs must produce the same output. Side effects belong outside render. Props, state, hook arguments and values already passed to JSX are **immutable snapshots**. You do not call component functions directly, and you do not call hooks from ordinary functions, from conditions, or after an early return. The compiler encodes those rules in validation passes; the diagnostics ship in `eslint-plugin-react-hooks` (the `recommended` preset, and the current preset that includes the compiler rules). A function that mutates its props, reads a ref during render, or otherwise cannot be proven safe is skipped, not "optimized anyway".

The output is still React. There is no new component model and no change to Fiber or to reconciliation. The compiler emits, for each memoized value, a small cache check: if the inputs are `===`-equal to last time, reuse the previous value; otherwise compute, then store the inputs and the result. In the [React Compiler Playground](https://playground.react.dev) that looks like an array of slots plus a comparison per scope:

```js
function FriendList(t0) {
  const $ = _c(8);
  const friends = t0.friends;
  const query = t0.query;
  let t1;
  if ($[0] !== friends || $[1] !== query) {
    t1 = filterFriends(friends, query);
    $[0] = friends;
    $[1] = query;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  // further slots for handlers, JSX elements, and other scopes
  return /* JSX that reuses t1 */;
}
```

The exact helper name and runtime import have moved as the compiler has matured (`react-compiler-runtime` is the compatibility package if your `target` is React 17 or 18; React 19 does not need extra configuration). The shape is the part that matters: **ordinary comparisons against per-component cache slots**, not a new subscription system.

Because the slots are just `if` checks, they can be placed after an early return, inside a branch, or around a single element of a map. That is the "conditional memoization" the 1.0 post highlights, and it is also why the compiler can fix the `onClick={() => handleClick(item)}` case: it can give *each element of the map* its own slot, keyed by `handleClick` and `item`.

Two limits are documented and worth taking at face value. The compiler only memoizes **components and hooks**, not every helper in the file. And its memoization is **not shared across components**: if five lists call the same expensive pure function with the same arguments, you still pay five times, unless that function has its own cache outside React. The docs recommend measuring before you add that cache.

## 4. Adoption, directives and existing memoization

For React 19, installation is a dev-dependency and a first-position Babel plugin:

```js
// babel.config.js
module.exports = {
  plugins: [
    'babel-plugin-react-compiler', // must run first
    // ...other plugins
  ],
};
```

React 17 and 18 work, with `target: '17'` or `'18'` and the `react-compiler-runtime` package. Vite, Metro and Rsbuild are supported. Next.js 15.3.1 and later can invoke the compiler through swc, which is the path you want if you do not want to put Babel back into a Next.js build. The React team has also been working with the oxc project so that a future Rolldown-based Vite pipeline does not need Babel either. Expo SDK 54 and newer enable the compiler by default; `create-vite` and `create-next-app` offer templates that do the same.

[`compilationMode`](https://react.dev/reference/react-compiler/compilationMode) decides which functions are candidates. The default is `'infer'`: PascalCase names that produce JSX or call hooks, hooks named with a `use` prefix, and anything annotated with `"use memo"`. `'annotation'` compiles only functions (or modules) that opt in with `"use memo"` — the incremental path on a large codebase. `'syntax'` is for Flow's `component` / `hook` syntax. `'all'` compiles every top-level function and is not recommended, because it will also compile helpers that are not React code. Regardless of mode, `"use no memo"` skips a function. Both directives can be set at module scope and overridden on a single function.

Directives are escape hatches, not the main switch. The docs' advice is to configure the project, use `"use no memo"` only with a comment that says why, and treat opt-outs as temporary. A `gating` option wraps the optimized body in a runtime feature-flag check, so you can roll the compiler out to a fraction of users without maintaining two source trees.

Existing `useMemo`, `useCallback` and `React.memo` keep working. The compiler will often be as precise, or more precise, than what you wrote — especially after an early return — but the official guidance for new code is to lean on the compiler and reach for a hook only when you need *control*, not when you need *memoization*. The most common remaining use of `useMemo` is to stabilize a value that is a dependency of an effect, so the effect does not re-run because a cache slot was grouped differently. For existing memoization, the 1.0 post's advice is to leave it in place: removing it can change compilation output.

That last point is also why upgrades deserve care. Future compiler versions may memoize more granularly. If a value that happens to be referentially stable today is used as an effect dependency, a more precise cache may re-create it more often, or less often, and the effect will fire differently. The React team's position is that effects should synchronize, not act as implicit triggers; in a real codebase some of them do anyway. If you cannot automatically catch those behavior changes when you bump the plugin, pin an exact compiler version rather than a SemVer range.

## 5. Comparison: compiler, `memo`, and signals

It is easy to describe React Compiler as "fine-grained reactivity for React". The introduction docs even use that phrase for the result — only the relevant parts of the tree re-render. The mechanism is not the same as signals, and the difference matters when you choose a stack.

A **signal** (Solid, Vue `ref` / `computed`, Angular `signal`, Preact Signals, Svelte 5 runes, the TC39 proposal) is a runtime graph. Reading a signal inside a computation subscribes that computation to the signal. When the signal writes, only the subscribed computations re-run, and in the fine-grained systems those computations often update a DOM node directly. There is no "parent function ran, so the child function ran" step. A previous article in this series walked through the push-pull algorithm, diamond glitches, and coloring in some depth.

**React Compiler leaves the runtime model alone.** A compiled `FriendList` still runs when its state or its hooks say it should. What the compiler changes is the *body*: the filter, the handlers, and the JSX for the children can all be reused, so `FriendCard` is not invoked and Fiber has nothing new to reconcile for that child. You still have a component tree, a render phase, and a diff. You just do much less of all three.

Against **manual `React.memo`**, the compiler wins on completeness and on cases hooks cannot express:

- It memoizes intermediate values, not just component boundaries.
- It memoizes per-element closures in a `map`.
- It memoizes after early returns.
- It infers dependencies, including optional chains and array indices, instead of trusting an array you maintained.
- It will also *refuse* to memoize when the Rules of React are broken, which is safer than a `useMemo` you wrote around a mutation.

Against **signals**, the compiler wins on migration cost — existing React, including React Native, does not have to be rewritten — and loses on the lower bound of work. If a parent must re-execute because it called `useFriendOnlineCount()`, the parent function still runs, even if every JSX slot hits. A signal-based badge would not involve the list's function at all. In the model in section 8, that shows up clearly: `FriendList` runs 37 times under every strategy, including the compiler. The win is everywhere *under* that function.

Svelte 5 and Solid also compile, but they compile *into* a different runtime (fine-grained subscriptions, direct updates). React Compiler compiles *into* better React. That is a smaller conceptual jump, and it is also a ceiling: you will not get Solid-style per-node updates from this compiler.

## 6. What it will not do

A short list, so the compiler does not get blamed for the wrong thing:

- **It will not skip a component that read changing state or a changing hook.** Put the hook in a smaller child if the parent is doing work you do not want on that update.
- **It will not memoize non-component helpers**, and it will not share a memo across components. A truly expensive pure function used in many places still needs its own cache.
- **It will not fix a Rules of React violation.** It will skip the function and, with the ESLint plugin, tell you. Mutating props, mutating data after it has been passed to JSX, reading or writing a ref during render, or calling hooks conditionally all put you off the happy path.
- **It will not make a heavy commit cheap.** Layout, paint, effects, and network are outside its scope. An earlier article in this series on the browser rendering pipeline, and another on hydration, cover those costs.
- **It will not stabilize a value for an effect unless it happens to.** If an effect's correctness depends on a particular identity, be explicit with `useMemo` / `useCallback`, or better, stop using identity as a protocol between render and effects.
- **It will not replace Server Components, islands, or resumability.** Those shrink how much code runs on the client in the first place. The compiler makes the code that *does* run cheaper to *update*. They complement each other; they do not substitute.

In production, the first thing to turn on is usually the lint preset, not the plugin. A codebase that already follows the Rules of React tends to compile cleanly. A codebase that does not will show you why, and `"use no memo"` plus `compilationMode: 'annotation'` let you opt in one island at a time.

## 7. A runnable model

The program below is not a compiler. It is a counter for the work each strategy is *trying* to avoid. The tree is a `FriendList` of 200 friends: an `OnlineBadge` driven by a hook, an expensive `filter`, a `MessageButton` with no inputs, a `FriendCard` per visible friend, and a `merge_theme` helper that — on the non-empty path — runs *after* an early return, where a hook would be illegal.

Four strategies:

- **naive.** Any time the parent runs, every child runs. Nothing is memoized.
- **manual_broken.** `FriendCard` is wrapped in `memo`, but the parent passes a new `on_select` closure per card, per render. The memo never hits. Filter, theme, badge and button are also unmemoized. This is the "we added `memo` and nothing got faster" configuration.
- **manual_correct.** `useMemo` for the filter, one stable `useCallback` for `on_select`, `React.memo` on `FriendCard`, `MessageButton` and `OnlineBadge`. `merge_theme` is *not* memoized, because it sits after the early return.
- **compiler.** Cache slots with identity comparisons for the filter, the stable handler, per-card props (including a stable handler), the chrome, and `merge_theme` on both sides of the branch.

The scenario is 37 updates: an initial render, eight query updates (the last two match nobody, so the tree swaps to `NoFriends`), a cleared query that remounts the list, five selections, twenty `online_count` ticks, a rename that replaces one friend object, and a theme-token change. Unmounting a child drops its memo state, so a remount is paid in full.

Output on CPython 3:

```text
Steps: 37  Friends: 200

== naive ==
FriendList=37  FriendCard=5969  OnlineBadge=37  MessageButton=35  NoFriends=2  filter=37  merge_theme=37

== manual_broken ==
FriendList=37  FriendCard=5969  OnlineBadge=37  MessageButton=35  NoFriends=2  filter=37  merge_theme=37

== manual_correct ==
FriendList=37  FriendCard=410  OnlineBadge=21  MessageButton=2  NoFriends=1  filter=11  merge_theme=37

== compiler ==
FriendList=37  FriendCard=410  OnlineBadge=21  MessageButton=2  NoFriends=1  filter=11  merge_theme=3

== phase totals (FriendCard / filter / merge_theme / FriendList) ==
initial                                   200/1/1/1        200/1/1/1        200/1/1/1        200/1/1/1
8 query keystrokes (last empty)           169/8/8/8        169/8/8/8          0/8/8/8          0/8/1/8
query cleared                             200/1/1/1        200/1/1/1        200/1/1/1        200/1/0/1
5 selections                             1000/5/5/5       1000/5/5/5          9/0/5/5          9/0/0/5
20 online-count ticks                 4000/20/20/20    4000/20/20/20        0/0/20/20         0/0/0/20
rename friend 0                           200/1/1/1        200/1/1/1          1/1/1/1          1/1/0/1
theme token change                        200/1/1/1        200/1/1/1          0/0/1/1          0/0/1/1

Cell format: FriendCard / filter / merge_theme / FriendList
```

Reading those numbers:

1. **Broken manual memoization is indistinguishable from doing nothing.** `manual_broken` and `naive` produce the same 5,969 `FriendCard` executions. A new `on_select` identity on every parent render is enough to defeat `React.memo` completely. During the twenty online-count ticks the naive and broken strategies each run the card body 4,000 times; the correct and compiler strategies run it zero times.

2. **Correct manual memoization and the compiler agree on the component tree.** Both run `FriendCard` 410 times: 200 on mount, 200 on remount after the empty query (memo state is gone when a child unmounts), 9 for the five selections (the first selection paints one card, each subsequent change paints two), and 1 when friend 0 is replaced. Both run `filter` 11 times — once per change of `friends` or `query`, never on a selection, tick or theme change. Both run `MessageButton` twice (mount and remount) and `OnlineBadge` 21 times (mount plus twenty ticks). If you already write memoization this carefully, the compiler is not a faster algorithm for the same tree. It is a way of getting this tree without writing, or keeping, that memoization.

3. **The compiler's extra win is the late `merge_theme`.** `manual_correct` still calls it 37 times, once per parent render, because `useMemo` cannot legally sit after the early return. The compiler keeps a slot on each side of the branch and calls it 3 times: once on the first non-empty path, once the first time the list is empty, and once when the theme token actually changes. During the twenty ticks, `manual_correct` pays 20 theme merges; the compiler pays 0. That is a small function in this model and a stand-in for any work that naturally lives on one side of a branch.

4. **The parent still runs.** `FriendList` is 37 under every heading, because the online-count hook lives in the parent. The compiler does not invent a subscription that would let the list function sleep. If those twenty ticks are on a hot path, the structural fix is to move the hook into `OnlineBadge`, which is a good idea with or without a compiler.

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple


@dataclass(frozen=True)
class Friend:
    id: int
    name: str


@dataclass
class State:
    friends: Tuple[Friend, ...]
    query: str
    selected_id: Optional[int]
    online_count: int
    theme_token: str


class Counters:
    def __init__(self) -> None:
        self.calls: Dict[str, int] = {}
        self.filter_runs = 0
        self.merge_theme_runs = 0

    def call(self, name: str) -> None:
        self.calls[name] = self.calls.get(name, 0) + 1

    def row(self) -> Dict[str, int]:
        out = dict(self.calls)
        out["filter"] = self.filter_runs
        out["merge_theme"] = self.merge_theme_runs
        return out


def filter_friends(friends: Tuple[Friend, ...], query: str, ctr: Counters) -> List[Friend]:
    ctr.filter_runs += 1
    q = query.lower()
    return [f for f in friends if q in f.name.lower()]


def merge_theme(token: str, ctr: Counters) -> str:
    ctr.merge_theme_runs += 1
    return f"theme:{token}"


class SlotCache:
    def __init__(self) -> None:
        self.slots: Dict[str, Tuple[Tuple[Any, ...], Any]] = {}

    def get(self, key: str, deps: Tuple[Any, ...], compute: Callable[[], Any]) -> Any:
        prev = self.slots.get(key)
        if prev is not None and prev[0] == deps:
            return prev[1]
        value = compute()
        self.slots[key] = (deps, value)
        return value


class Runtime:
    def __init__(self) -> None:
        self.caches: Dict[str, SlotCache] = {}

    def cache(self, identity: str) -> SlotCache:
        c = self.caches.get(identity)
        if c is None:
            c = SlotCache()
            self.caches[identity] = c
        return c


def shallow_equal(a: Dict[str, Any], b: Optional[Dict[str, Any]]) -> bool:
    if b is None or a.keys() != b.keys():
        return False
    return all(a[k] is b[k] or a[k] == b[k] for k in a)


class Strategy:
    name = ""

    def __init__(self) -> None:
        self.rt = Runtime()
        self.prev_props: Dict[str, Optional[Dict[str, Any]]] = {}
        self.mounted: set[str] = set()
        self._seen: set[str] = set()

    def begin(self) -> None:
        self._seen = set()

    def sweep(self) -> None:
        for identity in list(self.mounted):
            if identity not in self._seen:
                self.mounted.discard(identity)
                self.prev_props.pop(identity, None)
                self.rt.caches.pop(identity, None)
        self.mounted |= self._seen

    def maybe_run_memo(self, identity, props, body, enabled):
        self._seen.add(identity)
        if enabled and identity in self.mounted and shallow_equal(
            props, self.prev_props.get(identity)
        ):
            return
        self.prev_props[identity] = props
        body()


class Naive(Strategy):
    name = "naive"

    def render(self, state, ctr):
        friend_list(self, state, ctr, False, False, False, False, False)


class ManualBroken(Strategy):
    name = "manual_broken"

    def render(self, state, ctr):
        friend_list(self, state, ctr, True, False, False, False, False)


class ManualCorrect(Strategy):
    name = "manual_correct"

    def render(self, state, ctr):
        friend_list(self, state, ctr, True, True, True, False, True)


class Compiler(Strategy):
    name = "compiler"

    def render(self, state, ctr):
        friend_list(self, state, ctr, True, True, True, True, True)


def friend_list(strat, state, ctr, memo_cards, memo_chrome, memo_filter, memo_theme, stable_handler):
    strat.begin()
    ctr.call("FriendList")
    cache = strat.rt.cache("FriendList")

    if memo_filter:
        visible = cache.get(
            "filter",
            (state.friends, state.query),
            lambda: filter_friends(state.friends, state.query, ctr),
        )
    else:
        visible = filter_friends(state.friends, state.query, ctr)

    if stable_handler:
        def on_select(fid: int) -> None:
            return None
        on_select = cache.get("on_select", (), lambda: on_select)
    else:
        def on_select(fid: int) -> None:
            return None

    def online_badge() -> None:
        ctr.call("OnlineBadge")

    def message_button() -> None:
        ctr.call("MessageButton")

    def no_friends(theme: str) -> None:
        ctr.call("NoFriends")

    def friend_card(friend, selected, handler) -> None:
        ctr.call("FriendCard")

    if len(visible) == 0:
        if memo_theme:
            theme = cache.get(
                "theme_empty",
                (state.theme_token,),
                lambda: merge_theme(state.theme_token, ctr),
            )
        else:
            theme = merge_theme(state.theme_token, ctr)
        strat.maybe_run_memo("NoFriends", {"theme": theme}, lambda: no_friends(theme), memo_chrome)
        strat.maybe_run_memo("OnlineBadge", {"count": state.online_count}, online_badge, memo_chrome)
        strat.sweep()
        return

    if memo_theme:
        theme = cache.get(
            "theme_list",
            (state.theme_token,),
            lambda: merge_theme(state.theme_token, ctr),
        )
    else:
        theme = merge_theme(state.theme_token, ctr)
    _ = theme

    strat.maybe_run_memo("OnlineBadge", {"count": state.online_count}, online_badge, memo_chrome)
    strat.maybe_run_memo("MessageButton", {}, message_button, memo_chrome)

    for friend in visible:
        selected = friend.id == state.selected_id
        if stable_handler:
            handler = on_select
        else:
            def handler(fid: int = friend.id) -> None:
                return None
        strat.maybe_run_memo(
            f"FriendCard:{friend.id}",
            {"friend": friend, "selected": selected, "on_select": handler},
            lambda f=friend, s=selected, h=handler: friend_card(f, s, h),
            memo_cards,
        )
    strat.sweep()


NAMES = [
    "Ada", "Alan", "Alice", "Amir", "Ann", "Asha", "Bea", "Ben",
    "Cara", "Chen", "Cora", "Dan", "Deb", "Eve", "Eli", "Fay",
    "Gus", "Hana", "Ivy", "Jia", "Kai", "Lea", "Mo", "Nina",
    "Omar", "Pia", "Quin", "Raj", "Sam", "Tess", "Uma", "Val",
    "Wes", "Xan", "Yan", "Zoe",
]


def make_friends(n: int):
    return tuple(Friend(i, f"{NAMES[i % len(NAMES)]}{i // len(NAMES)}") for i in range(n))


def scenario(n: int = 200):
    friends = make_friends(n)
    state = State(friends, "", None, 47, "light")
    steps = []

    def push(label, **updates):
        nonlocal state
        d = dict(
            friends=state.friends, query=state.query, selected_id=state.selected_id,
            online_count=state.online_count, theme_token=state.theme_token,
        )
        d.update(updates)
        state = State(**d)
        steps.append((label, state))

    push("initial")
    for q in ["a", "al", "ali", "alic", "alice", "alice0", "alice0x", "no-such-name"]:
        push(f"query={q!r}", query=q)
    push("query-cleared", query="")
    for sid in [0, 1, 2, 3, 4]:
        push(f"select={sid}", selected_id=sid)
    for i in range(20):
        push(f"online-tick-{i + 1}", online_count=47 + i + 1)
    changed = list(state.friends)
    changed[0] = Friend(0, "Ada0*")
    push("rename-friend-0", friends=tuple(changed))
    push("theme-dark", theme_token="dark")
    return steps


def run(strat, steps):
    ctr = Counters()
    per = []
    prev = Counters().row()
    for label, state in steps:
        strat.render(state, ctr)
        now = ctr.row()
        per.append((label, {k: now.get(k, 0) - prev.get(k, 0) for k in now}))
        prev = now
    return ctr, per


def main():
    steps = scenario(200)
    keys = ["FriendList", "FriendCard", "OnlineBadge", "MessageButton", "NoFriends", "filter", "merge_theme"]
    print(f"Steps: {len(steps)}  Friends: 200")
    print()
    for cls in (Naive, ManualBroken, ManualCorrect, Compiler):
        ctr, _ = run(cls(), steps)
        print(f"== {cls.name} ==")
        print("  ".join(f"{k}={ctr.row().get(k, 0)}" for k in keys))
        print()

    bands = [
        ("initial", 0, 1),
        ("8 query keystrokes (last empty)", 1, 9),
        ("query cleared", 9, 10),
        ("5 selections", 10, 15),
        ("20 online-count ticks", 15, 35),
        ("rename friend 0", 35, 36),
        ("theme token change", 36, 37),
    ]
    print("== phase totals (FriendCard / filter / merge_theme / FriendList) ==")
    rows_by = {cls.name: run(cls(), steps)[1] for cls in (Naive, ManualBroken, ManualCorrect, Compiler)}
    for label, a, b in bands:
        cells = []
        for name in ("naive", "manual_broken", "manual_correct", "compiler"):
            acc = {"FriendCard": 0, "filter": 0, "merge_theme": 0, "FriendList": 0}
            for _, delta in rows_by[name][a:b]:
                for k in acc:
                    acc[k] += delta.get(k, 0)
            cells.append(f"{acc['FriendCard']}/{acc['filter']}/{acc['merge_theme']}/{acc['FriendList']}")
        print(f"{label:<34} {cells[0]:>16} {cells[1]:>16} {cells[2]:>16} {cells[3]:>16}")
    print()
    print("Cell format: FriendCard / filter / merge_theme / FriendList")


if __name__ == "__main__":
    main()
```

## Summary

- React re-renders a component and, by default, its whole subtree. Memoization in this model is about *identity*: a new closure or a new array is enough to make `React.memo` miss, even when the underlying data did not change.
- Manual memoization can match a compiler on the component tree, but only if you get every handler, every dependency array, and every memo boundary right, and only for work you can place *before* any early return. `useMemo` cannot sit after a branch; a cache slot can.
- React Compiler 1.0 (7 October 2025) is a build-time optimizer: a Babel-fronted pipeline that lowers your AST into a CFG-based HIR, analyses data flow and mutability, and emits per-scope cache checks. It is used in production at Meta, and it is on by default in Expo SDK 54. It does not change Fiber, and it does not introduce signals.
- The Rules of React are the input the analysis depends on. Code that mutates props or otherwise cannot be proven safe is skipped; `eslint-plugin-react-hooks` is the place those violations should show up before the plugin does.
- Adopt incrementally with `compilationMode: 'annotation'` and `"use memo"`, opt out with `"use no memo"`, keep existing memoization, and pin an exact compiler version if a change in cache grouping would be hard to notice.
- The compiler will not stop a parent that read a changing hook from running, will not share memos across components, and will not replace Server Components or islands. Move the hook, cache the shared helper, and treat the compiler as a way to make the client updates you already do cheaper.

## References

- React, [React Compiler](https://react.dev/learn/react-compiler)
- React, [React Compiler: Introduction](https://react.dev/learn/react-compiler/introduction)
- React, [React Compiler: Installation](https://react.dev/learn/react-compiler/installation)
- React, [React Compiler: Incremental Adoption](https://react.dev/learn/react-compiler/incremental-adoption)
- React, [Directives](https://react.dev/reference/react-compiler/directives) (`"use memo"`, `"use no memo"`)
- React, [`compilationMode`](https://react.dev/reference/react-compiler/compilationMode)
- React, [Configuration](https://react.dev/reference/react-compiler/configuration) and [Version compatibility (`target`](https://react.dev/reference/react-compiler/target))
- React, [Rules of React](https://react.dev/reference/rules)
- Lauren Tan, Joe Savona, and Mofei Zhang, [React Compiler v1.0](https://react.dev/blog/2025/10/07/react-compiler-1) (7 October 2025)
- [React Compiler Playground](https://playground.react.dev)
- [React Compiler Working Group](https://github.com/reactwg/react-compiler), including the Sanity Studio and Wakelet adoption notes
- [eslint-plugin-react-hooks](https://www.npmjs.com/package/eslint-plugin-react-hooks)
- Expo, [React Compiler guide](https://docs.expo.dev/guides/react-compiler/) (SDK 54 and later)
- Next.js, [reactCompiler](https://nextjs.org/docs/app/api-reference/config/next-config-js/reactCompiler) and the [15.3.1](https://github.com/vercel/next.js/releases/tag/v15.3.1) swc integration
