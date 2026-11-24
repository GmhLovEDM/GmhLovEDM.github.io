---
title: "Group Relative Policy Optimization：推理模型如何在没有 Critic 的情况下学习"
tag: ai
description: GRPO 如何用同一道题的一组答案代替 PPO 的价值模型作为基线；为什么这适合长思维链上的结果奖励；DeepSeekMath 与 DeepSeek-R1 实际如何训练；原目标函数里的长度偏差与难度偏差；DAPO 与 Dr. GRPO 改了什么；以及一个可运行模型，用来衡量优势、裁剪、KL 估计器和一次小型策略更新
date: "2026-11-24T13:29:00.000Z"
---

## 目标

推理模型不只是一个预训练好的 Transformer。那些会写出长长的思维链、自己检查、再换一条路的模型，是从奖励里学会这种行为的：方框里的数字和标准答案一致，程序通过了官方评测用例，格式标签放在了该放的位置。让这种训练在 2024 和 2025 年对开源模型变得可行的算法，是 **Group Relative Policy Optimization（GRPO）**。它首次出现在 DeepSeekMath 论文里，也是 DeepSeek-R1-Zero 和 DeepSeek-R1 背后的强化学习方法。

Proximal Policy Optimization（PPO）从 InstructGPT 以来就是这一阶段的常用工具，但它需要一个 **Critic**：通常和策略一样大的第二个模型，用来在每个 token 上预测期望回报，从而计算优势。这个 Critic 很贵；而当唯一的奖励出现在一条可能长达数万 token、中途还可能自我否定的解答的最后一个 token 上时，它也并不合适。GRPO 把 Critic 丢掉了。对每一道题，它从当前策略生成一组 *G* 条完整答案，打分，并用**这组内部**的均值和标准差作为基线。比同组对手好的答案得到正优势，差的得到负优势。如果一组里每条答案一样好，优势为零，这组数据什么也教不会。

本文会讲到：

1. 训练信号是什么，以及可验证奖励如何改变了这个问题。
2. LLM 设定下的 PPO，以及 Critic 为什么别扭。
3. GRPO 如何用一组答案构造基线。
4. 目标函数：概率比裁剪、按回答平均，以及损失里的 KL。
5. 结果监督、过程监督，以及基于规则的奖励。
6. DeepSeekMath 在一个经过指令微调的 7B 模型上测到了什么。
7. DeepSeek-R1-Zero：从基座模型直接做强化学习。
8. DeepSeek-R1 的多阶段流程。
9. 原目标函数里的偏差，以及 Dr. GRPO 和 DAPO 改了什么。
10. 取舍。
11. 一个可运行的模型，用来衡量优势、裁剪、KL 估计器，以及一次小型策略更新。

## 1. 训练信号

监督微调教模型去模仿已经存在的答案。强化学习教它更偏好得分高的答案，包括没有人写过的答案。一旦你关心的是长的、可核对的、而且并不唯一的解——一道证明、一段程序、一条会调用工具的轨迹——这个差别就重要了。同一条提示可以有许多条正确轨迹，一条轨迹也可以开局很差、随后挽回。

在很长一段时间里，InstructGPT 之后的默认配方是：一个学出来的奖励模型，再加上 PPO。奖励模型本身是一个在人类（或 AI）偏好对上训练的大网络。它能抓住有用性这类微妙的品质，也容易被钻空子。DeepSeek-R1 的作者写得很直接：在推理任务上他们不用神经奖励模型，因为在大规模强化学习里这类模型容易发生**奖励破解（reward hacking）**，而且重新训练它们会再套一层优化循环。

在数学和代码上，取而代之的是**可验证**的奖励。对于结果确定的数学题，模型必须把最终答案写成指定格式——常常是一个方框——然后由规则去和标准答案核对。对于编程题，编译器和一组官方评测用例决定对错。格式规则还可以加上第二种更便宜的信号：模型有没有用规定的标签包住推理过程？DeepSeek-R1-Zero 把正确性奖励和格式奖励以相同权重相加：

`Reward_rule = Reward_acc + Reward_format`

这是一个稀疏的、只在结尾出现的信号。长思维链里几乎每个 token 都没有属于自己的奖励。训练算法必须把回答末尾的一个数字，以及同一道题上少数几个这样的数字，变成对数万个 token 的信用分配。GRPO 就是对这个分配问题的一种回答。本博客已经在[一篇关于 KV cache 与 PagedAttention 的文章](/blog/140-llm-inference-kv-cache-paged-attention/zh_CN)和[另一篇关于 prefill-decode 分离的文章](/blog/159-prefill-decode-disaggregation/zh_CN)里讨论过这些长轨迹在**推理服务**时要付出的代价。这里要问的是：模型是怎么学会写出它们的。

## 2. PPO，以及 Critic 为什么别扭

PPO（Schulman 等，2017）是一种 actor-critic 方法。策略 \(\pi_\theta\) 为问题 \(q\) 生成回答 \(o\)。在每个 token 上，算法构造当前策略与产生这些数据的旧策略 \(\pi_{\theta_{old}}\) 之间的**概率比**：

`ratio_t = π_θ(o_t | q, o_<t) / π_θold(o_t | q, o_<t)`

