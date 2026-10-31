---
title: "深入 FlashAttention：IO 感知注意力、在线 Softmax、分块计算与 FA2/FA3"
tag: ai
description: 为什么标准注意力受限于显存带宽而非算力，FlashAttention 如何用分块、在线 softmax 和重计算避免生成 N×N 分数矩阵，FlashAttention-2 与 FlashAttention-3 分别针对 A100 和 H100 做了哪些改进，Flash-Decoding 与分页 KV Cache 如何配合，以及在真实训练与推理栈中如何通过 PyTorch SDPA 使用它
date: "2026-10-31T13:20:00.000Z"
---

## 目标

注意力是每个 Transformer 的核心，在长上下文下它同时主导显存和耗时。2022 年 Tri Dao 等人发表了 *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*，指出了一个出人意料的事实：标准实现慢，不是因为 FLOPs 多，而是因为**显存访问量太大**。他们围绕 GPU 存储层次重新组织计算，得到了**精确**（非近似）的注意力，速度快好几倍，显存占用随序列长度线性增长。

本文内容：

1. GPU 存储层次，以及朴素注意力为什么是访存受限的。
2. 在线 softmax：让分块成为可能的关键技巧。
3. FlashAttention 前向过程逐步拆解，附代码。
4. 反向传播：为什么重算比存储更便宜。
5. FlashAttention-2：更好的并行度，更少的非矩阵乘 FLOPs。
6. FlashAttention-3：Hopper 专属的异步与 FP8。
7. 推理：Flash-Decoding、分页 KV Cache 与变长批处理。
8. 工程实践，以及它**解决不了**的问题。

## 1. 注意力是访存受限的

对单个头，序列长度 `N`、头维度 `d`，注意力计算为：

```text
S = Q Kᵀ / sqrt(d)        # N × N
P = softmax(S)            # N × N，按行
O = P V                   # N × d
```

朴素实现会拆成三个独立 kernel，把 `S` 和 `P` 写回 GPU 主存（HBM）再读出来。`N = 8192` 时每个矩阵每个头有 6700 万个元素，fp16 下仅 `S` 就是 128 MiB——这还只是单个头、单个样本。

FlashAttention 论文以 A100 的存储层次来分析代价：

| 层级 | 容量 | 带宽（约） |
|---|---|---|
| 片上 SRAM（共享内存） | 每个 SM 192 KB，共 108 个 SM | 总计约 19 TB/s |
| HBM | 40–80 GB | 1.5–2.0 TB/s |

`QKᵀ` 和 `PV` 两个矩阵乘的算术强度很高；但 softmax、mask、dropout 都是逐元素操作：每个元素读进来、做几次运算、再写回去。这些操作受 HBM 带宽限制，而且作用在 `N × N` 的二次方大小矩阵上。结果就是 Tensor Core 大部分时间都在等显存。

核心洞察是 **IO 感知（IO-awareness）**：要统计 HBM 读写次数，而不只是 FLOPs。论文证明标准注意力需要 `Θ(Nd + N²)` 次 HBM 访问，而 FlashAttention 只需 `Θ(N²d²/M)`，其中 `M` 是 SRAM 大小。对常见的 `d`（64–128）和 `M`（约 100 KB），`d²/M` 远小于 1，搬运的字节数大幅减少。

## 2. 在线 Softmax

为了不生成完整的 `S`，我们希望把 `K`、`V` 分块处理，增量累加输出。障碍在于 softmax：它需要整行的最大值（保证数值稳定）和整行的求和，才能对输出做归一化。

解决办法是在线 softmax 递推（Milakov & Gimelshein, 2018）。对每个 query 行维护运行中的最大值 `m` 和分母 `ℓ`。新到一块分数 `s` 时：

```text
m_new = max(m, max(s))
ℓ_new = exp(m - m_new) * ℓ + sum(exp(s - m_new))
```

输出累加器做同样的修正：

```text
O_new = exp(m - m_new) * O + exp(s - m_new) @ V_block
```

最后再除以 `ℓ`。乘以 `exp(m_old - m_new)` 相当于回溯修正之前在旧最大值下算出的贡献。这在代数上是精确的，不是近似。

用一段 NumPy 代码就能验证分块版本与参考实现一致：

```python
import numpy as np

def attention_ref(q, k, v):
    s = q @ k.T / np.sqrt(q.shape[-1])
    p = np.exp(s - s.max(-1, keepdims=True))
    return (p / p.sum(-1, keepdims=True)) @ v

def attention_tiled(q, k, v, block=64):
    n, d = q.shape
    scale = 1.0 / np.sqrt(d)
    o = np.zeros_like(q)
    m = np.full((n, 1), -np.inf)
    l = np.zeros((n, 1))
    for j in range(0, k.shape[0], block):
        kj, vj = k[j:j+block], v[j:j+block]
        s = (q @ kj.T) * scale                 # n × block，相当于放在 SRAM 里
        m_new = np.maximum(m, s.max(-1, keepdims=True))
        p = np.exp(s - m_new)
        alpha = np.exp(m - m_new)
        l = alpha * l + p.sum(-1, keepdims=True)
        o = alpha * o + p @ vj
        m = m_new
    return o / l

rng = np.random.default_rng(0)
q, k, v = (rng.standard_normal((512, 64)) for _ in range(3))
print(np.abs(attention_ref(q, k, v) - attention_tiled(q, k, v)).max())  # 约 1e-15
```

