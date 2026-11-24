---
title: "Group Relative Policy Optimization: How Reasoning Models Learn Without a Critic"
tag: ai
description: How GRPO replaces PPO's value model with a baseline computed from a group of answers to the same question, why that fits outcome rewards on long chain-of-thought, how DeepSeekMath and DeepSeek-R1 actually train, what length and difficulty biases sit in the original objective, what DAPO and Dr. GRPO change, and a runnable model that measures advantages, clipping, the KL estimator and a tiny policy update
date: "2026-11-24T13:29:00.000Z"
---

## Goal

A reasoning model is not only a pretrained transformer. The ones that write a long chain of thought, check themselves, and try another approach learned that behavior from a reward: the boxed number matched the key, the program passed the official judging cases, the format tags were in the right place. The algorithm that made this style of training practical for open models in 2024 and 2025 is **Group Relative Policy Optimization (GRPO)**. It first appeared in the DeepSeekMath paper, and it is the reinforcement-learning method behind DeepSeek-R1-Zero and DeepSeek-R1.

Proximal Policy Optimization (PPO), the usual tool for this stage since InstructGPT, wants a **critic**: a second model, often as large as the policy, that predicts expected return at every token so you can compute an advantage. That critic is expensive, and it is a poor fit when the only reward arrives at the last token of a solution that may be tens of thousands of tokens long and that may contradict itself halfway through. GRPO throws the critic away. For each question it draws a group of *G* complete answers from the current policy, scores them, and uses the mean and standard deviation *inside that group* as the baseline. Answers that beat their siblings get a positive advantage; answers that lag get a negative one. If every answer in the group is equally good, the advantage is zero and that group teaches nothing.

This article covers:

1. The training signal, and why verifiable rewards changed the problem.
2. PPO in the LLM setting, and why the critic is awkward.
3. How GRPO builds a baseline from a group of answers.
4. The objective: the probability-ratio clip, the per-response average, and KL in the loss.
5. Outcome supervision, process supervision, and rule-based rewards.
6. What DeepSeekMath measured on a 7B instruction-tuned model.
7. DeepSeek-R1-Zero: reinforcement learning from a base model.
8. DeepSeek-R1's multi-stage pipeline.
9. Biases in the original objective, and what Dr. GRPO and DAPO change.
10. Trade-offs.
11. A runnable model that measures advantages, clipping, the KL estimator, and a tiny policy update.

## 1. The training signal

Supervised fine-tuning teaches a model to imitate answers that already exist. Reinforcement learning teaches it to prefer answers that score well, including answers no human wrote. The difference matters once you care about solutions that are long, checkable, and not unique: a proof, a program, a tool-using trajectory. Many correct traces can exist for one prompt, and a trace can start poorly and recover.

For a long time the default recipe, after InstructGPT, was a learned reward model plus PPO. A reward model is itself a large network trained on human (or AI) preference pairs. It can capture subtle qualities such as helpfulness, and it can also be gamed. DeepSeek-R1's authors state plainly that they stayed away from neural reward models on reasoning tasks because those models are susceptible to **reward hacking** at large scale, and because retraining them adds a second optimization loop.

What replaced them, for math and code, is a **verifiable** reward. For a math problem with a deterministic result, the model must put the final answer in a specified format — often a box — and a rule checks it against the key. For a programming problem, a compiler and a set of official judging cases decide correctness. Format rules can add a second, cheaper signal: did the model wrap its reasoning in the required tags? DeepSeek-R1-Zero adds the accuracy reward and the format reward with equal weight:

`Reward_rule = Reward_acc + Reward_format`

That is a sparse, terminal signal. Almost every token in a long chain of thought has no reward of its own. The training algorithm has to turn one number at the end of a response, and a handful of such numbers for the same question, into a credit assignment for tens of thousands of tokens. GRPO is one answer to that assignment problem. This blog has already looked at what those long traces *cost* at serving time, in [an earlier post on KV cache and PagedAttention](/blog/140-llm-inference-kv-cache-paged-attention/en) and in [another on prefill-decode disaggregation](/blog/159-prefill-decode-disaggregation/en). Here the question is how the model learned to write them.

## 2. PPO, and why the critic is awkward

