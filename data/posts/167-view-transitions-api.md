---
title: "Inside the View Transition API: Snapshots, Named Pairs, and What the Browser Actually Animates"
tag: javascript
description: How the View Transition API turns a DOM update into a visual transition without keeping both states in the tree — the startViewTransition lifecycle and its promises, capture and pairing by view-transition-name, the ::view-transition pseudo-element tree and the user-agent cross-fade, same-document versus cross-document versus element-scoped transitions, React 19.3's ViewTransition component, and a runnable model that measures default geometry motion, paint order, duplicate-name skips and hidden-document skips
date: "2026-11-22T11:55:00.000Z"
---

## Goal

For years, a smooth transition between two UI states meant both states had to exist in the DOM at once. To make a thumbnail "fly" into a large figure, you lifted the element out of its container, kept a placeholder, and used a FLIP (First, Last, Invert, Play) sequence — or you asked a library such as Motion or GSAP to do that bookkeeping for you. The in-between tree was a source of clipping bugs, focus glitches, and accessibility gaps: assistive technology could observe a structure that existed only so a picture could move.

The View Transition API takes a different cut at the problem. The document switches to the new state in one step. The browser captures the old pixels, captures the new state, and plays the animation on a tree of pseudo-elements that sits above the live DOM. The real tree is never in two states at once. Same-document transitions — `document.startViewTransition()` plus `view-transition-name` — became Baseline Newly available on 14 October 2025, after Firefox 144 joined Chromium and WebKit. Cross-document transitions and element-scoped transitions are later additions with narrower engine support.

This article covers:

1. Why an in-between DOM state is costly, and what the API puts in its place.
2. The lifecycle of `startViewTransition`, including the promises and the rule that the update always runs.
3. How snapshots are captured and paired by `view-transition-name`.
4. The `::view-transition` pseudo-element tree and the user-agent default animation.
5. Same-document, cross-document, and element-scoped transitions.
6. How React 19.3's `<ViewTransition>` maps onto the platform API.
7. Trade-offs you will actually hit in production.
8. A runnable model of pairing, default motion, paint order, and skip rules.

## 1. The problem with keeping both states in the tree

A CSS transition can interpolate `transform` and `opacity` only for elements that exist. If a list item moves from one container to another, or a route swap unmounts a page and mounts the next, there is no single element to transition. The usual workaround is to keep a visual clone in a root-level overlay, measure "first" and "last" boxes, invert the delta with a transform, and play that transform back to identity — FLIP.

That works, and it is still the right tool when you need per-property interpolation of live text or a gesture-driven spring. It also forces a temporary tree. Overflow clips and `transform` containing blocks belong to the old parent; the clone has to escape them. Keyboard focus and the accessibility tree see whatever you left behind. If the user prefers reduced motion, you must remember to skip not only the animation but also the clone.

View Transitions invert the dependency. The DOM update is the source of truth and happens immediately. The animation is an enhancement painted from captures, and the capture tree is not exposed to the accessibility tree. If the animation cannot be created — a duplicate name, a hidden document, an engine that does not implement the API — the update still happens. The specification calls this out as a design rule, not an accident.

## 2. The lifecycle of `startViewTransition`

A same-document transition starts with a single call:

```javascript
function renderNextView() {
  // route change, setState, or any other DOM mutation
}

if (!document.startViewTransition) {
  renderNextView();
  return;
}

const transition = document.startViewTransition(() => {
  renderNextView();
});
```

The Level 1 specification walks a successful transition through these phases:

1. The author calls `document.startViewTransition(updateCallback)` and gets a `ViewTransition` object.
2. The current state is captured as the **old** state.
3. Rendering is paused.
4. `updateCallback` runs and updates the document. When the promise it returns fulfills, `viewTransition.updateCallbackDone` fulfills.
5. The current state is captured as the **new** state.
6. The transition pseudo-elements are created.
7. Rendering is unpaused, revealing those pseudo-elements, and `viewTransition.ready` fulfills.
8. The pseudo-elements animate until they finish.
9. They are removed, and `viewTransition.finished` fulfills.

Three promises, three moments:

| Promise | Fulfills when |
| --- | --- |
| `updateCallbackDone` | The update callback has finished (or immediately, if you passed no callback) |
| `ready` | The pseudo-element tree exists and the animation is about to start |
| `finished` | The animation is over and the new view is what the user interacts with |

