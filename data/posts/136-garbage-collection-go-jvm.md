---
title: "Inside Garbage Collectors: Tri-Color Marking, Write Barriers, and How Go and the JVM Choose Different Trade-offs"
tag: performance
description: How modern tracing garbage collectors actually work — reachability, mark-sweep vs copying vs compacting, the tri-color abstraction and its invariants, Dijkstra and Yuasa write barriers, Go's hybrid barrier, pacer, GOGC and GOMEMLIMIT, the JVM's G1 and ZGC with remembered sets, SATB and colored pointers, escape analysis, and a practical guide to diagnosing and tuning GC in production
date: "2026-10-22T11:10:00.000Z"
---

## Goal

"The GC is slow" is one of the most common and least precise complaints in backend engineering. Sometimes it means long pauses, sometimes it means a quarter of the CPU spent marking, sometimes it means a container killed for exceeding its memory limit. These are different problems with different fixes, and you cannot tell them apart without a working model of what a collector does.

This article builds that model from the ground up. It starts with the basic algorithms (reference counting, mark-sweep, copying, compaction), then explains the tri-color abstraction that makes *concurrent* collection possible and the write barriers that keep it correct while your program keeps mutating the heap. With that foundation it walks through two production designs that made very different choices — Go's non-moving concurrent collector and the JVM's region-based G1 and ZGC — and ends with a practical guide to measuring and tuning GC behaviour in real services.

## What a Collector Has to Decide

An object is *live* if the program can still reach it. Reachability starts from a set of **roots** — global variables, thread stacks, CPU registers — and follows pointers. Everything not reachable from a root is garbage. Every collector design is an answer to four questions:

1. **How do we find garbage?** By counting references, or by tracing from roots.
2. **What do we do with free space?** Leave objects in place and track holes (sweep), or move live objects together (copy / compact).
3. **When does the program stop?** All the time the collector runs (stop-the-world), only briefly (concurrent), or in small steps (incremental).
4. **Do we treat objects differently by age?** Generational or not.

The three quantities you are always trading are **throughput** (share of CPU left for your code), **latency** (how long and how often the program is paused) and **memory footprint** (how much extra heap the collector needs to work efficiently). No design wins on all three; this is sometimes called the GC "impossible triangle".

## The Basic Algorithms

### Reference counting

Each object carries a counter; every pointer copy increments it, every overwrite decrements it, and an object is freed when it reaches zero. CPython, Swift (ARC), Objective-C and Rust's `Rc`/`Arc` work this way.

The benefits are immediacy and predictability: memory comes back the moment the last reference disappears, with no global pause. The costs are a counter update on every pointer write (atomic in multithreaded code, which is expensive), and **cycles**: two objects pointing at each other never reach zero. CPython solves this with an additional cycle-detecting collector; Swift asks you to break cycles yourself with `weak`/`unowned`.

### Mark-sweep

A tracing collector does nothing on pointer writes. When it runs, it **marks** every object reachable from the roots, then **sweeps** the heap and returns unmarked objects to the free lists. Objects never move, so pointers stay valid and interop with C is easy. The downside is **fragmentation**: after many cycles the free space is scattered in holes, and allocation has to search size-segregated free lists rather than just bump a pointer.

### Copying and compacting

A copying collector splits memory into two halves, traces live objects from "from-space" and copies them contiguously into "to-space", then discards from-space wholesale. Allocation becomes a pointer bump, the cost is proportional to **live** data rather than heap size, and fragmentation disappears. The price is moving objects — every pointer to a moved object must be updated — and, in the naive version, half the memory sitting idle. Mark-compact achieves the same tidiness in place, at the cost of more passes over the heap.

### Generations

The **weak generational hypothesis** says most objects die young. A generational collector exploits this by allocating into a small young generation and collecting it frequently with a copying collector: since most of it is dead, copying the few survivors is cheap. Objects that survive several young collections are promoted to an old generation that is collected rarely.

The catch is pointers from old objects to young ones. A young collection must treat them as roots, but scanning the whole old generation to find them would defeat the purpose. So the runtime installs a **write barrier** that records old-to-young pointer stores in a **card table** or **remembered set**. Write barriers are the recurring theme of this article.

## Concurrent Marking and the Tri-Color Abstraction

Stopping the world to trace a 30 GB heap takes seconds. To avoid that, modern collectors mark **concurrently** while application threads (the *mutators*, in GC literature) keep running. To reason about correctness, Dijkstra et al. introduced the tri-color abstraction in 1978:

- **White**: not yet visited. At the end of marking, white objects are garbage.
- **Grey**: known reachable, but its outgoing pointers have not been scanned yet. The grey set is the work queue.
- **Black**: reachable and fully scanned.

Marking starts by greying the roots, then repeatedly takes a grey object, greys its white children, and blackens it, until no grey objects remain.

```go
// A toy tri-color marker, stop-the-world version.
type Object struct {
    marked bool
    refs   []*Object
}

func mark(roots []*Object) {
    grey := append([]*Object(nil), roots...)
    for _, r := range roots {
        r.marked = true
    }
    for len(grey) > 0 {
        obj := grey[len(grey)-1]
        grey = grey[:len(grey)-1]       // obj becomes black
        for _, child := range obj.refs {
            if child != nil && !child.marked {
                child.marked = true      // white -> grey
                grey = append(grey, child)
            }
        }
    }
}
```

### How concurrency breaks it

Now let the mutator run during marking. An object is wrongly freed if and only if **both** of these happen:

1. The mutator stores a pointer to a white object into a black object (black objects are never rescanned, so the collector will not see it).
2. Every other path from a grey object to that white object is destroyed.

Concretely: black `A` has been scanned; grey `B` points to white `C`. The mutator executes `A.f = C` then `B.g = nil`. Now `C` is reachable only through `A`, which the collector considers done. `C` stays white and gets swept — a use-after-free in a memory-safe language.

This gives two invariants, each of which is enough for correctness:

- **Strong tri-color invariant**: no black object ever points to a white object.
- **Weak tri-color invariant**: any white object pointed to by a black object is also reachable from some grey object through a chain of white objects.

### Write barriers

A write barrier is a small piece of code the compiler emits around pointer stores while marking is active. The two classic designs break one of the two conditions above:

```text
// Dijkstra insertion barrier (1978): keeps the strong invariant.
writePointer(slot, ptr):
    shade(ptr)          // the new target can never stay white behind a black object
    *slot = ptr

// Yuasa deletion barrier (1990): "snapshot at the beginning".
writePointer(slot, ptr):
    shade(*slot)        // the old target is preserved, so no path is ever lost
    *slot = ptr
```

`shade` means "if white, make it grey". The Dijkstra barrier is precise — it only retains what is actually reachable — but because stacks are usually not instrumented (a barrier on every local variable write would be far too slow), stacks can turn "black" while pointing at white objects, so the collector must **rescan stacks** with the world stopped at the end of marking. The Yuasa barrier conserves everything that was reachable when marking began (the snapshot), needs no rescan, but retains more floating garbage: objects that die during the cycle survive until the next one.

There is also a symmetric concept for moving collectors: a **read barrier** (or load barrier), which runs on pointer *loads* so the mutator never observes a stale address of an object that has been relocated. We will see it in ZGC.

## Go: Concurrent, Non-Moving, Latency First

Go's collector is a concurrent tri-color mark-sweep collector. It is **non-generational** and **non-moving** (no compaction). Those choices look surprising until you see the rest of the language: Go has value types, interior pointers, and an escape-analysing compiler that keeps many short-lived values on the stack, so the young-object pressure that motivates generational GC is much lower than in Java. Not moving objects also keeps cgo interop and the runtime simpler.

### The cycle

A Go GC cycle has four phases:

1. **Sweep termination** (short stop-the-world): finish any remaining sweeping, then enable the write barrier.
2. **Concurrent mark**: background workers take about 25% of `GOMAXPROCS` to scan roots and the heap. Goroutines that allocate while marking is in progress are enlisted into **mark assists** — they must do marking work proportional to what they allocate, which stops a fast allocator from outrunning the collector.
3. **Mark termination** (short stop-the-world): drain remaining work, disable the write barrier.
4. **Concurrent sweep**: spans are swept lazily, in the background and when allocation needs space.

### The hybrid write barrier

Before Go 1.8, Go used a Dijkstra-style barrier and paid for the stack rescan at mark termination; programs with many goroutines saw pauses of tens of milliseconds. Proposal 17503 (Austin Clements and Rick Hudson) introduced a **hybrid barrier** combining Yuasa and Dijkstra:

```text
writePointer(slot, ptr):
    shade(*slot)                     // Yuasa: protect the deleted reference
    if current stack is grey:
        shade(ptr)                   // Dijkstra: protect the inserted reference
    *slot = ptr
```

