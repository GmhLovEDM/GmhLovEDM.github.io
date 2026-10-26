---
title: "深入 LLM 推理引擎：KV Cache、PagedAttention、连续批处理与投机解码"
tag: ai
description: 从提示词进入 vLLM、SGLang 这类推理引擎到 token 流式返回，中间到底发生了什么——prefill/decode 两阶段以及 decode 为何受限于显存带宽、KV cache 实际有多大、PagedAttention 的块表与写时复制、迭代级（连续）批处理、分块 prefill、基于基数树的前缀缓存、投机解码的接受规则，以及 prefill/decode 分离部署。最后整理调优参数及其背后的取舍
date: "2026-10-26T10:20:00.000Z"
---

## 目标

从外面看，部署大语言模型很简单：发提示词，拿 token。但推理引擎的内部，本质上是包在几个 GPU kernel 外面的**显存管理器加调度器**。过去几年几乎所有大的吞吐提升——PagedAttention、连续批处理、前缀缓存、分块 prefill、分离式部署——都是在更好地利用 GPU 显存和显存带宽，而不是让矩阵运算本身更快。

本文跟随一个请求走过 [vLLM](https://github.com/vllm-project/vllm) 或 [SGLang](https://github.com/sgl-project/sglang) 这样的引擎，从第一性原理解释每个机制，并用简短的代码模型还原核心思路。文中的数字要么由公开的模型配置算出，要么引自原始论文；凡是某个引擎特定的默认值都会单独说明，因为这些会随版本变化。

## 两个阶段：Prefill 与 Decode

Decoder-only Transformer 以自回归方式生成文本。一个提示词长度为 `P`、将输出 `N` 个 token 的请求，会分成两个性质截然不同的阶段：

- **Prefill**：全部 `P` 个提示词 token 在一次前向计算中通过模型。每一层并行地对整段提示词计算注意力，并保存每个 token 的 key 和 value 向量。这一遍结束时产出第一个输出 token。
- **Decode**：之后的每一步，每个序列只输入**一个**新 token，对之前所有的 key/value 做注意力，产出下一个 token。重复 `N - 1` 次。

这两个阶段正好对应用户能感知到的两个延迟指标：

| 指标 | 含义 | 主要取决于 |
| --- | --- | --- |
| TTFT（首 token 延迟） | 排队 + prefill | 提示词长度、队列深度 |
| TPOT / ITL（每个输出 token 的时间 / token 间延迟） | 一次 decode 步骤的耗时 | 批大小、上下文长度、显存带宽 |

### 为什么 decode 受限于显存带宽

在一次 decode 步骤中，批里的 `B` 个序列各贡献一个 token。对每个权重矩阵，GPU 都要把整个矩阵从 HBM 读出来，但每读一个权重只做大约 `2·B` 次浮点运算。权重是 16 位（2 字节）时，**算术强度**大约是每字节 `B` 次 FLOP。

现代加速器要达到算力瓶颈，需要的强度远高于此。以 NVIDIA H100 SXM 为例，官方规格约为 989 TFLOPS 的稠密 BF16 算力和 3.35 TB/s 的 HBM3 带宽，比值约为每字节 300 FLOP。所以批大小为 1 时，decode 用到的算力远不到 1%，GPU 的时间都花在搬运权重上。Prefill 正相反：`P` 个 token 共享每一次权重读取，长提示词能把 Tensor Core 跑满。

这带来两个影响全局的结论：

1. **对 decode 做批处理几乎是免费的**，直到接近算力拐点为止：为 64 个序列读一次权重，和为 1 个序列读一次的代价差不多。吞吐几乎随批大小线性增长。
2. 限制批大小的是 **KV cache 占用的显存**，而不是算力。

## KV Cache 到底有多大？

注意力需要每一层上所有历史 token 的 key 和 value。每步都重算会让生成变成平方复杂度，所以引擎会把它们缓存下来。每个 token 的占用为：

```
kv_bytes_per_token = 2 (K 和 V) × num_layers × num_kv_heads × head_dim × bytes_per_element
```

代入公开配置（16 位缓存）：

| 模型 | 层数 | KV 头数 × head_dim | 每 token 的 KV cache |
| --- | --- | --- | --- |
| OPT-13B（MHA） | 40 | 40 × 128 = 5120 | 约 800 KB |
| Llama 3 8B（GQA） | 32 | 8 × 128 = 1024 | 128 KiB |
| Llama 3 70B（GQA） | 80 | 8 × 128 = 1024 | 320 KiB |

OPT-13B 的数字正是 vLLM 论文中使用的例子。对 Llama 3 70B，一段 8K token 的对话就要占约 2.5 GiB 的 KV cache，32 个这样的并发对话需要约 80 GiB——这还没算约 140 GB 的 BF16 权重。这就是为什么决定一台机器能服务多少用户的，是缓存而不是权重。

不少模型结构上的选择，纯粹是为了压缩这个数字：

- **Multi-Query Attention**（Shazeer，2019）让所有 query 头共享一个 K/V 头。
- **Grouped-Query Attention**（Ainslie 等，2023）让每组 query 头共享一个 K/V 头——Llama 3 的 64 个 query 头只用 8 个 KV 头，相比完整的多头注意力缩小 8 倍。
- **Multi-head Latent Attention**（DeepSeek-V2，2024）缓存压缩后的低秩潜向量，而不是完整的 K/V。
- **滑动窗口注意力**限制每层能看到的历史 token 数，从而给缓存增长设定上限。
- **KV cache 量化**（如 FP8）把每个元素的字节数减半，代价是一定的精度损失。

## 碎片问题与 PagedAttention

早期的推理系统为每个请求分配一块**连续**的 KV cache 张量，按最大可能长度（提示词 + `max_tokens`）预留。这会从三个方面浪费显存：

- **预留浪费**：还没生成的 token 所占的空间在请求整个生命周期里都闲置着。
- **内部碎片**：大多数请求远在 `max_tokens` 之前就结束，尾部从未被用到。
- **外部碎片**：大小不一的连续块之间留下无法利用的空隙。

vLLM 论文（Kwon 等，*Efficient Memory Management for Large Language Model Serving with PagedAttention*，SOSP 2023）测得，现有系统的 KV cache 显存只有 **20%–40%** 真正存放了 token 状态——60%–80% 被浪费掉了。

PagedAttention 借用了操作系统的答案：**虚拟内存分页**。

- GPU 上的 KV 显存预先分配成一个由固定大小**物理块**组成的池子，每块存固定数量 token 的 K/V（vLLM 默认块大小是 16 个 token）。
- 每个序列有一张**块表**，把逻辑块（第 0–15 个 token、第 16–31 个 token……）映射到物理块 ID，物理块不必连续。
- 块随序列增长**按需分配**；每个序列只有最后一块可能没填满。
- 注意力 kernel 被改写为通过块表去收集 K/V，而不再假设张量是连续的。

这样，浪费的上限不到每个序列一块；论文报告浪费低于 4%，在相同延迟下吞吐比 FasterTransformer 和 Orca 高 **2–4 倍**。

### 共享与写时复制

块是间接引用的，所以多个序列可以指向同一个物理块。并行生成多个候选（`n > 1`）和 beam search 会让所有候选共享提示词的块，每块维护一个**引用计数**。当某个序列要写入一个被共享且未填满的块时，引擎先复制一份——和 `fork()` 的写时复制页完全一样。

分配器的最小模型：

```python
class BlockAllocator:
    def __init__(self, num_blocks: int, block_size: int = 16):
        self.block_size = block_size
        self.free = list(range(num_blocks))
        self.refcount = [0] * num_blocks

    def alloc(self) -> int:
        if not self.free:
            raise MemoryError("KV cache full: preempt or queue")
        b = self.free.pop()
        self.refcount[b] = 1
        return b

    def share(self, b: int) -> int:
        self.refcount[b] += 1
        return b

    def release(self, b: int) -> None:
        self.refcount[b] -= 1
        if self.refcount[b] == 0:
            self.free.append(b)


class Sequence:
    def __init__(self, alloc: BlockAllocator):
        self.alloc, self.table, self.num_tokens = alloc, [], 0

    def fork(self) -> "Sequence":
        child = Sequence(self.alloc)
        child.table = [self.alloc.share(b) for b in self.table]
        child.num_tokens = self.num_tokens
        return child

    def append_token(self, copy_block) -> None:
        bs = self.alloc.block_size
        if self.num_tokens % bs == 0:            # 最后一块已满（或还没有块）
            self.table.append(self.alloc.alloc())
        else:
            last = self.table[-1]
            if self.alloc.refcount[last] > 1:    # 被共享：写时复制
                new = self.alloc.alloc()
                copy_block(src=last, dst=new)    # 在 GPU 上复制一个块
                self.alloc.release(last)
                self.table[-1] = new
        self.num_tokens += 1
```

### 抢占

分页也让过载时可以平稳降级。块池耗尽时，调度器会**抢占**一部分正在运行的序列：要么把它们的块换出到 CPU 内存，要么直接释放、之后再**重算**缓存（对提示词加已生成 token 重新跑一遍 prefill）。由于 prefill 计算效率高，重算往往比走 PCIe 搬运更便宜。频繁抢占说明批处理上限设得太高了。

## 连续（迭代级）批处理

经典的“静态”批处理把请求凑成一批，一起运行直到**全部**结束，再开始下一批。输出长度差异很大，短请求只能作为填充空等最长的那个完成，新到的请求也要等整批结束。

Orca（Yu 等，OSDI 2022）提出了**迭代级调度**：调度器在**每一个 decode 步骤**都重新决策。完成的序列立即离开，等待中的序列在下一步加入。配合分页显存，批总能被填到 KV 池允许的上限。

```python
def engine_loop(waiting, running, model, allocator, max_seqs, token_budget):
    while waiting or running:
        # 1. 在显存和预算允许时接纳新请求
        budget = token_budget - len(running)          # 每个 decode 占 1 个 token
        while waiting and len(running) < max_seqs:
            req = waiting[0]
            if req.prompt_len > budget or not allocator.can_fit(req):
                break
            running.append(waiting.pop(0))
            budget -= req.prompt_len

        # 2. 对混合批（prefill + decode）做一次前向计算
        outputs = model.step(running)

        # 3. 追加 token、流式输出、回收已完成的序列
        for seq, tok in zip(list(running), outputs):
            seq.append(tok)
            stream(seq.id, tok)
            if tok == EOS or seq.num_generated >= seq.max_tokens:
                allocator.free_all(seq)
                running.remove(seq)
```

要让它跑起来还需要一个技巧：批里各序列长度不同，注意力没法用一次稠密的批量矩阵乘完成。Orca 的**选择性批处理（selective batching）**对逐 token 的运算（线性层和 MLP，它们看到的是一个扁平的 token 列表）做批处理，而注意力按序列分别计算。如今的引擎用以块表为输入的变长注意力 kernel 实现同样的效果。

## 分块 Prefill：让 decode 保持平稳

连续批处理在同一步里混合了 prefill 和 decode，这带来新问题：批里一旦接纳了一个 3 万 token 的提示词，这一步就会变得很长，**所有正在生成的用户都会看到 token 流卡顿**。

Sarathi-Serve（Agrawal 等，OSDI 2024）提出了**分块 prefill** 与无停顿批处理：把长提示词切成块（比如 512–2048 个 token），每一步用固定的 **token 预算**先装下所有待处理的 decode，再用剩余预算装 prefill。这样 decode 步骤始终短且可预测，而 prefill 的计算恰好填上了受限于带宽的 decode 留下的算力空闲。

取舍很明确：预算越小，token 间延迟越低越稳定，但长提示词的 TTFT 越慢；预算越大则相反。在 vLLM 中这个预算就是 `--max-num-batched-tokens`。

## 前缀缓存：算过的就别再算

真实流量高度重复：所有用户共用的系统提示词、相同的 few-shot 示例、多轮对话不断增长的历史、每次 Agent 调用都带的工具定义。一个块的 K/V 只取决于它及之前的 token，所以相同的前缀会产生完全相同的块。

- **基于哈希**（vLLM 的自动前缀缓存）：每个满块用“块内 token + 父块哈希”算出的哈希值标识。接纳请求时，引擎按块哈希查找并复用命中的块；被释放的块留在 LRU 缓存中，直到显存需要时才被回收。
- **基数树**（SGLang 的 RadixAttention，Zheng 等，2024）：缓存的前缀存放在以 token 序列为键的基数树中，最长前缀匹配和叶子节点的 LRU 淘汰都很自然。SGLang 的调度器还能调整等待请求的顺序，以最大化缓存命中。

对 Agent 这类“长且固定的前导内容 + 很短的新一轮输入”的负载，TTFT 的改善非常显著，因为大部分 prefill 直接消失了。这也解释了为什么托管 API 会对缓存命中的输入 token 打折，以及为什么应该**把提示词中稳定的部分放在前面**、可变部分放在后面：靠前位置哪怕改一个 token，其后的所有块都会失效。

## 投机解码：每次读权重多产出几个 token

Decode 受限于带宽，所以在一次前向计算里验证多个 token，代价和生成一个差不多。投机解码（Leviathan 等，ICML 2023；Chen 等，DeepMind，2023）正是利用了这一点：

1. 一个廉价的**提议器**（speculator）先提出 `γ` 个 token。
2. 目标模型在**一次**前向计算中给这 `γ` 个位置打分。
3. 按拒绝采样规则从左到右逐个接受；第一个被拒绝的位置从修正后的分布中重新抽取。

这个接受规则保证输出分布与目标模型**完全一致**——这是无损加速，而不是近似：

```python
import numpy as np

def verify(proposed_tokens, q_probs, p_probs, rng):
    """q_probs[i], p_probs[i]: 位置 i 上提议器 / 目标模型的分布。
    p_probs 多一行，用于全部接受后的额外 token。"""
    out = []
    for i, x in enumerate(proposed_tokens):
        if rng.random() < min(1.0, p_probs[i][x] / q_probs[i][x]):
            out.append(x)                        # 接受
            continue
        residual = np.maximum(p_probs[i] - q_probs[i], 0)
        residual /= residual.sum()
        out.append(rng.choice(len(residual), p=residual))
        return out                               # 遇到第一次拒绝即停止
    out.append(rng.choice(len(p_probs[-1]), p=p_probs[-1]))  # 全部接受：额外 token
    return out
```

如果每个提议 token 被接受的概率为 `α`（假设相互独立），每次目标模型前向计算的期望产出为 `(1 − α^(γ+1)) / (1 − α)`。当 `α = 0.8`、`γ = 4` 时约为 3.4 个 token。

提议器的选择是在质量与开销之间权衡：同系列的小模型、n-gram / 提示词查找（非常适合代码编辑和 RAG，因为输出常常照抄输入）、额外的解码头（Medusa），或基于特征层的提议器（EAGLE）。问题在于投机解码是用额外算力换带宽，所以**批越大收益越小**，GPU 逐渐变成算力瓶颈。它最适合对延迟敏感、并发较低的场景。

## Prefill 与 Decode 分离部署

即使有了分块，prefill 和 decode 仍在争抢同一块 GPU，而且它们想要的东西不同：prefill 要算力，能从张量并行中受益；decode 要显存容量和大批量。DistServe（Zhong 等，OSDI 2024）和 Splitwise（Patel 等，ISCA 2024）把它们放在**不同的 GPU 池**上运行，通过高速互联把 KV cache 从 prefill 节点传给 decode 节点。月之暗面的 Mooncake 系统更进一步，构建了以 KV cache 为中心的架构，用一个横跨 GPU、CPU 内存和 SSD 的分布式缓存池。

分离部署让每个池子可以针对自己的 SLO（prefill 看 TTFT，decode 看 TPOT）独立确定规模和并行方式。代价是 KV 传输带宽和运维复杂度；它在大规模、长提示词的场景下才划算，单机部署通常没必要。

## 简单说说 Kernel

上面讲的都是调度和显存，数学本身仍然要快：

- **FlashAttention**（Dao 等，2022）对注意力做分块，使 `N × N` 的分数矩阵根本不落到 HBM，让注意力具备 IO 感知；后续版本针对更新的 GPU 特性做了优化。
- **分页 / 变长 decode kernel**（vLLM 自带的实现、FlashInfer）高效地通过块表读取 K/V。
- **CUDA Graphs** 把 decode 步骤录制下来，消除逐个 kernel 启动的开销——当每一步只有几毫秒时，这一点很关键。
- **权重量化**（FP8、INT4 AWQ/GPTQ）直接减少每个 decode 步骤读取的字节数，这就是为什么即使算力没变，它也能加速受限于带宽的 decode。

## 实际调优

大多数参数都能直接对应到上面的机制。以下用 vLLM 的参数名：

| 参数 | 对应机制 | 何时调大 | 代价 |
| --- | --- | --- | --- |
| `--gpu-memory-utilization` | KV 块池大小 | 日志里出现抢占、并发上不去 | 留给激活值和其他进程的余量变少 |
| `--max-num-seqs` | 最大并发序列数 | 高负载时 GPU 利用率仍不足 | 每个用户的 TPOT 变高 |
| `--max-num-batched-tokens` | 分块 prefill 的 token 预算 | 长提示词的 TTFT 太高 | token 间延迟更容易抖动 |
| `--enable-prefix-caching` | 跨请求复用块 | 共享系统提示词 / 多轮对话 | 哈希查找开销（很小） |
| `--kv-cache-dtype fp8` | 更小的缓存元素 | 长上下文下显存吃紧 | 可能损失质量，需要验证 |
| `--max-model-len` | 上下文长度上限 | 需要长上下文 | 同样的块池能容纳的序列更少 |

生产实践中的几条经验：

- **分别测量 TTFT 和 TPOT**，看分位数，并使用贴近真实的提示词 / 输出长度分布。平均 tokens/s 会掩盖用户真正感受到的卡顿。
- **关注 KV cache 利用率和抢占计数**。块池一直 100% 且持续抢占，说明你在白白用重算换并发；应降低并发或增加显存。
- **为缓存组织提示词**：稳定的指令和工具 schema 放前面，用户相关的数据放后面。
- **按阶段选择并行方式**：张量并行能降低单 token 延迟，但每层都有通信开销；对于追求吞吐的 decode，多开副本往往比加大 TP 更划算。
- **投机解码是降延迟的工具**：在交互式、低并发流量上开启；用于离线批处理前先做基准评估。

## 总结

LLM 推理引擎首先是一个内存系统。Decode 每一步都要读一遍全部权重，所以吞吐来自批处理，而批处理受限于 KV cache。PagedAttention 让缓存可以按小块分配，并支持共享和写时复制；连续批处理让每一步的批都保持满载；分块 prefill 防止长提示词拖慢其他所有人；前缀缓存跳过已经做过的计算；投机解码把空闲算力变成每次读权重多出的 token；分离部署则把两个从来不需要同一种硬件的阶段拆开。弄清楚你的流量瓶颈在哪一环，调参才会从猜测变成工程。

## 参考资料

- Kwon 等，[Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180)，SOSP 2023
- Yu 等，[Orca: A Distributed Serving System for Transformer-Based Generative Models](https://www.usenix.org/conference/osdi22/presentation/yu)，OSDI 2022
- Agrawal 等，[Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve](https://arxiv.org/abs/2403.02310)，OSDI 2024
- Zheng 等，[SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104)
- Leviathan 等，[Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192)，ICML 2023
- Chen 等，[Accelerating Large Language Model Decoding with Speculative Sampling](https://arxiv.org/abs/2302.01318)
- Zhong 等，[DistServe: Disaggregating Prefill and Decoding for Goodput-optimized LLM Serving](https://arxiv.org/abs/2401.09670)，OSDI 2024
- Patel 等，[Splitwise: Efficient Generative LLM Inference Using Phase Splitting](https://arxiv.org/abs/2311.18677)，ISCA 2024
- Ainslie 等，[GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245)
- Dao 等，[FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135)
- [vLLM 文档](https://docs.vllm.ai/)
