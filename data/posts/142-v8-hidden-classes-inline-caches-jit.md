---
title: "Inside V8: Hidden Classes, Inline Caches and the Ignition / Sparkplug / Maglev / TurboFan Pipeline"
tag: javascript
description: How V8 makes a dynamically typed language fast — shapes (Maps) and transition trees, inline caches and their monomorphic / polymorphic / megamorphic states, feedback vectors, the four execution tiers from the Ignition interpreter through Sparkplug, Maglev and TurboFan, speculative optimization and deoptimization, elements kinds, Smis and pointer compression, and the practical coding habits that follow from all of it
date: "2026-10-28T11:30:00.000Z"
---

## Goal

JavaScript objects look like hash maps: you can add, delete and retype properties at any moment. If an engine really implemented every `obj.x` as a hash lookup, and every `a + b` as a full type dispatch, JavaScript would be an order of magnitude slower than it is. V8 (Chrome, Node.js, Deno, Electron) avoids this by **observing what your program actually does at runtime and speculating that it will keep doing it.**

This article explains the machinery behind that speculation:

1. **Hidden classes** (V8 calls them *Maps*) that give dynamic objects a static layout.
2. **Inline caches** and **feedback vectors** that record which layouts and types each operation has seen.
3. A **tiered pipeline** — Ignition, Sparkplug, Maglev, TurboFan — that spends more compile time on hotter code.
4. **Deoptimization**, the safety net that makes speculation correct.
5. **Elements kinds**, **Smis** and **pointer compression**, which explain many "mysterious" performance cliffs.

Details below follow V8's public design documents and blog posts (linked at the end). V8 evolves quickly; flag names and tier thresholds change between releases, so treat specifics as a description of the design, not a frozen contract.

## Part 1: Hidden Classes (Maps)

### The problem

Consider:

```js
function Point(x, y) {
  this.x = x;
  this.y = y;
}
const p = new Point(1, 2);
```

A naive engine stores `p` as a dictionary `{ "x": 1, "y": 2 }`. Every access hashes the string, probes a table, and compares keys. Worse, every `Point` repeats the key names.

### The V8 approach

V8 splits an object into two parts:

- The **object** itself holds only the *values*, in fixed slots (in-object properties, plus an overflow "properties" backing store if needed).
- A shared **Map** (hidden class / shape) describes the *layout*: which property names exist, at which slot offset, with which attributes (writable, enumerable, configurable) and a tracked field representation.

All objects with the same layout share one Map, so the key names are stored once.

Maps are linked into a **transition tree**. Starting from the empty-object Map, adding `x` follows (or creates) a transition to Map `{x}`, then adding `y` transitions to Map `{x, y}`:

```text
Map0 {}  --add "x"-->  Map1 {x@0}  --add "y"-->  Map2 {x@0, y@1}
                  \
                   --add "y"-->  Map3 {y@0}  --add "x"-->  Map4 {y@0, x@1}
```

Two consequences follow immediately:

- **Property order matters.** `{x, y}` and `{y, x}` end up with different Maps, even though they hold the same keys.
- **Initializing all fields in the constructor**, in the same order, makes every instance share one Map. Adding a property later "forks" the object onto a different branch of the tree.

### Watching it happen

Node exposes V8 internals behind `--allow-natives-syntax`:

```js
// node --allow-natives-syntax maps.js
function Point(x, y) { this.x = x; this.y = y; }

const a = new Point(1, 2);
const b = new Point(3, 4);
console.log(%HaveSameMap(a, b)); // true

b.z = 5;                          // b moves to a new Map
console.log(%HaveSameMap(a, b)); // false

const c = { y: 1, x: 2 };
const d = { x: 1, y: 2 };
console.log(%HaveSameMap(c, d)); // false: different insertion order
```

`%DebugPrint(obj)` prints the Map address, the descriptor array and the elements kind if you want more detail. These intrinsics are for exploration only — never ship them.

### When Maps give up: dictionary mode

Some operations make the shared-layout model unprofitable, and V8 switches the object to **dictionary (slow) mode**, where properties live in a per-object hash table:

- `delete obj.someProperty` (deleting the most recently added property can sometimes be undone by rolling back a transition, but deleting anything else typically normalizes the object),
- adding a very large number of properties dynamically,
- some uses of `Object.defineProperty` with unusual attributes.

`%HasFastProperties(obj)` tells you which mode an object is in. Dictionary mode is the right choice for genuine maps — that is what it is for — but if you are using an object as a record, prefer setting a field to `undefined` (or use a `Map` for truly dynamic keys).

## Part 2: Inline Caches and Feedback Vectors