Combined with scanning each goroutine stack once and blackening it, this eliminated the stack rescan, and typical stop-the-world pauses dropped well below a millisecond. (The implementation shades both pointers unconditionally, since tracking stack colour is more expensive than the extra shading.)

### When does a cycle start? GOGC, the pacer and GOMEMLIMIT

Go has essentially two knobs.

**GOGC** (default `100`) sets the target heap growth: the next cycle should finish when the heap reaches `live heap + (live heap + GC roots) × GOGC/100`. With 1 GB of live data and the default, the collector aims to complete by about 2 GB. Doubling `GOGC` roughly halves GC CPU cost in exchange for more memory; this is the throughput–footprint trade in its purest form. Since Go 1.18 the pacer also counts goroutine stacks and globals as part of the work.

The **pacer** decides when to *start* marking so that it finishes right at the target, using feedback from previous cycles about how fast the mutator allocates and how fast marking proceeds.

**GOMEMLIMIT** (Go 1.19+) is a soft memory limit. As total runtime memory approaches it, the collector runs more often regardless of `GOGC`. This fixes the classic container problem: with only `GOGC`, a heap spike could double memory and get the process OOM-killed. A common production setup is:

```bash
# Let the heap use most of the container, collect rarely while there is room,
# and only work hard when approaching the limit.
GOMEMLIMIT=3600MiB GOGC=200 ./server        # in a 4 GiB container
# or, if the service is memory-bound by design:
GOMEMLIMIT=3600MiB GOGC=off ./server
```

`GOGC=off` with a limit is powerful but sharp: if the live heap itself grows close to the limit, the runtime will collect continuously — a **death spiral** of GC CPU. The runtime caps GC CPU at roughly 50% under the memory limit to keep the program making progress, but you should still leave headroom and alert on it.

Before `GOMEMLIMIT` existed, teams used tricks: Twitch described a "memory ballast" — a large unused allocation that inflated the heap target so GC ran less often — and Uber described tuning `GOGC` dynamically per service. Both workarounds are mostly obsolete now.

Another historical gotcha: the runtime forces a GC at least every two minutes even if the heap has not grown. Discord's 2020 post on moving its "Read States" service from Go to Rust attributed its periodic latency spikes to exactly this, combined with a very large, mostly-static LRU cache that each forced cycle had to scan.

### Green Tea: making marking memory-friendly

Classic graph marking jumps from object to object across the whole heap, which is terrible for CPU caches and memory bandwidth. Go's **Green Tea** collector, an experiment in Go 1.25 and enabled by default in Go 1.26, changes the unit of work from individual objects to whole memory pages (spans of small objects): it accumulates marking work per span and scans spans in batches, getting much better locality. The Go team reported a 10–40% reduction in GC overhead for GC-heavy programs, with larger gains possible as it starts to use vector instructions. It is a good illustration that on modern hardware, memory access patterns often matter more than algorithmic complexity.

### Escape analysis: the cheapest garbage is the one never created

The Go compiler decides whether each value can live on the stack (freed for free when the function returns) or must "escape" to the heap. You can ask it:

```go
package main

type Point struct{ X, Y int }

func sum(p Point) int  { return p.X + p.Y }  // value: stays on the stack
func newPoint() *Point { return &Point{1, 2} } // pointer outlives the frame: escapes

func main() {
    _ = sum(Point{1, 2})
    _ = newPoint()
}
```

```bash
$ go build -gcflags=-m .
./main.go:6:25: &Point{...} escapes to heap
```

Common causes of escape are returning pointers, storing values in interfaces (`fmt.Println(x)` boxes `x`), closures capturing variables, and slices whose size is not known at compile time. Reducing allocations — via `sync.Pool` for big reusable buffers, pre-sizing slices and maps, avoiding interface boxing on hot paths — usually beats any GC flag.

## The JVM: Generational, Moving, and Configurable

The HotSpot JVM went the other way: object-heavy Java code (historically no value types, everything boxed into heap objects) fits the generational hypothesis very well, and a moving collector gets fast bump-pointer allocation and no fragmentation. HotSpot ships several collectors; the main ones are:

| Collector | Model | Pauses | Best for |
| --- | --- | --- | --- |
| Serial | single-threaded, generational, STW | long | small heaps, single-core containers |
| Parallel | multi-threaded, generational, STW | long, but efficient | batch jobs, maximum throughput |
| G1 | region-based, generational, mostly concurrent | target-based (default target 200 ms) | general-purpose default since JDK 9 |
| ZGC | concurrent, region-based, compacting, generational since JDK 21 | typically under 1 ms | large heaps, latency-sensitive services |
| Shenandoah | concurrent compacting (in OpenJDK builds, not all vendors) | low | similar to ZGC |

