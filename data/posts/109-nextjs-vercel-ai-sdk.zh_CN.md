---
title: "Next.js + Vercel AI SDK：全栈 AI 应用最佳实践"
tag: ai
description: 使用 Next.js 和 Vercel AI SDK 构建生产级全栈 AI 应用，涵盖流式响应、多模型支持与边缘部署
date: "2025-06-28T10:00:00.000Z"
---

## 目标

构建一个 AI 应用不仅仅是调用 OpenAI API 那么简单。你需要处理流式响应、管理对话状态、支持多模型切换、处理错误和重试、优化性能——而 Vercel AI SDK 正是为解决这些问题而生的。本文将展示如何使用 Next.js + Vercel AI SDK 构建一个生产级的全栈 AI 应用。

## 背景

### 为什么选择 Vercel AI SDK

Vercel AI SDK 是 Vercel 推出的 AI 应用开发工具包，它的核心优势：

1. **统一的 API 接口**：一套代码支持 OpenAI、Anthropic、Google 等多个 LLM 提供商
2. **流式响应内置**：不需要手动处理 SSE，SDK 内置了完善的流式支持
3. **React 集成**：提供 `useChat`、`useCompletion` 等 Hook，简化前端状态管理
4. **边缘就绪**：支持 Edge Runtime，可以在边缘节点运行
5. **类型安全**：完整的 TypeScript 支持

### 技术架构

```
┌─────────────────────────────────────────┐
│              Next.js App                │
│  ┌─────────────┐    ┌─────────────────┐ │
│  │   Client    │    │    Server       │ │
│  │  useChat()  │◄──►│  Route Handler  │ │
│  └─────────────┘    └─────────────────┘ │
│                          │              │
└──────────────────────────┼──────────────┘
                           │
                    ┌──────▼──────┐
                    │  Vercel AI  │
                    │    SDK      │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
         │ OpenAI  │ │Anthropic│ │  Local  │
         │   API   │ │   API   │ │  Model  │
         └─────────┘ └─────────┘ └─────────┘
```

## 项目搭建

### 初始化项目

```bash
npx create-next-app@latest ai-app --typescript --tailwind --app
cd ai-app
npm install ai @ai-sdk/openai @ai-sdk/anthropic
```

### 环境配置

```env
# .env.local
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
```

## 后端实现

### 基础 Chat API

```typescript
// app/api/chat/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages, model = 'openai' } = await req.json();

  const aiModel = model === 'anthropic'
    ? anthropic('claude-3-5-sonnet-20241022')
    : openai('gpt-4o');

  const result = streamText({
    model: aiModel,
    system: `你是一位专业的前端技术顾问。
你可以帮助用户解决 React、Vue、TypeScript、CSS 等前端相关问题。
回答时请注意：
1. 提供准确的技术信息
2. 给出可运行的代码示例
3. 解释关键概念和最佳实践
4. 如果不确定，诚实说明`,
    messages,
    maxTokens: 4096,
    temperature: 0.7,
  });

  return result.toDataStreamResponse();
}
```

### 带工具调用的 Chat API

```typescript
// app/api/chat-with-tools/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: `你是一位前端开发助手。
你可以帮助用户：
1. 编写和审查代码
2. 解答技术问题
3. 搜索文档（通过工具）
4. 创建代码示例`,
    messages,
    tools: {
      searchDocs: tool({
        description: '搜索前端技术文档',
        parameters: z.object({
          query: z.string().describe('搜索关键词'),
          technology: z.enum(['react', 'vue', 'css', 'typescript', 'node'])
            .describe('技术领域'),
        }),
        execute: async ({ query, technology }) => {
          const results = await searchDocumentation(query, technology);
          return {
            results: results.slice(0, 5),
            total: results.length,
          };
        },
      }),

      reviewCode: tool({
        description: '审查代码质量和潜在问题',
        parameters: z.object({
          code: z.string().describe('要审查的代码'),
          language: z.string().describe('编程语言'),
        }),
        execute: async ({ code, language }) => {
          const review = await performCodeReview(code, language);
          return {
            issues: review.issues,
            suggestions: review.suggestions,
            score: review.score,
          };
        },
      }),

      generateExample: tool({
        description: '生成代码示例',
        parameters: z.object({
          description: z.string().describe('功能描述'),
          framework: z.string().describe('使用的框架'),
          style: z.enum(['typescript', 'javascript']).default('typescript'),
        }),
        execute: async ({ description, framework, style }) => {
          const code = await generateCodeExample(description, framework, style);
          return { code, framework, style };
        },
      }),
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
```

### 对话历史管理

```typescript
// app/api/chat/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }

  const messages = await db.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({ messages });
}

export async function POST(req: NextRequest) {
  const { sessionId, messages } = await req.json();

  await db.message.createMany({
    data: messages.map((msg: any) => ({
      sessionId,
      role: msg.role,
      content: msg.content,
    })),
  });

  return NextResponse.json({ success: true });
}
```

