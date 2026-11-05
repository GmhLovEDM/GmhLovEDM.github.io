---
title: "Mixture of Experts 深挖：路由、负载均衡、专家并行与稀疏 Transformer 推理"
tag: ai
description: 稀疏 MoE Transformer 到底怎么工作——token-choice 与 expert-choice 路由、top-k 门控与辅助均衡损失、capacity factor 与 dropless 设计、DeepSeekMoE 的共享专家、专家并行与 all-to-all，以及 Switch、GShard、Mixtral、ST-MoE、DeepSeek-V3 对训练和 vLLM 一类推理栈的影响
date: "2026-11-05T11:20:00.000Z"
---

## Goal

稠密 Transformer 对每个 token 使用同一套前馈权重。Mixture-of-Experts（MoE）层打破了这一点：一个廉价的 **router** 为每个 token 只激活少数几个专家 MLP，于是总参数量可以远超稠密 FLOPs 所能支撑的规模，而每个 token 的激活计算量大致保持不变。GShard 与 Switch Transformer 把这条路走通，Mixtral 与 DeepSeekMoE / DeepSeek-V2/V3 又把它带回开放生态。

本文关注让稀疏 MoE 真正可训练、可服务的算法与系统，而不是「更大就更好」的空泛叙述：

1. MoE 层在 Transformer 里替换了什么，以及容量与 FLOP 的交换。
2. Token-choice 与 expert-choice 路由。
3. Top-k 门控、门控权重，以及一段已核验的 NumPy 示例。
4. 负载均衡：辅助损失、capacity factor、丢弃、dropless MoE，以及 DeepSeek-V3 的 bias 方案。
5. 专家并行、all-to-all 的 dispatch/combine 与通信量形态。
6. 共享专家与细粒度专家切分（DeepSeekMoE）。
7. Switch、Mixtral、ST-MoE、DeepSeek-V3 的路由差异对照。
8. vLLM / SGLang / TensorRT-LLM 一类推理引擎上的服务含义。
9. 何时 MoE 优于稠密模型，何时并不值得。

## 1. 稀疏容量，稠密 FLOPs

标准 Transformer block 里，attention 之后最贵的是位置级 FFN（今天常见 SwiGLU）：两到三个稠密线性映射，对每个 token 一视同仁。MoE 层保留稠密 attention，把 FFN 换成一组专家 FFN 外加一个 router。

对每个 token \(x\)：

1. Router 产出 \(N\) 个专家上的分数。
2. 稀疏规则只保留 \(k\) 个专家（\(k \ll N\)）。
3. 这 \(k\) 个专家在 \(x\) 上计算，输出按门控权重合成。
4. 未选中的专家对该 token 不做计算。

若每个专家有 \(P\) 个参数，则 MoE 总参数约 \(N \cdot P\)（外加很小的 router），而每个 token 激活参数约 \(k \cdot P\)。Mixtral 8×7B 是开放权重里的典型例子：每层 8 个专家、top-2 路由，总参数约 47B，但每个 token 大约只激活 13B（Jiang et al., 2024）。DeepSeek-V3 把同一思路推得更远：总参数 671B，每个 token 激活 37B（DeepSeek-AI, 2024）。

Attention、embedding 与残差通路仍然看见每个 token。MoE 是在 FFN 路径上的 **条件计算** 赌注：用更多显存占用与更多通信，换近乎固定的每 token FLOPs 下的更大容量。

```text
 token x
    │
    ▼
 router  →  N 个专家分数  →  保留 top-k
    │
    ├──▶ expert e₁(x) ──┐
    ├──▶ expert e₂(x) ──┼── 加权求和 → y
    └──▶ ...            │
```

对比 MoE 与稠密模型时，有两个数字必须同时看：

- **每 token 激活 FLOPs** —— 应接近你真正负担得起训练或推理的稠密基线。
- **驻留在内存中的总参数** —— 随 \(N\) 增长，要靠 EP 与量化来扛。

只报总参数（「671B MoE」）是在说容量；只报激活参数（「37B active」）是在说计算。质量、成本与硬件选型需要两者一起推理。

## 2. Token-choice 与 expert-choice

几乎所有生产级 LLM MoE 都用 **token-choice** 路由：每个 token 独立选择自己的 top-k 专家。这对自回归解码很自然（一次到来一个 token），也与 Switch、Mixtral、DeepSeekMoE 一致。

