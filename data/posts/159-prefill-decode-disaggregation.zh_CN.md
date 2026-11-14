---
title: "Prefill-Decode 分离：为什么 LLM 推理要把预填充和逐 Token 生成拆开"
tag: ai
description: LLM 推理如何把计算密集的 prefill 与显存带宽密集的 decode 拆到不同的机器上——为什么把两阶段放在同一块 GPU 会让 TTFT 与 TPOT 互相拖累、并行度只能折中，KV cache 传输量怎么算，pull 与 push 以及分块流式传输，prefill/decode 副本比为什么必须匹配负载，DistServe、Splitwise、Mooncake、vLLM 与 NVIDIA Dynamo 实际怎么做，什么时候不该分离，以及一个在明确延迟目标下比较协同部署与分离部署 goodput 的可运行 roofline 模型
date: "2026-11-14T13:30:00.000Z"
---

## 目标

每个 LLM 请求都包含两个几乎完全相反的阶段。**Prefill**（预填充）读取 prompt 并构建 key-value（KV）cache，它是计算密集的，适合较宽的张量并行。**Decode**（解码）随后一次生成一个 token，每一步都要重读模型权重、并在不断增长的 cache 上做注意力，它是显存带宽密集的，适合更多副本、并且希望 batch 稳定。

大多数推理系统仍然把两个阶段跑在同一块 GPU 上。这很简单，加上 *chunked prefill*（分块预填充）之后也还能用——直到一波长 prompt 和正在生成的请求挤进同一次 iteration。首 token 延迟（TTFT）和每输出 token 耗时（TPOT）开始互相抢时间，而一套并行度方案必须同时迁就两边。

Prefill-decode（P/D）分离把两个阶段放到不同的 worker 上，再把 KV cache 在它们之间传过去。本文包括：

1. 为什么两个阶段的瓶颈相反，以及协同部署如何把 TTFT 和 TPOT 绑在一起。
2. 分离后的数据路径：prefill worker、decode worker，以及 KV 传输。
3. 这份 KV 负载到底有多大，网络需要扛住怎样的带宽。
4. Pull 与 push、计算与通信重叠，以及感知 cache 的多轮路由。
5. 为什么 prefill 与 decode 的副本比是一等一的容量决策。
6. DistServe、Splitwise、Mooncake、vLLM 与 NVIDIA Dynamo 在实践中怎么做。
7. 什么时候不该做分离。
8. 一个带明确延迟目标、比较协同部署与分离部署 goodput 的可运行一阶模型。

## 1. 两个阶段，两种瓶颈

Transformer 的前向计算主要由与投影权重相关的大矩阵乘主导。Prefill 时 prompt 里的 *每个* token 都参与运算，算术强度高：同一份权重会在长序列上（常常还有打包在一起的一批 prompt）被反复使用，GPU 的 tensor core 能吃饱。注意力可以靠 FlashAttention 这类 IO 感知算子做到接近序列长度的线性开销（见本系列此前的文章），但整个阶段仍然是计算问题。

Decode 把这个比例反过来。每一步通常每个序列只追加一个 token。引擎几乎要把全部权重从 HBM 再流一遍，换来的算术量却相对很小，然后再读每个请求的 KV cache。在 batch 还不够大时，roofline 卡在显存带宽，而不是算力上限。这就是为什么单个请求会让大量计算单元闲着，以及为什么 continuous batching（按 iteration 粒度加入和移出请求，而不是等整个 batch 结束）能有效填满显存管道。

两个阶段对并行度的偏好也不一样：

- Prefill 更吃 **张量并行**（TP）：把大矩阵乘拆到多卡，付一次 all-reduce，更快做完 prompt。
- Decode 往往更喜欢 **更多副本、更小的 TP**：每个副本需要足够的显存带宽来撑住一个 batch，而在极短的 decode step 上做 all-reduce 几乎全是开销。

协同部署的实例只能选一套方案。

## 2. 协同部署的代价

在协同部署的引擎里，调度的单位是一次模型 iteration。现在的主流系统已经不会在处理 prompt 时把 decode 完全停住：它们把 prompt 切成块（Sarathi-Serve 的 chunked prefill，目前已是 vLLM 和 SGLang 的标配），再把一块与当前的 decode batch 混在一起。这能把伤害限制在一个范围内，但并不能消除它。

