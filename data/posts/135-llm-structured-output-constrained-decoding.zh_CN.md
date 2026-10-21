---
title: "结构化输出与工具调用：约束解码如何让大模型稳定输出 JSON"
tag: ai
description: 为什么 Agent 需要机器可读的模型输出，以及如何在解码阶段强制保证——token 掩码、把正则与 JSON Schema 编译成有限状态机、上下文无关文法与下推自动机（Outlines、XGrammar、llguidance、GBNF）、token 边界问题、各家服务的 strict 模式，以及可靠性、延迟和回答质量之间的取舍
date: "2026-10-21T12:30:00.000Z"
---

## 目标

几乎每个 Agent 框架最终都会撞上同一堵墙：模型必须输出程序能解析的东西。一次工具调用是"函数名 + 符合 schema 的参数"；抽取流水线需要字段齐全的 JSON 对象；路由器需要从五个标签里选一个。靠一句"请用 JSON 回答"的自由文本大多数时候能用，而"大多数时候"恰恰会毁掉长链路的 Agent 循环——只要有一步格式错误，后面全部跑偏。

本文讲清楚现代推理栈如何把"通常合法"变成"构造上即合法"：三个层级的约束手段（提示、校验重试、约束解码），约束解码背后的机制——用从正则、JSON Schema 或文法编译出的自动机去屏蔽 logits，让它难做的工程问题（分词、速度、无法编译的 schema 特性），托管 API 的 strict 模式到底保证了什么，以及什么时候约束弊大于利。

## 三个层级

| 层级 | 做法 | 保证 | 代价 |
|---|---|---|---|
| 提示 | 描述格式、给示例、预填 `{` | 无，通常合法 | 免费 |
| 校验重试 | 解析输出，把错误回传，再问一次 | 最终合法，或 N 次后失败 | 额外往返，延迟长尾不可控 |
| 约束解码 | 每一步禁止会导致输出非法的 token | 构造上语法合法（前提是生成正常结束） | 文法编译 + 每 token 掩码计算 |

Instructor 这类库处在第 2 层：把 Pydantic 模型转成 schema，调用模型，用 Pydantic 校验，再带着校验错误重问。即使用上了第 3 层，这一层依然有价值，因为约束解码只保证*形状*：它不知道 `end_date` 必须晚于 `start_date`，也不知道某个客户 ID 是否真实存在。稳健的流水线用解码约束管语法，用校验器管语义。

## 一段话讲清解码

自回归模型每一步输出一个 logits 向量——词表里每个 token 一个分数（当前模型的词表常见 10 万到 20 万个条目）。解码器施加 temperature、top-p 等变换，把分数变成概率，选出一个 token 追加到序列，然后重复。约束解码只多插入一步变换：**把所有会导致输出非法的 token 的 logit 设为 −∞**。这些 token 的概率变为零，永远不会被选中。模型仍按自己的偏好在剩余 token 中选择，所以输出是*在允许的语言之内*模型最可能的续写。

```python
import math

def constrained_step(logits, allowed_token_ids):
    """屏蔽允许集合之外的所有 token，然后照常选取。"""
    masked = [-math.inf] * len(logits)
    for t in allowed_token_ids:
        masked[t] = logits[t]
    return choose_token(masked)  # temperature / top-p / argmax 均不变
```

真正的难点在于又对又快地算出 `allowed_token_ids`——每一步都要算，词表有十万个多字符 token。

## 正则语言：编译成有限状态机

Willard 和 Louf 的论文《Efficient Guided Generation for Large Language Models》（2023，Outlines 库的基础）给出了关键洞察：如果目标格式是一个正则表达式，就能把它编译成一个基于*字符*的确定有限自动机（DFA）。"在 DFA 状态 *s* 下允许哪些 token"这个问题只取决于 *s*，与已生成的文本无关。因此可以对每个正则只做一次预计算：为每个 DFA 状态建立索引，记录哪些词表 token 的全部字符能从该状态被依次消费，以及消费后到达的状态。

生成时，每一步就变成一次字典查找加一次掩码，不必扫描整个词表：

```python
# 离线，每个 (正则, 分词器) 做一次：
#   index[state] = {token_id: next_state, ...}
def build_index(dfa, vocab):
    index = {}
    for state in dfa.states:
        allowed = {}
        for tid, text in vocab.items():
            s = state
            for ch in text:
                s = dfa.step(s, ch)
                if s is None:
                    break
            else:
                allowed[tid] = s
        index[state] = allowed
    return index

# 在线，每一步：
def generate(model, dfa, index, prompt):
    state, out = dfa.start, []
    while True:
        logits = model.next_logits(prompt + out)
        allowed = index[state]
        if dfa.is_accepting(state):
            allowed = {**allowed, EOS: state}
        tid = constrained_step(logits, allowed.keys())
        if tid == EOS:
            return out
        out.append(tid)
        state = allowed[tid]
```