失败模式是负载不均衡。热门专家被灌满，冷门专家饿死。训练系统因此引入每个专家的 **capacity**——一个微批次里该专家最多接受多少 token——然后要么丢弃溢出，要么为对齐形状做 padding。被丢弃的 token 失去该专家贡献（常用残差或零填充替代），丢弃频繁时会伤质量。

**Expert-choice** 路由（Zhou et al., 2022）把赋值方向反过来：每个专家按亲和度挑选自己的 top-c 个 token。每个专家的容量天然被填满，无需辅助损失即可均衡。代价是单个 token 可能被 0、1 或多个专家选中——每 token 的专家扇入可变——训练动态与解码期服务都更麻烦。Expert-choice 是重要的研究对照；你实际跑的大多数开放 LLM 权重仍是 token-choice。

历史上还有 Shazeer et al.（2017）的 **noisy top-k**：在选专家前给门控 logits 加高斯噪声，鼓励训练早期探索，避免少数专家从第一步就垄断 batch。现代 LLM MoE 常以仔细初始化、辅助项或 DeepSeek 式 bias 更新替代显式噪声。

## 3. Top-k 门控逐步拆解

经典稀疏门控 MoE（Shazeer et al., 2017）及其 Transformer 后代共用同一套核心公式。设 \(W_r\) 为 router 矩阵，对 token \(x\)：

\[
h = W_r x, \qquad
p_i = \frac{e^{h_i}}{\sum_j e^{h_j}}
\]

保留 top-k 下标集合 \(\mathcal{T}\)。层输出为

\[
y = \sum_{i \in \mathcal{T}} p_i \, E_i(x)
\]

（有时只在被选中的专家上对 \(p_i\) 重新归一化）。Switch Transformer 主张在训练稳定时 **k = 1** 就够，从而相对 top-2 削减通信（Fedus, Zoph and Shazeer, 2021）。Mixtral 在 8 个专家上保持 **k = 2**。DeepSeek-V3 在 256 个路由专家中激活 **8** 个，外加共享专家（见 §6），并用 **sigmoid** 亲和度、在选中集合上归一化，而不是对全部专家做 softmax。

下面用 NumPy 演示 softmax top-k 路由与 Switch 风格的辅助负载均衡项。核验环境未安装 Torch，使用的是 NumPy 2.x。

```python
import numpy as np

def softmax(x, axis=-1):
    x = x - np.max(x, axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)

def topk_route(x, W_r, k):
    """x: (B, D), W_r: (D, E) → gates (B, k), indices (B, k)"""
    logits = x @ W_r
    probs = softmax(logits, axis=-1)
    # argpartition 是 O(E)；教学用的 E 足够小
    idx = np.argpartition(-probs, k - 1, axis=-1)[:, :k]
    rows = np.arange(x.shape[0])[:, None]
    gates = probs[rows, idx]
    gates = gates / gates.sum(axis=-1, keepdims=True)
    return gates, idx, probs

def switch_aux_loss(probs, idx, k):
    """Switch 风格：E * sum_i f_i * P_i（按 batch 平均）。"""
    B, E = probs.shape
    rows = np.arange(B)[:, None]
    one_hot = np.zeros_like(probs)
    one_hot[rows, idx] = 1.0 / k
    f = one_hot.mean(axis=0)          # 路由到专家 i 的 token 比例
    P = probs.mean(axis=0)            # 专家 i 的平均 router 概率
    return float(E * np.sum(f * P))

rng = np.random.default_rng(0)
B, D, E, K = 8, 16, 8, 2
x = rng.normal(size=(B, D))
W_r = rng.normal(size=(D, E)) * 0.1
gates, idx, probs = topk_route(x, W_r, K)
aux = switch_aux_loss(probs, idx, K)
assert np.allclose(probs.sum(-1), 1.0)
assert np.allclose(gates.sum(-1), 1.0)
print("aux", round(aux, 4), "idx[0]", idx[0].tolist())
```

固定种子下会打印有限的辅助损失值，以及第一行 token 的 top-2 专家下标。真实训练步里还要把 token dispatch 到专家模块（常在远端 rank），跑完 FFN 再用 `gates` combine。

### 3.1 单机上的微型端到端 MoE 步

