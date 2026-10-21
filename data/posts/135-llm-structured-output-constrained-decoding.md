---
title: "Structured Output and Tool Calling: How Constrained Decoding Makes LLMs Speak JSON"
tag: ai
description: Why agents need machine-readable model output, and how it is enforced at decode time — token masks, regex and JSON Schema compiled to finite-state machines, context-free grammars and pushdown automata (Outlines, XGrammar, llguidance, GBNF), the token-boundary problem, provider "strict" modes, and the trade-offs between reliability, latency and answer quality
date: "2026-10-21T12:30:00.000Z"
---

## Goal

Every agent framework eventually hits the same wall: the model has to produce something a program can parse. A tool call is a function name plus arguments that must match a schema; an extraction pipeline needs a JSON object with the right fields; a router needs one label out of five. Free-form text with a "please answer in JSON" instruction works most of the time, and "most of the time" is exactly what breaks a long agent loop, because one malformed step derails everything after it.

This article explains how modern inference stacks turn "usually valid" into "valid by construction". It covers the three levels of enforcement (prompting, validate-and-retry, constrained decoding), the mechanism behind constrained decoding — masking logits with an automaton compiled from a regex, JSON Schema or grammar — the engineering problems that make it hard (tokenization, speed, unsupported schema features), what the hosted "strict" modes give you, and when constraints hurt more than they help.

## Three Levels of Enforcement

| Level | How it works | Guarantee | Cost |
|---|---|---|---|
| Prompting | Describe the format, give examples, maybe prefill `{` | None; output is usually valid | Free |
| Validate and retry | Parse the output, send the error back, ask again | Valid eventually, or fail after N tries | Extra round-trips, unbounded latency tail |
| Constrained decoding | At each step forbid tokens that would make the output invalid | Syntactically valid by construction (if generation finishes) | Grammar compilation plus per-token mask work |

Libraries such as Instructor sit at level 2: they turn a Pydantic model into a schema, call the model, validate with Pydantic, and re-ask with the validation error. That is still valuable even with level 3, because constrained decoding only guarantees *shape*. It cannot know that `end_date` must be after `start_date` or that a customer ID actually exists. A robust pipeline uses decoding constraints for syntax and validators for semantics.

## How Decoding Works, in One Paragraph

An autoregressive model produces, at every step, a vector of logits — one score per token in its vocabulary (often 100k–200k entries for current models). The decoder applies temperature, top-p and similar transforms, turns scores into probabilities, picks a token, appends it, and repeats. Constrained decoding inserts one more transform: **set the logit of every token that would lead to an invalid output to −∞**. Those tokens get probability zero and can never be chosen. The model still chooses among the remaining tokens with its own preferences, so the output is the model's most likely continuation *within* the allowed language.

```python
import math

def constrained_step(logits, allowed_token_ids):
    """Mask everything outside the allowed set, then pick a token as usual."""
    masked = [-math.inf] * len(logits)
    for t in allowed_token_ids:
        masked[t] = logits[t]
    return choose_token(masked)  # temperature / top-p / argmax, unchanged
```

The whole difficulty is computing `allowed_token_ids` correctly and fast — for every step, over a vocabulary of a hundred thousand multi-character tokens.

## Regular Languages: Compile to a Finite-State Machine

Willard and Louf's paper "Efficient Guided Generation for Large Language Models" (2023), the basis of the Outlines library, made the key observation. If the target format is a regular expression, it can be compiled into a deterministic finite automaton (DFA) over *characters*. The question "which tokens are allowed in DFA state *s*?" depends only on *s*, not on the text generated so far. So you can precompute, once per regex, an index from each DFA state to the set of vocabulary tokens whose characters can all be consumed starting from that state, and the state each token leads to.

At generation time, each step becomes a dictionary lookup plus a mask, instead of scanning the vocabulary:

```python
# Offline, once per (regex, tokenizer):
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

# Online, per step:
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

JSON Schema fits this model surprisingly well as long as the schema is bounded: an object with fixed properties, enums, numbers, booleans and strings with patterns can all be expressed as a (large) regular expression. Outlines converts a Pydantic model or JSON Schema to such a regex, then to the index above.

Where it breaks down is recursion. Arbitrary nesting — a JSON value that may contain arrays of objects that contain JSON values — is not a regular language. A regex can only approximate it by unrolling to a fixed depth.

## Context-Free Grammars: Add a Stack

Recursive structures (full JSON, SQL, programming languages, nested tool calls) are context-free languages, recognised by a pushdown automaton: a state machine plus a stack. Several implementations exist:

- **llama.cpp GBNF**: a BNF-style grammar format applied during decoding; llama.cpp ships a converter from JSON Schema to GBNF.
- **XGrammar** (Dong et al., 2024; used as a structured-output backend by vLLM, SGLang and others): compiles grammars to a pushdown automaton and splits the vocabulary into *context-independent* tokens, whose validity can be precomputed per automaton position, and *context-dependent* tokens, which need the stack and are checked at runtime. Since most tokens fall into the first group, the per-step work stays small.
- **llguidance** (from the Guidance project): a Rust engine that combines a lexer with an Earley parser and computes masks lazily by walking a token trie; it is used in llama.cpp and other runtimes.

The common idea: do as much as possible ahead of time, keep per-token work small enough to overlap with the GPU forward pass, and fall back to runtime checks only for the tokens that truly depend on the stack.

## Why It Is Harder Than It Looks

### Tokens Do Not Align with Grammar Symbols

Tokens are learned byte sequences, not grammar symbols. A single token may be `":"`, `{"`, `", "` or `"}]` — spanning several terminals. A naïve implementation that thinks in terminals will forbid tokens the model naturally wants to use and force it into unusual tokenizations. That hurts quality: the model has seen `{"name": "` in training as a handful of common tokens, and splitting it into rare fragments puts it off-distribution. The Guidance project calls the related fix at the prompt boundary **token healing**: back up over the last prompt token and constrain the first generated token to start with its text, so the model can choose the natural merge.

### Speed

The mask has to be ready before each token is chosen. If computing it takes longer than the forward pass, structured output becomes the bottleneck, especially with large batches where many requests each have their own grammar state. This is why engines precompute indexes, cache compiled grammars by schema hash, compute masks on the CPU concurrently with the GPU step, and use bitmasks applied in a fused kernel. The first request with a new schema also pays a compilation cost, which can be noticeable for large schemas; hosted APIs document this as extra latency on first use.

### Schema Features That Do Not Compile

Not every JSON Schema keyword maps to a grammar. Cross-field constraints, `uniqueItems`, numeric ranges with arbitrary bounds, large `minItems`/`maxItems`, and complex `oneOf` combinations are either unsupported or approximated. Hosted providers publish a supported subset; for example, OpenAI's strict mode requires `additionalProperties: false` and that every property be listed in `required` (optional fields are expressed as a union with `null`).

### Generation Can Still Stop Early

Constraints guarantee every *prefix* is valid, not that the output is complete. If the model hits `max_tokens` mid-object, you get truncated JSON. Always check the finish reason, and give the model room.

## Tool Calling Is Structured Output with a Protocol

A "tool call" in chat APIs is structured output plus a convention:

1. You declare tools: a name, a description, and a JSON Schema for the arguments.
2. The provider renders them into the prompt using the model's chat template; the model was fine-tuned to emit tool calls in a particular format (special tokens or a wrapper syntax).
3. The server parses that format back into a structured `tool_calls` field.
4. Your code executes the tool and returns the result as a `tool` message; the loop continues.

Without constraints, step 3 can fail — invalid JSON arguments, a hallucinated tool name, missing required fields. With a strict mode, the server constrains the argument JSON against the declared schema. Open-source servers expose the same idea: vLLM and SGLang accept an OpenAI-compatible `response_format` with a JSON Schema and can force tool arguments through a grammar backend.

```python
from openai import OpenAI
from pydantic import BaseModel

class Refund(BaseModel):
    order_id: str
    amount_cents: int
    reason: str | None

client = OpenAI()  # or base_url pointing at a vLLM / SGLang server

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
refund = Refund.model_validate_json(choice.message.content)  # semantic checks live here
```

When OpenAI launched Structured Outputs in August 2024, it reported that on its complex-schema evaluation the new model with strict mode reached 100% schema adherence, while an older model relying on prompting alone scored under 40%. The exact numbers are vendor-reported, but the direction matches what practitioners see: the long tail of malformed output disappears.

A practical rule for hosted APIs: when the model also needs to *refuse* (unsafe or impossible requests), check for the provider's refusal field rather than assuming the schema-shaped content is meaningful.

## Does Constraining Hurt Quality?

It can. Tam et al., "Let Me Speak Freely?" (2024), found that strict format restrictions degraded performance on some reasoning tasks compared with free-form answers, with the effect depending on task and format. Later discussion, including a response from the Outlines/.txt team, argued that much of the gap came from prompt design and that well-designed constraints need not hurt. Both sides agree on the practical lessons:

- **Leave room to think.** Put a `reasoning` string field *before* the `answer` field, or let the model reason freely first and constrain only a final extraction step. Field order matters, because the model generates left to right.
- **Keep the prompt and the schema consistent.** Tell the model the format you are enforcing; a constraint that fights the prompt yields odd output.
- **Prefer descriptive field names and enums.** The model reads them; `"severity": "low" | "medium" | "high"` guides it better than an unexplained integer.
- **Do not over-constrain strings.** Tight regexes on free text push the model into low-probability tokens.

## Choosing an Approach

| Situation | Recommendation |
|---|---|
| Hosted frontier model, tool calls or extraction | Provider strict mode plus a Pydantic/Zod validator for semantics |
| Self-hosted with vLLM / SGLang | `response_format` JSON Schema with the XGrammar (or equivalent) backend; cache schemas |
| Local models via llama.cpp | GBNF grammar or its JSON Schema converter |
| Fixed label set (routing, classification) | Enum or regex constraint; consider reading logprobs of each label directly |
| Output must be code or SQL | CFG constraint for syntax, then parse and execute in a sandbox for semantics |
| Long reasoning then a decision | Free-form reasoning, then a separate short constrained call |

## Summary

Constrained decoding enforces format at the only place it can be guaranteed: the token-selection step. A regex or bounded JSON Schema becomes a finite-state machine whose per-state allowed-token sets can be precomputed; recursive formats need a grammar and a stack, and engines like XGrammar and llguidance make that fast by precomputing what they can and checking the rest lazily. The hard parts are engineering ones — token boundaries, mask latency at batch scale, and schema features that do not compile — and the remaining risk is semantic, not syntactic. For agents, the result is a tool-calling loop where every step parses, which leaves your validators, retries and observability free to focus on whether the step was *right*.

## References

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
