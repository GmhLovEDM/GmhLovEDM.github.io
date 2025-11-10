---
title: "前端工程师如何搭建自己的 AI Agent"
tag: ai
description: 前端工程师搭建 AI Agent 的完整指南，从架构设计到实现细节，构建个人 AI 助手
date: "2025-11-10T10:00:00.000Z"
---

## 目标

AI Agent 不再是遥不可及的技术——作为前端工程师，你完全可以搭建自己的 AI Agent。本文将带你从零开始，利用你熟悉的 TypeScript/JavaScript 技术栈，构建一个能够理解指令、调用工具、完成任务的个人 AI Agent。

## 背景

### 前端工程师的独特优势

你可能觉得自己不懂 AI，但前端工程师其实有搭建 Agent 的天然优势：

| 优势 | 说明 |
|------|------|
| API 集成能力 | 你习惯与各种 API 打交道 |
| 异步编程 | Agent 的执行流程天然是异步的 |
| UI/UX 直觉 | 你能做出更好的 Agent 交互界面 |
| 状态管理 | Agent 的状态管理你已经很熟悉了 |

### Agent 的核心能力

一个完整的 AI Agent 需要：

1. **理解能力**：理解用户意图
2. **规划能力**：分解任务为可执行步骤
3. **执行能力**：调用工具完成任务
4. **反思能力**：评估结果，必要时重试
5. **记忆能力**：记住上下文和历史交互

## Agent 架构设计

### 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   核心循环  │  │   工具系统  │  │   记忆系统  │     │
│  │  (Loop)     │  │  (Tools)    │  │  (Memory)   │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          │                              │
│              ┌───────────▼───────────┐                  │
│              │        LLM 引擎       │                  │
│              └───────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

### 核心实现

```typescript
// agent/core.ts
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';

interface AgentConfig {
  model: string;
  apiKey: string;
  temperature?: number;
  maxIterations?: number;
}

interface AgentState {
  messages: Array<HumanMessage | AIMessage | SystemMessage>;
  tools: Tool[];
  memory: Memory;
  iterationCount: number;
}

class AIAgent {
  private llm: ChatOpenAI;
  private config: AgentConfig;
  private state: AgentState;

  constructor(config: AgentConfig) {
    this.config = config;
    this.llm = new ChatOpenAI({
      modelName: config.model,
      apiKey: config.apiKey,
      temperature: config.temperature ?? 0.7,
    });

    this.state = {
      messages: [],
      tools: [],
      memory: new Memory(),
      iterationCount: 0,
    };
  }

  async run(userInput: string): Promise<string> {
    this.state.messages.push(new HumanMessage(userInput));

    while (this.state.iterationCount < (this.config.maxIterations ?? 10)) {
      this.state.iterationCount++;

      const response = await this.llm.invoke(this.state.messages);

      if (this.shouldUseTool(response)) {
        const toolResult = await this.executeTool(response);
        this.state.messages.push(new AIMessage(toolResult));
        continue;
      }

      this.state.messages.push(response);
      this.state.memory.addInteraction(userInput, response.content as string);
      
      return response.content as string;
    }

    return '达到最大迭代次数，任务未完成';
  }

  private shouldUseTool(response: AIMessage): boolean {
    return response.additional_kwargs?.tool_calls?.length > 0;
  }

  private async executeTool(response: AIMessage): Promise<string> {
    const toolCalls = response.additional_kwargs.tool_calls;
    const results: string[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.state.tools.find(t => t.name === toolCall.function.name);
      if (tool) {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await tool.execute(args);
        results.push(JSON.stringify(result));
      }
    }

    return results.join('\n');
  }

  addTool(tool: Tool) {
    this.state.tools.push(tool);
  }

  getTools(): Tool[] {
    return this.state.tools;
  }

  getMemory(): Memory {
    return this.state.memory;
  }
}
```

### 工具系统

