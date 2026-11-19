---
title: "深入前缀缓存：RadixAttention、块哈希与缓存感知调度"
tag: ai
description: 自动前缀缓存如何把重复的系统提示、少样本前缀或多轮历史变成一次缓存命中，而不是再跑一遍预填充——为什么因果注意力只允许复用从位置 0 开始的前缀，vLLM 如何把块哈希串起来、SGLang 的 RadixAttention 如何用基数树存放前缀，整块缓存的对齐税，缓存感知调度与路由，拆分后的 KV 池如何改变这个问题，以及一个可运行模型，用来衡量命中率、逐出，以及把一段独特的头放在最前面的代价
date: "2026-11-19T11:50:00.000Z"
---

## 目标

服务引擎已经会在单次请求的生命周期里缓存键和值：那就是[更早一篇](/blog/140-llm-inference-kv-cache-paged-attention/zh_CN)里讲的 KV 缓存。请求一结束，朴素的引擎就会丢掉这些张量。下一个用户带着同一段系统提示、同一份工具定义，或同一段对话的前三轮到来时，预填充（prefill）的账得再付一次。

**自动前缀缓存（automatic prefix caching）** 会把已经结束——以及仍在进行——的前缀 KV 留下来，等到后来的提示以相同的 token 开头时再复用。对智能体和多轮流量来说，稳定的长前缀加上很短的新后缀，往往就是「再跑一次很长的预填充」和「几乎立刻吐出第一个 token」的差别。这也是托管 API 会给缓存命中的输入 token 打折的原因，以及为什么在提示**最前面**改一行，就可能把这个折扣全部丢掉。

本文会讲到：

1. 在因果注意力和与位置相关的键之下，为什么只有从左边开始的前缀可以安全复用。
2. 一次缓存命中值多少，以及它省不了什么。
3. vLLM 基于哈希链的自动前缀缓存，它只复用完整的块。
4. SGLang 的 RadixAttention，用基数树保存前缀，并按 LRU 逐出叶子。
5. 这种自动、精确的前缀设计，和 Prompt Cache 这类按模式驱动的模块化复用有何不同。
6. 提示的排版、缓存感知调度，以及缓存感知路由。
7. 当缓存不再局部于某一个副本时，问题会怎么变。
8. 什么时候不该把赌注押在前缀缓存上。
9. 一个可运行的模型，用来衡量命中率、块对齐税、紧张预算下的逐出，以及最长前缀优先调度的效果。

## 1. 为什么只有前导前缀可以复用

在仅解码器（decoder-only）的 Transformer 里，位置 `i` 上的键和值，是 token `i`、它的位置、以及它之前所有 token 的函数。旋转位置编码（RoPE）把对位置的依赖写得很明确；因果注意力则让对前缀的依赖无从回避。由此得出两条并不相同的结论：

- 两个请求若从位置 0 起，共享长度为 `L`、逐 token 相同的前缀，那么这 `L` 个 token 的 K/V 是相同的。复用这段前缀是精确的，不会改变输出分布。
- 两个请求若只是在**中间**共享某一段，或把同一份文档插在两个不同的偏移上，通常就不是这样。那些位置上的键是在不同的前文、不同的位置编号下算出来的，直接拷过来是错的。

这就是为什么自动前缀缓存是**前缀**缓存，而不是通用的子串缓存。靠近开头插入、删除或改掉一个 token，它后面的每一个缓存块都会失效。对应的工程规则也很简单：把提示里稳定的部分放在前面——系统指令、工具模式、少样本范例、到目前为止的对话——把会变的部分放在最后。

## 2. 一次命中值多少

SGLang 的论文把缓存命中率定义为

```
hit rate = (number of cached prompt tokens) / (number of prompt tokens)
```

一次命中，是让这些 token 不必再进入**这一次**的预填充。第一个 token 的时间（TTFT）会下降；构建这些 K/V 行所消耗的 GPU 算力和显存带宽也被省下。张量本身仍然占着内存，通常带有引用计数，好让若干请求共享同一块物理页，这是 [PagedAttention](/blog/140-llm-inference-kv-cache-paged-attention/zh_CN) 的自然延伸。

命中**做不到**的有三件：

- 它不会让解码（decode）变便宜。第一个 token 之后，每一步仍然受不断变长的上下文所主导，是不是共享前缀都一样，解码依然是内存带宽受限的。
- 它不会凭空变出容量。缓存的前缀仍然和在途请求抢同一块 GPU HBM。按更早那篇文章里的每 token 大小，Llama 3 70B 上一段热门的 800 token 系统提示是 `800 × 320 KiB ≈ 250 MiB` 的 KV。如果一百个用户共享它，这很划算；如果缓存为了留住一段没人即将复用的前缀，把工作集里的块挤出去，它就是税。
- 它帮不了第一次写入这段前缀的请求。预填充总得有人付；后来的请求是搭车。

当前缀很长、新后缀很短时，第一个 token 的收益最大——这正是使用工具的智能体、多轮对话、少样本分类器，或从同一根茎分出若干续写的思维树（tree-of-thought）的形状。

## 3. 哈希链上的块：vLLM 的自动前缀缓存