The update callback is **always** invoked, even if the visual transition will be skipped. Calling `skipTransition()` at the start of the lifecycle drops the snapshot and the pseudo-element tree, but it does not drop the callback. A rejection from the callback skips the animation and rejects the related promises. If the document's visibility becomes `hidden` — the window is minimized, another tab is in front — an in-flight transition is skipped with an `InvalidStateError`.

Because rendering is paused between the old capture and the new capture, a slow callback leaves the user looking at a frozen last frame of the old state. Do the state change in the callback; do not start a network fetch there and wait.

If you use the platform API next to React's own renderer, the callback must present the new DOM before it returns. A bare `setState` in React 18+ is asynchronous, so the browser would capture the old tree as the "new" state and animate nothing. `flushSync` is the usual hammer around a raw `startViewTransition` call. React 19.3's built-in component, discussed below, takes over this timing and you should not call `startViewTransition` yourself in that tree.

## 3. Capture and pairing

By default the user-agent style sheet sets `view-transition-name: root` on the document element, so every transition has at least a page-wide group. Any other element you want to animate on its own needs a name:

```css
.hero-image {
  view-transition-name: hero;
}
```

The name is a **pairing key**, not an element identity. An element named `hero` in the old tree and a different element named `hero` in the new tree are treated as two visual states of the same conceptual object and share one `::view-transition-group(hero)`. That is what makes a thumbnail morph into a large figure across a route change: the two nodes do not have to be the same object, they only have to share a name.

Names must be unique among **rendered** elements in each state. If two rendered elements compute to the same `view-transition-name` at capture time, capture fails, `ready` rejects, and the visual transition is skipped. The DOM update still stands. This is the most common production foot-gun — a list that uses `view-transition-name: card` on every row, or a name that leaks from a previous screen.

The capture algorithm, in paint order, is roughly:

1. Skip an element whose flat-tree ancestor skips its contents, or that is not rendered, or whose name is `none`.
2. Skip an element with more than one box fragment. (Inline wrapping across line boxes is allowed; fragmentation across columns or pages is not.)
3. Fail the whole transition if the name was already used in this state.
4. Record the border box, a transform that maps that box from the snapshot containing block origin, and a handful of style values (`writing-mode`, `direction`, `mix-blend-mode`, `backdrop-filter`, `color-scheme`, …).
5. Paint the image. For the document element, the snapshot is the snapshot containing block — a rectangle that covers the area that can show page content, including transient browser UI such as a mobile URL bar, so the old and new root images stay aligned. For any other element, the image is the ink-overflow rectangle of that element and its descendants.

A few rendering rules matter in practice:

- A transform on the element itself is **not** baked into the bitmap; it is reapplied on `::view-transition-group()`, so the group can interpolate it.
- Filters and opacity on the element and its descendants are captured; the same effects coming from **ancestors** are ignored, because those ancestors may not be part of this group.
- Descendants that themselves have a `view-transition-name` are omitted from the ancestor's image, so they are not drawn twice.
- An element with a non-`none` `view-transition-name` forms a stacking context, is flattened in 3D, and forms a backdrop root — **even when no transition is running**. Naming a large subtree is not free.

Level 2 and current engines also provide `view-transition-name: match-element`, which assigns an internal, unique name from element identity. That is enough for a same-document reorder of a stable list, where each node is the same object before and after. It will not pair a thumbnail on one route with a figure on the next, because those are different elements (and, in a multi-page app, different documents). For a shared-element morph you still invent an explicit name.

## 4. The pseudo-element tree and the default animation

After both captures, the engine builds a tree of tree-abiding pseudo-elements, all originating from the document element:

```
::view-transition
├─ ::view-transition-group(name)
│  └─ ::view-transition-image-pair(name)
│     ├─ ::view-transition-old(name)
│     └─ ::view-transition-new(name)
└─ …other groups…
```

Each unique name gets a group. `::view-transition-old()` or `::view-transition-new()` is omitted when that side has no capture, so an exit-only name has no new image and an entry-only name has no old image. `::view-transition-new(hero):only-child` is a useful selector for "this name appeared for the first time."

The user-agent style sheet does three important things:

- It places `::view-transition` as `position: fixed; inset: 0` in the snapshot containing block, and each group as `position: absolute` with a **0.25s** animation, `animation-fill-mode: both`.
- It cross-fades with `@keyframes -ua-view-transition-fade-out` (opacity to 0) on `::view-transition-old(*)` and `-ua-view-transition-fade-in` (opacity from 0) on `::view-transition-new(*)`.
- It sets `mix-blend-mode: plus-lighter` on `::view-transition-image-pair(*)`. For two identical pixels, plus-lighter preserves the original color during the overlap, which is what people mean by a "correct" cross-fade. Ordinary `opacity` blending of two copies of the same color goes muddy in the middle.