Iteration 时间在一阶上变成：

```text
t_iter ≈ t_prefill(chunk_tokens) + t_decode(decode_batch)
```

每一个正在生成的请求，都会在这一步额外承担 `t_prefill(chunk_tokens)`。一个在计算型 roofline 上耗时 20 ms 的 512 token 块，会把本来 8 ms、受显存限制的 decode step 拉成 28 ms。反过来，TTFT 也会受伤：每一块 prefill 都要等这次 iteration 的 decode 半拍，于是一段本来只需 80 ms 纯计算的长 prompt，会被若干次 decode 下限拉长。

运维上的结果是被迫权衡。要保护 TPOT，就得缩小 chunk 或推迟新的 prefill，TTFT 随之上升；要保护 TTFT，就得积极接纳 prefill，于是每一路正在进行的对话都会变慢。Goodput——同时满足 *两个* SLO 的请求速率——会下降，即使原始 token 吞吐量看起来还不错。

## 3. 把数据路径拆开

分离架构在概念上很小，在工程上却不小：

1. **Prefill worker**（或一组）接受 prompt，跑计算密集的前向，产出 KV cache 以及首 token 的 logits。
2. 一条 **传输路径** 把这份 KV 送到 decode worker。这些字节是整套架构的核心，其余都是围绕它做的调度。
3. **Decode worker**（或一组）把请求放进 continuous decode batch，生成剩下的 token，不再跑任何 prefill 算子。

两个池子不再共享同一次 iteration，因此 TPOT 就是 `t_decode(batch)`，TTFT 则是排队加上 prefill、加上传输、再加上第一步 decode。每个池子可以有自己的 TP、副本数、batch 大小，甚至不同代的 GPU——Splitwise 就专门研究过 *异构* 集群：更新、SM 更多的加速器做 prefill，更便宜、更低功耗的设备做 decode。

代价是 TTFT 现在包含一次网络跳，而且请求必须等 KV 落地才能开始 decode。后续设计的目标，就是让这次跳变小、可重叠，并且尽量不要出现在关键路径上。

## 4. KV 负载到底有多大？

对于标准的多头（或分组查询）注意力模型，cache 为每一层、每一个 KV 头、每一个 token 各存一份 key 和一份 value：

```text
bytes/token = n_layers × 2 × n_kv_heads × head_dim × dtype_bytes
```

一个采用 Llama 3 70B 公开 GQA 形状——80 层、8 个 KV 头、head dimension 128——并以 fp16 存储的 70B 级模型是：

```text
80 × 2 × 8 × 128 × 2 = 327,680 字节/token   (320 KiB)
```

于是一段 4096 token 的 prompt 对应 **1.250 GiB** 的 KV。按 50 GB/s 的线速（大约 400 Gbps RDMA，忽略协议开销）拷贝需要 **26.84 ms**。按 25 Gbps 以太网线速（3.125 GB/s）则需要 **429.50 ms**——还没算排队，就已经超过大多数交互式 TTFT 预算。这些数字来自上式的算术，而不是某块网卡的实测；真实传输会比线速稍慢，若在 prefill 尚未结束时按层流式发送，又会显得稍快一些。

有几组设计旋钮可以缩小负载，或把延迟藏起来：

- **GQA / MQA / MLA** 已经把 `n_kv_heads` 降到少于 query 头数；所以这里的 70B 是 320 KiB/token，而不是它的八倍。
- **更低精度的 KV**（fp8、int8，甚至某些引擎里的 4-bit）能把字节数砍半乃至更多，代价是质量，必须在自己的负载上衡量。
- **分块或按层流式传输**，例如 Mooncake，会在最后一块 prefill 还没算完时就开始发送已经完成的层或 prompt 块，让拷贝与剩余计算重叠。
- **前缀 cache 命中**（共享系统提示词、见过的检索文档、多轮对话的前几轮）意味着你只需要计算并传输 *后缀*。

如果集群无法在几十毫秒内搬走大约 1 GB 的数据，那么无论 decode 一侧看起来多么干净，分离都会在 TTFT 上输给协同部署。

## 5. Pull、push 和回来的路