vLLM 本来就把 KV 存在固定大小的**页**里（常见是 16 个 token）。自动前缀缓存在这些页上挂了一张哈希索引。官方设计文档里，一个块由三部分的哈希来标识：

- 它的**父块**（前面那段前缀）的哈希，
- 本块里的 **token id**，
- 可选的**额外键**：LoRA 适配器 id、多模态输入的哈希、用来隔离租户的 **cache salt**，以及类似的东西。

父块链接是关键：一个块的 K/V 依赖于它之前的一切，所以两个局部 token 相同、前缀却不同的块，绝不能撞到同一个键。把父哈希串起来，标识符就成了整段前导前缀的摘要，而不只是这个块自己的那一段。额外键则避免在某一个适配器、某一张图、某一个租户下算出的块，被拿去服务另一个。

这种表示带来两条运行约束：

1. **只缓存完整的块。** 块大小为 16 时，805 个 token 的提示可以共享前 800 个；最后 5 个是不完整的块，即便下一个请求有完全相同的 805 token 前缀，也得重算。这段余数就是**对齐税**。它通常不大，但不是零；一段刚好跨过块边界几个 token 的共享前缀，每次命中都要付这笔税。
2. **哈希碰撞是正确性问题**，不只是性能问题。一次碰撞会把错误的 K/V 接到某段前缀上，在静默中改掉输出——在多租户环境里，还可能把一个租户的前缀泄漏到后一个请求中。早期版本的索引并不保证无碰撞；从 vLLM v0.11 起，默认算法是 SHA-256。更快的非密码学哈希可以作为选项打开，文档也明确写了它们会提高碰撞风险。

请求进入时，引擎按块计算提示的哈希，逐块查找，并复用从左边开始连续命中的那一串。释放的块不会立刻回收：它们留在 LRU 池里，直到别的请求需要这块内存。插入和查找是 O(块数) 的，比起一次预填充很便宜；分页本来就在用的块表，也负责这份共享。

## 4. RadixAttention

SGLang 的运行时把已经结束的提示和生成的 KV 留在一棵**基数树（radix tree）**里，而不是丢弃（Zheng、Yin、Xie、Sun、Huang、Yu、Cao、Kozyrakis、Stoica、Gonzalez、Barrett 与 Sheng，NeurIPS 2024）。基数树是压缩过的前缀树：每条边上标的是一串 token，而不是单个 token，所以很长的共享系统提示可以先躺在一条边上，直到后来的请求迫使它分裂。

操作都是经典的，只是作用在 token id 上：

- **匹配。** 从根出发，把到来的提示和边标签比较，在第一处不同处停下。这是最长前缀匹配；匹配到的节点就是可复用的 K/V。
- **分裂。** 若新提示只共享某条已有边的一个真前缀，就把这条边切开，让两个后缀挂在同一个父节点下——文件系统在两条路径要共享一个目录时，做的是同一件事。
- **插入。** 未匹配的后缀成为一条新边，新算出来的 K/V 放进分页池。
- **逐出。** GPU 内存有限。RadixAttention 按 LRU 递归地逐出**叶子**节点，这样只要还有孩子依赖，共享的主干就不会被丢掉。

最初的设计把树的元数据放在 CPU 上，KV 池的页大小是 1 个 token，所以匹配不对齐到块：805 个 token 的共享前缀可以完整复用。这棵树还把**结构**暴露给了调度器。论文里的缓存感知策略，在批处理场景下，会按已匹配前缀的长度给等待中的请求排序，先跑匹配更长的，而不是先来先服务。目的是避免**缓存颠簸**：两类提示各有一段很大的私有前缀，如果它们交错到达，而预算又盛不下两段前缀，FCFS 就会为了接纳一家而逐出另一家，周而复始，命中率崩掉。最长前缀优先会在主干还热的时候先做完一家，然后再切换。

论文中的评测报告，在智能体、推理、少样本、JSON、RAG 和多轮等负载上，相对 Guidance、vLLM 和 LMQL，吞吐最高提升 **6.4 倍**，延迟最高降低 **3.7 倍**，模型从 Llama 7B 到 Mixtral 和 LLaVA，硬件是 A10G 与 A100。这些加速并不只来自 RadixAttention——系统还在单个程序内部做了并行，并加快了约束解码——但在那些基准上，缓存命中率在 **50% 到 99%** 之间，缓存感知调度平均达到**最优命中率的 96%**。在 Vicuna-33B 的对话与视觉负载上，前缀命中把第一个 token 的延迟平均降低了 **1.7 倍**。LMSYS 的发布博客用了一组稍早的基线，在 Llama-7B 和 Mixtral-8x7B 上，相对 Guidance 和 vLLM v0.2.5，吞吐最高提升 5 倍。论文里的消融表明，在没有任何命中时也没有可察觉的额外开销，所以运行时默认开着 RadixAttention。

RadixAttention 与连续批处理、PagedAttention 以及张量并行兼容。对多模态模型，图像 token 也参与同一棵树。

## 5. 模块化复用，以及为什么中间重复的片段更难

上面两种设计里的自动前缀缓存，都是精确而保守的：只复用已经按相同顺序、在相同位置上算过的连续前缀。真实提示里还有大量重复**并不是前缀**——同一份文档被许多问题引用，一段策略段落插在每条请求各自的头部之后，某一轮的工具结果会在后面的轮次里被引用。