A Map alone does not make `p.x` fast; the engine still has to *look up* `x` in the Map's descriptors. The trick is to do that lookup once per call site and cache the answer.

### Inline caches

Each property access, call, or arithmetic operation in bytecode has a slot in the function's **feedback vector**. The first time `p.x` executes, V8 performs the full lookup, then records "for Map2, `x` is at offset 0." Next time, it checks only whether the incoming object's Map is Map2; if so, it loads offset 0 directly. That check-plus-load is an **inline cache (IC)**.

An IC moves through states as it sees more shapes:

| State | Shapes seen | Cost |
|---|---|---|
| Uninitialized | none | first execution does a full lookup |
| **Monomorphic** | 1 | one Map compare + direct load — the fast path |
| **Polymorphic** | 2–4 | linear check over a small list of Maps |
| **Megamorphic** | more than 4 | falls back to a global stub cache / generic lookup |

The four-entry polymorphic limit is V8's long-standing default; the exact number is an implementation detail.

```js
function getX(o) { return o.x; }

// Monomorphic: every call sees the same Map
for (let i = 0; i < 1e6; i++) getX({ x: i, y: 0 });

// Polymorphic -> megamorphic: five different shapes reach the same site
const shapes = [
  { x: 1 }, { x: 1, a: 0 }, { x: 1, b: 0 }, { x: 1, c: 0 }, { x: 1, d: 0 },
];
for (let i = 0; i < 1e6; i++) getX(shapes[i % 5]);
```

The second loop is not "wrong", but `getX` can no longer be compiled to a single compare-and-load; the optimizing compiler has far less to work with.

### Feedback is more than shapes

The feedback vector also records:

- **Binary operation feedback**: has `a + b` only seen small integers? doubles? strings? a mix?
- **Call feedback**: which function a call site actually targets (enabling inlining).
- **Compare feedback**, **allocation site** information for arrays and object literals, and more.

This profile is the raw material for every higher tier.

## Part 3: The Tiered Execution Pipeline

V8 has to balance two costs: time spent compiling, and time spent running slow code. Its answer is a ladder of tiers, each slower to compile and faster to run than the previous one.

```text
source --parse--> AST --> Ignition bytecode
                              |
         (interpret, collect feedback)       Tier 1: Ignition
                              |
                    warm  --> Sparkplug       Tier 2: baseline machine code
                              |
                    hot   --> Maglev          Tier 3: fast optimizing JIT
                              |
                very hot  --> TurboFan        Tier 4: top optimizing JIT
                              ^
                deopt <-------+ (bail back to Ignition/Sparkplug frames)
```

### Ignition — the interpreter (since 2016–2017)

Ignition compiles the AST to a compact **register-based bytecode** and interprets it. Bytecode is far smaller than the machine code V8 used to generate eagerly, which mattered a lot for memory on phones. Every bytecode that can benefit from it updates the feedback vector.

You can see the bytecode with `node --print-bytecode --print-bytecode-filter=getX file.js`.

### Sparkplug — the non-optimizing baseline compiler (Chrome 91, 2021)

Sparkplug compiles bytecode to machine code **in a single linear pass, without building any IR**. Each bytecode becomes a short sequence of machine instructions, mostly calls into the same builtins the interpreter uses. It keeps the interpreter's frame layout, which makes switching between Ignition and Sparkplug essentially free (including on-stack replacement in the middle of a loop).

Sparkplug does not speculate and does not optimize; it just removes interpreter dispatch overhead. The V8 team reported meaningful gains on real-world browsing benchmarks because a large share of time on the web is spent in code that is warm, not hot.

### Maglev — the mid-tier optimizing compiler (Chrome 117, late 2023)

There used to be a big gap between Sparkplug and TurboFan: TurboFan produces excellent code but compiles slowly, so many functions ran too long in unoptimized form. Maglev fills that gap. It builds an SSA-based graph directly from bytecode plus feedback, performs speculative specialization (e.g. "this `+` only sees Smis", "this load only sees Map2") and a modest set of optimizations, and compiles roughly an order of magnitude faster than TurboFan.

### TurboFan — the top-tier optimizing compiler

TurboFan applies aggressive optimizations on top of feedback-driven speculation: inlining, escape analysis (allocating objects on the stack or eliding them entirely), load elimination, bounds-check elimination, loop optimizations, and careful instruction selection and register allocation. Its backend has been progressively migrated to a newer CFG-based IR called **Turboshaft**, and V8 has written publicly about moving away from the "sea of nodes" representation it originally used.

### How code moves up the ladder