### G1: regions, remembered sets and pause targets

G1 (Garbage-First, default since JDK 9 via JEP 248) splits the heap into equal-sized **regions** (1–32 MB) that are dynamically labelled eden, survivor, old or humongous. Young collections evacuate (copy) live objects out of eden and survivor regions in a stop-the-world pause. Old-generation marking runs concurrently using an **SATB** (snapshot-at-the-beginning) barrier — the Yuasa design from above. After marking, **mixed collections** evacuate young regions plus the old regions with the most garbage: "garbage first".

The key to G1's pause control is that it can pick *how many* regions to evacuate in a pause to meet `-XX:MaxGCPauseMillis`. To evacuate a region without scanning the whole heap, each region keeps a **remembered set** of incoming cross-region pointers, maintained by a post-write barrier that dirties cards. So a G1 pointer store carries two barriers: the SATB pre-barrier during marking and the card-marking post-barrier always. That barrier and remembered-set bookkeeping is part of the throughput cost of low pauses.

### ZGC: colored pointers and load barriers

ZGC aims for pauses that do not grow with heap or live-set size. It marks **and relocates** concurrently, which means the application may load a pointer to an object that is being moved. ZGC handles this with **colored pointers** — metadata bits stored inside the 64-bit pointer — and a **load barrier** on every reference load:

```text
// Conceptual ZGC load barrier
ref = *field
if ref has a "bad" color for the current phase:     // fast path: one bit check + branch
    ref = slow_path(ref)        // mark it, or find / perform relocation
    *field = ref                // self-heal so the next load is fast
use(ref)
```

Because the barrier heals the field, each stale pointer pays the slow path at most once per phase. Stop-the-world pauses only handle roots and phase transitions, and are typically well under a millisecond on heaps from a few hundred megabytes up to multiple terabytes. ZGC became production-ready in JDK 15 (JEP 377); **Generational ZGC** arrived in JDK 21 (JEP 439), became the default ZGC mode in JDK 23 (JEP 474), and the non-generational mode was removed in JDK 24 (JEP 490). Adding generations was mainly about throughput and memory: the original single-generation ZGC needed significant headroom to keep up with high allocation rates.

The cost profile is the mirror image of G1: almost no pauses, but a barrier on loads (which are far more frequent than stores), more concurrent GC threads competing for CPU, and somewhat lower raw throughput.

## Go vs JVM: The Same Problem, Different Bets

| Aspect | Go | JVM (G1 / ZGC) |
| --- | --- | --- |
| Generational | no | yes (ZGC since JDK 21) |
| Moves objects | no | yes (evacuation / concurrent relocation) |
| Barrier | hybrid write barrier, only during marking | G1: SATB pre-write + card post-write; ZGC: load barrier |
| Allocation | size-class free lists, per-P caches (`mcache`) | thread-local bump-pointer buffers (TLABs) |
| Fragmentation | possible, mitigated by size classes | eliminated by compaction |
| Tuning surface | `GOGC`, `GOMEMLIMIT` | dozens of flags; heap size and collector choice matter most |
| Typical pause | sub-millisecond | G1: tens to hundreds of ms target; ZGC: sub-millisecond |
| Philosophy | few knobs, stable latency, rely on escape analysis | choose a collector to match the workload |

Neither is "better". Go bets that its compiler and value types keep allocation rates low enough that a simple, non-moving collector is sufficient, and buys simplicity and predictability. The JVM bets on sophisticated runtime machinery to make heavy allocation cheap, and gives operators control. Both converged on the same insight: pauses are mostly solved; the remaining frontier is **CPU and memory overhead**, which is why Go invested in Green Tea and Java in generational ZGC.

## Diagnosing GC in Production

Start by naming the symptom, because each has a different fix.

**1. Too much CPU in GC.** In Go, run with `GODEBUG=gctrace=1`:

```text
gc 42 @12.031s 6%: 0.021+3.4+0.030 ms clock, 0.17+1.2/6.6/12+0.24 ms cpu, 412->420->205 MB, 418 MB goal, 0 MB stacks, 0 MB globals, 8 P
```

The `6%` is cumulative GC CPU share since start; `412->420->205 MB` is heap at start, heap at end and live heap after marking; the three clock numbers are STW sweep termination, concurrent mark and STW mark termination. A high percentage with a stable live heap means the collector runs too often: raise `GOGC` if memory allows, or (better) cut allocations. Find them with `go tool pprof -alloc_space http://host/debug/pprof/heap`.

