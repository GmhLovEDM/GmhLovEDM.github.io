---
title: "How Frontend Engineers Can Build Their Own AI Agent"
tag: ai
description: A complete guide for frontend engineers to build AI Agents, from architecture design to implementation details, building a personal AI assistant
date: "2025-11-10T10:00:00.000Z"
---

## Goal

AI Agents are no longer an unattainable technology -- as a frontend engineer, you can absolutely build your own AI Agent. This article walks you through building a personal AI Agent from scratch using your familiar TypeScript/JavaScript tech stack, one that can understand instructions, call tools, and complete tasks.

## Background

### Frontend Engineers' Unique Advantages

You may think you don't understand AI, but frontend engineers actually have natural advantages for building Agents:

| Advantage | Description |
|-----------|-------------|
| API Integration | You are accustomed to working with various APIs |
| Async Programming | Agent execution flows are naturally asynchronous |
| UI/UX Intuition | You can build better Agent interaction interfaces |
| State Management | You are already familiar with Agent state management |

### Core Agent Capabilities

A complete AI Agent needs:

1. **Understanding**: Interpreting user intent
2. **Planning**: Breaking tasks into executable steps
3. **Execution**: Calling tools to complete tasks
4. **Reflection**: Evaluating results and retrying when necessary
5. **Memory**: Remembering context and historical interactions

## Agent Architecture Design

### System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ Core Loop   │  │ Tool System │  │Memory System│     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          │                              │
│              ┌───────────▼───────────┐                  │
│              │       LLM Engine      │                  │
│              └───────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

### Core Implementation

```typescript
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

    this.state = { messages: [], tools: [], memory: new Memory(), iterationCount: 0 };
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

    return 'Max iterations reached, task not completed';
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

  addTool(tool: Tool) { this.state.tools.push(tool); }
  getTools(): Tool[] { return this.state.tools; }
  getMemory(): Memory { return this.state.memory; }
}
```

