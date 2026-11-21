---
title: "深入 Swiss Table：控制字节、SIMD 查找，以及 Go 与 Rust 如何重写哈希表"
tag: performance
description: 现代开放寻址哈希表如何在保持高密度的同时只用很少几次探测完成查找——Swiss Table 把 64 位哈希拆成 H1 与 7 位 H2 标签，用控制字节让 SIMD 或可移植的位运算一次扫描整组槽位，二次探测与墓碑，Abseil 与 Go 采用的 7/8 负载因子，扁平存储与节点存储以及指针稳定性，Rust 的 HashMap 与 Go 1.24 内置 map 如何采纳这一设计、以及 Go 为什么要把一张 map 拆成多张最多 1024 个条目的表，再加上一个可运行模型，统计链式、线性探测与 Swiss Table 的探测步数和键比较次数
date: "2026-11-21T13:50:00.000Z"
---

## 目标

哈希表看起来像一个已经做完的题目。把键做哈希，落到某个桶里，取出值。各语言里已经放了几十年：`std::unordered_map`、Java 的 `HashMap`、Python 的 `dict`、Go 的内置 `map`、Rust 的 `HashMap`。人们很容易把它的实现当成一件不再需要关心的商品。

它并没有做完。2017 年，Google 的 Sam Benzaquen、Alkis Evlogimenos、Matt Kulukundis 和 Roman Perepelitsa 提出了一种新的开放寻址设计，后来在 Abseil 里开源，成为 **Swiss Table** 家族——`absl::flat_hash_map`、`absl::flat_hash_set`，以及它们的节点版。Rust 标准库的 `HashMap` 是这一设计的移植（经由 [hashbrown](https://github.com/rust-lang/hashbrown)）。Go 1.24 则用 Swiss Table 实现替换了运行时的内置 map，并且默认启用。

真正有意思的不是又一个哈希函数。而是一张表可以很密——Abseil 与 Go 都在 **7/8** 的负载因子时才扩容——却不必走很长的探测链，也不必在每一步都比较键。办法是一组与槽位等长的 **控制字节**、一个叫 **H2** 的 7 位指纹，以及一次匹配整组槽位的操作：有 SIMD 时只要几条指令，没有 SIMD 时也能用可移植的位运算完成，只是更慢。

本文会讲到：

1. 为什么链式与普通线性探测会在表变满时开始吃亏。
2. Swiss Table 如何把 64 位哈希拆成 H1 与 H2，以及每个控制字节记录什么。
3. 如何一次匹配整组槽位，以及为什么结束探测的是空槽，而不是墓碑。
4. 二次探测、删除，以及 7/8 的负载上限。
5. 扁平存储与节点存储，以及指针稳定性上的取舍。
6. Rust 与 Go 实际发布了什么，包括 Go 必须额外解决的两个问题：增量扩容，以及允许在遍历时修改的语义。
7. 什么时候 Swiss Table 不是合适的默认选择，以及它和 Python、Java 的映射表是什么关系。
8. 一个可运行模型：统计链式、线性探测和 8 槽 Swiss Table 的探测步数与键比较次数。

## 1. 解决冲突的两种经典办法

哈希函数把键映射成整数。表的槽位是有限的，所以许多键会落到同一个槽。两种经典答案是 **链式（chaining）** 和 **开放寻址（open addressing）**。

在链式表里，每个槽是一条链表的头（Java `HashMap` 的某些桶在链足够长时会改成树）。查找先对键做哈希，再沿着这个桶走，比较键，直到命中或走到尽头。插入很直接，删除会缩短链表，指向某个节点的指针在该条目被移除之前一直有效。代价在别处：每个节点都是一次单独分配，一次查找是一次指针追逐。负载接近 1.0 时，你并不会扫完整张表，但你会在堆上跳来跳去，而且每个节点的头部开销，即便键很小也得付。

在开放寻址表里，所有条目住在同一块后备数组中。若首选槽已被占用，**探测序列**会给出下一个槽，再下一个，直到找到空槽。最早也最简单的序列是 **线性探测**：先试 `hash(key) mod n`，然后是下一个槽，再下一个，到末尾再绕回来。1954 年，Gene Amdahl、Elaine McGraw 和 Arthur Samuel 在 IBM 701 上用过这种方案；W. Wesley Peterson 在 1957 年把它形式化。Michael Pratt 介绍 Go 1.24 map 的 [这篇博客](https://go.dev/blog/swisstable)，正是用一张很小的线性探测表把这件事讲清楚的。

线性探测对缓存友好：探测走的是相邻槽位。表一挤，它就不友好了。被占用的槽会连成一段连续的 run，散列进这段 run 的新键必须走到末端。这就是 **一次聚集（primary clustering）**。因此大多数实现会设一个最大负载因子，并在 run 长到不可接受之前扩容——Go 的博文把它概括为通常在 70% 到 90% 之间。另一个麻烦是删除。你不能只把槽标成空：之后的查找可能会过早停下，错过一个曾经越过此槽继续探测的键。常见做法是打上 **墓碑（tombstone，即 deleted）**，查找看到它不会停。墓碑让探测序列仍然正确，也让探测序列继续偏长。

于是开放寻址同时想要两件互相拉扯的事：更高的负载因子，好让数组更小；以及更短的探测，好让一次查找既不必扫过很长的 run，也不必对途经的每个键都调用 `==`。

## 2. 控制字节，H1 与 H2

Swiss Table 仍然是开放寻址。后备存储仍然是一块密集的槽位数组。差别在于第二块同样密集的 **控制字节** 数组——每个槽一字节元数据——以及对哈希的拆分。

Abseil 的 [设计说明](https://abseil.io/about/design/swisstables) 从 64 位哈希出发，把它切成两段：

- **H1** 是高 57 位，用来选择探测序列的起点。
- **H2** 是低 7 位。若该槽已满，这 7 位就写进它的控制字节。

Go 运行时使用同样的拆分。在 [`internal/runtime/maps`](https://github.com/golang/go/blob/master/src/internal/runtime/maps/group.go) 里，控制字节有三种位型：

| 状态 | 位型 | 含义 |
| --- | --- | --- |
| empty | `0b10000000` | 没有键；查找可以在这里停止 |
| deleted | `0b11111110` | 墓碑；探测继续 |
| full | `0b0hhhhhhh` | 已占用；低 7 位是 H2 |

开关是最高位。满槽把这一位清掉，于是 H2 是 0–127 的 7 位值。空槽和已删除槽把这一位置上，再用其余位区分这两种特殊状态。Abseil 的 `raw_hash_set.h` 描述了同一件事，并额外放了一个供迭代器识别表尾的哨兵字节，以及一小段克隆出来的控制字节前缀，好让靠近数组末尾的整组加载仍然读到合法元数据。

这些控制字节是挤在一起的，并不和键交错存放。一行缓存里的元数据可以描述许多个槽。实现在碰键之前，就已经能回答：「这个槽还值得拿来比较吗？」

## 3. 一次匹配整组槽位

槽位不是一个一个探测的，而是分组的。

Abseil 公开的匹配路径在 x86 上使用 SSE：把 16 个控制字节放进 128 位寄存器，与广播后的 H2 比较，用几条指令得到一张 16 位的候选掩码。设计说明里的核心代码是：

```
Mask Match(h2_t hash) const {
  auto match = _mm_set1_epi8(hash);
  return Mask(_mm_movemask_epi8(_mm_cmpeq_epi8(match, metadata)));
}
```

Go 1.24 用的是 **8 个槽一组** 和 64 位控制字，不是 16。这个选择让可移植实现可以落在单个整数上：把控制字与 8 份 H2 做异或，再用减法与掩码，把每个匹配的字节变成置位。在 amd64 上，同一个函数是用 8 字节 SIMD 实现的内建指令。[Go 的博文](https://go.dev/blog/swisstable) 写得很清楚：16 字节 SIMD、从而 16 槽一组，是后续工作——大多数 SIMD 单元已经能做 16 字节比较，更宽的组可以减少一次探测需要访问的组数。

于是一次查找是这样的：

1. 计算 `hash(key)`，拆出 H1 与 H2。
2. 用 H1 选出第一组。
3. 把该组的控制字与 H2 比较。只有控制字节等于 H2 的槽才是候选；其余全部跳过——空的、已删除的，或 H2 不同的满槽。
4. 对每个候选，再比较真正的键。7 位标签仍有 1/128 的碰撞概率，所以 H2 是过滤器，不是证明。
5. 若一组里出现了 **空槽**，且没有候选命中，则键不在表中：插入本来就会停在这个空槽，探测序列不会再往前走。
6. 若一组里全是满槽和已删除槽，就沿探测序列走到下一组。

收益并不是比较变成了免费。而是在线性探测里本来要比对的那些槽，绝大多数被一次并行的字节比较挡下来了；而且访问一组，就等于一次走了 8（或 16）步探测。Abseil 的源码注释给过一个剩余量：即便在高负载下，一次成功查找在找到目标之前需要审视的「错误」对象通常少于 32，因此期望的误 `==` 次数低于 `32/128`，也就是每次成功查找不到八分之一次比较。第 8 节的模型落在同一量级。

已删除槽不是空槽。它不会匹配某个满键的 H2，也不会结束探测。这与线性探测的墓碑规则相同，只是粒度变成了一组。

## 4. 探测、删除，以及 7/8 的负载

在一组之内，每个槽的资格相同。在组与组之间，Abseil 使用 **二次探测（quadratic probing）**：在组数为 2 的幂时，第 i 步走三角形步伐 `group = (H1 + i(i+1)/2) mod G`，每个组恰好访问一次。步长依赖于组数，所以一张按倍增扩容的表不能继续使用旧的探测位置。这一点到 Go 时会变得很重要。

插入是「先查找，再放进去」。若键已存在，就更新原槽。若不存在，就沿探测序列复用第一个 **空的或已删除的** 槽，并把控制字节写成 H2。若已经超过负载上限，会先扩容。

对大于一组的表，这个上限是 **7/8**。Abseil 在 [容器指南](https://abseil.io/docs/cpp/guides/container) 里写明最大负载为 87.5%，之后表会倍增；`raw_hash_set.h` 里也是这个数。Go 的 `maxAvgGroupLoad = 7` 是同一个分数，并注释说 Abseil 的 16 槽组在这个负载下仍有两个空槽，而 8 槽组只剩一个。更小的表可以更密：Abseil 允许单组完全填满。

删除会写下墓碑，除非实现能证明之后的探测本来就会停在这一组。Abseil 文档中的启发式是：若该组已经有空槽，被删的槽可以直接标成 empty 而不是 deleted，因为查找从不会越过一个已经有空槽的组。下面的模型采用了这条规则，这也是为什么在同样的删除之后，Swiss Table 积累的墓碑比逐槽线性探测表更少。

墓碑仍然占着计入负载上限的空间，一长串墓碑仍然会迫使探测继续走。当活着的键重新装得下时，把它们 rehash 进一块干净的数组，是清掉墓碑的办法。靠倍增扩容的哈希表会在扩容路径上顺便完成这次清理；尺寸稳定、却在不断插入删除的表，则可能需要显式 rehash 或收缩。

## 5. 扁平表、节点表，以及指针稳定性

控制字节只是存储故事的一半。另一半是键和值住在哪里。

**扁平（flat）** 表——`absl::flat_hash_map`、Rust 的 `HashMap`、Go map 组里的槽——把 `value_type` 直接放在槽数组里。查找已经从控制字里挑出候选之后，可以在同一块对缓存友好的数组里比较键。每个条目不必再在堆上分配。代价是移动：rehash 会复制每一个条目，而 Abseil 的扁平表在这时会使指向元素的迭代器、引用和指针全部失效。如果你取过某个值的地址并把它存起来，下一次导致扩容的插入就会留给你一个悬空指针。

**节点（node）** 表——`absl::node_hash_map`，以及 `std::unordered_map` 的常见实现——为每个条目单独分配一个节点，表里只保留指针。键和值的地址保持稳定。空槽很便宜（一个指针外加一个控制字节）。较大的、或不可移动的对象也更自然。代价是你刚刚重新引入的那次间接访问，以及每次插入的一次堆分配。

Abseil 的建议是默认使用 `absl::flat_hash_map`；当真需要值的指针稳定性时，用 `absl::flat_hash_map<Key, std::unique_ptr<T>>`，而不是习惯性地改用节点表。节点形式的存在，是为了从 `std::unordered_map` 迁移，以及那种键和值的地址都不能动的少见情形。

用 Swiss Table 替换链式表时，还有两处 API 差异会立刻露出来。遍历顺序既不是插入顺序，也不是键的稳定函数：Abseil 的容器指南提醒过，从 `std::unordered_map` 迁过来可能揭开原先隐藏的顺序依赖。另外，异构查找——例如对键类型为 `std::string` 的表用 `string_view` 做 `find`——是 Abseil 表和 Rust `HashMap` 的一等能力，查找不必为此构造一个临时键。

## 6. Rust 发布了什么，Go 又补上了什么

Rust 的 [`std::collections::HashMap`](https://doc.rust-lang.org/std/collections/struct.HashMap.html) 被文档写成「用二次探测和 SIMD 查找实现」的哈希表，并且是 Google Swiss Table 的 Rust 移植。默认哈希器目前是随机播种的 SipHash 1-3，用来抵抗 HashDoS；在键已经可信、哈希又是热点时，可以按表替换。键必须具有一致的 `Eq` 与 `Hash`。rehash 仍然会移动条目，因此与 Abseil 扁平表相同的指针稳定性警告在这里同样适用。

Go 的问题比「把 C++ 的表移植过来」更大。这门语言里的内置 `map` 已有两个 Abseil 并不提供的性质。

第一件是 **增量扩容**。单独一张 Swiss Table，和 Abseil 的一样，是一次扩完的：探测序列依赖于组数，表倍增时所有条目都要复制到新数组。若一张 map 装着 1GB 的条目，一次插入就要复制 1GB。Go 常用于对延迟敏感的服务，旧 map 已经做了增量扩容，好让单次插入不会有无上界的停顿。1.24 的 map 用另一层间接保持这个上界：每张 Go map 是一组互相独立的 Swiss Table，由哈希的高位选择——这是可扩展哈希（extendible hashing）的一种。单张表最多存放 1024 个条目。这张表满了就一分为二，最多复制 1024 个条目，其他表不受影响。

第二件是 **在遍历时修改**。[Go 语言规范](https://go.dev/ref/spec#For_statements) 允许程序在 `range` 一张 map 时更新或删除条目，并且语义是确定的：尚未产出就被删除的条目会被跳过，尚未产出就被更新的条目会给出新值，新插入的条目可以出现，也可以不出现。Abseil 禁止在迭代期间修改表。Go 的迭代器会保持对当前正在遍历的那张表的引用，以免扩容在 `range` 中途打乱顺序；在真正产出之前，再去查扩容后的表，确认键是否还在，并取出最新的值。Pratt 的博文把迭代称作实现中最复杂的部分，而这部分之所以存在，只是因为语言规则如此。

Go 1.24 默认启用了新 map。构建时设置 `GOEXPERIMENT=noswissmap` 可以恢复旧实现。微基准中，博文给出的数字是 map 操作比 Go 1.23 最多快 60%，也有一些边角情况更慢；在完整应用基准中，CPU 时间的几何平均改进约为 1.5%。[Go 1.24 发行说明](https://go.dev/doc/go1.24) 写的是，在一组有代表性的基准上，运行时平均 CPU 开销下降 2–3%，来源是新 map，再加上更高效的小对象分配和新的运行时互斥量——并不是 map 单独贡献了这全部。

## 7. 取舍

对内存里的哈希表来说，Swiss Table 是一个很强的默认选择。但它不是唯一值得用的形状。

- **当指针稳定性就是契约时，链式仍然有位置。** 若调用方持有指向表内元素的指针，或条目绝不能移动，节点表（或存放指针的扁平表）才是诚实的选择。Java 的 `HashMap` 仍然是链式表（碰撞链过长时会树化），默认负载因子是 0.75；这是同一条轴上的另一个点，不是一张失败的 Swiss Table。
- **Python 的 `dict` 也是开放寻址，但不是 Swiss Table。** 从 Python 3.7 起，插入顺序是语言保证。CPython 用一块按插入顺序排列的紧凑条目数组，外加一块紧凑的哈希槽索引，于是遍历很便宜，哈希表也可以保持稀疏而不把条目打散。它的元数据不是用 SIMD 扫描的 H2 控制字，这个设计要解决的，并不只是极致的查找速度，还有有序、紧凑的遍历。
- **哈希质量不是可选项。** H1 决定起始组，H2 只有 7 位。一个不能在整个字上产生雪崩效应的哈希，会让探测聚集，并提高 H2 假命中。Abseil 为此提供 `absl::Hash`；Rust 默认使用抗 DoS 的哈希器；Go 会随机化种子和遍历顺序。若你为整数键塞进一个平凡的恒等哈希，聚集就是你自己的问题。
- **遍历顺序不是暗藏的排序。** 那些「碰巧」依赖某家 `std::unordered_map` 实现顺序的代码，在表变成 Swiss Table 之后会出问题。若你需要稳定顺序，就排序，或使用明确有序的结构。
- **很大的扁平条目，就是很大的槽。** 内联存储对小键小值是赢面。若一个槽装着数 KB 的对象，每一步探测都会更贵，rehash 还要复制全部数据。当载荷远远大于一个控制字节加一个键时，存指针，或改用节点表。
- **墓碑，以及一张永不扩容的表。** 一张大致保持恒定大小、却在不断插入删除的集合，可能被已删除的控制字节填满，失去「空槽结束探测」这一性质。当活负载已经很低、未命中查找却仍然很贵时，rehash 或收缩。
- **并发仍然是你的问题。** 这些设计都不是并发哈希表。Go 的 map 对并发写仍然不安全；Rust 的 `HashMap` 没有内置同步；Abseil 的表内部也不加锁。Swiss Table 改变的是探测，不是内存模型。

## 8. 一个可运行的模型

下面的脚本就是本节所有数字的来源。它不是 Abseil、Go 或 hashbrown 的墙钟时间对比。它在固定的 SplitMix64 混合函数下统计探测步数和键相等比较次数；Swiss Table 使用 8 槽一组、三角形二次探测，以及官方的 empty / deleted / H2 控制字节编码。这些运行关闭了扩容，好让选定的负载因子保持不变。「探测」对 Swiss Table 是访问的组数，对线性探测和链式则是访问的槽或链节点数。

三张表共用 1024 个槽的容量（128 个 Swiss 组）。同一批键分别插入到 0.50、0.75 和 0.875 的负载——最后一档就是 7/8 的上限——然后查找：既查在表里的键，也查同样数量、从未插入过的键。

| 负载 | 表 | 命中探测 | 命中比较 | 未命中探测 | 未命中比较 | 未命中最大探测 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0.500（512 个活条目） | chaining | 1.248 | 1.248 | 1.121 | 0.508 | 4 |
| 0.500 | linear | 1.439 | 1.439 | 2.568 | 1.568 | 21 |
| 0.500 | swiss-8 | 1.000 | 1.012 | 1.051 | 0.037 | 2 |
| 0.750（768 个活条目） | chaining | 1.384 | 1.384 | 1.238 | 0.742 | 5 |
| 0.750 | linear | 2.439 | 2.439 | 8.005 | 7.005 | 46 |
| 0.750 | swiss-8 | 1.094 | 1.021 | 1.673 | 0.078 | 7 |
| 0.875（896 个活条目） | chaining | 1.470 | 1.470 | 1.304 | 0.849 | 5 |
| 0.875 | linear | 4.020 | 4.020 | 32.252 | 31.252 | 166 |
| 0.875 | swiss-8 | 1.278 | 1.040 | 2.607 | 0.150 | 13 |

有三件事很清楚。

第一，**线性探测的未命中在负载接近 7/8 时会掉下悬崖**。这一负载下，成功查找已经平均要做 4 次键比较；一次未命中平均走过 32 个槽，本轮运行里最坏走到了 166 个槽。这就是一次聚集的一个数字：未命中必须走到一段 run 的尽头。

第二，**Swiss Table 的键比较次数几乎不怎么动**。在 7/8 时，命中仍然平均 1.040 次相等比较（本轮最多 2 次），未命中平均 0.150 次（最多 3 次）。访问的组数会上升——命中从 1.000 到 1.278，未命中从 1.051 到 2.607——因为一组若没有空槽，就不能结束探测。H2 过滤器承担了线性表用 `==` 做的那部分工作。

第三，**链式的比较次数始终不大**，即便到了 7/8。这在意料之中：1024 个桶上 0.875 的负载意味着链表很短，而且这个模型并不计入指针追逐或按节点分配。链式在「比较次数」这一栏里「赢了」，却输掉了 Swiss Table 想同时保住的两件事：密度，以及对键的顺序访问。

第二组运行把同样的 1024 个槽填到负载 0.75，然后在不 rehash 的情况下删除 40% 的活键（768 个里的 308 个），活负载降到 0.449。

| 删除 40% 之后 | 剩余键命中，探测 / 比较 | 从未插入的未命中 | 已删除键的未命中 |
| --- | --- | --- | --- |
| chaining | 1.237 / 1.237 | 1.104 / 0.460 | 1.081 / 0.429 |
| linear | 2.511 / 1.904 | 8.005 / 4.214 | 11.938 / 5.854 |
| swiss-8 | 1.076 / 1.013 | 1.673 / 0.051 | 1.922 / 0.042 |

线性表留下了 308 个墓碑。对从未插入过的键，未命中探测长度仍是 8.005——与删除前负载 0.75 时的未命中长度完全相同——因为墓碑并不会结束探测。比较次数下降（从 7.005 到 4.214），只是因为原先握着键的一些槽现在会被跳过、不再做 `==`。刚被删掉的那些键更糟：11.938 次探测，因为它们仍然散列进自己曾经占据的那些聚集区。

Swiss Table 只写下 144 个 deleted 控制字节。其余删除变成了 empty，用的就是「这一组里已经有空槽」这条启发式。未命中的比较次数接近零（0.051 与 0.042）。对从未插入的键，访问组数仍是 1.673，与负载 0.75 时相同，因为墓碑仍然不能结束行走；让 `==` 保持稀少的，是过滤器，而不是更短的探测。

```python
#!/usr/bin/env python3
"""A compact model of chaining, linear probing, and Swiss-table lookup.

This is an algorithmic model, not a timing benchmark of Abseil, Go, or
hashbrown. It counts probe steps and key equality checks under a fixed
64-bit mix, so the figures in the article are reproducible.

Control-byte encoding follows Go's internal/runtime/maps and Abseil's
raw_hash_set: empty = 0b10000000, deleted = 0b11111110, full = 7-bit H2.
Swiss groups have 8 slots, as in Go 1.24+. Quadratic probing walks
groups with the triangular step used by Abseil: group += i on the i-th
step, modulo a power-of-two group count. Growth uses a 7/8 load cap.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


def mix64(x: int) -> int:
    """SplitMix64 finalizer, used as a deterministic 64-bit hash."""
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9
    x = (x ^ (x >> 27)) * 0x94D049BB133111EB
    x = x ^ (x >> 31)
    return x & 0xFFFFFFFFFFFFFFFF


def h1(h: int) -> int:
    return h >> 7


def h2(h: int) -> int:
    return h & 0x7F


CTRL_EMPTY = 0b10000000
CTRL_DELETED = 0b11111110
GROUP_SLOTS = 8
MAX_GROUP_LOAD = 7  # 7/8, same cap Abseil and Go document


@dataclass
class Stats:
    probes: int = 0
    comparisons: int = 0
    found: bool = False


@dataclass
class ChainTable:
    n_buckets: int
    buckets: list[list[tuple[int, int, int]]] = field(init=False)
    size: int = 0

    def __post_init__(self) -> None:
        self.buckets = [[] for _ in range(self.n_buckets)]

    def insert(self, key: int, value: int) -> None:
        h = mix64(key)
        b = self.buckets[h % self.n_buckets]
        for i, (_, k, _) in enumerate(b):
            if k == key:
                b[i] = (h, key, value)
                return
        b.append((h, key, value))
        self.size += 1

    def lookup(self, key: int) -> Stats:
        h = mix64(key)
        chain = self.buckets[h % self.n_buckets]
        s = Stats()
        for _, k, _ in chain:
            s.probes += 1
            s.comparisons += 1
            if k == key:
                s.found = True
                return s
        if s.probes == 0:
            s.probes = 1  # inspected an empty bucket
        return s

    def delete(self, key: int) -> bool:
        h = mix64(key)
        b = self.buckets[h % self.n_buckets]
        for i, (_, k, _) in enumerate(b):
            if k == key:
                b.pop(i)
                self.size -= 1
                return True
        return False


@dataclass
class LinearTable:
    capacity: int
    keys: list[Optional[int]] = field(init=False)
    values: list[Optional[int]] = field(init=False)
    state: list[str] = field(init=False)  # empty / full / deleted
    size: int = 0

    def __post_init__(self) -> None:
        self.keys = [None] * self.capacity
        self.values = [None] * self.capacity
        self.state = ["empty"] * self.capacity

    def _slot(self, h: int, i: int) -> int:
        return (h + i) % self.capacity

    def insert(self, key: int, value: int) -> None:
        h = mix64(key)
        first_deleted: Optional[int] = None
        for i in range(self.capacity):
            idx = self._slot(h, i)
            st = self.state[idx]
            if st == "full":
                if self.keys[idx] == key:
                    self.values[idx] = value
                    return
            elif st == "deleted":
                if first_deleted is None:
                    first_deleted = idx
            else:
                dest = first_deleted if first_deleted is not None else idx
                self.keys[dest] = key
                self.values[dest] = value
                self.state[dest] = "full"
                self.size += 1
                return
        raise RuntimeError("linear table is full")

    def lookup(self, key: int) -> Stats:
        h = mix64(key)
        s = Stats()
        for i in range(self.capacity):
            idx = self._slot(h, i)
            s.probes += 1
            st = self.state[idx]
            if st == "full":
                s.comparisons += 1
                if self.keys[idx] == key:
                    s.found = True
                    return s
            elif st == "empty":
                return s
        return s

    def delete(self, key: int) -> bool:
        h = mix64(key)
        for i in range(self.capacity):
            idx = self._slot(h, i)
            st = self.state[idx]
            if st == "full":
                if self.keys[idx] == key:
                    self.keys[idx] = None
                    self.values[idx] = None
                    self.state[idx] = "deleted"
                    self.size -= 1
                    return True
            elif st == "empty":
                return False
        return False


@dataclass
class SwissTable:
    capacity: int  # power of two, multiple of GROUP_SLOTS
    ctrl: list[int] = field(init=False)
    keys: list[Optional[int]] = field(init=False)
    values: list[Optional[int]] = field(init=False)
    size: int = 0
    grow_on_load: bool = True

    def __post_init__(self) -> None:
        if self.capacity < GROUP_SLOTS or self.capacity & (self.capacity - 1):
            raise ValueError("capacity must be a power of two, at least one group")
        self.ctrl = [CTRL_EMPTY] * self.capacity
        self.keys = [None] * self.capacity
        self.values = [None] * self.capacity
        self._n_groups = self.capacity // GROUP_SLOTS

    def _groups(self, start_h1: int):
        group = start_h1 % self._n_groups
        step = 0
        seen = 0
        while seen < self._n_groups:
            yield group
            step += 1
            group = (group + step) % self._n_groups
            seen += 1

    def _maybe_grow(self) -> None:
        if not self.grow_on_load:
            return
        # 7 occupied slots per 8-slot group, matching maxAvgGroupLoad.
        if self.size + 1 > self._n_groups * MAX_GROUP_LOAD:
            self._rehash(self.capacity * 2)

    def _rehash(self, new_cap: int) -> None:
        old = [(self.keys[i], self.values[i]) for i in range(self.capacity) if self.ctrl[i] < 0x80]
        self.capacity = new_cap
        self.__post_init__()
        self.size = 0
        for k, v in old:
            assert k is not None and v is not None
            self._insert_new(k, v)

    def insert(self, key: int, value: int) -> None:
        if self.lookup(key).found:
            self._update(key, value)
            return
        self._maybe_grow()
        self._insert_new(key, value)

    def _update(self, key: int, value: int) -> None:
        h = mix64(key)
        target = h2(h)
        for g in self._groups(h1(h)):
            base = g * GROUP_SLOTS
            for off in range(GROUP_SLOTS):
                idx = base + off
                if self.ctrl[idx] == target and self.keys[idx] == key:
                    self.values[idx] = value
                    return
            if any(self.ctrl[base + off] == CTRL_EMPTY for off in range(GROUP_SLOTS)):
                raise RuntimeError("update missed a present key")
        raise RuntimeError("update missed a present key")

    def _insert_new(self, key: int, value: int) -> None:
        h = mix64(key)
        target = h2(h)
        first_open: Optional[int] = None
        for g in self._groups(h1(h)):
            base = g * GROUP_SLOTS
            for off in range(GROUP_SLOTS):
                idx = base + off
                c = self.ctrl[idx]
                if c == target and self.keys[idx] == key:
                    self.values[idx] = value
                    return
                if first_open is None and c >= 0x80:  # empty or deleted
                    first_open = idx
            if any(self.ctrl[base + off] == CTRL_EMPTY for off in range(GROUP_SLOTS)):
                break
        if first_open is None:
            raise RuntimeError("swiss table has no open slot")
        self.ctrl[first_open] = target
        self.keys[first_open] = key
        self.values[first_open] = value
        self.size += 1

    def lookup(self, key: int) -> Stats:
        h = mix64(key)
        target = h2(h)
        s = Stats()
        for g in self._groups(h1(h)):
            s.probes += 1
            base = g * GROUP_SLOTS
            saw_empty = False
            for off in range(GROUP_SLOTS):
                idx = base + off
                c = self.ctrl[idx]
                if c == target:
                    s.comparisons += 1
                    if self.keys[idx] == key:
                        s.found = True
                        return s
                elif c == CTRL_EMPTY:
                    saw_empty = True
            if saw_empty:
                return s
        return s

    def delete(self, key: int) -> bool:
        h = mix64(key)
        target = h2(h)
        for g in self._groups(h1(h)):
            base = g * GROUP_SLOTS
            saw_empty = False
            for off in range(GROUP_SLOTS):
                idx = base + off
                c = self.ctrl[idx]
                if c == target and self.keys[idx] == key:
                    # If the group already has an empty slot, a later lookup
                    # would stop here anyway, so the slot can be empty rather
                    # than a tombstone. Abseil documents this heuristic.
                    group_has_empty = any(
                        self.ctrl[base + j] == CTRL_EMPTY for j in range(GROUP_SLOTS) if j != off
                    )
                    self.ctrl[idx] = CTRL_EMPTY if group_has_empty else CTRL_DELETED
                    self.keys[idx] = None
                    self.values[idx] = None
                    self.size -= 1
                    return True
                if c == CTRL_EMPTY:
                    saw_empty = True
            if saw_empty:
                return False
        return False


def mean(xs: list[int]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def summarize(name: str, stats: list[Stats]) -> str:
    hits = [s for s in stats if s.found]
    misses = [s for s in stats if not s.found]
    def part(label: str, group: list[Stats]) -> str:
        if not group:
            return f"{label}: n=0"
        return (
            f"{label}: n={len(group)} "
            f"avg_probes={mean([s.probes for s in group]):.3f} "
            f"avg_comparisons={mean([s.comparisons for s in group]):.3f} "
            f"max_probes={max(s.probes for s in group)} "
            f"max_comparisons={max(s.comparisons for s in group)}"
        )
    return f"{name}\n  {part('hit', hits)}\n  {part('miss', misses)}"


def keys_for(n: int) -> list[int]:
    # Well-spread integer keys; mix64(key) is the hash, so the identity
    # of the key only matters for equality.
    return [i * 0x9E3779B97F4A7C15 & 0xFFFFFFFFFFFFFFFF for i in range(n)]


def absent_keys(n: int) -> list[int]:
    return [~k & 0xFFFFFFFFFFFFFFFF for k in keys_for(n)]


def run_load_factors() -> None:
    print("=" * 72)
    print("Load-factor comparison, capacity fixed at 1024 slots (128 Swiss groups)")
    capacity = 1024
    for load in (0.50, 0.75, 0.875):
        n = int(capacity * load)
        present = keys_for(n)
        missing = absent_keys(n)
        chain = ChainTable(capacity)
        linear = LinearTable(capacity)
        swiss = SwissTable(capacity, grow_on_load=False)
        for i, k in enumerate(present):
            chain.insert(k, i)
            linear.insert(k, i)
            swiss.insert(k, i)
        print(f"\n--- load={load:.3f}  live={n}/{capacity} ---")
        for label, table in (("chaining", chain), ("linear", linear), ("swiss-8", swiss)):
            hit = [table.lookup(k) for k in present]
            miss = [table.lookup(k) for k in missing]
            print(summarize(label, hit + miss))


def run_tombstones() -> None:
    print("\n" + "=" * 72)
    print("Tombstones: fill to 0.75, delete 40% of live keys, no rehash")
    capacity = 1024
    n = int(capacity * 0.75)
    present = keys_for(n)
    # Delete every key whose insertion index is 0 or 1 mod 5 -> 40%.
    doomed = [present[i] for i in range(n) if i % 5 in (0, 1)]
    remained = [k for i, k in enumerate(present) if i % 5 not in (0, 1)]
    missing = absent_keys(n)
    chain = ChainTable(capacity)
    linear = LinearTable(capacity)
    swiss = SwissTable(capacity, grow_on_load=False)
    for i, k in enumerate(present):
        chain.insert(k, i)
        linear.insert(k, i)
        swiss.insert(k, i)
    for k in doomed:
        assert chain.delete(k)
        assert linear.delete(k)
        assert swiss.delete(k)
    n_tomb = sum(1 for st in linear.state if st == "deleted")
    n_swiss_del = sum(1 for c in swiss.ctrl if c == CTRL_DELETED)
    n_swiss_empty = sum(1 for c in swiss.ctrl if c == CTRL_EMPTY)
    print(f"live after deletes: {len(remained)}")
    print(f"linear tombstones: {n_tomb}")
    print(f"swiss deleted ctrl bytes: {n_swiss_del}, empty: {n_swiss_empty}, live: {swiss.size}")
    print("before-delete baseline was load 0.75; after, live load "
          f"{len(remained)/capacity:.3f}")
    for label, table in (("chaining", chain), ("linear", linear), ("swiss-8", swiss)):
        hit = [table.lookup(k) for k in remained]
        miss = [table.lookup(k) for k in missing]
        gone = [table.lookup(k) for k in doomed]
        print(summarize(label + " (remaining keys)", hit))
        print(summarize(label + " (never inserted)", miss))
        print(summarize(label + " (deleted keys)", gone))


def run_walkthrough() -> None:
    print("\n" + "=" * 72)
    print("Small walkthrough: 16 slots, two Swiss groups, a handful of keys")
    table = SwissTable(16, grow_on_load=False)
    inserted = [10, 25, 32, 56, 78, 98]
    for k in inserted:
        h = mix64(k)
        table.insert(k, k)
        print(
            f"insert {k:3d}  hash=0x{h:016x}  h1={h1(h)}  h2={h2(h):3d}  "
            f"start_group={h1(h) % 2}"
        )
    print("ctrl bytes (d=deleted, .=empty, number=h2):")
    def fmt(c: int) -> str:
        if c == CTRL_EMPTY:
            return "  ."
        if c == CTRL_DELETED:
            return "  d"
        return f"{c:3d}"
    print(" group0:", " ".join(fmt(c) for c in table.ctrl[:8]))
    print(" group1:", " ".join(fmt(c) for c in table.ctrl[8:]))
    for k in inserted + [99, 21]:
        s = table.lookup(k)
        print(f"lookup {k:3d}  found={str(s.found):5s}  groups={s.probes}  comparisons={s.comparisons}")
    table.delete(32)
    print("after deleting 32:")
    print(" group0:", " ".join(fmt(c) for c in table.ctrl[:8]))
    print(" group1:", " ".join(fmt(c) for c in table.ctrl[8:]))
    s = table.lookup(32)
    print(f"lookup  32  found={s.found}  groups={s.probes}  comparisons={s.comparisons}")


def main() -> None:
    run_walkthrough()
    run_load_factors()
    run_tombstones()


if __name__ == "__main__":
    main()

```

## 小结

- Swiss Table 是一种开放寻址哈希表，元数据集中存放在一块密集的控制字节数组里。64 位哈希拆成 H1 与 7 位的 H2：H1 选择第一组，满槽的控制字节里存放 H2。
- 查找一次匹配整组控制字节——Abseil 在 SSE 上是 16 个槽，Go 1.24 是 8 个槽；没有 SIMD 时则使用可移植的位运算回退。只有 H2 命中才会变成键比较。组里的空槽结束探测，墓碑不会。
- Abseil 与 Go 都把大表的负载上限设为 7/8。二次探测走的是组，不是单个槽。删除时，若该组已经有空槽，优先写成 empty，否则写成墓碑。
- 扁平存储把键和值放在槽内，rehash 时指针失效。节点存储用一次分配和一次间接访问换来指针稳定性。Abseil 建议默认使用扁平表。
- Rust 的 `HashMap` 是带二次探测、SIMD 查找和抗 DoS 默认哈希器的 Swiss Table。Go 1.24 的内置 map 也是 Swiss Table，并且额外拆成多张最多 1024 个条目的独立表，好让扩容保持增量；迭代时再去查扩容后的表，从而继续满足语言「在 range 中修改」的规则。
- 文中的模型统计的是操作次数，不是 CPU 基准。在 7/8 负载下，线性探测的未命中平均走过 32 个槽（最多 166）；8 槽 Swiss Table 平均访问 2.607 组、做 0.150 次键比较。在不 rehash 的情况下删除 40% 之后，线性探测的未命中步数并没有缩短，因为墓碑不会结束行走。

## 参考资料

- Abseil，[Swiss Tables Design Notes](https://abseil.io/about/design/swisstables)
- Sam Benzaquen、Alkis Evlogimenos、Matt Kulukundis、Roman Perepelitsa，[Swiss Tables and `absl::Hash`](https://abseil.io/blog/20180927-swisstables)，2018 年 9 月 27 日
- Abseil，[C++ Container Guide](https://abseil.io/docs/cpp/guides/container)（扁平表与节点表，87.5% 最大负载）
- Abseil，[`absl/container/internal/raw_hash_set.h`](https://github.com/abseil/abseil-cpp/blob/master/absl/container/internal/raw_hash_set.h)（二次探测、控制字节布局、7/8 扩容、墓碑启发式）
- Michael Pratt，[Faster Go maps with Swiss Tables](https://go.dev/blog/swisstable)，2025 年 2 月 26 日
- The Go Programming Language，[Go 1.24 Release Notes](https://go.dev/doc/go1.24)（运行时 map，`GOEXPERIMENT=noswissmap`）
- Go 源码，[`internal/runtime/maps`](https://github.com/golang/go/blob/master/src/internal/runtime/maps/group.go)（8 槽一组、控制字节编码、`maxAvgGroupLoad = 7`）
- The Go Programming Language Specification，[For statements](https://go.dev/ref/spec#For_statements)（map 遍历，以及同一 goroutine 在遍历时修改）
- Rust 文档，[`std::collections::HashMap`](https://doc.rust-lang.org/std/collections/struct.HashMap.html)
- [hashbrown](https://github.com/rust-lang/hashbrown)，Rust 标准 `HashMap` 背后的 Swiss Table 实现
