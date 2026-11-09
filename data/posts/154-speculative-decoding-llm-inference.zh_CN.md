---
title: "深入投机解码：为什么大模型一次前向就能生成多个 Token，而输出分布完全不变"
tag: ai
description: 投机解码如何加速 LLM 推理——为什么解码受限于显存带宽、"先提议后验证"的循环、可证明保持目标分布的改进拒绝采样规则、期望加速比的推导，以及从独立小模型到 Medusa 头、EAGLE、多 Token 预测、Lookahead 与 Prompt Lookup 解码的方案谱系，还有 vLLM 等推理服务如何处理批处理
date: "2026-11-09T14:25:00.000Z"
---

## Goal

一个 70B 参数的模型逐个生成 Token 时，每一步的大部分时间其实不在计算，而在等待：每次解码都要把全部权重从 HBM 搬到计算单元，却只为每条序列产出一个 Token。投机解码（Speculative Decoding）让模型在**一次昂贵的前向传播里产出多个 Token**，同时输出与普通解码**分布完全相同**。它已经内置在 vLLM、SGLang、TensorRT-LLM 和 Hugging Face Transformers 中，其变体（EAGLE、多 Token 预测）也已在生产模型中落地。

本文包括：

1. 为什么自回归解码受限于显存带宽，以及为什么验证 k 个 Token 的成本和生成 1 个差不多。
2. "先提议、后验证"的循环。
3. 改进的拒绝采样规则及其无损性证明，并附一段可运行的 Python 模型来验证。
4. 期望加速比公式与 k 的选择。
5. 方案谱系：独立小模型、Medusa、EAGLE、多 Token 预测、Token 树、Lookahead 与 Prompt Lookup 解码。
6. 生产问题：批处理、KV Cache 回滚，以及投机何时不再划算。

## 1. 解码受限于显存带宽

解码时每个新 Token 都需要一次完整前向。对单条序列来说，矩阵乘法实际上是矩阵乘向量：每个权重加载一次，只为这一个 Token 做一次乘加。按 Roofline 模型粗略估算：H100 这类加速器每字节 HBM 带宽对应数百 FLOPs 的算力，而 batch=1 的解码每个权重（FP16 占 2 字节）只做约 2 次浮点运算，算术强度约 1 FLOP/字节，比硬件能承受的低两个数量级。芯片大部分时间在空等内存。

关键推论：**只要 k 不大，让模型一次处理 k+1 个位置，耗时几乎和处理 1 个位置相同**。权重无论如何只加载一次，多出来的位置只是把矩阵乘向量变成"瘦长"的矩阵乘矩阵，用的是原本闲置的算力。这也正是 Prefill 阶段每个 Token 比生成阶段快得多的原因。

所以，如果能廉价地*猜*出接下来几个 Token，大模型就能在一次前向里把这些猜测全部检查一遍。

## 2. 先提议，后验证

投机解码（Leviathan、Kalman 与 Matias，ICML 2023；DeepMind 的 Chen 等人 2023 年独立提出）涉及两个模型：

- **目标模型** `p`：我们想要其输出分布的大模型。
- **提议者** `q`：近似 `p` 的廉价组件，可以是同系列小模型、挂在目标模型上的额外头，甚至是字符串匹配启发式。

一轮迭代：

1. 提议者自回归地生成 k 个候选 Token `x1..xk`，并记录各自的分布 `q1..qk`。
2. 目标模型对"前缀 + `x1..xk`"做**一次**前向，得到每个位置的分布 `p1..p(k+1)`。
3. 从左到右按下面的规则逐个接受或拒绝；遇到第一次拒绝时，用修正后的 Token 替换它，丢弃其后所有候选。
4. 如果 k 个全部接受，还能从 `p(k+1)` 免费多拿一个"奖励" Token。

每轮迭代用一次目标前向产出 1 到 k+1 个 Token。最坏情况（全部被拒）仍能得到一个正确 Token，所以输出质量永远不会比普通解码差，浪费的只是提议者的时间。

## 3. 接受规则与无损性

贪心解码时规则很直观：当且仅当 `xi` 等于 `argmax pi` 时接受。随机解码（温度、top-p）则要求更强：产出的 Token 必须**严格**服从 `p`，而不是"接近"。规则是拒绝采样的一个变体：