```typescript
// agent/tools.ts
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
  execute: (args: Record<string, any>) => Promise<any>;
}

const weatherTool: Tool = {
  name: 'get_weather',
  description: '获取指定城市的天气信息',
  parameters: {
    city: {
      type: 'string',
      description: '城市名称',
      required: true,
    },
  },
  execute: async (args) => {
    const response = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${args.city}`
    );
    return response.json();
  },
};

const calculatorTool: Tool = {
  name: 'calculate',
  description: '执行数学计算',
  parameters: {
    expression: {
      type: 'string',
      description: '数学表达式',
      required: true,
    },
  },
  execute: async (args) => {
    const result = Function('"use strict"; return (' + args.expression + ')')();
    return { result };
  },
};

const fileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容',
  parameters: {
    path: {
      type: 'string',
      description: '文件路径',
      required: true,
    },
  },
  execute: async (args) => {
    const fs = require('fs').promises;
    const content = await fs.readFile(args.path, 'utf-8');
    return { content };
  },
};

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  toFunctionDefinitions() {
    return this.getAll().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters,
          required: Object.entries(tool.parameters)
            .filter(([, param]) => param.required)
            .map(([name]) => name),
        },
      },
    }));
  }
}

export const toolRegistry = new ToolRegistry();
toolRegistry.register(weatherTool);
toolRegistry.register(calculatorTool);
toolRegistry.register(fileTool);
```

### 记忆系统

```typescript
// agent/memory.ts
interface MemoryEntry {
  id: string;
  timestamp: number;
  type: 'interaction' | 'fact' | 'task';
  content: string;
  metadata?: Record<string, any>;
}

class Memory {
  private entries: MemoryEntry[] = [];
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  addInteraction(input: string, output: string) {
    this.add({
      id: `interaction-${Date.now()}`,
      timestamp: Date.now(),
      type: 'interaction',
      content: `用户: ${input}\n助手: ${output}`,
    });
  }

  addFact(fact: string, metadata?: Record<string, any>) {
    this.add({
      id: `fact-${Date.now()}`,
      timestamp: Date.now(),
      type: 'fact',
      content: fact,
      metadata,
    });
  }

  addTask(task: string, status: 'pending' | 'completed' | 'failed') {
    this.add({
      id: `task-${Date.now()}`,
      timestamp: Date.now(),
      type: 'task',
      content: task,
      metadata: { status },
    });
  }

  private add(entry: MemoryEntry) {
    this.entries.push(entry);
    
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize);
    }
  }

  search(query: string): MemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.entries.filter(entry =>
      entry.content.toLowerCase().includes(lowerQuery)
    );
  }

  getRecent(count: number): MemoryEntry[] {
    return this.entries.slice(-count);
  }

  getByType(type: MemoryEntry['type']): MemoryEntry[] {
    return this.entries.filter(entry => entry.type === type);
  }

  toContextString(): string {
    return this.entries
      .slice(-10)
      .map(entry => `[${entry.type}] ${entry.content}`)
      .join('\n');
  }
}
```

## 高级功能

### 任务规划

```typescript
// agent/planner.ts
interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  currentStep: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
}

interface PlanStep {
  id: string;
  description: string;
  action: string;
  tool?: string;
  args?: Record<string, any>;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: any;
}

class TaskPlanner {
  private llm: ChatOpenAI;

  constructor(llm: ChatOpenAI) {
    this.llm = llm;
  }

  async createPlan(goal: string, availableTools: Tool[]): Promise<Plan> {
    const toolsDescription = availableTools
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');

    const response = await this.llm.invoke([
      new SystemMessage(`你是一个任务规划器。根据用户的目标，创建一个详细的执行计划。

可用工具：
${toolsDescription}

输出 JSON 格式的计划：
{
  "goal": "目标",
  "steps": [
    {
      "description": "步骤描述",
      "action": "执行动作",
      "tool": "使用的工具（可选）",
      "args": {}
    }
  ]
}`),
      new HumanMessage(`目标：${goal}`),
    ]);

    const plan = JSON.parse(response.content as string);
    return {
      id: `plan-${Date.now()}`,
      ...plan,
      currentStep: 0,
      status: 'planning',
    };
  }