For a **paired** name, the engine also writes a dynamic rule on `::view-transition-group(name)` that sets `width`, `height`, and `transform` to the new border box (and keeps those values in sync if the new element moves during the animation). The default group animation interpolates from the old box to the new one. That is the morph: the old and new images sit in a box that travels and resizes, while they cross-fade.

You customize the same way you customize any CSS animation: target the pseudo-elements, change `animation-name`, `animation-duration`, or `animation-timing-function`, or set `animation: none` and drive the effect from the Web Animations API after `ready` fulfills.

Two later styling hooks are worth knowing. `view-transition-class` attaches a shared class to several groups so one rule can style all of them. View transition **types** — passed as `document.startViewTransition({ update, types: ["forwards"] })`, or set on `transition.types`, or declared on `@view-transition` for a cross-document navigation — let you write:

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

Neither the platform nor React disables motion automatically when the user asks for less of it. That media query is yours to ship.

Paint order follows capture order. Groups are first created from old-state names, in paint order; names that exist only in the new state are appended, so **entry animations paint on top of** exit animations and paired morphs. The model in section 8 reproduces that ordering.

## 5. Same-document, cross-document, and element-scoped

There are now three ways to start a transition, and they are not interchangeable.

**Same-document (SPA).** You call `document.startViewTransition(updateCallback)`. This is the Baseline Newly available core from 14 October 2025: the method, `view-transition-name`, `view-transition-class`, `match-element`, and `:active-view-transition`. Firefox 144's first implementation did not include transition types; if you rely on types, keep a fallback path.

**Cross-document (MPA).** There is no callback, because the navigation itself is the update. Both documents must opt in:

```css
@view-transition {
  navigation: auto;
}
```

And all of the following must hold: the two documents are same-origin; the navigation has no cross-origin redirect; the page stays visible for the whole navigation; and the navigation is a `traverse` (back/forward) or a `push`/`replace` whose user involvement is not `"browser UI"`. Typing a URL in the address bar does not start a view transition. The old document can customize or skip the transition from a `pageswap` event; the new document sees it on `pagereveal`. Because there is no author callback to say "the new tree is ready," the engine uses render-blocking: a `blocking` attribute on critical styles and scripts, or an `expect` link for a known fragment, can hold the animation until the new state is stable. Hold it too long and the user stares at the last frame of the previous page.

Cross-document transitions are not Baseline as of this writing. Safari has shipped them (from 18.2); Firefox's 144-era support covered same-document transitions only. Engines that do not implement the rule simply navigate as usual, which is the enhancement model working as designed.

**Element-scoped.** Chrome 147, described in Chrome's 27 March 2026 note, adds `Element.startViewTransition()` so a subtree can transition on its own. Several scopes can run at once, and the rest of the page stays interactive — something a document-scoped transition cannot offer, because it pauses rendering for the whole document. Scope roots participate in the transition by default, nested groups are used so overflow clipping can be preserved, and the engine applies `contain: layout` on the scope root for the duration of the transition. This is still engine-specific; do not assume it in a Baseline-only path.

Level 2 also introduces `view-transition-group` for **nested** groups, so a named child can stay clipped or filtered by a named ancestor instead of jumping into the flat, viewport-sized `::view-transition` tree. If a card is clipped by a rounded carousel and you name both, a flat tree will let the flying card escape the rounded edge mid-animation; a nested group keeps the clip.

## 6. What React actually does

React 19.3 shipped a built-in `<ViewTransition>` component (9 September 2026). Under the hood it assigns `view-transition-name` on the nearest DOM node at the moment that boundary should participate, then calls `startViewTransition` itself. The public docs are explicit: in a tree that uses this component, you should not call `startViewTransition` on your own, and a foreign transition on the same document may be interrupted.

Activation is opt-in by **update path**, not by "any render." Ordinary `setState` does not start a view transition. Updates wrapped in `useTransition`, a `<Suspense>` reveal, or `useDeferredValue` do. React then chooses a trigger:

- `enter` / `exit` — the boundary is the first inserted or deleted component in that Transition
- `update` — DOM mutations inside the boundary, or the boundary's own box changed because of an immediate sibling
- `share` — a named boundary in a deleted subtree and a named boundary with the same `name` in an inserted subtree, in the same Transition