- 以概率 `min(1, p(x) / q(x))` 接受提议的 Token `x`。
- 若被拒绝，从**残差分布** `norm(max(0, p(x) − q(x)))` 中重新抽取一个替代 Token。

为什么结果恰好是 `p`：最终 Token 为 `x` 的概率是

```
P(提议 x 且接受)               + P(拒绝) · residual(x)
= q(x) · min(1, p(x)/q(x))    + (1 − Σ min(p, q)) · max(0, p(x) − q(x)) / Σ max(0, p − q)
= min(p(x), q(x))             + max(0, p(x) − q(x))
= p(x)
```

中间一步用到 `Σ max(0, p − q) = 1 − Σ min(p, q)`，归一化因子正好抵消拒绝概率。提议者高估的 Token，多出的部分被拒掉；低估的 Token，缺少的概率质量由残差分布精确补齐。证明不依赖 `q` 的好坏：差的提议者只会降低接受率，永远不会损害质量。

注意温度、top-k、top-p 必须对 `p` 和 `q` **同样**施加后再比较；该规则保持的是你交给它的*处理后*分布。

### 可运行的验证

下面的脚本用两个只有 6 个 Token 的玩具"模型"（提议者是目标分布的平滑版），把投机步骤运行 20 万次，再把首个产出 Token 的分布与直接从目标分布抽取的结果对比：

```python
import random
from collections import Counter

VOCAB = list(range(6))

def target_dist(ctx):
    last = ctx[-1] if ctx else 0
    w = [((last + i) % 6) + 1 for i in VOCAB]
    s = sum(w)
    return [x / s for x in w]

def proposer_dist(ctx):
    p = target_dist(ctx)
    return [0.6 * x + 0.4 / 6 for x in p]   # cheaper, flatter guess

def draw(dist, rng):
    return rng.choices(VOCAB, weights=dist, k=1)[0]

def speculative_step(ctx, k, rng):
    proposed, qs, c = [], [], list(ctx)
    for _ in range(k):
        q = proposer_dist(c)
        t = draw(q, rng)
        proposed.append(t); qs.append(q); c.append(t)
    # A real system gets all k+1 target distributions from ONE forward pass.
    out, c = [], list(ctx)
    for t, q in zip(proposed, qs):
        p = target_dist(c)
        if rng.random() < min(1.0, p[t] / q[t]):
            out.append(t); c.append(t)
        else:
            resid = [max(0.0, pi - qi) for pi, qi in zip(p, q)]
            z = sum(resid)
            out.append(draw([r / z for r in resid], rng))
            return out
    out.append(draw(target_dist(c), rng))  # bonus token
    return out
```

我这次运行的结果（种子 42，上下文 `[3]`，k = 4）：

| Token | 精确 p | 投机解码 | 普通解码 |
|---|---|---|---|
| 0 | 0.1905 | 0.1910 | 0.1924 |
| 1 | 0.2381 | 0.2383 | 0.2365 |
| 2 | 0.2857 | 0.2847 | 0.2848 |
| 3 | 0.0476 | 0.0474 | 0.0476 |
| 4 | 0.0952 | 0.0963 | 0.0958 |
| 5 | 0.1429 | 0.1423 | 0.1430 |

投机解码这一列与精确分布的吻合程度和普通解码一样，差异只是蒙特卡洛噪声。

## 4. 能快多少：推导

设 α 为一个提议 Token 被接受的概率。对单个位置，α = Σ min(p, q) = 1 − TV(p, q)，即 1 减去总变差距离。假设每个位置的 α 相同，每次目标前向产出的 Token 数是一个截断几何级数：

```
E[每轮产出 Token 数] = (1 − α^(k+1)) / (1 − α)
```

玩具模型中 α = 0.9143（按构造在所有上下文中都相同），模拟结果与公式一致：

| k | 模拟值 | 公式值 |
|---|---|---|
| 1 | 1.914 | 1.914 |
| 2 | 2.745 | 2.750 |
| 4 | 4.207 | 4.213 |
| 8 | 6.468 | 6.459 |