并最大化一个经过裁剪的代理目标。用 \(\varepsilon\) 表示裁剪范围，token 项是 `ratio_t * A_t` 与 `clip(ratio_t, 1-ε, 1+ε) * A_t` 的较小值。裁剪是为了阻止一次更新把策略推得太远：优势为正时，一个 token 不能靠概率暴涨领取超过 `(1+ε) A_t` 的信用；优势为负、而且这个 token 已经变得远不那么可能时，代理目标就不再继续推它。

优势 \(A_t\) 通常用 Generalized Advantage Estimation（GAE）来估计，而这需要一个作为基线的**价值函数** \(V_\psi(s_t)\)——也就是 Critic。InstructGPT 还会在每个 token 的奖励里减去一项 KL 惩罚，免得策略离开监督微调的起点太远。

当策略是大语言模型、奖励又是结果分数时，会出现两个问题。

Critic 通常是另一个体量相当的模型。你得加载它、训练它，并让它和本身也在移动的策略保持合拍。这是一笔可观的显存和算力税，也是 DeepSeekMath 放弃 PPO 的第一条理由。

第二条理由是统计上的。在这种设定里，奖励模型或规则通常只给**最后一个** token 打分。一个被训练去预测每个前缀之期望回报的 Critic，等于是在根据半截思维链去预报最终分数。DeepSeek-R1 对 GRPO 与 PPO 的比较，把这一点在长推理轨迹上说得更清楚：回答变长之后，模型更可能反思、修改、甚至推翻前面的步骤，前缀对最终奖励的预测能力就更弱。GAE 有一个 \(\lambda\)，在完整的蒙特卡洛回报和一步时序差分之间插值。R1 作者在 DeepSeek-Coder-V2-Lite（16B MoE，激活 2.4B 参数）的 MATH 对比里，PPO 用常见默认值 \(\lambda = 0.95\) 时明显落后于 GRPO；把 \(\lambda\) 设为 1.0、更依赖完整回报而不是 Critic 的自举，PPO 就接近了 GRPO。Critic 可以调到能用，但它不是免费的，而且对一个很容易被留在错误默认值上的旋钮很敏感。

## 3. 用一组答案做基线

GRPO 保留了 PPO 的裁剪概率比，丢掉了价值模型。对每一道题 \(q\)，它从 \(\pi_{\theta_{old}}\) 生成一组输出 \(\{o_1, \ldots, o_G\}\) 并打分，得到奖励 \(\{r_1, \ldots, r_G\}\)。每条输出的优势只由这些组内分数计算。在**结果监督**下，\(o_i\) 里的每个 token 共享同一个优势：

`A_i = (r_i − mean(r)) / std(r)`

当奖励是 0/1、并用总体标准差时，一个对错各半的组里，正确答案得到 \(A = +1\)。如果一组里几乎人人已经答对，正确答案只得到很小的正优势，而那一个失败会得到很大的负优势。如果每条输出的奖励都相同，标准差为零，公式没有定义。实现里这时会把优势当作零，这也是只减均值时会得到的结果。全体一致的组不贡献策略梯度。第 9 节还会回到这件事。

这条基线还有 DeepSeekMath 指出的第二层概念上的好处：奖励模型常常是在**同一道题的不同答案之间的比较**上训练的。在同一条提示上给一组答案打分，比较的形状是一样的，哪怕打分的是一条确定性规则，而不是一个网络。

组大小 \(G\) 是一个真正的超参数，不是脚注。DeepSeekMath 对每道题生成 \(G = 64\) 条输出，最大长度 1,024。DeepSeek-R1-Zero 用 \(G = 16\)，最大长度先是 32,768 个 token，后来提高到 65,536。组大小、回答长度、以及每一步里不重复的题目数，三者的乘积才是两次策略更新之间真正要生成的东西。R1-Zero 每一步用 32 道不重复的题（一批 512 条序列），每次 rollout 生成 8,192 条输出，再切成 16 个小批次，只做一轮内部更新。

## 4. 目标函数：裁剪、长度，以及 KL

DeepSeekMath 写的是**token 级**目标。对每条输出 \(o_i\)，它把裁剪项在 (|o_i|) 个 token 上取平均，再减去 KL 正则，然后对整组再取平均：

每个 token 上的项是

`min( ratio_{i,t} * A_{i,t},  clip(ratio_{i,t}, 1−ε, 1+ε) * A_{i,t} )  −  β  KL(π_θ || π_ref)`

这些项按 \(\frac{1}{G} \sum_i \frac{1}{|o_i|} \sum_t (\cdot)\) 归约。\(\frac{1}{|o_i|}\) 意味着：如果概率比都接近 1，那么无论回答有多长，每条**回答**对目标函数的贡献是一样的。按 token 计，短的正确答案比长的权重更大。这究竟是特性还是缺陷，是第 9 节的主题。

DeepSeek-R1 的 Nature 版本用更紧凑的**序列级**形式表达了同一个想法：一个单独的概率比 \(\pi_\theta(o_i|q) / \pi_{\theta_{old}}(o_i|q)\) 乘以 \(A_i\)，仍然裁剪，仍然带 KL 项。veRL、TRL 这类公开训练栈通常实现的是 DeepSeekMath 的 token 级形式，有时再配上后文讨论的归约方式。

有两处关于 KL 的细节很容易被跳过，跳过后又很贵。

InstructGPT 风格的 PPO 是从**每个 token 的奖励里**减去 KL 惩罚。强化学习最大化的是累积奖励，这种做法惩罚的是整段回答上 KL 的**总和**，从而可能隐式地给长度加税。GRPO 改为把 \(\mathrm{KL}(\pi_\theta \| \pi_{ref})\) 的估计**加进损失**，于是优势本身不会和一项跟长度有关的惩罚混在一起。估计器用的是 Schulman 在 2020 年推荐的那一个：