下一段展示 gather → 专家 MLP → scatter-combine 的完整形状。仍是纯 NumPy，但与融合 CUDA kernel 隐藏的数据布局一致。

```python
def moe_forward(x, W_r, expert_w1, expert_w2, k):
    """x: (B, D); expert_w1: (E, H, D); expert_w2: (E, D, H)"""
    gates, idx, _ = topk_route(x, W_r, k)          # (B, k), (B, k)
    B, D = x.shape
    E, H, _ = expert_w1.shape
    out = np.zeros((B, D), dtype=x.dtype)
    # 为清晰起见用循环 —— 真实系统用 grouped GEMM
    for b in range(B):
        for j in range(k):
            e = int(idx[b, j])
            h = np.maximum(0.0, expert_w1[e] @ x[b])  # ReLU MLP
            y = expert_w2[e] @ h
            out[b] += gates[b, j] * y
    return out

H = 32
expert_w1 = rng.normal(size=(E, H, D)) * 0.05
expert_w2 = rng.normal(size=(E, D, H)) * 0.05
y = moe_forward(x, W_r, expert_w1, expert_w2, K)
assert y.shape == x.shape
print("moe out std", float(y.std()))
```

Router **z-loss**（ST-MoE；Zoph et al., 2022）对 \(\log\sum_i e^{h_i}\)（或同类量）加惩罚，使 router logits 保持良好尺度；没有它时，即便辅助均衡项看起来正常，深层稀疏堆叠也可能数值发散。

## 4. 不伤质量的负载均衡

不均衡路由既是质量问题（专家坍缩），也是系统问题（专家并行下的长尾）。主流修法大致三类。

### 4.1 辅助负载均衡损失

GShard 与 Switch 推广了与 \(\sum_i f_i P_i\) 成正比（再乘 \(N\)）的辅助项，促使硬分配到专家 \(i\) 的 token 比例跟踪该专家的平均 router 概率。理想均衡时 \(f_i = P_i = 1/N\)，缩放后的项等于 \(1\)。权重过大时，router 会牺牲主任务损失去换均衡——专家变得可互换，质量下降。ST-MoE 及后续工作把该权重当成一等超参，并常与 z-loss 联用。

### 4.2 Capacity factor 与丢弃

对 \(T\) 个 token 的微批次、\(N\) 个专家、top-k 路由，均衡时每个专家大约看到 \(k T / N\) 个 token。**Capacity factor** \(c\) 定义为

\[
\mathrm{capacity} = c \cdot \frac{k T}{N}
\]

超出 capacity 的 token 被丢弃（或进入缓冲）。\(c = 1.0\) 很紧；略大于 \(1\) 的取值用更多计算/内存换更少丢弃。固定形状下丢弃实现简单——对 XLA/TPU 友好——但训练信号会被部分丢掉。在专家并行下，capacity 也限制每个 rank 必须接收的 token 数，从而约束 all-to-all 缓冲。

```python
def apply_capacity(idx, k, n_experts, capacity):
    """返回布尔掩码 (B, k)：False 表示该赋值被丢弃。"""
    B = idx.shape[0]
    counts = np.zeros(n_experts, dtype=np.int32)
    keep = np.zeros((B, k), dtype=bool)
    # 按 token 顺序处理 —— 生产代码可能先按门控分数排序
    for b in range(B):
        for j in range(k):
            e = int(idx[b, j])
            if counts[e] < capacity:
                keep[b, j] = True
                counts[e] += 1
    return keep, counts

T, capacity_factor = B, 1.25
cap = int(capacity_factor * (K * T) / E)
keep, counts = apply_capacity(idx, K, E, max(cap, 1))
print("capacity", cap, "per-expert counts", counts.tolist(), "kept", int(keep.sum()))
```

### 4.3 Dropless MoE

MegaBlocks（Gale et al., 2022/2023）把 MoE 计算改写成按真实 token→专家赋值尺寸的 **block-sparse** 矩阵乘。这样不必为形状去 pad 到固定 capacity，也不必为此丢 token，代价是更复杂的 GPU kernel 与每专家可变工作量。Tutel 与 FasterMoE 则攻坚相关瓶颈（grouped GEMM、通信调度、专家放置）。在可接受动态形状的 GPU 上，dropless 训练很有吸引力；TPU/XLA 栈历史上更偏爱固定 capacity。

### 4.4 无辅助损失的均衡（DeepSeek-V3）