每次前向产出的 Token 数并不等于实际墙钟加速比。如果提议者一步的成本是目标模型一步的 c 倍，一轮大约花费 `k·c + 1` 个目标步，于是

```
加速比 ≈ (1 − α^(k+1)) / ((1 − α) · (k·c + 1))
```

由此得出两点：

- **k 的收益递减很快。** 表中 k 从 4 增到 8 只多出约 2.3 个 Token，提议成本却翻倍；真实场景 α 常在 0.6–0.8，曲线会更早变平。
- **提议成本和准确率同等重要。** 成本为目标 10%、α = 0.8 的提议者，胜过成本 30%、α = 0.85 的。这正是业界从独立小模型转向"挂在目标模型上的头"的原因。

真实的 α 随内容差异很大：样板代码、JSON、照抄提示词的文本高度可预测；高温度下的创意写作则不然。原始论文报告 T5-XXL 约 2–3 倍（Leviathan 等）、Chinchilla 70B 约 2–2.5 倍（Chen 等），这些数字强烈依赖负载、硬件和批大小。

## 5. 提议者的方案谱系

### 5.1 独立小模型

经典做法：例如用同系列 1B 模型给 70B 模型提议，共享分词器。Hugging Face Transformers 称之为 "assisted generation"（`generate` 的 `assistant_model=` 参数）。简单有效，但需要部署、加载并维护第二个模型，它的 KV Cache 也占显存。

### 5.2 Medusa：额外的解码头

Medusa（Cai 等，2024）在目标模型最后一层隐藏状态上加若干轻量头，第 i 个头预测往后第 i+1 个位置的 Token。无需第二个模型，头的训练成本很低（Medusa-1 冻结主干）。由于各头独立预测，它在每个位置给出多个候选，组合成一棵**树**，用树形注意力掩码一次验证。弱点是：第 i 个头不知道前面的头选了什么，距离越远准确率下降越快。

### 5.3 EAGLE：在特征层做自回归

EAGLE（Li 等，2024）发现预测下一个*隐藏特征*比直接预测下一个 Token 更容易。它训练一个很小的单层 Transformer，输入目标模型顶层特征和已选 Token，自回归地预测后续特征，再交给目标模型自己的 LM Head 转成 Token。把已选 Token 作为输入，解决了 Medusa 忽略的不确定性。EAGLE-2 根据置信度动态构造候选树，EAGLE-3 则融合多层特征。EAGLE 系列是目前 vLLM 和 SGLang 中支持最广泛的方案之一。

### 5.4 训练时内置的多 Token 预测

DeepSeek-V3 训练时带有额外的多 Token 预测（MTP）模块，多预测一个未来 Token。推理时该模块可直接当提议者；技术报告称第二个 Token 的接受率约 85%–90%，每秒 Token 数提升约 1.8 倍。当模型在训练时就为投机而设计，提议者几乎是免费的。

### 5.5 Token 树

不只提议一条长 k 的链，而是提议一棵树：每个深度给出多个备选。SpecInfer（Miao 等，2023）证明目标模型可以把整棵树展平，用"每个节点只关注其祖先"的注意力掩码一次前向全部验证。配合无损的多分支接受规则，一条分支未命中时兄弟分支还能补救，从而提高期望接受长度。代价是每次验证的位置更多，会吃掉"几乎免费"的算力预算，大批量时尤其明显。

### 5.6 完全不用模型：Lookahead 与 Prompt Lookup

- **Prompt Lookup 解码**（Saxena，2023）在提示词中查找最近生成的几个 Token 构成的 n-gram，把提示词中紧随其后的内容作为提议。无需训练、成本几乎为零，对摘要、代码编辑、引用原文的 RAG 回答非常有效。vLLM 以 n-gram 提议器的形式提供它。
- **Lookahead 解码**（Fu 等，2024）用 Jacobi 迭代让目标模型自身并行生成 n-gram，缓存后从中挑选候选再验证，同样不需要额外模型。

| 提议者 | 额外权重 | 训练 | 典型优势 |
|---|---|---|---|
| 独立小模型 | 一个完整模型 | 无（复用） | 通用文本，易于接入 |
| Medusa 头 | 若干个头 | 轻量 | 集成简单 |
| EAGLE | 约一层 | 中等 | 接受率高，支持广泛 |
| MTP 模块 | 内置 | 预训练阶段 | 模型自带时几乎免费 |
| Prompt Lookup / n-gram | 无 | 无 | 复制密集型任务：编辑、RAG、摘要 |
| Lookahead | 无 | 无 | 没有训练预算时 |