`KL ≈ π_ref / π_θ − log(π_ref / π_θ) − 1`

它在通常的蒙特卡洛意义上是无偏的，而且保证非负；光秃秃的 `log(π_θ / π_ref)` 则会变号。在文末的模型里，当策略概率是参考策略的四倍时，这个 k3 估计是 0.6363，而带符号的对数比是 +1.3863；当策略概率是参考策略的四分之一时，k3 是 1.6137，带符号的对数比是 −1.3863。

参考策略也有寿命。如果 \(\pi_{ref}\) 在最初的监督（或基座）模型上冻结几千步，一个开始写长思维过程的策略，迟早会因为离开那个起点而被重罚。DeepSeekMath 的迭代配方会周期性地用当前策略替换参考策略。DeepSeek-R1-Zero 每 400 步做一次同样的事，并用很小的系数 \(\beta = 0.001\)（DeepSeekMath 用的是 0.04）。裁剪范围是另一个这样的旋钮：R1 的第一阶段强化学习把 \(\varepsilon\) 设为 10，远高于教科书里的 0.2，因为收得太紧的裁剪会截断很大一部分 token 的梯度。

## 5. 结果监督、过程监督，以及规则

在**结果监督**下，归一化后的组奖励被放在回答末尾，并作为 \(A_{i,t}\) 复制给每一个 token。这就是基于规则的数学和代码奖励所用的形式，也是第 11 节的模型实现的形式。

DeepSeekMath 也尝试过**过程监督**。过程奖励模型给每一个推理步骤打分。这些步骤奖励在步骤之间、也在组内一起做归一化，一个 token 的优势是**从该 token 起往后所有归一化步骤奖励之和**。信用于是比最后的方框来得更早，代价是步骤切分，以及第二个需要学习（或标注）的评分器。DeepSeek-R1-Zero 的作者拒绝了这笔交易：他们只用规则，只用最终答案和格式，因为他们观察到，在大规模训练里，神经的结果奖励模型和过程奖励模型都容易被破解。

他们强制的格式很简单。模板要求助手先思考再作答，并用指定标签分别包住推理和答案——在公开的轨迹里，是用 `<think> ... </think>` 包住思维链，数字答案放在方框中。他们刻意没有规定**该如何**思考，这样后来出现的任何反思行为，都可以归到奖励上，而不是提示词里写好的文风。

## 6. DeepSeekMath：在指令微调后的 7B 上做 GRPO

DeepSeekMath-RL 的起点是 DeepSeekMath-Instruct 7B，不是生的基座模型。强化学习的数据，是监督数据里来自 GSM8K 和 MATH、并写成思维链形式的那些题，大约 144,000 条提示。其他监督提示被有意留在强化学习阶段之外，这样在那些基准上的提升，就可以读成这次更新的域外效果。

策略学习率是 \(1 \times 10^{-6}\)，KL 系数是 0.04，批量大小是 1,024，最大长度是 1,024，每次探索之后只做一次策略更新。初始奖励模型从 DeepSeekMath-Base 7B 以 \(2 \times 10^{-5}\) 的学习率训练。在这套设置下，论文报告 GRPO 把域内思维链分数从 GSM8K 的 82.9% 提到 88.2%，从 MATH 的 46.8% 提到 51.7%，也把域外的中文基准 CMATH 从 84.6% 提到 88.8%。摘要里的 51.7% MATH，就是这个经过 GRPO 训练的 7B，不借助外部工具，也不做投票；DeepSeekMath 7B 在 64 次生成上做 self-consistency，MATH 达到 60.9%。

DeepSeekMath 还把 RFT、DPO、PPO 和 GRPO 写成同一族方法。DPO（Rafailov 等，2023）在训练过程中不再生成新的组：它从固定的偏好对里拟合一个隐式奖励，同样不训练 Critic，但是离线的。GRPO 是 on-policy 的（或通过 \(\pi_{\theta_{old}}\) 略微 off-policy），把预算花在新的 rollout 上。当策略会变得和昨天的偏好对不再同一回事时——也就是模型开始写出长得多的轨迹时——这笔开销才花在刀刃上。

## 7. DeepSeek-R1-Zero：从基座模型直接做强化学习

DeepSeek-R1-Zero 把 GRPO **直接用在 DeepSeek-V3 Base 上**，跳过监督微调。用作者自己的话说，假设是：人类示范可能会限制模型愿意探索的推理风格；如果奖励可靠，纯强化学习可以生长出新的风格。骨干是 DeepSeek-V3 的 MoE，其路由本博客已经在[一篇关于 Mixture of Experts 的文章](/blog/150-mixture-of-experts-routing-parallelism/zh_CN)里讨论过。

这次训练在所有对长推理重要的方向上都比 DeepSeekMath 更大。学习率是 \(3 \times 10^{-6}\)，\(\beta = 0.001\)，rollout 的 softmax 温度为 1，\(G = 16\)，最大长度先是 32,768 个 token，在第 8,200 步之后提高到 65,536。训练共 10,400 步，大约 1.6 个 epoch。作者记录到，在长度上限改变的那一步，准确率和回答长度都出现了跳升。