DeepSeek-V3 保留 sigmoid 的 token–专家亲和度与 top-k 选择，但为每个专家增加仅用于路由决策的 **bias** \(b_i\)：

\[
\text{按 } s_{i,t} + b_i \text{ 做路由，}\qquad
\text{但仍用 } s_{i,t} \text{ 做混合}
\]

每个训练步结束后，过载专家的 bias 减小，欠载专家的 bias 增大，步长为 \(\gamma\)。乘到专家输出上的门控值仍来自无 bias 的亲和度，因此均衡机制不会直接扭曲残差混合。报告还保留了一个极小的序列级均衡损失，避免单条序列极端倾斜，并称在该方案下 DeepSeek-V3 训练中不丢 token（DeepSeek-AI, 2024）。报告中的消融表明，在多数评测上 bias 方案优于纯辅助损失基线。

直觉上：bias 像作用在专家热度上的慢速积分控制器；辅助损失则是逐步软约束 router 权重本身。软约束可能与主损失对抗；放在梯度路径之外的 bias 往往对抗得更少。

## 5. 专家并行与 all-to-all

一旦专家放不进单卡，**专家并行（EP）** 就会把不同专家放到不同 rank。一次 MoE 前向于是变成：

1. **Route**：各 rank 本地 hidden → 专家 id + gates。
2. **Dispatch** all-to-all：把 token 发到拥有其专家的 rank。
3. **Compute**：在收到的 token 上跑本地专家（常为 grouped GEMM）。
4. **Combine** all-to-all：把专家输出送回 token 原点 rank，按 gates 加权求和。

```text
 rank0 tokens ──dispatch──▶ 专家分片（EP ranks）
 rank1 tokens ──dispatch──▶        │
                                   ▼
                            本地专家 FFN
                                   │
 rank0 ◀──combine──────────────────┤
 rank1 ◀──combine──────────────────┘
```

通信量大致与 token 数 × hidden 大小 × \(k\) 成正比（每个 token 发往 \(k\) 个专家）。跨节点 EP 尤其痛苦，因为节点内 NVLink 带宽远高于节点间 RDMA。DeepSeek-V3 因此采用 **节点受限路由**：每个 token 最多触及 \(M\) 个节点（他们取 \(M = 4\)），按每节点亲和度质量聚合来选节点，从而限制 IB 流量，再由 NVLink 完成节点内投递。其 DualPipe 调度把 attention/MLP 计算与 dispatch、combine 重叠，使得在其集群的计算/通信比下，all-to-all 几乎可以被隐藏（DeepSeek-AI, 2024）。

其它并行维度仍然适用：

| 并行 | 切分对象 | 与 MoE 的关系 |
| --- | --- | --- |
| Data（DP / FSDP / ZeRO） | batch | 每个 DP rank 跑自己的 router；EP 组嵌在其中 |
| Tensor（TP） | 矩阵维度 | Attention 常做 TP；EP 很宽时 MoE 专家可避开 TP |
| Pipeline（PP） | 层 | MoE 层只是更重的 PP stage，内部再套 EP |
| Expert（EP） | 专家 | 主导 MoE 通信 |

经验法则：把 EP 加宽到每个专家的 token batch 足以喂饱 GEMM 为止——再加 EP 只会增大 all-to-all 扇出，却不提升算术强度。DeepSeek-V3 公开的预训练布局使用跨 8 节点的 64 路 EP，配合 pipeline 与 ZeRO-1 数据并行，有意在 MoE 路径上避免沉重的张量并行，以节省显存与通信（DeepSeek-AI, 2024）。

### 5.1 Dispatch 缓冲如何定尺寸

每个 EP rank 需要大到能容纳「最坏情况下落到本地专家的 token 数」的接收缓冲。有 capacity factor \(c\) 时，最坏情况有上界；无 capacity（dropless）时，则按经验峰值定尺寸或动态分配。推理引擎常按配置的最大批 token 数 × \(k\) 预分配，再靠路由约束（以及有时的冗余专家）保证不越界。

## 6. 共享专家与细粒度 DeepSeekMoE

经典 MoE 把每个专家都当作 top-k 的可互换候选。DeepSeekMoE（Dai et al., 2024）加了两条结构想法：