## 6. 生产环境的问题

**批处理会吃掉免费午餐。** 第 1 节的论证假设 GPU 受限于显存带宽。批很大时解码步骤已接近算力瓶颈，每条序列多验证 k 个位置要花真实算力，被拒的 Token 纯属浪费。因此推理服务通常把投机解码视为延迟优化，在低到中等负载下收益最大；有的系统会随批大小调整 k，甚至关闭投机。

**KV Cache 回滚。** 候选 Token 会为可能被拒的位置写入 KV。引擎必须把该序列的 KV Cache 截断到最后一个被接受的位置。在分页 KV Cache（vLLM 的 PagedAttention）下这基本是簿记工作：释放或复用尾部块；提议者自己的缓存也要同样处理。

**参差不齐的接受长度。** 同一批中序列 A 可能接受 4 个 Token，B 一个都没接受。内核和调度器必须处理每步长度不一的推进，这让 CUDA Graph 和固定形状的批处理更复杂。

**正确性很微妙。** 只有当 `p` 和 `q` 经过完全相同的后处理（温度、top-p、重复惩罚、语法约束）时，无损保证才成立。这里的 Bug 会让输出*轻微*偏离目标分布，极难察觉。比如用贪心规则去验证随机提议，就是常见错误。

**用自己的流量来衡量。** α 依赖负载，选择方案和 k 唯一可靠的办法是回放真实请求，在实际并发下测量接受长度与端到端延迟。

## 总结

- 解码受限于显存带宽，所以检查 k+1 个位置的成本与生成 1 个相当。
- 廉价提议、目标模型一次前向验证、以 `min(1, p/q)` 接受、从 `max(0, p − q)` 修复拒绝，输出分布可证明保持不变。
- 每次前向的期望 Token 数为 `(1 − α^(k+1)) / (1 − α)`；提议成本与接受率共同决定真实加速比。
- 方案从独立小模型演进到解码头（Medusa）、特征层提议（EAGLE）、训练内置 MTP，以及无模型的 n-gram 方法，并用 Token 树提高接受长度。
- 在线服务中，批处理、KV 回滚以及两侧分布的一致后处理，决定理论加速能否兑现。

## 参考资料


- Leviathan, Kalman, Matias. *Fast Inference from Transformers via Speculative Decoding*. ICML 2023. [arXiv:2211.17192](https://arxiv.org/abs/2211.17192)
- Chen et al. *Accelerating Large Language Model Decoding with Speculative Sampling*. 2023. [arXiv:2302.01318](https://arxiv.org/abs/2302.01318)
- Stern, Shazeer, Uszkoreit. *Blockwise Parallel Decoding for Deep Autoregressive Models*. NeurIPS 2018. [arXiv:1811.03115](https://arxiv.org/abs/1811.03115)
- Cai et al. *Medusa: Simple LLM Inference Acceleration Framework with Multiple Decoding Heads*. 2024. [arXiv:2401.10774](https://arxiv.org/abs/2401.10774)
- Li et al. *EAGLE: Speculative Sampling Requires Rethinking Feature Uncertainty*. 2024. [arXiv:2401.15077](https://arxiv.org/abs/2401.15077)
- Miao et al. *SpecInfer: Accelerating Generative LLM Serving with Tree-based Speculative Inference and Verification*. 2023. [arXiv:2305.09781](https://arxiv.org/abs/2305.09781)
- Fu et al. *Break the Sequential Dependency of LLM Inference Using Lookahead Decoding*. 2024. [arXiv:2402.02057](https://arxiv.org/abs/2402.02057)
- DeepSeek-AI. *DeepSeek-V3 Technical Report*. 2024. [arXiv:2412.19437](https://arxiv.org/abs/2412.19437)
- [Prompt lookup decoding](https://github.com/apoorvumang/prompt-lookup-decoding)
- [vLLM documentation: Speculative Decoding](https://docs.vllm.ai/en/stable/features/spec_decode.html)