在 AIME 2024 基准上，他们报告 DeepSeek-R1-Zero 的平均 pass@1 从强化学习开始时的 15.6% 升到 77.9%。加上 self-consistency（Cons@16），同一模型达到 86.7%。训练集上的平均回答长度全程在涨，而奖励里并没有一项是为长度付的：模型不是因为啰嗦而得分，是因为正确而得分，更多的 token 是手段。随着训练进行，反思性的说法出现了，包括单词 “wait” 的突然增多。论文把其中一段称为 "aha moment"——不是因为某个指标翻过了阈值，而是因为模型停下来，重新评估一段推导，然后再试一次，而奖励函数里并没有人写出这种行为。

这是这项工作最重要的定性主张，阅读时应当把第 9 节里后来的批评放在旁边。更长的轨迹**确实**是在困难、可验证的任务上做基于结果的强化学习的产物。长度趋势的一部分，也可能被原版 GRPO 目标函数给序列加权的方式放大。这两件事可以同时成立。

## 8. DeepSeek-R1：冷启动、第二次监督阶段，以及第二次强化学习

R1-Zero 是很强的推理者，却不是好的对话者。论文把可读性差和语言混用列为做 DeepSeek-R1 的原因——DeepSeek-V3 Base 是多语的，尤其是英语和中文——并为此设计了更长的流程。

第一阶段是**冷启动**：收集数千条已经带有对话式、与人类对齐的思考风格的轨迹，作为强化学习之前的监督数据。随后的第一段强化学习看起来很像 R1-Zero（同样的学习率、同样的 \(\beta\)、同样的 \(G = 16\)、同样每步 32 道题、同样每次 rollout 8,192 条输出、同样每 400 步刷新参考策略、裁剪 \(\varepsilon = 10\)），只多了一项奖励：**语言一致性**，即思维链中属于目标语言的词所占的比例。作者报告，这种对齐会让任务表现略降，但换来的可读性是值得的。这一阶段的最大长度是 32,768。

之后，他们筛出高奖励的 rollout，再做一次监督训练，这一次把推理数据和非推理的写作数据混在一起，这样模型就不仅仅是解题器。第二段强化学习继续使用基于规则的推理奖励，并在共 1,700 步的最后 400 步里，加入用于有用性和无害性的偏好模型奖励。有用性只对最后的摘要评分，以免评分器不断打断思维链；无害性对整段回答评分。他们有意把这些偏好奖励放得很晚、很短：用学出来的偏好信号多训练一些步数，就会出现奖励破解。这一阶段的 softmax 温度降到 0.7，因为更高的温度会生成不连贯的内容。

所以，这条流水线并不是“GRPO 对监督训练”。它是两段不同奖励体制下的 GRPO，监督数据被用来启动一种可读的风格，并在第一段强化学习之后，把非推理的能力再放回去。

## 9. 偏差、Dr. GRPO 和 DAPO

原目标函数里有两个旋钮，后来的工作把它们当成偏差来处理。

**长度。** 对 (|o_i|) 取平均，让每条回答在目标函数里总权重相同，同时让更短的回答拥有更大的每 token 权重。Liu 等（2025）在 *Understanding R1-Zero-Like Training* 里，把去掉这一项、也去掉标准差项、只留下 \(A_i = r_i - \mathrm{mean}(r)\) 的更新称为 **Dr. GRPO**。他们的主张是：\(\frac{1}{|o_i|}\) 会在优势为正时过度加权短的正确答案，在优势为负时对长的错误答案惩罚不足，从而把策略推向“对的时候短、错的时候长”。在下面的模型里，一条 32 token 的正确答案和一条 256 token 的正确答案，在原归约下各自贡献 (+0.250)，但短的那条每 token 权重是长的八倍（0.007812 对 0.000977）。如果组里每一个 token 共享同一个权重 \(1/\sum_i |o_i|\)——也就是 DAPO 使用的 **token-mean** 归约——那么长的正确答案贡献就是短的八倍（0.470588 对 0.058824）。

**难度。** 除以组内标准差，会让简单题和困难题被不同地缩放。一个 4/8 答对的组，标准差是 0.500，优势是 \(\pm 1.000\)。一个 7/8 或 1/8 答对的组，标准差是 0.331，*少数派*答案的优势是 \(\pm 2.6458\)——也就是中心化后的差距 0.875 的 \(\sqrt{7}\) 倍。困难题上罕见的成功，以及简单题上罕见的失败，因此会相对于中等难度的组被向上加权。全体一致的组（0/8 或 8/8）则是另一种糟：梯度恰好为零，于是随着策略变好，一批数据里会有越来越多的部分停止教学。DAPO 把这叫做梯度衰减问题，并**过滤**掉准确率为 0 或 1 的组，继续生成 rollout，直到一批里装满对错混杂的组。

DAPO（Yu 等，2025）是建立在这一诊断上的完整训练配方，也是一套基于 veRL 的开源系统。起主要作用的是四处改动：

- **Clip-Higher。** 裁剪可以不对称。他们报告的界限是 \(\varepsilon_{low} = 0.2\) 和 \(\varepsilon_{high} = 0.28\)。更高的上界让低概率的“探索” token 在一次更新里可以升得更远；他们主张，过紧的上裁剪是熵崩塌的一条路径，一组里的答案会变得几乎一模一样。在模型里，概率比为 1.5、优势为 (+1) 时，对称的 \(\varepsilon = 0.2\) 会把项裁到 1.200，DAPO 的界限裁到 1.280，而 R1 第一阶段的 \(\varepsilon = 10\) 会把它留在 1.500。
- **动态的组过滤**，如上所述，让零优势的组不去稀释一个批次。
- **Token-mean 损失**，前面已经讲过，用来代替按回答的 \(\frac{1}{|o_i|}\)。
- **对超长回答做软的塑形**，而不是在长度上限上打一个硬零，这样一条稍稍超长的正确答案，就不会和一条错误答案被当成同一件事。