**Prompt Cache**（Gim、Chen、Lee、Sarda、Khandelwal 与 Zhong，MLSys 2024）用一套显式的 **prompt module** 模式，来对付这种更宽的重叠。模块被预先计算并存下来；后来的提示是**导入**它们，而不是指望运行时自己发现一段共享的开头。模式的作用是让位置编号保持一致。论文报告，在他们的原型里，长文档类提示的第一个 token 时间，在 GPU 上最高降低 **8 倍**，在 CPU 上最高降低 **60 倍**，而且不必改模型权重。

取舍在约定。独立的预计算意味着，默认情况下，一个模块并不会去关注后来请求里将要出现在它前面的那段独特文本。这和「只在因果前缀完全相同时才复用 K/V」是更激进的另一种赌注。自动引擎站在精确的一边，把问题交回给写提示的人：若你希望某份文档被复用，就把它放进稳定的前缀，或走一个显式暴露这段前缀缓存的 API。若你需要复用非前缀的模块，就需要一个为此而写的设计，并且如实承认哪些是近似的。

## 6. 排版、调度和路由

一段理论上可共享的前缀，到底会不会变成命中，取决于三层。

**排版。** 缓存从左边看 token id。把独特的请求编号、时间戳、用户名，或一行「现在的时间是……」放在共享系统提示的**上面**，每个请求看起来都是全新的，系统提示永远不会被复用。同一段独特文本放在末尾则无妨。这是写提示的人能做的、杠杆最高的改动，而且不需要引擎做任何事。

**调度，在同一个副本上。** 即便提示排得很好，FCFS 仍可能把紧张的缓存抖散。优先处理已经有很长匹配的等待请求——第 4 节里的策略——能让一段热的主干留在内存里，直到这条主干上的队列被排空。代价是公平性：前缀是冷的请求，可能会排在一串对缓存友好的请求后面。生产环境里的调度器会把这两件事混在一起，例如加上最长等待时间，或给新前缀留出额度，而不是只按命中长度排序。

**路由，在多个副本之间。** 缓存在通常情况下是进程本地的。若负载均衡把一轮多轮会话，或许多使用同一系统提示的用户，均匀随机地洒开，就会一直错过：前缀在副本 A 上，下一个请求落到副本 B，B 再算一遍，并逐出别的东西。缓存感知路由试图把请求送到已经持有最长匹配前缀的副本，并在那个副本过载时仍然允许溢出。粗略的做法是把一段稳定前缀或会话 id 哈希到某个副本；更精确的做法是从引擎接收缓存事件，维护一份按副本索引的前缀表。这是缓存一直都有的局部性问题，如今摆在了 LLM 的前面。

同一份清单里还有这些细节：

- **LoRA 和多模态输入**会改变 K/V。它们必须成为缓存键的一部分，否则适配器 A 的块会被拿去服务适配器 B。
- **分词器、对话模板或权重的变化**会在静默中让所有条目失效。用 cache salt 或一个世代编号，就可以便宜地把新的模型修订隔离开。
- **多租户隔离。** 没有 salt 的话，两个碰巧共享前缀的租户就会共享张量。对公开的系统提示，这可能正是你想要的；对私有文档，则不可接受。

## 7. 一块 GPU、一组副本、一个拆分后的池

在单个副本上，前缀缓存是一个内存管理器加一张索引：也就是第 3、第 4 节里的设计。一旦预填充和解码不再共享同一块设备，缓存就变成了**集群**问题。一次命中可能住在另一个进程的 HBM 里、CPU 的 DRAM 里，或 SSD 上，取它的时间可能比重算一段短后缀还要长。

[预填充与解码拆分](/blog/159-prefill-decode-disaggregation/zh_CN) 已经会把 KV 从预填充工作进程搬到解码工作进程。**Mooncake**（Qin、Li、He、Zhang、Wu、Zheng 与 Xu，2024）是 Moonshot 的 Kimi 背后的服务平台，它走得更远，把一个多层的 KV 池当作调度的中心。全局调度器尽量把可复用的缓存带到选中的预填充实例，再把新的 KV 流式送到解码实例。复用远端前缀能省计算，但在较冷的层上等待可能错过 TTFT 的 SLO；调度器必须预测这一次传输划不划算。在真实流量下，他们报告可以多处理 **75%** 的请求；在一些模拟的长上下文设定里，在仍满足 SLO 的前提下，吞吐最高提升 **525%**——这是论文里、针对他们负载的数字，不是一条普遍承诺。

架构上的寓意很克制：一旦缓存离开了这台机器，「这段前缀缓存了吗？」就不再是一个布尔值。它是一个位置、一次传输代价，以及一个 SLO。

## 8. 什么时候不该把赌注押在前缀缓存上

在这些情况下，前缀缓存并不合适，或不足以依赖：