PPO (Schulman et al., 2017) is an actor-critic method. The policy \(\pi_\theta\) generates a response \(o\) for a question \(q\). At each token the algorithm forms a **probability ratio** between the current policy and the policy that produced the data, \(\pi_{\theta_{old}}\):

`ratio_t = π_θ(o_t | q, o_<t) / π_θold(o_t | q, o_<t)`

and maximizes a clipped surrogate. Writing \(\varepsilon\) for the clip range, the token term is the minimum of `ratio_t * A_t` and `clip(ratio_t, 1-ε, 1+ε) * A_t`. The clip is there to stop a single update from moving the policy too far: when the advantage is positive, a token cannot claim more credit than `(1+ε) A_t` by becoming much more likely; when the advantage is negative and the token has already become much *less* likely, the surrogate stops pushing.

The advantage \(A_t\) is usually estimated with Generalized Advantage Estimation (GAE), which needs a **value function** \(V_\psi(s_t)\) — the critic — as a baseline. InstructGPT also subtracts a KL penalty from the reward at every token, so that the policy cannot wander too far from the supervised starting point.

Two problems show up when the policy is a large language model and the reward is an outcome.

The critic is typically another model of comparable size. You have to load it, train it, and keep it coherent with a policy that is itself moving. That is a serious memory and compute tax, and it is the first reason DeepSeekMath gives for replacing PPO.

The second reason is statistical. In this setting the reward model, or the rule, usually assigns a score only to the *last* token. A critic trained to predict expected return at every prefix is being asked to forecast the final score from a partial chain of thought. DeepSeek-R1's comparison of GRPO and PPO makes this sharper for long reasoning traces: as the response grows, the model is more likely to reflect, revise, and contradict an earlier step, so the prefix is an even weaker predictor of the eventual reward. GAE has a \(\lambda\) that interpolates between fully discounted Monte Carlo and a one-step temporal-difference backup. In the R1 authors' MATH comparison on DeepSeek-Coder-V2-Lite (a 16B MoE with 2.4B active parameters), PPO with the common default \(\lambda = 0.95\) lagged GRPO clearly; setting \(\lambda = 1.0\), which leans on the full return rather than the critic's bootstrap, brought PPO close to GRPO. The critic can be made to work. It is not free, and it is sensitive to a knob that is easy to leave at the wrong default.

## 3. A group of answers as the baseline

GRPO keeps PPO's clipped probability ratio and drops the value model. For each question \(q\), it draws a group of outputs \(\{o_1, \ldots, o_G\}\) from \(\pi_{\theta_{old}}\) and scores them, producing rewards \(\{r_1, \ldots, r_G\}\). The advantage of each output is computed only from those group scores. Under **outcome supervision**, every token in \(o_i\) shares the same advantage:

`A_i = (r_i − mean(r)) / std(r)`

A correct answer in a group that is half correct and half wrong gets \(A = +1\) when rewards are (0/1) and the population standard deviation is used. A correct answer in a group where almost everyone is already correct gets a much smaller positive advantage; a lone failure in that group gets a large negative one. If every output has the same reward, the standard deviation is zero and the formula is undefined. Implementations then treat the advantage as zero, which is also what you get if you only subtract the mean. A unanimous group contributes no policy gradient. That fact will come back in section 9.

This baseline has a second, conceptual, appeal that DeepSeekMath points out: reward models are often trained on *comparisons between answers to the same question*. Scoring a group on one prompt is the same shape of comparison, even when the scorer is a deterministic rule rather than a network.

The group size is a real hyperparameter, not a footnote. DeepSeekMath used \(G = 64\) outputs per question, with a maximum length of 1,024. DeepSeek-R1-Zero used \(G = 16\), with a maximum length of 32,768 tokens, later raised to 65,536. The product of group size, response length, and the number of unique questions in a step is what you actually have to generate between policy updates. R1-Zero used 32 unique questions per step (a batch of 512 sequences), and generated 8,192 outputs per rollout before splitting them into 16 mini-batches for a single inner epoch.

## 4. The objective: clip, length, and KL

DeepSeekMath writes a **token-level** objective. For each output \(o_i\) it averages the clipped term over the (|o_i|) tokens, subtracts a KL regularizer, and then averages over the group:

the per-token term is

`min( ratio_{i,t} * A_{i,t},  clip(ratio_{i,t}, 1−ε, 1+ε) * A_{i,t} )  −  β  KL(π_θ || π_ref)`

and those terms are reduced by \(\frac{1}{G} \sum_i \frac{1}{|o_i|} \sum_t (\cdot)\). The \(\frac{1}{|o_i|}\) factor means that, if the probability ratios are close to one, each *response* contributes the same amount to the objective regardless of how long it is. Per token, a short correct answer is weighted more heavily than a long one. Whether that is a feature or a bug is the subject of section 9.

The Nature write-up of DeepSeek-R1 presents a more compact, **sequence-level** form of the same idea: a single probability ratio \(\pi_\theta(o_i|q) / \pi_{\theta_{old}}(o_i|q)\) multiplied by \(A_i\), still clipped, still with a KL term. Open training stacks such as veRL and TRL typically implement the token-level DeepSeekMath form, sometimes with the reductions discussed later.

Two KL details are easy to skip and expensive to skip.

PPO, in the InstructGPT style, subtracts a KL penalty *from the reward* at every token. Because reinforcement learning maximizes cumulative reward, that choice penalizes the *sum* of KL along the response, which can implicitly tax length. GRPO instead adds an estimator of \(\mathrm{KL}(\pi_\theta \| \pi_{ref})\) **in the loss**, so the advantage itself is not mixed with a length-dependent penalty. The estimator is the one Schulman recommended in 2020:

`KL ≈ π_ref / π_θ − log(π_ref / π_θ) − 1`

It is unbiased (in the usual Monte Carlo sense) and is guaranteed to be non-negative, unlike a bare `log(π_θ / π_ref)`, which changes sign. In the model at the end, when the policy has four times the reference probability, this k3 estimator is 0.6363, while the signed log ratio is +1.3863; when the policy has one quarter of the reference probability, k3 is 1.6137 and the signed log ratio is −1.3863.

The reference policy also has a lifetime. If \(\pi_{ref}\) is frozen at the initial supervised (or base) model for thousands of steps, a long-thinking policy will eventually be heavily taxed for leaving that starting point. DeepSeekMath's iterative recipe periodically replaces the reference with the current policy. DeepSeek-R1-Zero does the same every 400 steps, and uses a small coefficient \(\beta = 0.001\) (DeepSeekMath used 0.04). The clip range is another such knob: R1's first RL stage sets \(\varepsilon = 10\), far above the textbook 0.2, because a tight clip was truncating gradients on a large fraction of tokens.

## 5. Outcome supervision, process supervision, and rules

With **outcome supervision**, the normalized group reward is placed at the end of the response and copied backward as \(A_{i,t}\) for every token. That is the form used for rule-based math and code rewards, and it is what the model in section 11 implements.

DeepSeekMath also tried **process supervision**. A process reward model scores each reasoning step. Those step rewards are normalized together, across steps and across the group, and the advantage of a token is the *sum of the normalized step rewards from that token onward*. Credit then arrives earlier than the final box, at the cost of a step parser and a second learned (or labeled) scorer. For DeepSeek-R1-Zero the authors refused that trade: they used only rules, on the final answer and on the format, after observing that neural outcome and process reward models were both vulnerable to hacking in large-scale runs.

The format they enforced is simple. A template tells the assistant to think first and then answer, and to wrap the reasoning and the answer in designated tags — in the published traces, `<think> ... </think>` around the chain of thought, with the numeric answer in a box. They deliberately did not prescribe *how* to think, so that whatever reflective behavior appeared later could be attributed to the reward, not to a scripted style in the prompt.

## 6. DeepSeekMath: GRPO on a 7B instruction-tuned model

DeepSeekMath-RL starts from DeepSeekMath-Instruct 7B, not from a raw base model. The RL data are the chain-of-thought questions from the supervised set that come from GSM8K and MATH, about 144,000 prompts. Other supervised prompts are held out of the RL phase on purpose, so that gains on those benchmarks can be read as out-of-domain effects of the update.