用这套配方，DAPO 论文报告在 Qwen2.5-32B **基座**模型上，AIME 2024 达到 50 分。他们公布的目标函数也去掉了 KL 项；探索交给裁剪、过滤和数据，而不是一个移动的参考策略。

这些改动都没有放弃那个中心想法。它们仍然生成一组答案，仍然打分，仍然用同组对手做基线。它们的分歧在于：组已经拿到手之后，怎样把这些分数变成梯度。

## 10. 取舍

GRPO 不是免费的午餐，也不是训练推理模型的唯一办法。

- **组是要付钱的。** Critic 很贵，但为每条提示生成 \(G\) 条长轨迹同样贵。\(G\) 太小，组均值是一条嘈杂的基线；\(G\) 很大，rollout 就会成为瓶颈。R1-Zero 在 32k–64k token 上用宽度为 16 的组，和 DeepSeekMath 在 1,024 token 上用宽度为 64 的组，是两种工程问题。
- **可验证奖励很窄。** 规则适用于数学、代码，以及其他有检查器的任务。它们本身教不会语气、安全性，或那种没有标准答案的有用性。R1 为此把学出来的偏好奖励加回来，加得很晚、很小心，因为那些奖励可以被破解。
- **零优势的组会浪费计算。** 策略变好之后，更多提示在组内会变成 0% 或 100%。你可以接受这种浪费，可以过滤它（DAPO），也可以改数据。你不能在一次长训练里假装看不见。
- **原来的归约会渗进行为里。** 按长度平均、按组内标准差缩放，都不是中性的记账。如果你希望长度只是达到正确的手段，而不是损失函数的副产品，就必须有意识地选择归约方式。
- **On-policy 的 rollout 跟着一个移动的目标走。** 这正是目的，也是 GRPO 能长出新推理习惯的原因。这也是为什么你需要一套稳定的生成栈、一份干净的奖励实现，以及一套关于参考策略的计划。当一份固定的偏好集仍然有代表性时，DPO 更便宜。一旦策略已经离开那份集合，它就替代不了新的 rollout。
- **账单在服务端付。** 一个思考数千 token 的模型会抬高 prefill 和 decode 的成本、KV cache 的占地，以及在重复题干上做前缀复用的价值。这些是前面引用过的文章，以及[前缀缓存与 RadixAttention](/blog/164-prefix-caching-radixattention/zh_CN)所关心的事。训练一个推理模型和部署一个推理模型，是同一件东西的两面。

## 11. 一个可运行的模型

下面的脚本并不训练语言模型。它实现了结果监督下的优势、两种归约、裁剪后的代理目标、Schulman 的 KL 估计器，以及一个用组相对优势来更新的四动作分类策略。它用一个很小的线性同余发生器，这样印出来的数字不依赖第三方库也可以复现。全程使用总体标准差（除以 \(G\)，而不是 \(G-1\)）。

在固定的奖励组上，4/8 分组的均值是 0.500，标准差是 0.500，按标准差缩放的优势是 \(\pm 1.000\)。7/8 的“简单”组和 1/8 的“困难”组共享标准差 0.331；少数派输出被缩放到 \(\pm 2.6458\)，而只做中心化时少数派是 \(\pm 0.8750\)。一旦除以标准差，全对和全错的组没有定义；如果只减均值，它们是零。

在原归约下，短的和长的正确答案贡献相同（(+0.250000)，比值 1.000）。在 token-mean 下，长的贡献 0.470588，短的贡献 0.058824，比值 0.125，也就是 (32/256)。

分类策略的初始概率是 0.4606、0.2070、0.2070、0.1255——众数是一个错误动作，两个奖励为 1 的动作一开始相等。在 4,000 组、每组大小为 8 之后，按标准差缩放的那一次运行，平均奖励是 0.9942，但这个平均包含了策略已经转移之后的长长一段；4,000 组里有 3,869 组是全体一致的，只有 131 组有定义好的标准差，以及非零的、按标准差缩放的梯度。最终概率是 0.0003、0.9397、0.0598、0.0002。只做中心化的那一次运行结束于 0.0009、0.9033、0.0950、0.0008，其中 3,705 组是全体一致的。概率集中到两个同样好的动作中的一个，是这次运行的性质，不是长度效应：更新发生在动作一级，并不编码 token 数。更有用的数字是：策略一旦找到了获胜动作，对错混杂的组会消失得有多快。这正是 DAPO 的过滤器要对付的局面。