- 提示既独特又长，没有稳定的前缀。索引做不了事，留下来的内存还不如交给正在运行的工作集。
- 提示里会变的部分在最前面。没有任何调度器修得了这种排版。
- **互不相同**的前缀的工作集放不进去。缓存就会颠簸，而 FCFS 会看起来像是「缓存坏了」——见第 9 节的模型——直到你加大预算、整理流量，或为局部性做调度。
- 你要的是更低的**解码**延迟，或更高的解码吞吐。去看批处理、[推测解码](/blog/154-speculative-decoding-llm-inference/zh_CN)，或拆分；前缀缓存推不动那根针。
- 对正确性敏感的多租户部署，不能容忍碰撞或意外共享。使用密码学哈希和按租户的 salt，并且不要为了速度把它们关掉。

它也不能代替把缓存本身变小（GQA、MLA、量化、滑动窗口——在更早的 KV 缓存文章里讨论过）。前缀复用和更小的每 token 占用是可以相乘的，它们不能互相替代。

## 9. 一个可运行的模型

下面这份脚本是三种策略的一个紧凑模型：不复用、vLLM 风格、块大小为 16 的哈希链块缓存，以及按 token 粒度匹配、按 LRU 逐出叶子的基数树。内存是以 token 计的预算。请求一次处理一条，要么按到达顺序，要么在等待集合里做**最长前缀优先**。五类负载共用同一组积木：800 token 的系统提示、400 token 的工具模式、600 token 的少样本前缀、较短的独特用户轮次，以及在其中一类里，放在最前面的 8 token 独特头部。

它不模拟 GPU 内核、连续批处理或网络传输。命中率、被逐出的 token，以及对齐税，是索引和预算的真实性质，也正是它要衡量的东西。本节中的数字是这份脚本打印出来的结果，不是硬件计时。

