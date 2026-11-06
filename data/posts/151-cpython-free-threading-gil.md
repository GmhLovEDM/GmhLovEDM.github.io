---
title: "CPython Free-Threading Without the GIL: Biased Refcounting, Immortal Objects, Per-Object Locks and Extension Migration"
tag: python
description: How CPython's free-threaded build (PEP 703) removes the Global Interpreter Lock — GIL history and why it existed, biased reference counting and immortal objects, deferred and per-thread refcounting, per-object mutexes and critical sections, interaction with the specializing adaptive interpreter, when free-threaded builds win or lose, and practical migration notes for C extensions
date: "2026-11-06T10:30:00.000Z"
---

## Goal

For three decades the CPython Global Interpreter Lock (GIL) meant that only one thread at a time could execute Python bytecode in a process. That design kept the interpreter simple and made reference counting cheap, but it also made CPU-bound multi-threading a non-starter: more threads often made pure-Python loops *slower*, not faster.

PEP 703 ("Making the Global Interpreter Lock Optional in CPython") and the free-threaded build that shipped experimentally in 3.13 change that contract. A `--disable-gil` / free-threaded interpreter can run Python threads in parallel on multiple cores — at the cost of a larger object header, more careful reference counting, and new rules for C extensions.

This article focuses on the mechanisms that make free-threading workable, not on a slogan about "removing the GIL":

1. Why the GIL existed, and what it actually serialized.
2. A verified CPU-bound threading measurement on a GIL-enabled 3.13 build.
3. Biased reference counting (BRC), immortal objects, deferred and per-thread refcounting.
4. Per-object locks, critical sections, and container thread-safety.
5. How free-threading interacts with the specializing adaptive interpreter (PEP 659).
6. When free-threaded builds win, when they lose, and memory trade-offs (mimalloc, QSBR).
7. Migration notes for C extensions: `Py_mod_gil`, borrowed references, and critical-section macros.
8. A practical decision checklist for teams adopting free-threaded CPython.