The policy learning rate is \(1 \times 10^{-6}\), the KL coefficient is 0.04, the batch size is 1,024, the maximum length is 1,024, and there is a single policy update after each exploration stage. The initial reward model is trained from DeepSeekMath-Base 7B at \(2 \times 10^{-5}\). Under this setup the paper reports that GRPO lifts in-domain chain-of-thought scores from 82.9% to 88.2% on GSM8K and from 46.8% to 51.7% on MATH, and also lifts an out-of-domain Chinese benchmark, CMATH, from 84.6% to 88.8%. The 51.7% MATH figure in the abstract is the GRPO-trained 7B, without external tools and without voting; self-consistency over 64 generations of DeepSeekMath 7B reaches 60.9% on MATH.

DeepSeekMath also frames RFT, DPO, PPO, and GRPO as members of one family. DPO (Rafailov et al., 2023) never draws fresh groups during training: it fits an implicit reward from fixed preference pairs and never trains a critic either, but it is offline. GRPO is on-policy (or slightly off-policy, through \(\pi_{\theta_{old}}\)) and spends its budget on new rollouts. That is the right spending when the policy is going to change so much that yesterday's preference pairs no longer describe it — which is exactly what happens when a model starts writing much longer traces.

## 7. DeepSeek-R1-Zero: RL from a base model

DeepSeek-R1-Zero applies GRPO **directly to DeepSeek-V3 Base**, skipping supervised fine-tuning. The hypothesis, as the authors state it, is that human demonstrations may cap the reasoning styles the model is willing to explore, and that a pure RL run can grow new ones if the reward is reliable. The backbone is the DeepSeek-V3 MoE, whose routing this blog has already discussed in [a post on Mixture of Experts](/blog/150-mixture-of-experts-routing-parallelism/en).

The run is larger than DeepSeekMath in every direction that matters for long reasoning. The learning rate is \(3 \times 10^{-6}\), \(\beta = 0.001\), the softmax temperature for rollouts is 1, \(G = 16\), and the maximum length starts at 32,768 tokens and jumps to 65,536 after step 8,200. Training lasts 10,400 steps, about 1.6 epochs. The authors record a jump in both accuracy and response length at the length-limit change.

On the AIME 2024 benchmark, they report that DeepSeek-R1-Zero's average pass@1 moves from 15.6% at the start of RL to 77.9%. With self-consistency (Cons@16), the same model reaches 86.7%. Average response length on the training set rises throughout, without any explicit reward on length: the model is not paid to be verbose, it is paid to be correct, and it uses more tokens as a means. Reflective phrases, including a sudden increase in the word "wait", show up as training proceeds. The paper calls one such passage an "aha moment" — not because a metric ticks over, but because the model stops, re-evaluates a derivation, and tries again, in a way nobody wrote into the reward.

This is the most important qualitative claim of the work, and it should be read with the later critiques in section 9 in mind. Longer traces *are* a genuine product of outcome-based RL on hard, verifiable tasks. Some of the length trend can also be amplified by the way the original GRPO objective weights sequences. Both things can be true.

## 8. DeepSeek-R1: cold start, a second supervised stage, and a second RL stage

R1-Zero is a strong reasoner and a poor conversationalist. The paper lists poor readability and language mixing — DeepSeek-V3 Base is multilingual, especially in English and Chinese — as the reasons to build DeepSeek-R1 on a longer pipeline.

The first stage is a **cold start**: thousands of traces that already have a conversational, human-aligned thinking style, used as supervised data before RL. The first RL stage then looks a lot like R1-Zero (same learning rate, same \(\beta\), same \(G = 16\), same 32-question steps, same 8,192-output rollouts, same 400-step reference refresh, clip \(\varepsilon = 10\)) with one extra reward: a **language-consistency** term, the fraction of words in the chain of thought that belong to the target language. The authors report that this alignment costs a little task performance and is worth it for readability. The maximum length in this stage is 32,768.

After that, they filter high-reward rollouts and run another supervised pass, now mixing reasoning data with non-reasoning writing data, so the model is not only a solver. A second RL stage continues the rule-based reasoning reward and, in its last 400 steps of a 1,700-step run, adds preference-model rewards for helpfulness and harmlessness. Helpfulness is judged on the final summary only, so the scorer does not keep interrupting the chain of thought; harmlessness is judged on the whole response. They keep those preference rewards late and brief on purpose: more steps with the learned preference signal led to reward hacking. The softmax temperature drops to 0.7 in this stage, because higher temperatures produced incoherent generations.