```python
#!/usr/bin/env python3
"""A compact model of group-relative policy optimization.

It does not train a language model. It measures how group baselines,
standard-deviation scaling, length averaging, clipping, and the
unbiased KL estimator behave on small, fully specified rewards and
on a four-action categorical policy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


def make_rng(seed: int):
    # A tiny LCG so the script has no third-party dependency.
    state = seed & 0xFFFFFFFF

    def _next() -> int:
        nonlocal state
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        return state

    class Rng:
        def rand(self) -> float:
            return _next() / 2**32

        def choice_index(self, weights: list[float]) -> int:
            total = sum(weights)
            x = self.rand() * total
            acc = 0.0
            for i, w in enumerate(weights):
                acc += w
                if x < acc:
                    return i
            return len(weights) - 1

    return Rng()


def softmax(logits: list[float]) -> list[float]:
    mlog = max(logits)
    exps = [math.exp(x - mlog) for x in logits]
    z = sum(exps)
    return [e / z for e in exps]


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def stdev(xs: list[float]) -> float:
    """Population standard deviation over the G rewards, i.e. divide by G."""
    if len(xs) < 2:
        return 0.0
    m = mean(xs)
    var = sum((x - m) ** 2 for x in xs) / len(xs)
    return math.sqrt(var)


def grpo_advantages(rewards: list[float], scale_by_std: bool) -> list[float] | None:
    """Outcome-supervision advantages for a single group.

    If scale_by_std is true, this is the DeepSeekMath / R1 formula
    A_i = (r_i - mean(r)) / std(r). If every reward is identical, std
    is 0 and the formula is undefined; we return None.
    If scale_by_std is false, this is Dr. GRPO's centering
    A_i = r_i - mean(r), which is 0 when the group is unanimous.
    """
    m = mean(rewards)
    if not scale_by_std:
        return [r - m for r in rewards]
    s = stdev(rewards)
    if s == 0.0:
        return None
    return [(r - m) / s for r in rewards]


def fmt(xs: list[float] | None, digits: int = 4) -> str:
    if xs is None:
        return "undefined (std=0)"
    parts = []
    for x in xs:
        parts.append(f"{0:.{digits}f}" if x == 0 else f"{x:+.{digits}f}")
    return "[" + ", ".join(parts) + "]"


def length_weights(lengths: list[int], mode: str) -> list[float]:
    """Per-token weight in the objective, before multiplying by the advantage.

    original: average tokens inside a response, then average the group,
              so the per-token weight is 1/(G * |o_i|).
    token_mean: DAPO-style, every token in the group shares 1/sum_i |o_i|.
    """
    g = len(lengths)
    total = sum(lengths)
    if mode == "original":
        return [1.0 / (g * L) for L in lengths]
    if mode == "token_mean":
        return [1.0 / total for _ in lengths]
    raise ValueError(mode)


def kl_unbiased(pi_ref: float, pi_theta: float) -> float:
    # Schulman 2020: r - log(r) - 1 with r = pi_ref / pi_theta, always >= 0.
    r = pi_ref / pi_theta
    return r - math.log(r) - 1.0


def clipped_term(ratio: float, advantage: float, eps_low: float, eps_high: float) -> float:
    unclipped = ratio * advantage
    clipped = min(max(ratio, 1.0 - eps_low), 1.0 + eps_high) * advantage
    return min(unclipped, clipped)


def ratio_outside(ratio: float, eps_low: float, eps_high: float) -> bool:
    return ratio < 1.0 - eps_low or ratio > 1.0 + eps_high


@dataclass
class RunRecord:
    steps: int
    n_groups: int
    n_unanimous: int
    n_mixed: int
    n_defined_std: int
    mean_reward: float
    probs: list[float]


def run_policy(
    seed: int,
    n_steps: int,
    group_size: int,
    scale_by_std: bool,
    lr: float,
) -> RunRecord:
    """Four actions with deterministic rewards, drawn from a categorical policy.

    Rewards given the action:
      0: 0, initially the most likely
      1: 1, one good action
      2: 1, another good action, identical reward
      3: 0, a rarer bad action
    The policy is a softmax over logits. Each group applies a REINFORCE
    update with the group-relative advantage of the chosen action,
    averaged over the group. The update is at action level: it does not
    encode response length.
    """
    rng = make_rng(seed)
    logits = [0.8, 0.0, 0.0, -0.5]
    rewards_of = [0.0, 1.0, 1.0, 0.0]
    n_unanimous = 0
    n_mixed = 0
    n_defined_std = 0
    reward_acc = 0.0
    n_groups = 0

    for _ in range(n_steps):
        p = softmax(logits)
        actions = [rng.choice_index(p) for _ in range(group_size)]
        rs = [rewards_of[a] for a in actions]
        n_groups += 1
        reward_acc += mean(rs)
        adv = grpo_advantages(rs, scale_by_std=scale_by_std)
        unanimous = len(set(rs)) == 1
        if unanimous:
            n_unanimous += 1
        else:
            n_mixed += 1
        if adv is None:
            continue
        n_defined_std += 1
        grad = [0.0] * 4
        for a, A in zip(actions, adv):
            for k in range(4):
                indicator = 1.0 if a == k else 0.0
                grad[k] += (A / group_size) * (indicator - p[k])
        for k in range(4):
            logits[k] += lr * grad[k]

    return RunRecord(
        steps=n_steps,
        n_groups=n_groups,
        n_unanimous=n_unanimous,
        n_mixed=n_mixed,
        n_defined_std=n_defined_std,
        mean_reward=(reward_acc / n_groups) if n_groups else 0.0,
        probs=softmax(logits),
    )


def main() -> None:
    print("=== 1. Group-relative advantages on fixed reward groups ===")
    groups = {
        "mixed 4/8": [1, 1, 0, 0, 1, 0, 0, 1],
        "easy 7/8": [1, 1, 1, 1, 1, 1, 1, 0],
        "hard 1/8": [1, 0, 0, 0, 0, 0, 0, 0],
        "all correct": [1, 1, 1, 1, 1, 1, 1, 1],
        "all wrong": [0, 0, 0, 0, 0, 0, 0, 0],
        "graded": [0.2, 0.4, 0.6, 0.8, 1.0, 0.3, 0.5, 0.7],
    }
    print(f"{'group':<14} {'mean':>6} {'std':>6}  advantages (std-scaled)  advantages (centered only)")
    for name, r in groups.items():
        s = stdev(r)
        a_std = grpo_advantages(r, True)
        a_ctr = grpo_advantages(r, False)
        print(f"{name:<14} {mean(r):6.3f} {s:6.3f}  {fmt(a_std):<28} {fmt(a_ctr)}")

    print("\n=== 2. Difficulty bias: |advantage| of a single minority output ===")
    print("Group size G=8, one correct and the rest wrong, versus seven correct and one wrong.")
    for name, r in (("hard 1/8", [1] + [0] * 7), ("easy 7/8", [1] * 7 + [0])):
        a_std = grpo_advantages(r, True)
        a_ctr = grpo_advantages(r, False)
        print(
            f"{name}: std-scaled {fmt(a_std)}; "
            f"centered-only {fmt(a_ctr)}; "
            f"|A_minority| std-scaled={max(abs(x) for x in a_std):.4f} "
            f"centered={max(abs(x) for x in a_ctr):.4f}"
        )

    print("\n=== 3. Length averaging: per-token weight of a correct response ===")
    lengths = [32, 256, 128, 128]
    labels = ["short correct (32)", "long correct (256)", "wrong (128)", "wrong (128)"]
    rewards = [1.0, 1.0, 0.0, 0.0]
    adv = grpo_advantages(rewards, True)
    print(f"rewards={rewards} advantages={fmt(adv)}")
    for mode in ("original", "token_mean"):
        w = length_weights(lengths, mode)
        print(f"-- {mode} per-token weights --")
        for lab, wi, A, L in zip(labels, w, adv, lengths):
            contrib = wi * A * L
            print(
                f"  {lab:<22} per-token weight={wi:.6f}  "
                f"times A={A:+.4f}  response contribution={contrib:+.6f}"
            )
        short_c = w[0] * adv[0] * lengths[0]
        long_c = w[1] * adv[1] * lengths[1]
        print(f"  short/long contribution ratio = {short_c / long_c:.3f}")

    print("\n=== 4. Clipping the probability ratio ===")
    ratios = [0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 2.0]
    settings = [
        ("PPO/GRPO eps=0.2", 0.2, 0.2),
        ("DAPO 0.2/0.28", 0.2, 0.28),
        ("R1 first-stage eps=10", 10.0, 10.0),
    ]
    for A in (1.0, -1.0):
        print(f"-- advantage A={A:+.1f} --")
        header = f"{'ratio':>7}  " + "  ".join(f"{name:>24}" for name, _, _ in settings)
        print(header)
        for ratio in ratios:
            cells = []
            for _, lo, hi in settings:
                used = clipped_term(ratio, A, lo, hi)
                flag = " *out" if ratio_outside(ratio, lo, hi) else "     "
                cells.append(f"{used:+.4f}{flag}")
            print(f"{ratio:7.2f}  " + "  ".join(f"{c:>24}" for c in cells))

    print("\n=== 5. Unbiased KL estimator (Schulman 2020) ===")
    print("k3 = r - log(r) - 1, r = pi_ref / pi_theta, always non-negative.")
    for pi_theta, pi_ref in [
        (0.20, 0.20),
        (0.25, 0.20),
        (0.40, 0.20),
        (0.10, 0.20),
        (0.05, 0.20),
        (0.80, 0.20),
    ]:
        k3 = kl_unbiased(pi_ref, pi_theta)
        log_ratio = math.log(pi_theta / pi_ref)
        print(
            f"  pi_theta={pi_theta:.2f} pi_ref={pi_ref:.2f}  "
            f"log(pi_theta/pi_ref)={log_ratio:+.4f}  k3={k3:.4f}"
        )

    init = [0.8, 0.0, 0.0, -0.5]
    print("\n=== 6. Tiny categorical policy, 4000 groups, G=8, seed=169, lr=0.15 ===")
    print("initial probs:", ", ".join(f"{p:.4f}" for p in softmax(init)))
    configs = [
        ("GRPO std-scaled", True),
        ("centered only (no std)", False),
    ]
    for name, scale in configs:
        st = run_policy(169, 4000, 8, scale, 0.15)
        print(
            f"{name}: mean_reward={st.mean_reward:.4f} "
            f"unanimous={st.n_unanimous}/{st.n_groups} "
            f"mixed={st.n_mixed}/{st.n_groups} "
            f"std_defined={st.n_defined_std}/{st.n_groups}"
        )
        print(
            "  final probs [bad0, good1, good2, rare_bad]:",
            ", ".join(f"{p:.4f}" for p in st.probs),
        )

    print("\n=== 7. Same policy, G=16, 4000 groups ===")
    for name, scale in configs:
        st = run_policy(169, 4000, 16, scale, 0.15)
        print(
            f"{name}: mean_reward={st.mean_reward:.4f} "
            f"unanimous={st.n_unanimous}/{st.n_groups} "
            f"mixed={st.n_mixed}/{st.n_groups}"
        )
        print("  final probs:", ", ".join(f"{p:.4f}" for p in st.probs))


if __name__ == "__main__":
    main()
```