The `name` prop is reserved for that shared-element case. For everything else React generates a unique name, which is the same idea as `match-element`: prevent accidental pairing.

If several React view transitions would overlap, React waits for the in-flight one and **batches** later updates. An `A → B` animation that is interrupted by updates to `C` and then `D` continues to completion, then animates `B → D`. `useLayoutEffect` and layout measurement run inside the update callback; `useEffect` is deferred until `finished`, so effects are less likely to jab the animation. A `flushSync` in the middle of this sequence causes React to skip the transition, because the sequence depends on completing synchronously.

The component still produces snapshots, not per-child layout animations. A large boundary that wraps a whole page will cross-fade or morph as one image. If inner pieces should travel on their own, they need their own boundaries — the same discipline as choosing `view-transition-name` by hand.

## 7. Trade-offs

View Transitions are a captured-image API. That is the feature, and it is the limitation.

- **Bitmaps scale like bitmaps.** A 160×100 thumbnail interpolating to a 640×400 figure is a 4× enlargement of a captured image for most of the 250 ms. Fine for a short morph; soft if the duration is long or the scale jump is larger. Live text inside the capture is not live: you cannot select it, and a screen reader never looks at it, because it is not in the accessibility tree. The real DOM has already moved on.
- **A duplicate name aborts the whole visual transition.** There is no "skip just this group." List rows need unique names, or `match-element` / React-generated names, or no name at all.
- **Naming has a standing cost.** `view-transition-name` other than `none` creates a stacking context and a backdrop root even when idle. Apply it to the elements you intend to morph, not to every node "just in case."
- **The animation is an enhancement.** A hidden tab, a capture that exceeds an implementation-defined snapshot size, a fragmented box, or a missing API must not be the thing that decides whether the new route renders. Write the fallback first: call the update directly when `startViewTransition` is missing, and treat `ready` rejection as "the new state is already on screen."
- **Document-scoped transitions freeze the page.** The old frame is held until the callback finishes. Element-scoped transitions in Chrome 147 exist in part to leave the rest of the UI live.
- **Motion preference is not default-on.** Ship `prefers-reduced-motion`.
- **Engine coverage is uneven outside the same-document core.** Types, cross-document opt-in, nested groups, layered capture, and element-scoped transitions should be treated as progressive layers, not as a single Baseline bundle.

Compared with a FLIP library, you give up live per-property control and mid-gesture retargeting, and you gain a browser-native snapshot, a built-in story for multi-page navigations, and a DOM that stays in one state. Many codebases use both: View Transitions for route-level and shared-element morphs, a library for pointer-driven motion.

## 8. A runnable model

The script below is the model that produced every figure in this section. It is not a pixel-accurate Chromium, Firefox, or WebKit, and it does not rasterize anything. It implements the pairing rules, the "update always runs" skip policy, the 0.25 s default duration, and the paint order from Level 1: old names first, in paint order; names that exist only in the new state appended at the end.

A 1280×800 root, used in every run, is always named `root`. Travel is the Euclidean distance between the old and new border-box centers. Scale is `new size / old size` on each axis, and only applies to paired names.

**Root-only navigation.** A content box moves and resizes, but it has no name, so it is folded into the root snapshot. The transition has a single group. The root box does not move. The user sees a 250 ms cross-fade of the whole viewport.

| Group | Kind | Travel | Scale |
| --- | --- | ---: | --- |
| `root` | paired | 0.0 px | 1.00×1.00 |

**Shared hero.** A 160×100 thumbnail at `(24, 120)` is named `hero` and morphs into a 640×400 figure at `(80, 80)`. The card around the thumbnail is exit-only; the article that wraps the figure is entry-only.

| Group | Kind | Old box `(x,y,w,h)` | New box | Travel | Scale |
| --- | --- | --- | --- | ---: | --- |
| `root` | paired | `(0,0,1280,800)` | `(0,0,1280,800)` | 0.0 px | 1.00×1.00 |
| `card` | exit | `(24,120,400,280)` | — | — | — |
| `hero` | paired | `(24,120,160,100)` | `(80,80,640,400)` | 315.8 px | 4.00×4.00 |
| `article` | entry | — | `(80,80,1120,640)` | — | — |