只要 schema 是有界的，JSON Schema 与这个模型契合得出奇地好：固定属性的对象、枚举、数字、布尔值、带 pattern 的字符串，都能表达成一个（很大的）正则。Outlines 正是把 Pydantic 模型或 JSON Schema 转成这样的正则，再建出上面的索引。

它的短板是递归。任意嵌套——一个 JSON 值里可以有对象数组，对象里又可以有 JSON 值——不是正则语言，正则只能按固定深度展开去近似。

## 上下文无关文法：加一个栈

递归结构（完整 JSON、SQL、编程语言、嵌套的工具调用）属于上下文无关语言，由下推自动机识别：状态机加一个栈。常见实现有：

- **llama.cpp 的 GBNF**：一种类 BNF 的文法格式，在解码时生效；llama.cpp 自带把 JSON Schema 转成 GBNF 的转换器。
- **XGrammar**（Dong 等，2024；被 vLLM、SGLang 等用作结构化输出后端）：把文法编译成下推自动机，并把词表分成*上下文无关* token（其合法性可以按自动机位置预计算）和*上下文相关* token（需要看栈，运行时检查）。绝大多数 token 属于前者，所以每一步的工作量很小。
- **llguidance**（来自 Guidance 项目）：一个 Rust 引擎，结合词法分析器与 Earley 解析器，沿 token 前缀树惰性计算掩码；llama.cpp 等运行时已接入。

共同思路是：能提前算的尽量提前算，把每 token 的工作压到足以和 GPU 前向计算重叠的程度，只对真正依赖栈的 token 做运行时检查。

## 为什么比看上去难

### token 与文法符号不对齐

token 是学出来的字节序列，不是文法符号。一个 token 可能是 `":"`、`{"`、`", "` 或 `"}]`——横跨好几个终结符。按终结符思考的朴素实现会禁止模型本来想用的 token，逼它换成少见的切分方式，从而损害质量：模型在训练中见到的 `{"name": "` 是几个常见 token，被拆成生僻碎片就偏离了训练分布。Guidance 项目在提示词边界处的对应修正叫 **token healing**：回退提示词的最后一个 token，并约束第一个生成的 token 必须以它的文本开头，让模型自己选出自然的合并方式。

### 速度

每个 token 被选取之前，掩码必须就绪。如果算掩码比前向计算还慢，结构化输出就成了瓶颈，尤其是大批量时每个请求都有自己的文法状态。所以各引擎会预计算索引、按 schema 哈希缓存编译好的文法、在 CPU 上与 GPU 步骤并发计算掩码，并用融合 kernel 应用位掩码。新 schema 的第一次请求还要付出编译成本，大 schema 时会比较明显；托管 API 的文档也说明了首次使用会有额外延迟。

### 编译不了的 schema 特性

并非每个 JSON Schema 关键字都能映射成文法。跨字段约束、`uniqueItems`、任意边界的数值范围、很大的 `minItems`/`maxItems`、复杂的 `oneOf` 组合，要么不支持，要么只能近似。托管服务会公布支持的子集，例如 OpenAI 的 strict 模式要求 `additionalProperties: false`，并且所有属性都必须列在 `required` 中（可选字段用与 `null` 的联合类型来表达）。

### 仍可能提前截断

约束保证的是每个*前缀*合法，而不是输出完整。如果模型生成到对象中间撞上 `max_tokens`，拿到的就是被截断的 JSON。一定要检查 finish reason，并给模型留足长度。

## 工具调用 = 结构化输出 + 协议

聊天 API 里的"工具调用"就是结构化输出加上一套约定：

1. 你声明工具：名称、描述，以及参数的 JSON Schema。
2. 服务端用模型的聊天模板把它们渲染进提示词；模型经过微调，会以特定格式（特殊 token 或包装语法）输出工具调用。
3. 服务端把该格式解析回结构化的 `tool_calls` 字段。
4. 你的代码执行工具，把结果作为 `tool` 消息返回，循环继续。

没有约束时，第 3 步可能失败——参数 JSON 不合法、工具名凭空捏造、缺少必填字段。开启 strict 模式后，服务端会按声明的 schema 约束参数 JSON。开源推理服务也提供同样能力：vLLM 和 SGLang 接受 OpenAI 兼容的、带 JSON Schema 的 `response_format`，并能通过文法后端强制约束工具参数。