## 3. 前向过程

FlashAttention 把所有步骤融合进一个 kernel：

1. 把 `Q` 切成行块 `Q_i`，把 `K, V` 切成列块 `K_j, V_j`，块大小保证它们连同累加器一起放得进共享内存。
2. 对每个 `Q_i`（FA1 的外层循环是 `K/V`，FA2 调换了顺序，见下文），加载到 SRAM。
3. 对每个 `K_j, V_j`：在 Tensor Core 上计算 `S_ij = Q_i K_jᵀ`，应用因果 mask 和缩放，按在线 softmax 规则更新 `m`、`ℓ` 和输出累加器，需要时在寄存器里做 dropout。
4. 只把 `O_i`（`N × d`）和每行的 log-sum-exp `L_i = m_i + log ℓ_i`（`N` 个浮点数）写回 HBM。

`N × N` 矩阵从不落到 HBM。除输入输出外，显存从 `O(N²)` 降到 `O(N)`。这正是 16K、64K 乃至更长上下文训练变得可行的原因。

因果 mask 还带来额外收益：完全位于对角线上方的块直接跳过，大约一半的计算消失了。

## 4. 反向传播：重算而非存储

注意力的梯度需要 `P`。标准实现在前向时把它存下来，又是 `O(N²)` 显存。FlashAttention 只保存 `O` 和 log-sum-exp `L`，在反向 kernel 中逐块**重算** `S_ij` 和 `P_ij = exp(S_ij - L_i)`。

这会多花一些 FLOPs，但论文报告反向仍比标准实现更快，因为省下的 HBM 流量比重算的矩阵乘更值钱。这和梯度检查点（gradient checkpointing）是同一种权衡，只不过发生在一个融合 kernel 内部，重算几乎是免费的。

反向中有一个有用的恒等式：`dS = P ∘ (dP - D)`，其中 `D_i = rowsum(dO_i ∘ O_i)`。预先算好 `D`，每个块就可以独立处理。

## 5. FlashAttention-2

FA1 前向大约只达到 A100 理论峰值 FLOPs 的 25–40%。*FlashAttention-2*（Dao, 2023）报告比 FA1 快约 2 倍，前向最高达到峰值的 73%，主要靠三点改动：

- **减少非矩阵乘 FLOPs。** A100 上 fp16 矩阵乘吞吐是 312 TFLOPs，而非矩阵乘的 fp32 吞吐只有 19.5 TFLOPs，也就是每次指数运算和缩放比矩阵乘贵约 16 倍。FA2 把最后的 `1/ℓ` 除法推迟到最后，并且只保存 log-sum-exp，削减了重缩放的开销。
- **在序列长度维度并行。** FA1 只在 batch × head 维度并行。长序列、小 batch 时 SM 会闲置。FA2 让外层循环遍历 `Q` 块，并把它分配到不同线程块上，即使 batch 为 1 也能把 GPU 填满。
- **线程块内更好的工作划分。** FA1 把 `K/V` 分给不同 warp（"split-K"），各 warp 需要通过共享内存交换部分结果。FA2 改成把 `Q` 分给不同 warp，每个 warp 独占自己的行，不再需要 warp 间归约。

FA2 还支持最大 256 的头维度，以及多查询注意力和分组查询注意力（MQA/GQA），即多个 query 头共享一个 K/V 头。

## 6. FlashAttention-3

在 H100（Hopper）上，FA2 利用率只有约 35%，因为 Hopper 的 Tensor Core 太快，其他环节都成了瓶颈。*FlashAttention-3*（Shah, Bikshandi, Zhang, Thakkar, Ramani, Dao, 2024）利用了 Hopper 专属特性：

- **通过 warp 特化实现异步。** 生产者 warp 发起 TMA（Tensor Memory Accelerator）加载，消费者 warp 执行 WGMMA（异步 warpgroup 矩阵乘）指令，数据搬运与计算重叠。
- **乒乓调度。** 两个 warpgroup 交替执行：一个做 softmax 时另一个做 GEMM，把较慢的指数运算藏在矩阵乘后面。在同一个 warpgroup 内，上一块的 softmax 也和下一块的 GEMM 流水化。
- **FP8 与非相干处理（incoherent processing）。** FP8 让 Tensor Core 吞吐翻倍，但精度下降，而 LLM 激活中的离群值会放大误差。FA3 在量化前把 Q、K 乘以一个随机正交矩阵（基于 Hadamard 变换）来打散离群值；论文报告数值误差比基线 FP8 注意力低 2.6 倍。

论文报告 FP16 最高 740 TFLOPs（约 H100 峰值的 75%），FP8 接近 1.2 PFLOPs。

## 7. 推理：解码是另一类问题

自回归解码时，每一步每个序列只有**一个** query token，要去关注很长的 KV Cache。`Q` 块极小，按 `Q` 块并行几乎没有并行度，小 batch 下 GPU 大部分时间都闲着。