## 总结

- GRPO 保留了 PPO 的裁剪概率比，丢掉了价值模型。对每一道题，它生成一组答案、打分，并且只用这些分数做基线。在结果监督下，一条答案里的每个 token 共享 A_i = (r_i - mean(r)) / std(r)。全体一致的组标准差为零，不贡献梯度。
- 当奖励只是一条又长、又会自我修改的思维链末尾的一个结果时，这笔交易是合理的，因为这对 token 级的 Critic 是一个很难的目标。在 R1 作者的对比里，PPO 仍然可以在 MATH 上接近 GRPO，但需要把 GAE 的 lambda 设为 1.0 而不是常见的 0.95，并且还要再训练一个同样大的模型。
- DeepSeekMath 从 DeepSeekMath-Instruct 7B 出发做 GRPO，G = 64，使用学出来的奖励模型，长度上限 1,024，并报告域内分数从 GSM8K 的 82.9% 提到 88.2%，从 MATH 的 46.8% 提到 51.7%，域外的 CMATH 从 84.6% 提到 88.8%。
- DeepSeek-R1-Zero 把 GRPO 用在未经监督预热的 DeepSeek-V3 Base 上，奖励纯粹基于规则（正确性加格式），G = 16，最大长度从 32,768 再到 65,536 个 token。论文报告 AIME 2024 的 pass@1 从 15.6% 升到 77.9%，Cons@16 达到 86.7%，平均回答长度在没有长度奖励的情况下上升。DeepSeek-R1 增加了冷启动监督阶段、语言一致性奖励、第二次监督训练，以及一段短而晚的、用于有用性和无害性的偏好奖励强化学习。
- 原目标函数里的两处记账选择不是中性的。对 |o_i| 取平均会在每个 token 上过度加权短的正确答案；除以组内标准差会抬高罕见的成功和罕见的失败。Dr. GRPO 把这两处都去掉。DAPO 保留组基线，但改了裁剪（不对称的 0.2/0.28）、归约（token-mean）、批次（过滤全体一致的组）和超长惩罚，并报告从 Qwen2.5-32B 基座模型在 AIME 2024 上得到 50 分。
- 在模型里，4/8 组按标准差缩放的优势是 +/- 1.000；7/8 或 1/8 组的少数派被缩放到 +/- 2.6458。原归约让 32 token 和 256 token 的正确答案有相同的回答贡献 +0.250000；token-mean 则分别给出 0.058824 和 0.470588。在 4,000 组、每组大小为 8 之后，一个初始在错误动作上概率为 0.4606 的小策略，平均奖励达到 0.9942，但其中 3,869 组已经全体一致，只剩 131 组还能提供按标准差缩放的梯度。