```python
#!/usr/bin/env python3
"""A small model of automatic prefix caching: no reuse, block-hash caching, and a radix tree."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Iterable, Optional


# ---------------------------------------------------------------------------
# Shared vocabulary of prompt pieces
# Token ids are arbitrary integers; only equality matters.
# ---------------------------------------------------------------------------

def seq(start: int, length: int) -> tuple[int, ...]:
    return tuple(range(start, start + length))


SYSTEM = seq(1, 800)
TOOLS = seq(10_000, 400)
FEWSHOT = seq(20_000, 600)
USER_BASE = 100_000
ASSIST_BASE = 200_000
NOISE_BASE = 300_000


def user_turn(i: int, length: int = 60) -> tuple[int, ...]:
    return seq(USER_BASE + i * 200, length)


def assistant_turn(i: int, length: int = 80) -> tuple[int, ...]:
    return seq(ASSIST_BASE + i * 200, length)


def noise_prefix(i: int, length: int = 8) -> tuple[int, ...]:
    # A short unique header (request id, timestamp, ...). Placing this at the
    # front of an otherwise shared prompt destroys prefix sharing.
    return seq(NOISE_BASE + i * 20, length)


# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------

@dataclass
class InsertResult:
    prompt_tokens: int
    reused: int
    computed: int
    evicted: int


class PrefixCache:
    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        raise NotImplementedError

    def reset(self) -> None:
        raise NotImplementedError

    def stored_tokens(self) -> int:
        raise NotImplementedError


class NoCache(PrefixCache):
    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        n = len(tokens)
        return InsertResult(n, 0, n, 0)

    def reset(self) -> None:
        return

    def stored_tokens(self) -> int:
        return 0


class BlockHashCache(PrefixCache):
    """vLLM-style automatic prefix caching: only full blocks, hash-chained."""

    def __init__(self, capacity: int, block_size: int = 16) -> None:
        self.capacity = capacity
        self.block_size = block_size
        self.blocks: dict[tuple, tuple[int, ...]] = {}
        self.lru: OrderedDict[tuple, None] = OrderedDict()
        self.stored = 0

    def reset(self) -> None:
        self.blocks.clear()
        self.lru.clear()
        self.stored = 0

    def stored_tokens(self) -> int:
        return self.stored

    def _touch(self, key: tuple) -> None:
        if key in self.lru:
            self.lru.move_to_end(key)

    def _evict(self, needed: int) -> int:
        evicted = 0
        while self.stored + needed > self.capacity and self.lru:
            key, _ = self.lru.popitem(last=False)
            block = self.blocks.pop(key, None)
            if block is not None:
                self.stored -= len(block)
                evicted += len(block)
        return evicted

    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        n = len(tokens)
        bs = self.block_size
        n_full = n // bs
        reused = 0
        computed = 0
        evicted = 0
        parent = ("root",)
        # Walk cached full blocks until a miss, then allocate the rest.
        first_miss = n_full
        for i in range(n_full):
            chunk = tokens[i * bs : (i + 1) * bs]
            key = (parent, chunk)
            if key in self.blocks:
                reused += bs
                self._touch(key)
                parent = key
            else:
                first_miss = i
                break
        for i in range(first_miss, n_full):
            chunk = tokens[i * bs : (i + 1) * bs]
            key = (parent, chunk)
            evicted += self._evict(bs)
            if self.stored + bs > self.capacity:
                # Cannot hold this block; it is computed but not retained.
                computed += bs
                parent = key
                continue
            self.blocks[key] = chunk
            self.lru[key] = None
            self.stored += bs
            computed += bs
            parent = key
        leftover = n - n_full * bs
        computed += leftover  # partial blocks are never cached
        return InsertResult(n, reused, computed, evicted)


@dataclass
class RadixNode:
    tokens: tuple[int, ...]
    children: dict[int, "RadixNode"] = field(default_factory=dict)
    parent: Optional["RadixNode"] = None
    last_used: int = 0


class RadixCache(PrefixCache):
    """SGLang-style radix tree over token sequences, with LRU leaf eviction.

    Matching is at token granularity, matching the page size of one token
    described in the original RadixAttention design.
    """

    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.root = RadixNode(tokens=())
        self.clock = 0
        self.stored = 0

    def reset(self) -> None:
        self.root = RadixNode(tokens=())
        self.clock = 0
        self.stored = 0

    def stored_tokens(self) -> int:
        return self.stored

    def _leaves(self) -> list[RadixNode]:
        out: list[RadixNode] = []
        stack = [self.root]
        while stack:
            node = stack.pop()
            if node is not self.root and not node.children:
                out.append(node)
            stack.extend(node.children.values())
        return out

    def _evict(self, needed: int) -> int:
        evicted = 0
        while self.stored + needed > self.capacity:
            leaves = [n for n in self._leaves() if n is not self.root]
            if not leaves:
                break
            victim = min(leaves, key=lambda n: n.last_used)
            evicted += len(victim.tokens)
            self.stored -= len(victim.tokens)
            parent = victim.parent
            if parent is not None and victim.tokens:
                first = victim.tokens[0]
                if parent.children.get(first) is victim:
                    del parent.children[first]
            # Drop the node's tokens; if parent became a leaf it is evictable later.
            victim.tokens = ()
            victim.children.clear()
            victim.parent = None
        return evicted

    def _split(self, node: RadixNode, at: int) -> RadixNode:
        # Split node.tokens at 'at', returning the prefix node (same object)
        # and attaching the suffix as a child.
        prefix = node.tokens[:at]
        suffix = node.tokens[at:]
        child = RadixNode(tokens=suffix, parent=node, last_used=node.last_used)
        child.children = node.children
        for c in child.children.values():
            c.parent = child
        node.tokens = prefix
        node.children = {}
        if suffix:
            node.children[suffix[0]] = child
        return node

    def insert(self, tokens: tuple[int, ...]) -> InsertResult:
        self.clock += 1
        n = len(tokens)
        node = self.root
        i = 0
        reused = 0
        while i < n:
            if not node.children or tokens[i] not in node.children:
                break
            child = node.children[tokens[i]]
            edge = child.tokens
            k = 0
            while k < len(edge) and i + k < n and edge[k] == tokens[i + k]:
                k += 1
            if k == 0:
                break
            if k < len(edge):
                self._split(child, k)
            reused += k
            child.last_used = self.clock
            # Mark ancestors as recently used so a shared trunk is not treated
            # as colder than its leaves just because it was not itself a leaf.
            anc = child.parent
            while anc is not None:
                anc.last_used = max(anc.last_used, self.clock)
                anc = anc.parent
            i += k
            node = child
        remaining = tokens[i:]
        evicted = 0
        computed = len(remaining)
        if remaining:
            evicted = self._evict(len(remaining))
            if self.stored + len(remaining) <= self.capacity:
                child = RadixNode(tokens=remaining, parent=node, last_used=self.clock)
                node.children[remaining[0]] = child
                self.stored += len(remaining)
            # else: computed but not retained (capacity filled with warmer nodes)
        return InsertResult(n, reused, computed, evicted)


# ---------------------------------------------------------------------------
# Workloads
# ---------------------------------------------------------------------------

@dataclass
class Workload:
    name: str
    prompts: list[tuple[int, ...]]


def shared_system(n_users: int = 40) -> Workload:
    prompts = [SYSTEM + TOOLS + user_turn(i) for i in range(n_users)]
    return Workload("shared-system+tools + unique questions", prompts)


def fewshot_batch(n_questions: int = 30) -> Workload:
    prompts = [SYSTEM + FEWSHOT + user_turn(i, 40) for i in range(n_questions)]
    return Workload("shared few-shot batch", prompts)


def multi_turn(n_sessions: int = 8, turns: int = 4) -> Workload:
    prompts: list[tuple[int, ...]] = []
    for s in range(n_sessions):
        hist: tuple[int, ...] = SYSTEM
        for t in range(turns):
            uid = s * 20 + t
            hist = hist + user_turn(uid, 50)
            prompts.append(hist)
            hist = hist + assistant_turn(uid, 70)
    return Workload(f"multi-turn chat ({n_sessions} sessions, {turns} turns)", prompts)


def branching(n_questions: int = 6, branches: int = 4) -> Workload:
    # Tree-of-thought / self-consistency style: several continuations share
    # the same question prefix, including the question itself.
    prompts: list[tuple[int, ...]] = []
    for q in range(n_questions):
        stem = SYSTEM + FEWSHOT + user_turn(q, 80)
        for b in range(branches):
            # A short distinct "branch tag" then a continuation, as if the
            # engine were asked to produce another candidate from the same stem.
            tag = seq(400_000 + q * 50 + b * 10, 4)
            prompts.append(stem + tag)
    return Workload(f"branching ({n_questions} questions, {branches} forks)", prompts)


def unstable_front(n_users: int = 40) -> Workload:
    prompts = [noise_prefix(i) + SYSTEM + TOOLS + user_turn(i) for i in range(n_users)]
    return Workload("same body, unique header at the front", prompts)


def mixed_interleave(n_a: int = 12, n_b: int = 12) -> Workload:
    # Two unrelated shared prefixes, arrivals interleaved — FCFS thrashes a
    # tight cache; longest-prefix scheduling keeps each family together.
    a = [SYSTEM + user_turn(i, 50) for i in range(n_a)]
    b = [FEWSHOT + user_turn(1000 + i, 50) for i in range(n_b)]
    prompts: list[tuple[int, ...]] = []
    for i in range(max(n_a, n_b)):
        if i < n_a:
            prompts.append(a[i])
        if i < n_b:
            prompts.append(b[i])
    return Workload("two families, interleaved arrivals", prompts)


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------

def run_fcfs(cache: PrefixCache, prompts: Iterable[tuple[int, ...]]) -> dict[str, int]:
    cache.reset()
    tot = reused = computed = evicted = 0
    for p in prompts:
        r = cache.insert(p)
        tot += r.prompt_tokens
        reused += r.reused
        computed += r.computed
        evicted += r.evicted
    return {
        "prompt": tot,
        "reused": reused,
        "computed": computed,
        "evicted": evicted,
        "stored": cache.stored_tokens(),
    }


def run_cache_aware(cache: PrefixCache, prompts: list[tuple[int, ...]]) -> dict[str, int]:
    """Longest-prefix-first among the waiting set, as in SGLang's batch policy."""
    cache.reset()
    waiting = list(prompts)
    tot = reused = computed = evicted = 0

    def matched_len(p: tuple[int, ...]) -> int:
        # Probe the cache without mutating LRU / occupancy: replay a dry insert
        # on a snapshot is expensive; instead, use a side-channel per cache type.
        if isinstance(cache, NoCache):
            return 0
        if isinstance(cache, BlockHashCache):
            bs = cache.block_size
            n_full = len(p) // bs
            parent = ("root",)
            hit = 0
            for i in range(n_full):
                chunk = p[i * bs : (i + 1) * bs]
                key = (parent, chunk)
                if key in cache.blocks:
                    hit += bs
                    parent = key
                else:
                    break
            return hit
        if isinstance(cache, RadixCache):
            node = cache.root
            i = 0
            n = len(p)
            while i < n and p[i] in node.children:
                child = node.children[p[i]]
                edge = child.tokens
                k = 0
                while k < len(edge) and i + k < n and edge[k] == p[i + k]:
                    k += 1
                if k == 0:
                    break
                if k < len(edge):
                    return i + k  # would split; matched k of this edge
                i += k
                node = child
            return i
        return 0

    while waiting:
        # Pick the waiting prompt with the longest current match (stable sort).
        best_i = max(range(len(waiting)), key=lambda j: (matched_len(waiting[j]), -j))
        p = waiting.pop(best_i)
        r = cache.insert(p)
        tot += r.prompt_tokens
        reused += r.reused
        computed += r.computed
        evicted += r.evicted
    return {
        "prompt": tot,
        "reused": reused,
        "computed": computed,
        "evicted": evicted,
        "stored": cache.stored_tokens(),
    }


def fmt(stats: dict[str, int]) -> str:
    hit = (100.0 * stats["reused"] / stats["prompt"]) if stats["prompt"] else 0.0
    return (
        f"prompt={stats['prompt']:<6} reused={stats['reused']:<6} "
        f"computed={stats['computed']:<6} evicted={stats['evicted']:<6} "
        f"stored={stats['stored']:<6} hit={hit:5.1f}%"
    )


def banner(title: str) -> None:
    print(f"\n== {title} ==")


def compare_capacity(workloads: list[Workload], capacities: list[int]) -> None:
    banner("Hit rate versus cache capacity (FCFS, block size 16)")
    for wl in workloads:
        print(f"-- {wl.name}  ({len(wl.prompts)} prompts, "
              f"avg length {sum(map(len, wl.prompts)) // len(wl.prompts)}) --")
        none = run_fcfs(NoCache(), wl.prompts)
        print(f"  no cache          {fmt(none)}")
        for cap in capacities:
            block = run_fcfs(BlockHashCache(cap, block_size=16), wl.prompts)
            radix = run_fcfs(RadixCache(cap), wl.prompts)
            print(f"  block cap={cap:<6} {fmt(block)}")
            print(f"  radix cap={cap:<6} {fmt(radix)}")
        print()


def partial_block_effect() -> None:
    banner("Partial trailing block: 8-token remainder after a shared 800-token system prompt")
    # SYSTEM is 800 tokens, divisible by 16. Add 8 unique tokens in the middle
    # of nowhere — actually, append an 8-token unique tail after SYSTEM.
    prompts = [SYSTEM + noise_prefix(i, 8) for i in range(20)]
    cap = 8_000
    block = run_fcfs(BlockHashCache(cap, block_size=16), prompts)
    radix = run_fcfs(RadixCache(cap), prompts)
    print(f"  20 prompts of 808 tokens, cache capacity {cap}")
    print(f"  block-16          {fmt(block)}")
    print(f"  radix             {fmt(radix)}")
    print("  The 8-token tail is unique each time, so the radix tree also")
    print("  recomputes it; the difference is only that the shared 800 tokens")
    print("  are fully reusable in both, which they are, because 800 % 16 == 0.")
    # Now a shared prefix that is NOT block-aligned: 805 tokens.
    almost = SYSTEM + seq(9_000, 5)  # 805
    prompts2 = [almost + user_turn(i, 40) for i in range(20)]
    block2 = run_fcfs(BlockHashCache(cap, block_size=16), prompts2)
    radix2 = run_fcfs(RadixCache(cap), prompts2)
    print(f"  20 prompts with a shared 805-token prefix + 40 unique tokens")
    print(f"  block-16          {fmt(block2)}")
    print(f"  radix             {fmt(radix2)}")


def scheduling_effect() -> None:
    banner("FCFS versus longest-prefix-first under a tight cache")
    wl = mixed_interleave(12, 12)
    # Each family prefix is 800 or 600 tokens; a tight cache cannot hold both
    # trunks plus working suffixes at once.
    cap = 1_200
    print(f"-- {wl.name}, capacity {cap} --")
    for name, ctor in (
        ("block-16", lambda: BlockHashCache(cap, 16)),
        ("radix   ", lambda: RadixCache(cap)),
    ):
        fcfs = run_fcfs(ctor(), wl.prompts)
        aware = run_cache_aware(ctor(), wl.prompts)
        print(f"  {name} FCFS               {fmt(fcfs)}")
        print(f"  {name} longest-prefix     {fmt(aware)}")


def layout_effect() -> None:
    banner("Prompt layout: shared body with a unique header at the front versus at the end")
    cap = 16_000
    good = shared_system(40)
    bad = unstable_front(40)
    print(f"-- unique question at the end (stable prefix in front), cap {cap} --")
    print(f"  radix             {fmt(run_fcfs(RadixCache(cap), good.prompts))}")
    print(f"  block-16          {fmt(run_fcfs(BlockHashCache(cap, 16), good.prompts))}")
    print(f"-- unique 8-token header at the front, same body, cap {cap} --")
    print(f"  radix             {fmt(run_fcfs(RadixCache(cap), bad.prompts))}")
    print(f"  block-16          {fmt(run_fcfs(BlockHashCache(cap, 16), bad.prompts))}")


def main() -> None:
    capacities = [2_000, 4_000, 8_000, 16_000]
    workloads = [
        shared_system(40),
        fewshot_batch(30),
        multi_turn(8, 4),
        branching(6, 4),
        unstable_front(40),
    ]
    compare_capacity(workloads, capacities)
    partial_block_effect()
    scheduling_effect()
    layout_effect()


if __name__ == "__main__":
    main()
```