The pipeline is therefore not "GRPO versus supervised learning." It is GRPO in two different reward regimes, with supervised data used to start a readable style and to put non-reasoning skills back in after the first RL pass.

## 9. Biases, Dr. GRPO, and DAPO

The original objective has two knobs that later work treats as biases.

**Length.** Averaging over (|o_i|) gives each response the same total weight in the objective, and a larger per-token weight to shorter responses. Liu et al. (2025), in *Understanding R1-Zero-Like Training*, call the resulting updates **Dr. GRPO** when both this factor and the standard-deviation term are removed, leaving \(A_i = r_i - \mathrm{mean}(r)\). Their claim is that \(\frac{1}{|o_i|}\) over-weights short correct answers (positive advantage) and under-penalizes long wrong ones (negative advantage), which can push the policy toward brief successes and long failures. In the model below, a 32-token correct answer and a 256-token correct answer each contribute (+0.250) under the original reduction, but the short one has a per-token weight eight times larger (0.007812 versus 0.000977). If every token in the group instead shares a single weight \(1/\sum_i |o_i|\) — the **token-mean** reduction used by DAPO — the long correct answer contributes eight times as much as the short one (0.470588 versus 0.058824).

**Difficulty.** Dividing by the group standard deviation rescales easy and hard prompts differently. A group that is 4/8 correct has standard deviation 0.500 and advantages \(\pm 1.000\). A group that is 7/8 or 1/8 correct has standard deviation 0.331, and the *minority* answer gets advantage \(\pm 2.6458\) — \(\sqrt{7}\) times the centered gap of 0.875. Rare successes on hard questions, and rare failures on easy ones, are therefore up-weighted relative to a medium-difficulty group. Unanimous groups (0/8 or 8/8) are worse in a different way: the gradient is exactly zero, so as the policy improves, more and more of the batch stops teaching. DAPO calls this a gradient-decreasing problem and **filters** groups whose accuracy is 0 or 1, drawing more rollouts until the batch is full of mixed groups.

DAPO (Yu et al., 2025) is a complete training recipe built on that diagnosis, and an open system on top of veRL. Four changes do most of the work:

- **Clip-Higher.** The clip is allowed to be asymmetric. Their reported bounds are \(\varepsilon_{low} = 0.2\) and \(\varepsilon_{high} = 0.28\). The higher upper bound lets low-probability "exploration" tokens rise farther in one update; a tight upper clip, they argue, is one path to entropy collapse, where a group's answers become nearly identical. In the model, a probability ratio of 1.5 with advantage (+1) is capped at 1.200 under a symmetric \(\varepsilon = 0.2\), at 1.280 under DAPO's bounds, and is left at 1.500 when \(\varepsilon = 10\) as in R1's first stage.
- **Dynamic group filtering**, as above, so that zero-advantage groups do not dilute the batch.
- **Token-mean loss**, already described, in place of a per-response \(\frac{1}{|o_i|}\).
- **Soft shaping of overlong responses**, rather than a hard zero at the length cap, so a slightly too-long correct answer is not treated as the same event as a wrong answer.

With this recipe, the DAPO paper reports 50 points on AIME 2024 from a Qwen2.5-32B *base* model. Their published objective also drops the KL term; exploration is handled by the clip, the filter, and the data, not by a moving reference.

None of these changes abandons the central idea. They still draw a group of answers, still score them, and still use the siblings as the baseline. They disagree about how to turn those scores into a gradient once the group is in hand.

## 10. Trade-offs

GRPO is not a free lunch, and it is not the only way to train a reasoner.