## 参考文献

- Zhihong Shao, Peiyi Wang, Qihao Zhu, Runxin Xu, Junxiao Song, Xiao Bi, Haowei Zhang, Mingchuan Zhang, Y.K. Li, Y. Wu, and Daya Guo, [DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models](https://arxiv.org/abs/2402.03300), arXiv:2402.03300, 2024
- DeepSeek-AI, [DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning](https://arxiv.org/abs/2501.12948), arXiv:2501.12948, 2025; 亦见 [Nature 645, 633-638 (2025)](https://www.nature.com/articles/s41586-025-09422-z)
- John Schulman, Filip Wolski, Prafulla Dhariwal, Alec Radford, and Oleg Klimov, [Proximal Policy Optimization Algorithms](https://arxiv.org/abs/1707.06347), arXiv:1707.06347, 2017
- John Schulman, Philipp Moritz, Sergey Levine, Michael Jordan, and Pieter Abbeel, [High-Dimensional Continuous Control Using Generalized Advantage Estimation](https://arxiv.org/abs/1506.02438), arXiv:1506.02438, 2015
- John Schulman, [Approximating KL Divergence](http://joschu.net/blog/kl-approx.html), 2020
- Long Ouyang, Jeff Wu, Xu Jiang, Diogo Almeida, Carroll L. Wainwright, Pamela Mishkin, Chong Zhang, Sandhini Agarwal, Katarina Slama, Alex Ray, John Schulman, Jacob Hilton, Fraser Kelton, Luke Miller, Maddie Simens, Amanda Askell, Peter Welinder, Paul Christiano, Jan Leike, and Ryan Lowe, [Training language models to follow instructions with human feedback](https://arxiv.org/abs/2203.02155), NeurIPS 2022
- Rafael Rafailov, Archit Sharma, Eric Mitchell, Stefano Ermon, Christopher D. Manning, and Chelsea Finn, [Direct Preference Optimization: Your Language Model is Secretly a Reward Model](https://arxiv.org/abs/2305.18290), NeurIPS 2023
- Zichen Liu, Changyu Chen, Wenjun Li, Penghui Qi, Tianyu Pang, Chao Du, Wee Sun Lee, and Min Lin, [Understanding R1-Zero-Like Training: A Critical Perspective](https://arxiv.org/abs/2503.20783), arXiv:2503.20783, 2025
- Qiying Yu et al., [DAPO: An Open-Source LLM Reinforcement Learning System at Scale](https://arxiv.org/abs/2503.14476), arXiv:2503.14476, 2025
- Hugging Face TRL, [GRPO Trainer](https://huggingface.co/docs/trl/grpo_trainer)
- veRL, [volcengine/verl](https://github.com/volcengine/verl)