```python
from openai import OpenAI
from pydantic import BaseModel

class Refund(BaseModel):
    order_id: str
    amount_cents: int
    reason: str | None

client = OpenAI()  # 或把 base_url 指向 vLLM / SGLang 服务

resp = client.chat.completions.create(
    model="gpt-4o-2024-08-06",
    messages=[
        {"role": "system", "content": "Extract the refund request."},
        {"role": "user", "content": "Please refund 19.99 for order A-1042, item arrived broken."},
    ],
    response_format={
        "type": "json_schema",
        "json_schema": {
            "name": "refund",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "order_id": {"type": "string"},
                    "amount_cents": {"type": "integer"},
                    "reason": {"type": ["string", "null"]},
                },
                "required": ["order_id", "amount_cents", "reason"],
                "additionalProperties": False,
            },
        },
    },
)

choice = resp.choices[0]
if choice.finish_reason != "stop":
    raise RuntimeError(f"incomplete output: {choice.finish_reason}")
refund = Refund.model_validate_json(choice.message.content)  # 语义校验放在这里
```

OpenAI 在 2024 年 8 月推出 Structured Outputs 时报告：在其复杂 schema 评估中，新模型开启 strict 模式后 schema 遵循率达到 100%，而只靠提示的旧模型不到 40%。具体数字是厂商自报的，但方向与一线经验一致：格式错误的长尾消失了。

托管 API 的一条实践规则：当模型也可能*拒答*（不安全或无法完成的请求）时，要检查服务商提供的拒答字段，而不是默认 schema 形状的内容就有意义。

## 约束会不会损害质量？

可能会。Tam 等人的《Let Me Speak Freely?》（2024）发现，与自由作答相比，严格的格式限制在部分推理任务上降低了表现，影响大小取决于任务和格式。后续讨论（包括 Outlines/.txt 团队的回应）认为差距很大程度来自提示设计，设计得当的约束不一定有损。双方都认同以下实践：

- **给思考留空间。** 把 `reasoning` 字符串字段放在 `answer` 字段*之前*，或者先让模型自由推理，只对最后的抽取步骤加约束。字段顺序很重要，因为模型从左到右生成。
- **提示词与 schema 保持一致。** 告诉模型你在强制什么格式；约束与提示相互打架会产出古怪的结果。
- **用有描述性的字段名和枚举。** 模型会读它们；`"severity": "low" | "medium" | "high"` 比一个没有解释的整数更能引导模型。
- **别把字符串约束得太死。** 对自由文本施加过紧的正则，会把模型逼到低概率 token 上。

## 方案选择

| 场景 | 建议 |
|---|---|
| 托管前沿模型，工具调用或信息抽取 | 服务商 strict 模式 + Pydantic/Zod 做语义校验 |
| 用 vLLM / SGLang 自建 | 带 JSON Schema 的 `response_format`，后端选 XGrammar 或同类；缓存 schema |
| 通过 llama.cpp 跑本地模型 | GBNF 文法或其 JSON Schema 转换器 |
| 固定标签集（路由、分类） | 枚举或正则约束；也可直接读取各标签的 logprobs |
| 输出必须是代码或 SQL | 用 CFG 约束语法，再在沙箱中解析、执行以验证语义 |
| 先长推理再做决定 | 先自由推理，再单独发起一次简短的约束调用 |

## 总结

约束解码在唯一能给出保证的地方强制格式：选取 token 的那一步。正则或有界的 JSON Schema 会变成有限状态机，每个状态的允许 token 集合可以预先算好；递归格式需要文法和栈，XGrammar、llguidance 这类引擎通过"能预算的预算、其余惰性检查"把它做快。难点都在工程上——token 边界、批量场景下的掩码延迟、编译不了的 schema 特性——剩下的风险是语义上的，而非语法上的。对 Agent 而言，结果就是一个每一步都能被解析的工具调用循环，让你的校验器、重试和可观测性可以专注于这一步是否*正确*。

## 参考资料

- Brandon T. Willard, Rémi Louf, [Efficient Guided Generation for Large Language Models](https://arxiv.org/abs/2307.09702) (2023)
- Yixin Dong et al., [XGrammar: Flexible and Efficient Structured Generation Engine for Large Language Models](https://arxiv.org/abs/2411.15100) (2024)
- Zhi Rui Tam et al., [Let Me Speak Freely? A Study on the Impact of Format Restrictions on Performance of Large Language Models](https://arxiv.org/abs/2408.02442) (2024)
- OpenAI, [Introducing Structured Outputs in the API](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- OpenAI, [Structured Outputs guide](https://platform.openai.com/docs/guides/structured-outputs)
- Outlines, [GitHub repository](https://github.com/dottxt-ai/outlines)
- Guidance and llguidance, [guidance-ai on GitHub](https://github.com/guidance-ai/llguidance)
- llama.cpp, [GBNF grammar guide](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)
- vLLM documentation, [Structured Outputs](https://docs.vllm.ai/en/stable/features/structured_outputs.html)
- Instructor, [documentation](https://python.useinstructor.com/)