Primary sources: [PEP 703](https://peps.python.org/pep-0703/), [PEP 683](https://peps.python.org/pep-0683/) (immortal objects), [PEP 659](https://peps.python.org/pep-0659/) (specializing adaptive interpreter), the official howtos [Python support for free threading](https://docs.python.org/3/howto/free-threading-python.html) and [C API Extension Support for Free Threading](https://docs.python.org/3/howto/free-threading-extensions.html), plus tracking sites such as [py-free-threading.github.io](https://py-free-threading.github.io/tracking/) and [hugovk's free-threaded wheels list](https://hugovk.github.io/free-threaded-wheels/).

## 1. Why the GIL existed

CPython's memory model is reference counting plus a cyclic garbage collector. Almost every bytecode that touches a `PyObject*` adjusts `ob_refcnt`. Under a single global lock, those increments and decrements can be ordinary non-atomic loads and stores, and C extension authors could treat "I hold the GIL" as "no other thread is mutating the interpreter".

The GIL also papered over a long list of shared structures:

- the small-integer cache and interned-string table
- type object state and method resolution bookkeeping
- import-related serialization and module dicts
- frame evaluation and the ceval loop itself
- countless extension modules that stored global C pointers with no mutex of their own

Historically this was a deliberate engineering bet. Early CPython ran on uniprocessor machines; correctness and a approachable C API mattered more than multi-core bytecode. Alternatives existed in other runtimes — Jython and IronPython had no GIL because they sat on JVMs / CLR GCs; PyPy experimented with STM — but CPython's extension ecosystem is enormous, and any GIL removal had to keep `Py_INCREF`-shaped code viable.

What the GIL did *not* do is make Python "single-threaded" at the OS level. I/O-bound programs have always released the GIL around blocking syscalls (`Py_BEGIN_ALLOW_THREADS` / `Py_END_ALLOW_THREADS`), so a web server with many waiting sockets can still benefit from threads. Native extensions that do heavy math can also release the GIL for the duration of a kernel. The pain point is **CPU-bound Python**: numerical loops, parsers, and hot business logic written in pure Python, where the interpreter never drops the lock long enough for another thread to make progress.

Two escape hatches people used for years:

| Approach | Parallelism | Cost |
|----------|-------------|------|
| `multiprocessing` | True multi-process | Pickle/IPC, memory duplication |
| Subinterpreters (PEP 684 era) | Per-interpreter GIL | Isolation limits, API maturity |
| Free-threaded build (PEP 703) | True multi-thread in one process | Refcount/header/extension work |

Free-threading is the first path that keeps shared-memory threads *and* parallel bytecode in CPython proper.

## 2. Verified: GIL-bound CPU threading on 3.13

On this machine the interpreter is a normal (GIL-enabled) CPython 3.13.5 build: `sysconfig.get_config_var("Py_GIL_DISABLED")` is `0`, and `sys._is_gil_enabled()` returns `True`. The following snippet times a pure-Python CPU loop across 1, 2 and 4 threads:

```python
import sys, sysconfig, threading, time

print(sys.version.split()[0])
print("Py_GIL_DISABLED:", sysconfig.get_config_var("Py_GIL_DISABLED"))
print("_is_gil_enabled:", sys._is_gil_enabled())

def cpu_bound(n=3_000_000):
    s = 0
    for i in range(n):
        s += i * i
    return s

def timed(n_threads):
    threads = [threading.Thread(target=cpu_bound) for _ in range(n_threads)]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return time.perf_counter() - t0

for n in (1, 2, 4):
    print(f"threads={n} elapsed={timed(n):.3f}s")
```

Observed on the box (Asia/Shanghai wall clock, GIL-enabled 3.13.5):

| Threads | Elapsed | Approx. vs 1 thread |
|--------:|--------:|--------------------:|
| 1 | 0.084 s | 1.0× |
| 2 | 0.171 s | 2.0× |
| 4 | 0.345 s | 4.1× |

Wall time scales almost linearly with thread count. That is the textbook GIL result: threads take turns on one core's worth of bytecode, and scheduling overhead makes 4 threads slightly worse than a clean 4×. A free-threaded build of the same workload is exactly where parallel speedups appear — if the work is actually parallel and not serialized on a shared Python object.

How to recognize a free-threaded interpreter when you have one:

- `python -VV` / `sys.version` contain the phrase `free-threading build`
- `sysconfig.get_config_var("Py_GIL_DISABLED") == 1`
- `sys._is_gil_enabled()` may still return `True` if the GIL was turned back on at runtime (via `PYTHON_GIL`, `-X gil`, or an unmarked extension import)

That last point matters in production: "I installed a free-threaded binary" is not the same as "the GIL is off right now".

## 3. Biased reference counting

Removing the GIL without changing refcounting would force every `Py_INCREF` / `Py_DECREF` onto atomic read-modify-write instructions. On contemporary CPUs those atomics are expensive when many cores bounce the same cache line — and hot objects (interned strings, small ints, widely shared modules) would become scalability bottlenecks.

PEP 703 adopts **biased reference counting** (BRC), a 2018 technique by Jiho Choi, Thomas Shull and Josep Torrellas. The observation: even in multi-threaded programs, most objects are touched by only one thread — usually the thread that created them.

Each object carries roughly:

```c
struct _object {
    uintptr_t ob_tid;          /* owning thread id; 0 = unowned */
    /* padding / flags ... */
    uint8_t  ob_mutex;         /* PyMutex storage */
    uint8_t  ob_gc_bits;
    uint32_t ob_ref_local;     /* local refcount + immortal/deferred flags */
    Py_ssize_t ob_ref_shared;  /* shared refcount (shifted) + BRC state */
    PyTypeObject *ob_type;
};
```

(The exact layout matches the free-threaded `PyObject` work tracked in CPython issues such as [gh-110481](https://github.com/python/cpython/issues/110481); treat field widths as illustrative of the PEP 703 design.)

The owning thread updates `ob_ref_local` with ordinary non-atomic ops. Other threads update `ob_ref_shared` with atomics. Ownership can be handed off; the slow path merges counts and may queue an object for later deallocation from the eval-breaker.

Compared with "just use an atomic `Py_ssize_t` everywhere", BRC keeps single-threaded and thread-local object traffic cheap — which is the common case — while still being correct when objects cross threads.

### Immortal objects

Some objects live for the whole process: `None`, `True`, `False`, small integers, many type objects, and (in free-threaded builds) interned strings and code constants. Touching their refcounts from every thread would create pure contention for no benefit.

PEP 683 introduced immortal objects in 3.12. The free-threaded build extends the idea: immortal objects set a sentinel in `ob_ref_local` (conceptually `UINT32_MAX`), and `Py_INCREF` / `Py_DECREF` become no-ops for them.

As of the 3.14 docs, free-threaded immortalization covers at least:

- Code constants (numeric / string / constant tuples)
- Strings passed through `sys.intern()`

Important behavioral change: in the default build, interned strings can still die when the last reference disappears; in the free-threaded build, interned strings stay alive until interpreter shutdown. That avoids refcount traffic, but it can grow memory if a program interns unbounded unique strings.

### Deferred and per-thread refcounting

Two more techniques cut cross-thread refcount traffic:

1. **Deferred reference counting** — enabled for modules, module-level functions, class methods defined in class scope, descriptors, and `threading.local` objects. Stack references from Python frames are *not* reflected in the refcount. When the internal count hits zero, the object is examined on the next GC cycle rather than freed immediately.
2. **Per-thread reference counting** — used for heap types (classes created in Python), code objects, and module `__dict__`. Each thread keeps a local count array keyed by object id; the true count is the sum. Objects tend to live longer because counts must be merged at a safe point (eval breaker) or thread exit. `gc.collect()` forces a merge.

Net effect versus the default build: objects often live longer, peak RSS is higher, and "refcount hit zero ⇒ free now" is no longer a reliable mental model for every type.

```text
Default build:     INCREF/DECREF → often free immediately at 0
Free-threaded:     local fast path | shared atomic | queued/deferred/GC
                   immortal no-ops | per-thread merge at safe points
```

## 4. Per-object locks and critical sections

Without a GIL, built-in containers still need mutual exclusion. In the free-threaded build each `PyObject` gains an `ob_mutex` (`PyMutex`). CPython's **critical section** API (`Py_BEGIN_CRITICAL_SECTION` / `Py_END_CRITICAL_SECTION`, and the two-object variant `...CRITICAL_SECTION2`) is the supported way to take that mutex.

Critical sections are not plain mutex scopes:

- Each thread keeps a stack of active critical sections.
- If acquiring a lock would block, the thread **suspends** its active critical sections (releases those mutexes), waits, then reacquires — similar in spirit to how the GIL is dropped around blocking calls.
- Nested critical sections therefore do *not* reliably hold outer locks for the whole inner section; lock at most two objects at once with `CRITICAL_SECTION2`, or restructure.
- Do **not** lock `ob_mutex` with raw `PyMutex_Lock` while also using critical sections on the same object — that can deadlock. Extension types that need their own lock should add a separate `PyMutex` field.

At the Python level, `dict`, `list` and `set` take internal locks so concurrent mutation behaves closer to the old GIL-serialized world. The docs still recommend explicit `threading.Lock` (or equivalent) for application-level invariants: internal locks protect the container's own consistency, not your higher-level protocol.

```c
/* Illustrative: lock one dict while iterating with PyDict_Next */
Py_BEGIN_CRITICAL_SECTION(dict);
PyObject *key, *value;
Py_ssize_t pos = 0;
while (PyDict_Next(dict, &pos, &key, &value)) {
    /* use key/value; still a borrowed pair — keep section short */
}
Py_END_CRITICAL_SECTION();
```

Known sharp edges from the free-threading howto:

- Do not read `frame.f_locals` for a frame running on another thread — it may crash the interpreter.
- Sharing one iterator across threads can yield duplicates or missing elements.
- Prefer strong-reference C APIs over borrowed ones when the container may mutate concurrently (`PyList_GetItemRef`, `PyDict_GetItemRef`, `PyDict_GetItemStringRef`, `PyWeakref_GetRef`, …).
- Tuples are immutable, so `PyTuple_GetItem()` remains comparatively safe; lists and dicts are the hazard.

## 5. Specializing adaptive interpreter under free-threading

PEP 659's specializing adaptive interpreter rewrites hot bytecodes into type-specialized instructions (for example, attribute loads that assume a particular object shape). Specialization depends on **stable feedback**: version tags on types, dict keys versions, and the assumption that the observed type/shape stays valid long enough to be profitable.

Under the GIL, "another thread mutated this type mid-instruction" was largely excluded by construction. Free-threading makes that assumption harder:

- Another thread can mutate a type, a class dict, or an instance shape while a specialized instruction is in flight.
- The runtime must invalidate or guard specialized code more carefully; some specializations become more conservative or require locks / version checks that the GIL previously implied for free.
- De-optimization paths matter more: a wrong speculation must be detected without data races on the feedback metadata itself.
- Single-threaded free-threaded runs therefore pay an overhead even when you never start a second thread: larger headers, atomic slow paths when ownership is wrong, mimalloc instead of pymalloc, and stricter specialization.

The official howto quotes pyperformance overhead for free-threaded versus default builds on the order of roughly **1% on macOS aarch64** to about **8% on x86-64 Linux**, workload-dependent. That is the tax you pay for the option to scale across cores.

Faster CPython work (Mark Shannon and collaborators) and the free-threading effort are therefore coupled: the same interpreter that wants aggressive specialization must also remain correct when threads race on shapes. Expect ongoing tuning of which opcodes specialize how aggressively in `--disable-gil` builds.

## 6. Memory subsystem: mimalloc, QSBR, larger headers

Free-threading does not only change refcounts. Several allocator-level choices show up as higher RSS:

1. **Larger object headers** — GC metadata moves into the normal header for non-GC objects. Docs cite `None` as 32 bytes on free-threaded AMD64 versus 16 bytes on the default build. GC-managed objects (dicts, lists) are closer in size across builds.
2. **mimalloc instead of pymalloc** — free-threaded builds allocate Python objects with mimalloc, often across multiple heaps (for example a dedicated heap for GC objects). Free space in one heap cannot satisfy allocations from another; some heaps free pages via QSBR.
3. **QSBR (quiescent-state based reclamation)** — lock-free structures (notably list internals and dict keys) defer reclaiming backing memory until threads reach quiescent states. `gc.collect()` should release QSBR-held memory, but the allocator may still not return pages to the OS immediately. `MIMALLOC_PURGE_DELAY=0` can reduce that delay at a performance cost.
4. **Longer object lifetimes** — BRC queued state, deferred refcounting, per-thread counts, and immortal interned strings all delay frees.

These are deliberate trade-offs: correctness and scalability first, then tune the allocator. Teams moving services to free-threaded builds should baseline RSS, not only wall-clock throughput.

## 7. When free-threaded builds win or lose

**Prefer free-threaded when:**

- The bottleneck is CPU-bound Python that is already decomposed into threads (or can be).
- Threads share little mutable Python state — message passing, shard-local objects, or immutable inputs.
- Extension modules you depend on declare free-threading support (`Py_MOD_GIL_NOT_USED`) and publish `t`-suffix wheels.
- You can accept higher memory use for higher wall-clock throughput on multi-core hosts.

**Prefer the default GIL build when:**

- The workload is single-threaded or dominated by one hot thread: you mostly pay the free-threading tax.
- The bottleneck is already in native code that releases the GIL (NumPy ufuncs, compression, cryptography) — threads may already overlap, and free-threading adds little.
- Critical extensions still re-enable the GIL on import (CPython warns and turns the GIL back on when an unmarked extension loads).
- Memory is tight: larger headers, immortal interned strings, deferred frees, QSBR delays, and mimalloc's multiple heaps all push RSS up.

**Concurrency model reminder:** free-threading removes the interpreter lock; it does not invent a memory model for your program. Race conditions on shared `list`/`dict` mutation, check-then-act bugs, and extension global state are still your problem — often *more* visible than under the GIL, where they were latent.

Behavioral defaults that also change in free-threaded builds (per the howto):

- `thread_inherit_context` defaults to true — new `threading.Thread`s copy the caller's contextvars `Context`
- `context_aware_warnings` defaults to true — `warnings.catch_warnings` uses a context variable instead of a process-global filter list

## 8. C extension migration notes

High-signal checklist from the C API free-threading howto:

1. **Declare support** or you will flip the GIL back on:
   - Multi-phase init: add `{Py_mod_gil, Py_MOD_GIL_NOT_USED}` (guard with `PY_VERSION_HEX >= 0x030D0000` if you support older Pythons).
   - Single-phase init: call `PyUnstable_Module_SetGIL(m, Py_MOD_GIL_NOT_USED)` under `#ifdef Py_GIL_DISABLED`.
2. **Detect the build** with `Py_GIL_DISABLED` in C, or `sysconfig.get_config_var("Py_GIL_DISABLED")` in Python.
3. **Stop relying on borrowed references** for concurrently mutable containers — switch to `*Ref` APIs; use `Py_BEGIN_CRITICAL_SECTION` around `PyDict_Next` when the dict may change.
4. **Allocate correctly:** only Python objects via the object allocator domain; raw buffers via `PyMem_Malloc`, not `PyObject_Malloc`.
5. **Keep using** `Py_BEGIN_ALLOW_THREADS` / thread-state APIs around blocking work so the cyclic GC and other threads can run even with the GIL disabled.
6. **Protect extension globals** with your own locks or thread-local storage; the GIL no longer serializes them. Caches are a frequent footgun — lock them or disable them under free-threading if they are not load-bearing.
7. **Build separate wheels** for free-threaded CPython (the `t` ABI tag, e.g. `cp314t`). Limited C API / stable ABI is not available for free-threaded builds today. `cibuildwheel` / manylinux document `python3.14t`-style tags.
8. **Add a dedicated `PyMutex`** on your types if you need locking; never drive `ob_mutex` yourself.

Multi-phase slot sketch:

```c
static struct PyModuleDef_Slot module_slots[] = {
    /* ... other slots ... */
#if PY_VERSION_HEX >= 0x030D0000
    {Py_mod_gil, Py_MOD_GIL_NOT_USED},
#endif
    {0, NULL}
};
```

Track ecosystem readiness via [py-free-threading tracking](https://py-free-threading.github.io/tracking/) and [free-threaded wheels](https://hugovk.github.io/free-threaded-wheels/). Meta, Faster CPython, and the free-threading working group posts are useful for roadmap context; always re-check the PEPs and howtos for the version you ship.

## 9. Adoption checklist

Before flipping a service to a free-threaded interpreter:

1. Confirm the binary is free-threaded *and* `sys._is_gil_enabled()` is false under your real import set.
2. Inventory native dependencies; unmarked modules silently undo the migration.
3. Re-measure CPU-bound paths with 1 vs N threads; also re-measure single-thread latency.
4. Watch RSS and allocator env tunables (`MIMALLOC_PURGE_DELAY`) under production-like churn.
5. Audit shared mutable Python containers; add explicit locks where invariants matter.
6. For extensions you own: declare `Py_mod_gil`, replace borrowed-reference hot paths, add critical sections where needed, ship `t` wheels.
7. Keep a GIL-enabled build in CI so regressions that only appear under free-threading are visible as differentials — without relying on the GIL as a correctness crutch in application code.

## Practical takeaways

- The GIL was a productivity feature for the interpreter and the C API; free-threading replaces that global lock with biased refcounting, immortal / deferred / per-thread count schemes, and per-object critical sections.
- On a GIL-enabled 3.13.5 build, a pure-Python CPU loop showed ~1× / ~2× / ~4× wall time for 1 / 2 / 4 threads — the problem free-threading targets.
- Single-threaded overhead (a few percent on pyperformance, higher on some x86-64 Linux setups) and higher memory use are real; free-threading is not a free lunch.
- Python-level thread safety of builtins is improved with internal locks, but application invariants still need explicit synchronization.
- Extension authors must opt in (`Py_mod_gil`), purge unsafe borrowed-reference patterns, and ship `t`-tagged artifacts.
- Choose free-threaded builds for parallel CPU-bound Python with a ready dependency stack; keep the default build when single-thread latency, memory, or unmarked native modules dominate.

Free-threading turns "threads don't help CPU-bound Python" from a law into an engineering choice — one that rewards programs designed for parallel ownership of objects, and punishes programs that treated the GIL as their only lock.