- **You pay for the group.** A critic is expensive, but so is generating \(G\) long traces per prompt. If \(G\) is too small, the group mean is a noisy baseline; if it is large, the rollout becomes the bottleneck. R1-Zero's 16-wide groups at 32k–64k tokens are a different engineering problem from DeepSeekMath's 64-wide groups at 1,024 tokens.
- **Verifiable rewards are narrow.** Rules work for math, code, and other tasks with a checker. They do not, by themselves, teach tone, safety, or the kind of helpfulness that has no key. R1 puts learned preference rewards back in for that, late and carefully, because those rewards can be hacked.
- **Zero-advantage groups waste work.** As the policy improves, more prompts go to 0% or 100% inside the group. You can accept the waste, filter it (DAPO), or change the data. You cannot ignore it in a long run.
- **The original reductions leak into behavior.** Length averaging and group-standard-deviation scaling are not neutral bookkeeping. If you want length to be a means to correctness rather than an artifact of the loss, you have to choose the reduction on purpose.
- **On-policy rollouts follow a moving target.** That is the point, and it is why GRPO can grow new reasoning habits. It is also why you need a stable generation stack, a clean reward implementation, and a plan for the reference policy. DPO is cheaper when a fixed preference set is still representative. It is not a substitute for new rollouts once the policy has left that set behind.
- **Serving pays the bill.** A model that thinks for thousands of tokens raises prefill and decode cost, KV-cache footprint, and the value of prefix reuse on a repeated stem. Those are the concerns of the earlier posts cited above, and of [prefix caching and RadixAttention](/blog/164-prefix-caching-radixattention/en). Training a reasoner and serving one are the same object seen from two sides.

## 11. A runnable model

The script below does not train a language model. It implements outcome-supervision advantages, the two reductions, the clipped surrogate, the Schulman KL estimator, and a four-action categorical policy updated with group-relative advantages. It uses a tiny linear congruential generator so the printed numbers are reproducible without third-party libraries. Population standard deviation (divide by \(G\), not \(G-1\)) is used throughout.

On the fixed reward groups, a 4/8 split has mean 0.500, standard deviation 0.500, and std-scaled advantages \(\pm 1.000\). A 7/8 "easy" group and a 1/8 "hard" group share standard deviation 0.331; the minority output is scaled to \(\pm 2.6458\), against a centered-only minority of \(\pm 0.8750\). All-correct and all-wrong groups are undefined once you divide by the standard deviation, and are zero if you only subtract the mean.

Under the original reduction, the short and long correct answers contribute equally ((+0.250000), ratio 1.000). Under token-mean, the long one contributes 0.470588 and the short one 0.058824, a ratio of 0.125, which is also (32/256).

The categorical policy starts with probabilities 0.4606, 0.2070, 0.2070, 0.1255 — the mode is a wrong action, and the two reward-1 actions start equal. After 4,000 groups of size 8, the std-scaled run has mean reward 0.9942, but that average includes the long stretch after the policy has already moved; 3,869 of 4,000 groups are unanimous, and only the 131 mixed groups have a defined standard deviation and a nonzero std-scaled gradient. The final probabilities are 0.0003, 0.9397, 0.0598, 0.0002. The centered-only run ends at 0.0009, 0.9033, 0.0950, 0.0008, with 3,705 unanimous groups. Concentration onto one of the two equally good actions is a property of this run, not a length effect: the update is at action level and does not encode token counts. The more useful number is how quickly mixed groups dry up once the policy has found a winning action. That is the situation DAPO's filter is built for.

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

## Summary