1. **细粒度切分。** 把原来的 \(N\) 个粗专家拆成 \(mN\) 个更小的，并激活 \(m k\) 个。激活 FLOPs 大致不变，但可组合的专家混合物更丰富，论文认为这有助于专业化。
2. **共享专家隔离。** 始终开启的共享 FFN 捕捉共性知识；路由专家做特化。这减少了路由专家之间的冗余。

DeepSeek-V3 的实例是 **1 个共享专家 + 256 个路由专家**，每 token 激活 **8** 个路由专家，每个专家中间维度 2048，亲和度用 sigmoid（DeepSeek-AI, 2024）。相比之下，Mixtral 使用 8 个全尺寸专家与 top-2，没有共享专家——更简单、专家更少、特化更粗。

共享专家也改变服务形态：它们本质上是始终运行的稠密 FFN，需要小心放置，以免相对路由路径成为长尾。DeepSeek 的解码部署说明甚至把共享专家视为负载规划中「总是被选中」的专家，再把热门路由专家的副本放到空闲 rank。

## 7. 一张简短对照表

| 系统 | 路由 | 均衡 | 显著系统选择 |
| --- | --- | --- | --- |
| Shazeer et al. 2017 | noisy top-k | importance / load 损失 | LSTM 之间的 MoE |
| GShard（2020） | top-2 | 辅助损失 + capacity | TPU 自动切分；大规模翻译 MoE |
| Switch（2021） | top-1 | 辅助损失 + capacity | 简化路由；bfloat16 稀疏训练 |
| ST-MoE（2022） | top-k | 辅助 + **router z-loss** | 关注稳定性与迁移 |
| Expert-Choice（2022） | 专家选 token | 设计上即均衡 | 每 token 专家数可变 |
| MegaBlocks（2022） | token-choice | block-sparse kernel 实现 dropless | 避开丢弃/padding 权衡 |
| Mixtral（2024） | 8 选 top-2 | 常规 MoE 训练 | 开放权重；约 47B 总 / 约 13B 激活 |
| DeepSeekMoE / V3 | 256 选 top-8 + 共享 | **bias**（+ 极小序列辅助） | 节点受限路由；声称训练不丢 token |

DeepSeek-V2/V3 中的 MLA（Multi-head Latent Attention）与 MoE 正交：MLA 压缩 attention 的 KV cache，MoE 稀疏化 FFN。它们在服务期会叠加——更少的 KV 流量与更少的激活 FFN 权重——但算法彼此独立；本文只站在 MoE 一侧。

## 8. 稀疏 MoE 的推理服务

训练期的 all-to-all 与推理期的 all-to-all 形似，但 decode batch 更小、对延迟更敏感。

**Prefill** 像训练：序列长、token 多，EP 能把专家喂饱。**Decode** 每步每条序列只吐一个 token；若不认真做批处理，每个专家看到的 GEMM 极小，router/dispatch 开销反而占主导。连续批处理通过提高并发序列数，间接让每个 step 有更多 token 进入专家。

实务上的服务栈（vLLM 的 fused MoE 路径、SGLang、TensorRT-LLM 的 MoE 插件）通常会：

- 把路由、dispatch、专家 GEMM 与 combine 融进少量 kernel，削减显存流量。
- 跨 GPU 支持 EP，有时为吞吐与延迟准备不同的 all-to-all 后端。
- 对专家权重做激进量化（FP8 / INT4 一类），因为相对激活 FLOPs，MoE 模型更吃显存。
- 可选地复制热门专家（**冗余专家**），以便提示分布相对训练漂移时 decode 负载仍均衡——DeepSeek-V3 的部署说明描述了为 prefill 与 decode 周期性复制热专家。

vLLM 的设计文档描述了一种模块化 fused MoE kernel：把 prepare/finalize（量化、all-to-all dispatch/combine）与专家计算路径（permute、matmul、激活、unpermute）分开。这样同一套专家 GEMM 可以对接多种通信后端，而不必重写数学。

与激活规模相近的稠密模型相比，MoE 服务：

- 需要更多 GPU 显存（除非卸载，否则全部专家常驻）。
- 需要更多互连带宽做 EP。
- 在 checkpoint 够强时，单位激活 FLOP 可换更高质量。
- 对 batch 组成更敏感：即便平均负载看起来正常，过度集中在单一专家的 batch 也会制造长尾。