The hero's center travels from `(104, 170)` to `(400, 280)`, a distance of 315.8 px, while the group scales 4× on both axes. Paint order is `root`, `card`, `hero`, `article`: the entry-only article is last, so it stacks above the exiting card and the morphing hero, which is the Level 1 rule about new-only names being appended.

**List reorder.** Five 1232×48 rows with a 8 px gap, uniquely named, go from `[a, b, c, d, e]` to `[c, a, e, b, d]`. Row pitch is 56 px.

| Group | Old y | New y | Travel |
| --- | ---: | ---: | ---: |
| `item-a` | 80 | 136 | 56.0 px |
| `item-b` | 136 | 248 | 112.0 px |
| `item-c` | 192 | 80 | 112.0 px |
| `item-d` | 248 | 304 | 56.0 px |
| `item-e` | 304 | 192 | 112.0 px |
| total (including a still root) |  |  | 448.0 px |

The same reorder with no item names produces one group, `root`, and **0 px** of travel. The items still change places, but all the user gets is a viewport cross-fade. The names are the difference between "the rows slide" and "the page blinks."

**Entry and exit.** Drop `item-a`, append `item-f`, and the surviving rows each move up by one pitch (56 px), for 224.0 px of combined travel. `item-f` is entry-only and is last in paint order, so the incoming row stacks above the exiting one.

**Skips.** Two rendered elements named `card` in either the old tree or the new tree skip the visual transition, with the update still applied. A hidden document does the same, with reason `document hidden`. In every skip the model still reports `update_applied=True`.

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

- View Transitions separate the DOM update from the visual interpolation. The document jumps to the new state; the browser animates a pseudo-element tree built from an old capture and a new capture. The accessibility tree never sees an in-between document, and a failure to animate does not cancel the update.
- `view-transition-name` is a pairing key. The document element is named `root` by default. Two different elements that share a name become one morphing group. A duplicate name in either state skips the visual transition. `match-element` (and React's generated names) is for same-object, same-document cases; a shared-element morph still needs an explicit name.
- The default animation lasts 0.25 s: old and new images cross-fade under `mix-blend-mode: plus-lighter`, and a paired group's `width`, `height`, and `transform` interpolate from the old border box to the new one. Entry-only groups paint on top of exit-only and paired groups.
- Same-document transitions are Baseline Newly available since 14 October 2025. Cross-document transitions opt in with `@view-transition { navigation: auto; }` on both same-origin documents and are not Baseline. Element-scoped transitions, `Element.startViewTransition()`, shipped in Chrome 147 and can run concurrently without freezing the rest of the page.
- React 19.3's `<ViewTransition>` calls the platform API for you, activates only on Transition / Suspense / `useDeferredValue` updates, and uses `name` only for shared elements. It does not honor `prefers-reduced-motion` by itself.
- The model in this post is an operation-level pairing model, not a rasterizer. A named 160×100 thumbnail morphing to a 640×400 figure travels 315.8 px and scales 4×. The same five-row reorder is 448 px of combined row travel with unique names, and 0 px — a plain cross-fade — without them. Duplicate names and a hidden document skip the animation and still apply the update.

## References

- CSS View Transitions Module Level 1, W3C, [https://www.w3.org/TR/css-view-transitions-1/](https://www.w3.org/TR/css-view-transitions-1/) (lifecycle, `view-transition-name`, pseudo-element tree, user-agent style sheet, capture and skip algorithms)
- CSS View Transitions Module Level 2, W3C, [https://www.w3.org/TR/css-view-transitions-2/](https://www.w3.org/TR/css-view-transitions-2/) (cross-document `@view-transition`, types, `view-transition-class`, automatic naming, nested groups)
- MDN, [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
- MDN, [`Document.startViewTransition()`](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition)
- MDN, [`view-transition-name`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/view-transition-name) (`match-element`, uniqueness)
- MDN, [`@view-transition`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@view-transition)
- Chrome Developers, [View Transitions API](https://developer.chrome.com/docs/web-platform/view-transitions)
- Bramus, [Same-document view transitions are now Baseline Newly available](https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available), 16 October 2025 (Firefox 144, 14 October 2025 Baseline date, Interop 2025)
- Bramus, [Element-scoped view transitions](https://developer.chrome.com/blog/element-scoped-view-transitions), 27 March 2026 (Chrome 147, `Element.startViewTransition()`)
- React, [`<ViewTransition>`](https://react.dev/reference/react/ViewTransition)
- React, [React 19.3](https://react.dev/blog/2026/09/09/react-19-3), 9 September 2026