  async executePlan(plan: Plan, agent: AIAgent): Promise<any> {
    plan.status = 'executing';

    for (const step of plan.steps) {
      step.status = 'executing';
      
      try {
        if (step.tool) {
          const tool = agent.getTools().find(t => t.name === step.tool);
          if (tool) {
            step.result = await tool.execute(step.args || {});
          }
        } else {
          step.result = await agent.run(step.description);
        }
        
        step.status = 'completed';
        plan.currentStep++;
      } catch (error) {
        step.status = 'failed';
        step.result = error;
        plan.status = 'failed';
        return { success: false, error, completedSteps: plan.currentStep };
      }
    }

    plan.status = 'completed';
    return { success: true, plan };
  }
}
```

### 前端交互界面

```tsx
'use client';

import { useState, useRef, useEffect } from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  name: string;
  args: Record<string, any>;
  result?: any;
  status: 'pending' | 'success' | 'error';
}

export function AgentInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [tools, setTools] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isThinking) return;

    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsThinking(true);

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input }),
      });

      const data = await response.json();

      const assistantMessage: Message = {
        id: `msg-${Date.now() + 1}`,
        role: 'assistant',
        content: data.response,
        timestamp: Date.now(),
        toolCalls: data.toolCalls,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Agent error:', error);
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      {/* 头部：工具列表 */}
      <div className="border-b p-4">
        <h1 className="text-xl font-bold mb-2">我的 AI Agent</h1>
        <div className="flex gap-2">
          {tools.map(tool => (
            <span key={tool} className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
              {tool}
            </span>
          ))}
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <div
            key={message.id}
            className={`flex ${
              message.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-4 ${
                message.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100'
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
              
              {/* 工具调用展示 */}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
                  {message.toolCalls.map((tc, idx) => (
                    <div key={idx} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className={
                          tc.status === 'success' ? 'text-green-600' :
                          tc.status === 'error' ? 'text-red-600' :
                          'text-yellow-600'
                        }>
                          {tc.status === 'success' ? '✓' :
                           tc.status === 'error' ? '✗' : '○'}
                        </span>
                        <span className="font-mono">{tc.name}</span>
                      </div>
                      {tc.result && (
                        <pre className="mt-1 text-xs bg-gray-50 p-2 rounded overflow-x-auto">
                          {JSON.stringify(tc.result, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        
        {isThinking && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg p-4 animate-pulse">
              思考中...
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {/* 输入框 */}
      <form onSubmit={handleSubmit} className="border-t p-4">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="告诉 Agent 你想做什么..."
            className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isThinking}
          />
          <button
            type="submit"
            disabled={isThinking}
            className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 部署和使用

### 本地部署

```bash
# 安装依赖
npm install ai @ai-sdk/openai zustand

# 启动 Agent 服务
npm run agent:serve

# 启动前端界面
npm run dev
```

### API 接口

```typescript
// app/api/agent/route.ts
import { AIAgent } from '@/agent/core';
import { toolRegistry } from '@/agent/tools';

const agent = new AIAgent({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
});

agent.addTool(toolRegistry.get('get_weather')!);
agent.addTool(toolRegistry.get('calculate')!);
agent.addTool(toolRegistry.get('read_file')!);

export async function POST(req: Request) {
  const { message } = await req.json();

  const response = await agent.run(message);

  return Response.json({
    response,
    toolCalls: agent.getMemory().getRecent(5),
  });
}
```

## 总结

搭建个人 AI Agent 的核心步骤：

1. **架构设计**：核心循环 + 工具系统 + 记忆系统
2. **工具开发**：将常用操作封装为工具
3. **记忆管理**：记住上下文和历史交互
4. **任务规划**：让 Agent 能够分解和执行复杂任务
5. **前端交互**：构建友好的 Agent 交互界面

作为前端工程师，你已经有搭建 Agent 所需的核心技能：
- TypeScript/JavaScript 编程能力
- API 集成和异步编程经验
- 状态管理和 UI 开发能力

开始构建你的第一个 Agent 吧——从简单的任务开始，逐步扩展能力。你会发现，AI Agent 并没有想象中那么复杂。