- GRPO keeps PPO's clipped probability ratio and drops the value model. For each question it draws a group of answers, scores them, and uses only those scores as the baseline. Under outcome supervision, every token in an answer shares A_i = (r_i - mean(r)) / std(r). A unanimous group has standard deviation zero and contributes no gradient.
- That trade makes sense when the reward is a single outcome at the end of a long, self-revising chain of thought, which is a hard target for a token-level critic. PPO can still match GRPO on MATH in the R1 authors' comparison, but only after setting GAE's lambda to 1.0 rather than the common 0.95, and at the cost of training a second large model.
- DeepSeekMath trained GRPO on DeepSeekMath-Instruct 7B with G = 64, a learned reward model, and a 1,024-token cap, and reports in-domain lifts from 82.9% to 88.2% on GSM8K and from 46.8% to 51.7% on MATH, plus an out-of-domain lift on CMATH from 84.6% to 88.8%.
- DeepSeek-R1-Zero applies GRPO to DeepSeek-V3 Base with no supervised warm start, a purely rule-based reward (accuracy plus format), G = 16, and maximum lengths of 32,768 then 65,536 tokens. The paper reports AIME 2024 pass@1 moving from 15.6% to 77.9%, and 86.7% with Cons@16, while average response length rises without a length reward. DeepSeek-R1 adds a cold-start supervised stage, a language-consistency reward, a second supervised pass, and a short, late preference-reward RL stage for helpfulness and harmlessness.
- Two bookkeeping choices in the original objective are not neutral. Averaging over |o_i| over-weights short correct answers per token; dividing by the group standard deviation up-weights rare successes and rare failures. Dr. GRPO removes both. DAPO keeps the group baseline and changes the clip (asymmetric 0.2/0.28), the reduction (token-mean), the batch (filter unanimous groups), and the overlong penalty, reporting 50 points on AIME 2024 from Qwen2.5-32B base.
- In the model, a 4/8 group has std-scaled advantages of +/- 1.000; a 7/8 or 1/8 group's minority is scaled to +/- 2.6458. The original reduction gives a 32-token and a 256-token correct answer the same response contribution of +0.250000; token-mean gives them 0.058824 and 0.470588. After 4,000 groups of size 8, a tiny policy that started at 0.4606 on a wrong action reaches mean reward 0.9942, but 3,869 of those groups are already unanimous and only 131 still provide a std-scaled gradient.

## References

- Zhihong Shao, Peiyi Wang, Qihao Zhu, Runxin Xu, Junxiao Song, Xiao Bi, Haowei Zhang, Mingchuan Zhang, Y.K. Li, Y. Wu, and Daya Guo, [DeepSeekMath: Pushing the Limits of Mathematical Reasoning in Open Language Models](https://arxiv.org/abs/2402.03300), arXiv:2402.03300, 2024
- DeepSeek-AI, [DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning](https://arxiv.org/abs/2501.12948), arXiv:2501.12948, 2025; also [Nature 645, 633-638 (2025)](https://www.nature.com/articles/s41586-025-09422-z)
- John Schulman, Filip Wolski, Prafulla Dhariwal, Alec Radford, and Oleg Klimov, [Proximal Policy Optimization Algorithms](https://arxiv.org/abs/1707.06347), arXiv:1707.06347, 2017
- John Schulman, Philipp Moritz, Sergey Levine, Michael Jordan, and Pieter Abbeel, [High-Dimensional Continuous Control Using Generalized Advantage Estimation](https://arxiv.org/abs/1506.02438), arXiv:1506.02438, 2015
- John Schulman, [Approximating KL Divergence](http://joschu.net/blog/kl-approx.html), 2020
- Long Ouyang, Jeff Wu, Xu Jiang, Diogo Almeida, Carroll L. Wainwright, Pamela Mishkin, Chong Zhang, Sandhini Agarwal, Katarina Slama, Alex Ray, John Schulman, Jacob Hilton, Fraser Kelton, Luke Miller, Maddie Simens, Amanda Askell, Peter Welinder, Paul Christiano, Jan Leike, and Ryan Lowe, [Training language models to follow instructions with human feedback](https://arxiv.org/abs/2203.02155), NeurIPS 2022
- Rafael Rafailov, Archit Sharma, Eric Mitchell, Stefano Ermon, Christopher D. Manning, and Chelsea Finn, [Direct Preference Optimization: Your Language Model is Secretly a Reward Model](https://arxiv.org/abs/2305.18290), NeurIPS 2023
- Zichen Liu, Changyu Chen, Wenjun Li, Penghui Qi, Tianyu Pang, Chao Du, Wee Sun Lee, and Min Lin, [Understanding R1-Zero-Like Training: A Critical Perspective](https://arxiv.org/abs/2503.20783), arXiv:2503.20783, 2025
- Qiying Yu et al., [DAPO: An Open-Source LLM Reinforcement Learning System at Scale](https://arxiv.org/abs/2503.14476), arXiv:2503.14476, 2025
- Hugging Face TRL, [GRPO Trainer](https://huggingface.co/docs/trl/grpo_trainer)
- veRL, [volcengine/verl](https://github.com/volcengine/verl)