**Flash-Decoding**（Dao, Haziza, Massa, Sizov, 2023）改为沿 **KV 序列** 切块并行处理，每块输出一个部分结果和对应的 log-sum-exp，最后用一个小的归约 kernel 按在线 softmax 同样的缩放规则合并。作者报告在超长序列上解码最高快 8 倍。

在推理服务栈里还有两件事很重要：

- **分页 KV Cache。** vLLM 的 PagedAttention 把 KV 存在固定大小的块里，用块表索引。FlashAttention 增加了 `block_table` 参数，kernel 可以直接读取分页缓存；FlashInfer 是另一个围绕分页和不规则布局设计的 kernel 库。
- **变长批处理。** `flash_attn_varlen_func` 接收打包后的序列和累计偏移（`cu_seqlens`），避免 padding 浪费。训练中的序列打包也靠它实现，且不同文档之间不会互相干扰。

## 8. 工程实践

在 PyTorch 中最简单的入口是 `scaled_dot_product_attention`，它会根据 dtype、硬件、头维度和 mask，分派到 FlashAttention、内存高效 kernel（源自 xFormers）、cuDNN 注意力或数学回退实现：

```python
import torch
import torch.nn.functional as F
from torch.nn.attention import sdpa_kernel, SDPBackend

q = torch.randn(2, 16, 8192, 128, device="cuda", dtype=torch.bfloat16)
k = torch.randn_like(q)
v = torch.randn_like(q)

# 强制使用 flash 后端；输入不支持时会抛错
with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
    out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
```

需要更多控制（GQA、滑动窗口、分页 KV、变长）时，直接使用 `flash-attn` 包：

```python
from flash_attn import flash_attn_func

# 形状：(batch, seqlen, heads, head_dim)；GQA 时 k/v 的头数可以更少
out = flash_attn_func(q, k, v, causal=True, window_size=(4096, 0))
```

工程要点：

- **dtype 与硬件。** Flash kernel 需要 fp16 或 bf16。FA2 支持 Ampere、Ada 和 Hopper；FA3 面向 Hopper。在更老的 GPU 上，SDPA 会回退到内存高效或数学实现。
- **任意 mask 会打破快速路径。** 稠密布尔 mask 意味着要从 HBM 读一个 `N × N` 张量，等于前功尽弃。优先用 `is_causal`、滑动窗口或变长打包。确实需要自定义模式时，PyTorch 的 FlexAttention 能把自定义分数修改和块稀疏 mask 编译成融合 kernel。
- **确定性。** 某些配置下反向对 `dQ` 使用原子加，梯度不一定逐位可复现；flash-attn 提供 `deterministic` 开关，代价是一些速度。
- **数值。** 结果在浮点运算重排序的意义上是精确的。和数学实现有微小差异属于正常现象，不是 bug。

### 它解决不了什么

FlashAttention 保持注意力**精确**，FLOPs 仍然是二次方的。它推倒了显存墙，但没有推倒算力墙。对超长上下文，团队通常还会结合：

- 滑动窗口或块稀疏注意力（FLOPs 更少，但模型行为不同）。
- 上下文并行，例如 Ring Attention：把序列切分到多张 GPU 上，K/V 块沿环传递，合并时复用同样的在线 softmax 规则。
- 推理时的 KV Cache 压缩：GQA/MQA、多头潜在注意力（MLA）或 KV 量化。

## 总结

- 用字节而不只是 FLOPs 来做性能分析。二次方张量上的逐元素操作才是真正的成本。
- 在线 softmax 把全局归约变成流式归约，这同时支撑了分块、kernel 融合、Flash-Decoding 和 Ring Attention。
- 在融合 kernel 内部重算，可以比存储中间结果更快。
- 每一代 GPU 都会转移瓶颈：FA2 针对 Ampere 上矩阵乘与非矩阵乘的吞吐差距，FA3 针对 Hopper 的异步能力与 FP8。

## 参考资料

- Dao et al., *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*, NeurIPS 2022. [arXiv:2205.14135](https://arxiv.org/abs/2205.14135)
- Dao, *FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning*, 2023. [arXiv:2307.08691](https://arxiv.org/abs/2307.08691)
- Shah et al., *FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision*, 2024. [arXiv:2407.08608](https://arxiv.org/abs/2407.08608)
- Milakov & Gimelshein, *Online normalizer calculation for softmax*, 2018. [arXiv:1805.02867](https://arxiv.org/abs/1805.02867)
- Rabe & Staats, *Self-attention Does Not Need O(n²) Memory*, 2021. [arXiv:2112.05682](https://arxiv.org/abs/2112.05682)
- Dao, Haziza, Massa, Sizov, *Flash-Decoding for long-context inference*, 2023. [PyTorch 博客](https://pytorch.org/blog/flash-decoding/)
- [GitHub 上的 Dao-AILab/flash-attention](https://github.com/Dao-AILab/flash-attention)
- [PyTorch `scaled_dot_product_attention` 文档](https://pytorch.org/docs/stable/generated/torch.nn.functional.scaled_dot_product_attention.html)