早期的 vLLM 分离式 prefill 是跑两个实例，再通过 `vllm/distributed/kv_transfer` 下的 KV connector 连接。默认的 NIXL connector 是 **pull** 模式：decode worker 得知某次 prefill 结束后，再分配 block、再去读 cache。握手——元数据、block 分配、RDMA 描述符——坐落在 prefill *之后* 的关键路径上，而且跑在 decode worker 上，而你偏偏最希望它的 TPOT 保持平稳。

**Push** 型 connector（vLLM 的 `NixlPushConnector`，见项目 2026 年 10 月的文章）把这次握手反过来。Decode worker 可以更早被选定，并在 prefill 还在跑的时候就登记好目标 block；prefill 一侧一旦准备好，就由后台线程把 cache 推过去。在 AWS EFA 上的 1P1D、Qwen3-32B 部署里，那篇文章报告 push 相对 pull 最多可把 TTFT 改善 3 倍、TPOT 改善约 30%。这是传输模式之间的对比，不是对协同部署基线的声明，并且会随负载变化。

多轮代理（agent）还需要第二条方向。一次工具调用之后，下一轮 prompt 是“原有上下文 + 新的观察”。如果 decode worker 在一轮结束时丢掉 KV，prefill worker 就得重算。vLLM 的双向传输会按可配置的存活时间把 decode 侧的 block 留住，让 prefill worker 复用它们；Mooncake 把这件事做得更彻底：把 DRAM 和 SSD 汇成集群级的 KV 存储，并把请求调度到前缀已经在的地方。

NVIDIA Dynamo 是同一副骨架：PrefillRouter 选择 worker，再通过 NIXL 在拓扑允许的 NVLink、InfiniBand 或 PCIe 上做 GPU 到 GPU 的传输。

## 6. Prefill 与 decode 的比例是容量规划

分离并没有取消规划的必要，它只是让规划变得可见。1 个 prefill worker 配 3 个 decode worker（1P3D）是在赌 decode 才是瓶颈——典型情况是短 prompt、长生成。3P1D 则是在赌长 prompt、短回答：检索增强对话、文档摘要、许多 agent 轨迹。比例选错，队列会重新出现，只不过现在它被关在某一个阶段里，有时比“至少每张 GPU 都能做 prefill”的协同基线更糟。

Mooncake 的 Conductor 就是围绕这一点构建的全局调度器。它选择一对 prefill/decode，把可复用的 cache 拉到 prefill worker，把新的 KV 流式送到 decode worker，并且——因为生产集群经常过载——当预测的 TTFT 或 token 间隔会错过 SLO 时，选择尽早拒绝请求，而不是接下一份注定来不及做完的工作。

DistServe（OSDI 2024）在放置上又走了一步：给定 TTFT 和 TPOT 目标，它联合优化每个阶段要多少 GPU、用哪种并行度，并按集群带宽来放置这两个阶段，好让 KV 这一跳仍然负担得起。

## 7. 文献与生产中的系统

- **DistServe**（Zhong、Liu、Chen、Hu、Zhu、Liu、Jin、Zhang；OSDI 2024）把问题表述为在分阶段 SLO 下的 *goodput*。通过拆分阶段并独立规划并行度，作者报告在强协同基线之上能多服务 7.4 倍请求，或满足收紧 12.6 倍的 SLO，并且超过 90% 的请求落在延迟限制内。
- **Splitwise**（Patel、Choukse、Zhang、Shah、Goiri、Maleki、Bianchini；ISCA 2024）在 A100 与 H100 上刻画了 prompt 与 generation 的差异，再把它们拆到不同机器上——包括异构资源池。结合生产轨迹，论文报告在成本降低 20% 的同时吞吐量最高提升 1.4 倍，或在相同功耗与成本预算下吞吐量达到 2.35 倍。
- **Mooncake**（Qin、Li、He、Zhang、Wu、Zheng、Xu；arXiv:2407.00079）是月之暗面为 Kimi 构建的推理平台。它以 KV cache 为中心：分离的 prefill/decode 集群，加上汇聚的 DRAM/SSD cache、Conductor 调度器、分块流式传输，以及尽早拒绝。论文报告在某些模拟设定下、在守住 SLO 的同时吞吐量最高提升 525%，在真实流量下多处理 75% 的请求。
- **vLLM** 与 **SGLang** 现在已经把 P/D 分离做成一种部署模式，并提供可插拔的 KV connector（InfiniBand 或 EFA 上的 NIXL，以及上文的 push 与双向变体）。
- **NVIDIA Dynamo** 是一套分离式推理框架，包含 prefill 路由器和 NIXL 的 GPU 到 GPU 传输，用来把同一模式扩到整个集群。