在先来先服务之下，把一段共享的 1,200 token 系统提示加工具模式放在 40 条独特的 60 token 问题前面（总共 50,400 个提示 token），一旦缓存盛得下这段主干，表现就会如人所愿：

| 策略 | 容量（token） | 复用 | 计算 | 命中率 |
| --- | ---: | ---: | ---: | ---: |
| 无缓存 | — | 0 | 50,400 | 0% |
| 块-16 或基数树 | 2,000 及以上 | 46,800 | 3,600 | 92.9% |

算术很直接。第一个请求计算 `800 + 400 + 60 = 1,260` 个 token；接下来 39 个各复用 1,200、计算 60；总计算量是 `1,260 + 2,340 = 3,600`。再加大容量也不会提高命中率：剩下的 3,600 个 token 是独特后缀，再加上前缀的第一次写入，没有哪种索引能复用它们。容量为 2,000 时，缓存已经在逐出旧的用户尾巴来腾地方，但共享主干还在，所以命中率不动。

一旦共享前缀不是 16 的倍数，块大小就开始露头。一段 1,400 token 的系统提示加少样本前缀是 `87 × 16 + 8`。基数树在命中时复用全部 1,400 个 token；块缓存复用 1,392 个，并每次重算那余下的 8 个。在 30 道各有 40 个独特 token 的问题里，这就是 2,600 对 2,832 个被计算的 token，也就是 **94.0%** 对 **93.4%**。同样的缺口出现在分支负载里，若干续写共享同一段 1,480 token 的茎：**94.5%** 对 **93.9%**。这笔税不大。它也是真实的，而且会在第一个请求之后的每一次上支付。