### Tool System

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (args: Record<string, any>) => Promise<any>;
}

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get weather information for a specified city',
  parameters: { city: { type: 'string', description: 'City name', required: true } },
  execute: async (args) => {
    const response = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${args.city}`);
    return response.json();
  },
};

const calculatorTool: Tool = {
  name: 'calculate',
  description: 'Perform mathematical calculations',
  parameters: { expression: { type: 'string', description: 'Mathematical expression', required: true } },
  execute: async (args) => {
    const result = Function('"use strict"; return (' + args.expression + ')')();
    return { result };
  },
};

const fileTool: Tool = {
  name: 'read_file',
  description: 'Read file contents',
  parameters: { path: { type: 'string', description: 'File path', required: true } },
  execute: async (args) => {
    const fs = require('fs').promises;
    const content = await fs.readFile(args.path, 'utf-8');
    return { content };
  },
};

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  register(tool: Tool) { this.tools.set(tool.name, tool); }
  get(name: string): Tool | undefined { return this.tools.get(name); }
  getAll(): Tool[] { return Array.from(this.tools.values()); }

  toFunctionDefinitions() {
    return this.getAll().map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters,
          required: Object.entries(tool.parameters).filter(([, p]) => p.required).map(([n]) => n),
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

### Memory System

```typescript
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

  constructor(maxSize: number = 100) { this.maxSize = maxSize; }

  addInteraction(input: string, output: string) {
    this.add({ id: `interaction-${Date.now()}`, timestamp: Date.now(), type: 'interaction', content: `User: ${input}\nAssistant: ${output}` });
  }

  addFact(fact: string, metadata?: Record<string, any>) {
    this.add({ id: `fact-${Date.now()}`, timestamp: Date.now(), type: 'fact', content: fact, metadata });
  }

  addTask(task: string, status: 'pending' | 'completed' | 'failed') {
    this.add({ id: `task-${Date.now()}`, timestamp: Date.now(), type: 'task', content: task, metadata: { status } });
  }

  private add(entry: MemoryEntry) {
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) this.entries = this.entries.slice(-this.maxSize);
  }

  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.entries.filter(e => e.content.toLowerCase().includes(q));
  }

  getRecent(count: number): MemoryEntry[] { return this.entries.slice(-count); }
  getByType(type: MemoryEntry['type']): MemoryEntry[] { return this.entries.filter(e => e.type === type); }
  toContextString(): string { return this.entries.slice(-10).map(e => `[${e.type}] ${e.content}`).join('\n'); }
}
```

## Advanced Features

### Task Planning

```typescript
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

  constructor(llm: ChatOpenAI) { this.llm = llm; }

  async createPlan(goal: string, availableTools: Tool[]): Promise<Plan> {
    const toolsDescription = availableTools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    const response = await this.llm.invoke([
      new SystemMessage(`You are a task planner. Create a detailed execution plan based on the user's goal.

Available tools:
${toolsDescription}

Output JSON plan:
{
  "goal": "goal",
  "steps": [{ "description": "step description", "action": "action", "tool": "tool (optional)", "args": {} }]
}`),
      new HumanMessage(`Goal: ${goal}`),
    ]);

    const plan = JSON.parse(response.content as string);
    return { id: `plan-${Date.now()}`, ...plan, currentStep: 0, status: 'planning' };
  }

  async executePlan(plan: Plan, agent: AIAgent): Promise<any> {
    plan.status = 'executing';

    for (const step of plan.steps) {
      step.status = 'executing';
      try {
        if (step.tool) {
          const tool = agent.getTools().find(t => t.name === step.tool);
          if (tool) step.result = await tool.execute(step.args || {});
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

### Frontend Interface

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

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isThinking) return;

    const userMessage: Message = { id: `msg-${Date.now()}`, role: 'user', content: input, timestamp: Date.now() };
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
      const assistantMessage: Message = { id: `msg-${Date.now() + 1}`, role: 'assistant', content: data.response, timestamp: Date.now(), toolCalls: data.toolCalls };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Agent error:', error);
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      <div className="border-b p-4">
        <h1 className="text-xl font-bold mb-2">My AI Agent</h1>
        <div className="flex gap-2">
          {tools.map(tool => (<span key={tool} className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">{tool}</span>))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-lg p-4 ${message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-gray-100'}`}>
              <p className="whitespace-pre-wrap">{message.content}</p>
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
                  {message.toolCalls.map((tc, idx) => (
                    <div key={idx} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className={tc.status === 'success' ? 'text-green-600' : tc.status === 'error' ? 'text-red-600' : 'text-yellow-600'}>
                          {tc.status === 'success' ? '✓' : tc.status === 'error' ? '✗' : '○'}
                        </span>
                        <span className="font-mono">{tc.name}</span>
                      </div>
                      {tc.result && <pre className="mt-1 text-xs bg-gray-50 p-2 rounded overflow-x-auto">{JSON.stringify(tc.result, null, 2)}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {isThinking && <div className="flex justify-start"><div className="bg-gray-100 rounded-lg p-4 animate-pulse">Thinking...</div></div>}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t p-4">
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Tell the Agent what you want to do..." className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" disabled={isThinking} />
          <button type="submit" disabled={isThinking} className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50">Send</button>
        </div>
      </form>
    </div>
  );
}
```

## Deployment and Usage

### Local Deployment

```bash
npm install ai @ai-sdk/openai zustand
npm run agent:serve
npm run dev
```

### API Endpoint

```typescript
import { AIAgent } from '@/agent/core';
import { toolRegistry } from '@/agent/tools';

const agent = new AIAgent({ model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY! });
agent.addTool(toolRegistry.get('get_weather')!);
agent.addTool(toolRegistry.get('calculate')!);
agent.addTool(toolRegistry.get('read_file')!);

export async function POST(req: Request) {
  const { message } = await req.json();
  const response = await agent.run(message);
  return Response.json({ response, toolCalls: agent.getMemory().getRecent(5) });
}
```

## Summary

Core steps for building a personal AI Agent:

1. **Architecture Design**: Core loop + Tool system + Memory system.
2. **Tool Development**: Encapsulate common operations as tools.
3. **Memory Management**: Remember context and historical interactions.
4. **Task Planning**: Enable the Agent to decompose and execute complex tasks.
5. **Frontend Interaction**: Build a friendly Agent interaction interface.

As a frontend engineer, you already have the core skills needed to build Agents:
- TypeScript/JavaScript programming ability
- API integration and async programming experience
- State management and UI development skills

Start building your first Agent -- begin with simple tasks and gradually expand capabilities. You will find that AI Agents are not as complex as you might think.