V8 uses a budget-based heuristic: as a function runs (calls, loop back-edges), it consumes an "interrupt budget"; when the budget is exhausted, V8 considers tiering up. Hot loops can be optimized while running via **on-stack replacement (OSR)**. Optimizing compilation for TurboFan happens largely on background threads, so the main thread keeps executing the slower version until the optimized code is ready.

You can observe decisions with `--trace-opt` and `--trace-deopt`:

```bash
node --trace-opt --trace-deopt app.js 2>&1 | grep -E "optimiz|deoptimiz" | head
```

## Part 4: Speculation and Deoptimization

Optimizing tiers compile code that is only correct **if the assumptions from the feedback still hold.** Each assumption is guarded by a cheap check:

```text
// Conceptual optimized code for: function getX(o) { return o.x; }
  if (o is not a heap object)      -> deopt
  if (o.map != Map2)               -> deopt
  return load(o + offset_of_x)
```

When a check fails, V8 performs a **deoptimization**: it reconstructs the interpreter (or baseline) frame from the optimized frame — rematerializing values that escape analysis had eliminated — and continues in unoptimized code. The function collects fresh feedback and may be re-optimized later with broader assumptions.

Deopts themselves are normal and cheap in isolation. What hurts is a **deopt loop**: code that keeps getting optimized, invalidated and re-optimized, or code whose feedback becomes so generic (megamorphic, mixed number/string arithmetic) that the optimizer cannot produce much better code than the baseline.

A classic trigger:

```js
function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

sum([1, 2, 3]);           // Smi feedback
for (let i = 0; i < 1e5; i++) sum([1, 2, 3]); // optimized for Smi adds
sum([1.5, 2.5]);          // doubles: guard fails -> deopt, feedback widens
sum(["a", "b"]);          // strings: feedback widens again
```

## Part 5: Numbers, Smis and Pointer Compression

V8 represents values as tagged words. Small integers are stored **inline** as **Smis** (small integers) with a tag bit, so they need no heap allocation; everything else (objects, strings, and non-Smi numbers as `HeapNumber`s) is a pointer to the heap.

Since V8 8.0 (Chrome 80, 2020), 64-bit Chrome uses **pointer compression**: tagged values in the heap are 32 bits wide, interpreted as offsets from a base address inside a 4 GB "cage". This cut V8 heap size substantially on real websites (the V8 team reported up to about 43% reduction), with negligible performance cost. A side effect is that Smis are 31-bit on such builds, so values outside roughly ±1 billion become HeapNumbers. Node.js builds have historically shipped *without* pointer compression by default, so the details there differ; check your build.

Practical implication: keep hot numeric code either consistently integer or consistently floating point. Fields that flip between Smi and double representation force the Map's field representation to generalize.

## Part 6: Elements Kinds — Arrays Have Shapes Too

Indexed properties (array elements) are stored separately from named properties, and V8 tracks an **elements kind** for each array. The most common ones form a lattice, and transitions only go **downward** (more general), never back:

```text
PACKED_SMI_ELEMENTS  ->  PACKED_DOUBLE_ELEMENTS  ->  PACKED_ELEMENTS
        |                         |                         |
        v                         v                         v
HOLEY_SMI_ELEMENTS   ->  HOLEY_DOUBLE_ELEMENTS   ->  HOLEY_ELEMENTS
```

- *SMI* arrays hold only small integers; *DOUBLE* arrays store unboxed floats; plain *ELEMENTS* hold arbitrary values.
- *HOLEY* arrays may contain holes, so every read must check for a hole and possibly walk the prototype chain.

```js
const a = [1, 2, 3];      // PACKED_SMI_ELEMENTS
a.push(4.5);              // -> PACKED_DOUBLE_ELEMENTS (permanent)
a.push("x");              // -> PACKED_ELEMENTS (permanent)

const b = new Array(3);   // HOLEY_SMI_ELEMENTS: created with holes
b[0] = 1; b[1] = 2; b[2] = 3; // still HOLEY, even when filled

const c = [1, 2, 3];
c[10] = 4;                // writing past the end creates holes -> HOLEY
```

Also avoid putting `NaN`/`Infinity`/`-0` into what you want to be a Smi array (they force doubles), and avoid reading past `length`, which hits the prototype-chain slow path. When you need a homogeneous numeric buffer, **typed arrays** (`Float64Array`, `Int32Array`) give you a fixed representation with no elements-kind transitions at all.

## Part 7: Comparing Approaches Across Engines

V8 is not alone in this design; the ideas originate in the Self and Smalltalk research of the late 1980s and 1990s.