一段 805 token 的共享前缀加上 40 token 的独特后缀，能把这笔税单独拎出来看。第一次写入之后，块缓存可以复用 800 个 token，必须重算 45 个；基数树复用 805 个，重算 40 个。20 条提示的合计是 1,700 对 1,605，也就是 **89.9%** 对 **90.5%**。

排版压过其他所有因素。同一段 1,200 token 的主体，把独特的 60 token 问题放在末尾，命中率是 **92.9%**。把一个 8 token 的独特头部移到这段主体**前面**，其余一切不变，两种索引在扫过的每档容量上命中率都掉到 **0%**，包括 16,000 个 token——够放下许多份完整拷贝，但其中没有任何两份共享一段前导前缀。引擎并没有出错。它只是正确地拒绝复用在不同的前 8 个 token 之下算出来的 K/V。

调度是另一处悬崖。两类提示，一类有 800 token 的主干，一类有 600 token 的主干，交错到达。缓存能放下 1,200 个 token，够一段主干加上一些尾巴，但两段主干不能同时坐下：

| 策略 | 顺序 | 复用 | 计算 | 命中率 |
| --- | --- | ---: | ---: | ---: |
| 块-16 | 先来先服务 | 0 | 18,000 | 0% |
| 块-16 | 最长前缀优先 | 15,312 | 2,688 | 85.1% |
| 基数树 | 先来先服务 | 0 | 18,000 | 0% |
| 基数树 | 最长前缀优先 | 15,400 | 2,600 | 85.6% |