两个协同部署里的想法仍然是互补而不是替代：**chunked prefill**（Sarathi-Serve，OSDI 2024）和 **分页式 KV 管理**（本系列关于 PagedAttention 的文章）。分离部署依然会用到它们——只是不再把 prefill 的分块混进 decode 的 iteration。

## 8. 什么时候不该分离

分离是系统层面的取舍，不是免费的加速。

- **网络偏弱或已经过载。** 在下面的模型里，同一套在 50 GB/s 上达到 94.5% goodput 的 2P2D 拓扑，到了 25 Gbps 以太网线速就掉到 21.8%，几乎全是 TTFT 的锅。如果没有 RDMA 或 NVLink 这一档的互联，把两个阶段放在一起更合适。
- **P:D 比例不对。** 长 prompt 负载遇到太少的 prefill GPU 会严重排队；我们那组平均 prompt 为 4045 token 的检索增强式负载，在 2P2D 下比协同部署更差，在 3P1D 下则明显更好。先衡量 prompt 与输出的 token 比，再冻结池子的形状。
- **小模型、短 prompt。** 如果 prefill 只有几毫秒，一次 27 ms 的 KV 拷贝就是净亏损，而协同部署的 iteration 税也几乎可以忽略。
- **集群太小。** 只有两块 GPU 时，往往组不出有意义的池子，也失去了让每台设备都能消化 prefill 突发的能力。
- **运维复杂度。** 你现在有两套弹性伸缩、一张传输织物、cache 局部性，以及不同的故障域（decode worker 在生成中途挂掉，和 prefill worker 在拷贝前挂掉，恢复路径并不一样）。当 SLO 很紧、并且集群大到足以摊掉这笔成本时，这套架构才划算。

## 9. 一个可运行的 roofline 模型

下面的脚本不是 GPU 基准，而是一个参数写明的一阶离散事件模型：每个 token 0.040 ms 的 prefill 计算，8 ms 的显存型 decode 下限（计算赶上之后按每个序列 0.30 ms 增长），512 token 的 prefill 分块，以及按上面 70B 级公式计算的 KV 传输。协同部署的 worker 把 chunked prefill 混进 decode iteration；分离部署则把 4 个加速器拆成 2P2D、3P1D 或 1P3D。负载是 60 秒内 400 个泊松到达（平均间隔 100 ms，prompt 在 512–3072 上均匀，输出在 64–256 上均匀，种子 7）。请求同时满足 TTFT ≤ 150 ms 且 TPOT ≤ 10 ms，才算达到 SLO。

模型代码与英文版相同，在 CPython 3 上的输出为：

```text
KV bytes per token (70B-class GQA, fp16): 327680
KV for 4096 tokens: 1.250 GiB
Transfer 4096 tokens @ 50 GB/s:    26.84 ms
Transfer 4096 tokens @ 3.125 GB/s: 429.50 ms
workload: 400 req in 60s, mean prompt=1730, mean output=157
SLOs: TTFT <= 150 ms, TPOT <= 10 ms
colocated 4-GPU         finished=400  TTFT p50/p90=103.7/166.6 ms  TPOT p50/p90=9.57/10.72 ms  goodput=228/400 (57.0%)  miss TTFT=88 TPOT=114
disagg 2P2D @ 50 GB/s   finished=400  TTFT p50/p90=89.1/143.1 ms  TPOT p50/p90=8.00/8.00 ms  goodput=378/400 (94.5%)  miss TTFT=22 TPOT=0
disagg 3P1D @ 50 GB/s   finished=400  TTFT p50/p90=84.2/137.2 ms  TPOT p50/p90=8.00/8.00 ms  goodput=397/400 (99.2%)  miss TTFT=3 TPOT=0
disagg 1P3D @ 50 GB/s   finished=400  TTFT p50/p90=146.7/379.6 ms  TPOT p50/p90=8.00/8.00 ms  goodput=207/400 (51.8%)  miss TTFT=193 TPOT=0
disagg 2P2D @ 25 GbE    finished=400  TTFT p50/p90=255.5/424.6 ms  TPOT p50/p90=8.00/8.00 ms  goodput=87/400 (21.8%)  miss TTFT=313 TPOT=0
```