若流量是单 GPU 上的低 QPS 单流对话，稠密 7B–70B 模型往往运维更简单。当有足够并发序列摊销路由成本、且内存/互连能装下整个专家库时，MoE 才真正发光。

### 8.1 生产环境值得盯的指标

- 每步每专家的 token 数（看直方图，不要只看均值）。
- Dispatch/combine 时间相对专家 GEMM 时间。
- 丢弃率（若启用 capacity）或最大专家占用（若 dropless）。
- 热专家身份随时间的漂移——这是刷新冗余副本的信号。
- 更改 \(k\)、量化或 EP 度数后的质量回退——分布一变，路由就很脆。

## 9. 相对稠密模型的工程权衡

**更适合选 MoE 的情况：**

- 想在训练或 decode 时不按比例增加 FLOPs，却扩大容量。
- 负担得起存储 \(N\) 个专家的显存，以及做 EP 的网络。
- 训练微批次或在线并发序列的规模足以利用专家。
- 具备负载指标、热专家复制与 fused MoE kernel 的工具链。

**更适合稠密的情况：**

- 单卡或小切分部署比峰值质量更重要。
- 延迟 SLO 吞不下 dispatch/combine 长尾。
- 缺少匹配你量化方案的成熟 MoE kernel。
- 微调流程默认「每个参数看见每个 token」（MoE 微调容易欠更新冷专家）。

一个有用的心智模型：MoE 把 **显存与互连** 换成 **固定激活计算下的质量**；稠密模型更直接地把 **计算** 换成质量。当内存容量与集合通信库追上 2017–2022 的路由研究后，业界才再度摆向 MoE。

训练成本对比还应区分 **GPU-hours** 与 **墙钟时间**。稀疏模型每 token FLOPs 可以更少，却仍需要大集群来装参数；DeepSeek-V3 的报告对预训练、上下文扩展与后训练的 H800 GPU-hours 写得很明确，这才是给 MoE 与稠密定价时该用的单位。

## Summary

稀疏 MoE 层把 Transformer FFN 变成一组可路由的专家：top-k token-choice 是主力；expert-choice 反转赋值以换取完美均衡，代价是可变扇入。辅助损失、capacity factor 与 dropless 的 block-sparse kernel 是应对负载不均的三代答案；DeepSeek-V3 的每专家路由 bias 表明，常常可以在没有沉重辅助项的情况下完成均衡。专家并行让 all-to-all 成为核心系统问题——节点受限路由与计算/通信重叠，是大规模 MoE 跨节点仍高效的关键。共享专家与细粒度切分提升专业化；推理栈必须融合 kernel、管理 EP，并有时复制热专家以免 decode 卡住。MoE 不是免费容量：它是用显存与网络去换稀疏计算的刻意交易，只有定价正确时才划算。

## References

- Shazeer et al., "Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer" (2017): https://arxiv.org/abs/1701.06538
- Lepikhin et al., "GShard: Scaling Giant Models with Conditional Computation and Automatic Sharding" (2020): https://arxiv.org/abs/2006.16668
- Fedus, Zoph and Shazeer, "Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity" (2021): https://arxiv.org/abs/2101.03961
- Zoph et al., "ST-MoE: Designing Stable and Transferable Sparse Expert Models" (2022): https://arxiv.org/abs/2202.08906
- Zhou et al., "Mixture-of-Experts with Expert Choice Routing" (2022): https://arxiv.org/abs/2202.09368
- Gale et al., "MegaBlocks: Efficient Sparse Training with Mixture-of-Experts" (2022): https://arxiv.org/abs/2211.15841
- Jiang et al., "Mixtral of Experts" (2024): https://arxiv.org/abs/2401.04088
- Dai et al., "DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models" (2024): https://arxiv.org/abs/2401.06066
- DeepSeek-AI, "DeepSeek-V3 Technical Report" (2024): https://arxiv.org/abs/2412.19437
- Microsoft Research, Tutel MoE system overview: https://www.microsoft.com/en-us/research/blog/tutel-an-efficient-mixture-of-experts-implementation-for-large-dnn-model-training/
- vLLM fused MoE modular kernel design (stable docs): https://docs.vllm.ai/en/stable/design/fused_moe_modular_kernel/
- vLLM MoE kernel features (GitHub): https://github.com/vllm-project/vllm/blob/main/docs/design/moe_kernel_features.md
- MegaBlocks implementation: https://github.com/databricks/megablocks