## 前端实现

### useChat Hook

```tsx
'use client';

import { useChat } from 'ai/react';
import { useState } from 'react';

export function ChatInterface() {
  const [model, setModel] = useState<'openai' | 'anthropic'>('openai');
  
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    reload,
    stop,
  } = useChat({
    api: '/api/chat',
    body: { model },
    onError: (error) => {
      console.error('Chat error:', error);
    },
    onFinish: (message) => {
      console.log('Message completed:', message);
    },
  });

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto p-4">
      <div className="flex gap-2 mb-4">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value as any)}
          className="border rounded-lg px-3 py-2"
        >
          <option value="openai">GPT-4o</option>
          <option value="anthropic">Claude 3.5 Sonnet</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.map((message) => (
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
                  : 'bg-gray-100 dark:bg-gray-800'
              }`}
            >
              <MessageContent content={message.content} />
              
              {message.toolInvocations?.map((toolInvocation) => (
                <ToolResult key={toolInvocation.toolCallId} invocation={toolInvocation} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-300 rounded-lg text-red-700">
          出错了：{error.message}
          <button onClick={reload} className="ml-2 underline">
            重试
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="输入你的问题..."
          className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50"
        >
          {isLoading ? '思考中...' : '发送'}
        </button>
        {isLoading && (
          <button
            type="button"
            onClick={stop}
            className="bg-gray-500 text-white px-4 py-2 rounded-lg"
          >
            停止
          </button>
        )}
      </form>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {content.split('\n').map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}

function ToolResult({ invocation }: { invocation: any }) {
  const { toolName, state, args } = invocation;

  if (state === 'result') {
    return (
      <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900 rounded border">
        <p className="text-sm font-medium text-gray-500 mb-2">
          工具调用：{toolName}
        </p>
        <pre className="text-xs overflow-x-auto">
          {JSON.stringify(invocation.result, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 rounded border">
      <p className="text-sm text-blue-600 animate-pulse">
        正在调用 {toolName}...
      </p>
    </div>
  );
}
```

### useCompletion Hook

```tsx
'use client';

import { useCompletion } from 'ai/react';

export function CodeGenerator() {
  const {
    completion,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
  } = useCompletion({
    api: '/api/completion',
  });

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">代码生成器</h1>
      
      <form onSubmit={handleSubmit} className="mb-4">
        <textarea
          value={input}
          onChange={handleInputChange}
          placeholder="描述你需要的功能..."
          className="w-full border rounded-lg p-3 h-32"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="mt-2 bg-blue-500 text-white px-4 py-2 rounded-lg"
        >
          生成代码
        </button>
      </form>

      {completion && (
        <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm">
          <pre>{completion}</pre>
        </div>
      )}
    </div>
  );
}
```

## 高级功能

### 多模态支持

```typescript
// app/api/chat/vision/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    messages: messages.map((msg: any) => ({
      ...msg,
      content: msg.parts?.map((part: any) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        if (part.type === 'image') {
          return {
            type: 'image' as const,
            image: new URL(part.image),
          };
        }
      }) || msg.content,
    })),
    system: '你是一位前端设计专家，可以分析 UI 截图并提供建议。',
  });

  return result.toDataStreamResponse();
}
```

### Edge Runtime 部署

```typescript
// app/api/chat/edge/route.ts
export const runtime = 'edge';

import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o-mini'),
    messages,
  });

  return result.toDataStreamResponse();
}
```

### 性能优化

```typescript
// lib/cache.ts
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL!,
  token: process.env.UPSTASH_REDIS_TOKEN!,
});

export async function cachedQuery(
  query: string,
  fetcher: () => Promise<string>
): Promise<string> {
  const cacheKey = `chat:${hashQuery(query)}`;
  
  const cached = await redis.get<string>(cacheKey);
  if (cached) return cached;

  const result = await fetcher();
  
  await redis.setex(cacheKey, 3600, result);
  
  return result;
}

function hashQuery(query: string): string {
  return require('crypto').createHash('md5').update(query).digest('hex');
}
```

## 总结

使用 Next.js + Vercel AI SDK 构建全栈 AI 应用的最佳实践：

1. **统一 API 层**：通过 Vercel AI SDK 的 `streamText` 统一处理不同 LLM 提供商
2. **流式响应**：利用 SDK 内置的流式支持，提供实时反馈
3. **工具调用**：通过 `tool()` 函数定义工具，让 AI 能够调用外部服务
4. **前端 Hook**：使用 `useChat`/`useCompletion` 简化前端状态管理
5. **边缘部署**：利用 Edge Runtime 提升全球访问速度

Vercel AI SDK 极大地降低了 AI 应用开发的复杂度，让你能够专注于业务逻辑而非底层实现。