先来先服务会为了接纳 B 家而逐出 A 家的主干，再为了下一条 A 逐出 B，永远打不出一次命中。最长前缀优先在主干还在的时候先做完一家，再切换，预填充的大部分就消失了。两个索引之间剩下的那点差距，仍然是对齐税。这正是 SGLang 论文里缓存感知调度器要对付的情形；如果在紧张预算下只试了先来先服务，它很容易被误认成「前缀缓存不管用」。

## 小结

- 自动前缀缓存会在请求之间复用一段从左边起、逐 token 相同的前缀 KV。由于因果注意力和与位置相关的键，对从位置 0 开始的前缀，这种复用是精确的；对中间重复的片段，或出现在不同偏移上的同一段，通常是错的。
- 一次命中削减的是预填充的工作和第一个 token 的时间。它削减不了解码成本，缓存里的张量也仍然占用 HBM。前缀的第一次写入，总得有人付。
- vLLM 的自动前缀缓存用父哈希、本块 token id，以及 LoRA id、多模态哈希、cache salt 这类额外键，来标识每一个完整的页。只存储完整的块，所以一段不是块大小倍数的共享前缀，会在之后的每次请求上对齐税。从 v0.11 起默认哈希是 SHA-256，因为碰撞是正确性缺陷。
- SGLang 的 RadixAttention 把前缀放在基数树里，按 token 序列做匹配和分裂，按 LRU 逐出叶子，并且可以按已匹配前缀长度来调度等待中的请求。论文报告，相对当时的基线，吞吐最高提升 6.4 倍，延迟最高降低 3.7 倍，其负载上的命中率在 50%–99%，缓存感知调度平均达到最优命中率的 96%。
- Prompt Cache 是另一种设计：一套预先计算的模块的显式模式，针对不一定是前导前缀的重叠，并在位置和跨模块注意力上采用更激进的约定。
- 应用层杠杆最高的规则是排版：稳定的内容在前，会变的内容在后。在模型里，把一个 8 token 的独特头部放在原本共享的主体前面，命中率会从 92.9% 掉到 0%。
- 在紧张的缓存上，先来先服务可以把两类交错到达的前缀颠簸到 0% 命中率；最长前缀优先能恢复到大约 85%。在多个副本之间，随机负载均衡有同样形状的问题，缓存感知路由是对应的修复。
- 一旦预填充、解码和 KV 池被拆开，一次命中就有了位置和传输代价，而不再只是一个布尔值；若你正贴着 TTFT 的 SLO，远端取回有可能输给一次短的重算。

## 参考资料

- Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie, Chuyue Sun, Jeff Huang, Cody Hao Yu, Shiyi Cao, Christos Kozyrakis, Ion Stoica, Joseph E. Gonzalez, Clark Barrett, and Ying Sheng, [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104), NeurIPS 2024
- Lianmin Zheng, Liangsheng Yin, Zhiqiang Xie, Jeff Huang, Chuyue Sun, Cody Hao Yu, Shiyi Cao, Christos Kozyrakis, Ion Stoica, Joseph E. Gonzalez, Clark Barrett, and Ying Sheng, [Fast and Expressive LLM Inference with RadixAttention and SGLang](https://www.lmsys.org/blog/2024-01-17-sglang/), LMSYS Org, January 2024
- vLLM, [Automatic Prefix Caching](https://docs.vllm.ai/en/stable/design/prefix_caching/)（设计说明：哈希链、只缓存完整块、额外键、v0.11 起默认 SHA-256）
- Woosuk Kwon, Zhuohan Li, Siyuan Zhuang, Ying Sheng, Lianmin Zheng, Cody Hao Yu, Joseph E. Gonzalez, Hao Zhang, and Ion Stoica, [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180), SOSP 2023
- In Gim, Guojun Chen, Seung-seob Lee, Nikhil Sarda, Anurag Khandelwal, and Lin Zhong, [Prompt Cache: Modular Attention Reuse for Low-Latency Inference](https://arxiv.org/abs/2311.04934), MLSys 2024
- Ruoyu Qin, Zheming Li, Weiran He, Mingxing Zhang, Yongwei Wu, Weimin Zheng, and Xinran Xu, [Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving](https://arxiv.org/abs/2407.00079), 2024
- Yinmin Zhong, Shengyu Liu, Junda Chen, Jianbo Hu, Yibo Zhu, Xuanzhe Liu, Xin Jin, and Hao Zhang, [DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving](https://arxiv.org/abs/2401.09670), OSDI 2024