For Java, enable unified GC logging:

```bash
java -Xlog:gc*:file=gc.log:time,uptime,level,tags -XX:+UseG1GC -Xms8g -Xmx8g -jar app.jar
```

and look at the share of time in pauses and the concurrent-cycle frequency. If you see frequent full GCs or "to-space exhausted" in G1, the heap is too small for the allocation rate or the live set.

**2. Latency spikes.** Correlate p99 latency with GC events. In Go, sub-millisecond STW is rarely the cause; look instead at **mark assists**, which slow down allocating goroutines during a cycle (visible in `go tool trace`), and at scheduling interference from GC workers. In Java on G1, long young pauses usually mean too many survivors being copied or large remembered sets; consider ZGC if pauses dominate the latency budget and you can spare CPU.

**3. Memory growth or OOM kills.** Distinguish a growing **live heap** (a leak: caches without bounds, goroutine leaks holding references, listeners never removed) from a large **heap goal** (normal behaviour for the configured `GOGC`). In containers, always set `GOMEMLIMIT` or, for Java, an explicit `-Xmx` / `-XX:MaxRAMPercentage`, below the cgroup limit to leave room for non-heap memory (goroutine stacks, metaspace, thread stacks, direct buffers, cgo allocations).

**4. Large, long-lived caches.** A tracing collector must scan every pointer in live data on every cycle. A multi-gigabyte map of pointer-rich values makes each mark expensive. Options: store values without pointers (Go does not scan pointer-free spans — `map[uint64][32]byte` costs far less to mark than `map[string]*Item`), move the data off-heap (`mmap`, Java's `ByteBuffer.allocateDirect` or the FFM API), or use an external cache.

## Summary

Every garbage collector is a negotiated settlement between throughput, latency and memory. Tracing from roots finds garbage; concurrent tracing is made safe by the tri-color invariants and the write or load barriers that enforce them; generations and compaction buy cheap allocation at the cost of moving objects and maintaining remembered sets. Go chose a non-moving, non-generational collector with a hybrid write barrier and two simple knobs, relying on escape analysis to keep garbage low; the JVM chose generational, moving collectors and lets you pick between G1's balanced pause targets and ZGC's near-pauseless concurrent relocation. In practice, the biggest wins rarely come from flags: they come from allocating less, sizing memory limits correctly for containers, and measuring with `gctrace`, pprof and GC logs before changing anything.

## References

- E. W. Dijkstra, L. Lamport, A. J. Martin, C. S. Scholten, E. F. M. Steffens, "On-the-fly garbage collection: an exercise in cooperation", *Communications of the ACM* (1978)
- T. Yuasa, "Real-time garbage collection on general-purpose machines", *Journal of Systems and Software* (1990)
- Richard Jones, Antony Hosking, Eliot Moss, *The Garbage Collection Handbook*, 2nd edition (2023)
- Austin Clements, Rick Hudson, [Proposal: Eliminate STW stack re-scanning](https://github.com/golang/proposal/blob/master/design/17503-eliminate-rescan.md) (Go issue 17503)
- [A Guide to the Go Garbage Collector](https://go.dev/doc/gc-guide) — official documentation for GOGC, GOMEMLIMIT and gctrace
- Go Blog, [The Green Tea Garbage Collector](https://go.dev/blog/greenteagc) (2025)
- Rick Hudson, [Getting to Go: The Journey of Go's Garbage Collector](https://go.dev/blog/ismmkeynote) (ISMM 2018 keynote)
- [JEP 248: Make G1 the Default Garbage Collector](https://openjdk.org/jeps/248), [JEP 377: ZGC: A Scalable Low-Latency Garbage Collector (Production)](https://openjdk.org/jeps/377), [JEP 439: Generational ZGC](https://openjdk.org/jeps/439), [JEP 474: ZGC: Generational Mode by Default](https://openjdk.org/jeps/474), [JEP 490: ZGC: Remove the Non-Generational Mode](https://openjdk.org/jeps/490)
- Oracle, [HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/)
- Discord Engineering, [Why Discord is switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust) (2020)
- Twitch Engineering, [Go memory ballast: How I learnt to stop worrying and love the heap](https://blog.twitch.tv/en/2019/04/10/go-memory-ballast-how-i-learnt-to-stop-worrying-and-love-the-heap/) (2019)