| Engine | Shapes | Tiers (simplified) |
|---|---|---|
| V8 (Chrome, Node, Deno) | Maps | Ignition → Sparkplug → Maglev → TurboFan |
| SpiderMonkey (Firefox) | Shapes | Interpreter → Baseline Interpreter → Baseline JIT → WarpMonkey (Ion) |
| JavaScriptCore (Safari, Bun) | Structures | LLInt → Baseline JIT → DFG → FTL |

The convergence is telling: every major engine landed on hidden classes + inline caches + several tiers + deoptimization. The differences are in how many tiers, how fast each compiles, and how aggressively each speculates.

Trade-offs that drive the tier design:

- **Startup vs. peak**: an interpreter starts instantly and uses little memory; an optimizing JIT has the best throughput but costs compile time and memory. Short-lived pages favor the low tiers; long-running servers favor the top tier.
- **Speculation vs. stability**: aggressive speculation gives faster code but more deopt risk. Mid tiers like Maglev speculate with cheaper compilation, so a wrong guess costs less.
- **Security**: JIT compilers are a frequent source of browser exploits, which is why environments like iOS Lockdown Mode or Edge's "enhanced security" can disable the JIT tiers, trading speed for a smaller attack surface.

## Part 8: What This Means for Everyday Code

Most application code is dominated by I/O, DOM, and network, not by property access. Profile first. But in hot paths — parsers, serializers, rendering loops, game logic, data processing in Node — these habits pay off:

1. **Initialize every field in the constructor (or class field declarations), in a consistent order.** Use `null`/`undefined` placeholders rather than adding properties later.
2. **Keep hot functions monomorphic.** If a function receives several unrelated shapes, consider splitting it per type.
3. **Do not `delete` properties on record-like objects.** Set them to `undefined`, or use `Map` for dynamic keys.
4. **Keep arrays packed and homogeneous.** Prefer literals or `push` over `new Array(n)` for small arrays; avoid mixing numbers, strings and objects in one hot array; use typed arrays for numeric buffers.
5. **Keep numeric types stable.** Do not mix integers, doubles and numeric strings in the same arithmetic site.
6. **Do not micro-optimize blindly.** Use Chrome DevTools' Performance panel, `node --cpu-prof`, `--trace-deopt`, and tools like [Deopt Explorer](https://github.com/microsoft/deoptexplorer-vscode) to confirm a hot spot before restructuring code.

A small before/after:

```js
// Before: shape depends on input, properties added later
function makeUser(row) {
  const u = {};
  u.id = row.id;
  if (row.email) u.email = row.email;
  if (row.admin) u.role = "admin";
  return u;
}

// After: one shape for every user
class User {
  constructor(row) {
    this.id = row.id;
    this.email = row.email ?? null;
    this.role = row.admin ? "admin" : "member";
  }
}
```

Every `User` now shares one Map, so every call site that reads `user.email` stays monomorphic.

## Summary

- V8 gives dynamic objects a static layout through **Maps** and a transition tree; property order and initialization patterns decide which Map you get.
- **Inline caches** and **feedback vectors** record what each operation has seen; monomorphic sites are cheapest, megamorphic sites the most expensive.
- Code climbs from **Ignition** (bytecode interpreter) to **Sparkplug** (baseline code), **Maglev** (fast optimizing JIT) and **TurboFan** (peak optimizing JIT) as it gets hotter.
- Optimized code is **speculative** and guarded; **deoptimization** falls back safely when assumptions break.
- **Smis**, **pointer compression** and **elements kinds** explain many performance cliffs around numbers and arrays.
- In practice: stable shapes, homogeneous arrays, stable numeric types — and measure before you optimize.

## References

- V8 blog, "Firing up the Ignition interpreter": https://v8.dev/blog/ignition-interpreter
- V8 blog, "Sparkplug — a non-optimizing JavaScript compiler": https://v8.dev/blog/sparkplug
- V8 blog, Maglev announcement: https://v8.dev/blog/maglev
- V8 blog, "Land ahoy: leaving the Sea of Nodes": https://v8.dev/blog/leaving-the-sea-of-nodes
- V8 blog, "Fast properties in V8": https://v8.dev/blog/fast-properties
- V8 blog, "Elements kinds in V8": https://v8.dev/blog/elements-kinds
- V8 blog, "Pointer compression in V8": https://v8.dev/blog/pointer-compression
- Mathias Bynens & Benedikt Meurer, "JavaScript engine fundamentals: Shapes and Inline Caches": https://mathiasbynens.be/notes/shapes-ics
- Chambers, Ungar & Lee, "An Efficient Implementation of SELF" (OOPSLA 1989) — the origin of maps/hidden classes