可以这样读这几行。首先，分离把 TPOT 压平了：所有分离配置都坐在 8.00 ms 的显存下限上，而协同部署的混合 iteration 把 p50 推到 9.57 ms、p90 推到 10.72 ms——足以让 400 个请求里的 114 个错过 10 ms 的 TPOT 目标。其次，在快速互联下，2P2D 把 goodput 从 57.0% 提到 94.5%，更适合这组偏 prompt 负载的 3P1D 则达到 99.2%。第三，1P3D *不如* 协同部署（51.8%），因为唯一的 prefill worker 在排队；架构本身救不了一个选错的池子形状。第四，同一套 2P2D 拓扑在 25 Gbps 以太网上掉到 21.8% goodput，原因全部来自 TTFT。

用同一模型再跑一组、只加密到达率（种子 11，SLO 不变），差距会在负载升高时拉大：平均间隔 80 ms 时，协同部署的 goodput 是 37.4%，2P2D 是 92.0%，3P1D 是 99.4%；60 ms 时分别是 10.1%、80.6% 和 97.3%。到了 40 ms，连 3P1D 也会垮掉，因为唯一的 decode worker 开始排队，而这段队列会反映到 TTFT 上。一组检索增强式负载（平均 prompt 4045、平均输出 64、间隔 80 ms，SLO 为 TTFT ≤ 400 ms、TPOT ≤ 12 ms）把比例问题衬得更清楚：2P2D 的 goodput 掉到 7.6%——比协同部署的 20.4% 更差——而 3P1D 达到 89.4%。

## 小结

- Prefill 是计算密集的，decode 是显存带宽密集的；它们想要不同的并行度方案，并且在共享同一次 iteration 时会互相拖累，即使已经做了 chunked prefill。
- 分离把两个阶段隔开，同时让 KV cache 传输变成新的关键路径。对 fp16 的 70B 级 GQA 模型，这条路径是每 token 320 KiB：在 400 Gbps 级 RDMA 上从容，在普通以太网上吃力。
- Push 传输、按层流式发送和前缀复用可以隐藏或缩小拷贝；双向 cache 则是让多轮代理便宜到值得这样服务的前提。
- Prefill 与 decode 的副本比是负载决策。比例选错，或网络偏慢，可能输给一套调好的协同部署引擎。
- DistServe、Splitwise、Mooncake、vLLM 和 Dynamo 都在实现这种拆分，只是在调度、异构和 cache 放置上给出了不同的答案。

## 参考文献

- Zhong, Liu, Chen, Hu, Zhu, Liu, Jin, Zhang. *DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving*. OSDI 2024. https://www.usenix.org/conference/osdi24/presentation/zhong-yinmin
- Patel, Choukse, Zhang, Shah, Goiri, Maleki, Bianchini. *Splitwise: Efficient Generative LLM Inference Using Phase Splitting*. ISCA 2024.
- Qin, Li, He, Zhang, Wu, Zheng, Xu. *Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving*. arXiv:2407.00079, 2024.
- Agrawal, Kedia, Panwar, Mohan, Kwatra, Gulavani, Tumanov, Ramjee. *Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve*. OSDI 2024.
- Kwon et al. *Efficient Memory Management for Large Language Model Serving with PagedAttention*. SOSP 2023.
- Dao, Fu, Ermon, Rudra, Ré. *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*. NeurIPS 2022.
- vLLM. *Push-Based KV Transfer to Improve TTFT and TPOT for Disaggregated Inference in vLLM*. https://vllm.ai/blog/2026-10-14-nixl-push-connector
- vLLM. *Improve TTFT for Multi-Turn Agentic Workloads with Bi-Directional KV Transfer in vLLM*. https://vllm.ai/blog/2026-10-12-bidirectional-kvxfer-multiturn-agentic-workload
- NVIDIA. Dynamo documentation, *Disaggregated Serving*. https://docs.nvidia.com/dynamo/knowledge-base/concepts/system-architecture/disaggregated-serving

