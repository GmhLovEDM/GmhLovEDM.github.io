---
title: "Next.js + Vercel AI SDK: Full-Stack AI Application Best Practices"
tag: ai
description: Building production-grade full-stack AI applications with Next.js and Vercel AI SDK, covering streaming responses, multi-model support, and edge deployment
date: "2025-06-28T10:00:00.000Z"
---

## Goal

Building an AI application is not as simple as calling the OpenAI API. You need to handle streaming responses, manage conversation state, support multiple model switching, handle errors and retries, and optimize performance. Vercel AI SDK was built to solve exactly these problems. This article demonstrates how to build a production-grade full-stack AI application using Next.js and Vercel AI SDK.

## Background

### Why Choose Vercel AI SDK

Vercel AI SDK is an AI application development toolkit from Vercel. Its core advantages include:

1. **Unified API Interface**: One codebase supports multiple LLM providers including OpenAI, Anthropic, and Google.
2. **Built-in Streaming**: No need to manually handle SSE -- the SDK includes comprehensive streaming support.
3. **React Integration**: Provides `useChat`, `useCompletion`, and other Hooks to simplify frontend state management.
4. **Edge Ready**: Supports Edge Runtime for execution at edge nodes.
5. **Type Safety**: Complete TypeScript support.

### Technical Architecture

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

## Project Setup

### Initialize Project

```bash
npx create-next-app@latest ai-app --typescript --tailwind --app
cd ai-app
npm install ai @ai-sdk/openai @ai-sdk/anthropic
```

### Environment Configuration

```env
# .env.local
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
```

## Backend Implementation

### Basic Chat API

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
    system: `You are a professional frontend technical consultant.
You can help users solve React, Vue, TypeScript, CSS, and other frontend-related problems.
When answering, please:
1. Provide accurate technical information
2. Give runnable code examples
3. Explain key concepts and best practices
4. If unsure, be honest`,
    messages,
    maxTokens: 4096,
    temperature: 0.7,
  });

  return result.toDataStreamResponse();
}
```

### Chat API with Tool Calling

```typescript
// app/api/chat-with-tools/route.ts
import { openai } from '@ai-sdk/openai';
import { streamText, tool } from 'ai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4o'),
    system: `You are a frontend development assistant.
You can help users:
1. Write and review code
2. Answer technical questions
3. Search documentation (via tools)
4. Create code examples`,
    messages,
    tools: {
      searchDocs: tool({
        description: 'Search frontend technology documentation',
        parameters: z.object({
          query: z.string().describe('Search keywords'),
          technology: z.enum(['react', 'vue', 'css', 'typescript', 'node'])
            .describe('Technology domain'),
        }),
        execute: async ({ query, technology }) => {
          const results = await searchDocumentation(query, technology);
          return { results: results.slice(0, 5), total: results.length };
        },
      }),

      reviewCode: tool({
        description: 'Review code quality and potential issues',
        parameters: z.object({
          code: z.string().describe('Code to review'),
          language: z.string().describe('Programming language'),
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
        description: 'Generate code example',
        parameters: z.object({
          description: z.string().describe('Feature description'),
          framework: z.string().describe('Framework to use'),
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

### Conversation History Management

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

## Frontend Implementation

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
          Error: {error.message}
          <button onClick={reload} className="ml-2 underline">
            Retry
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask your question..."
          className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50"
        >
          {isLoading ? 'Thinking...' : 'Send'}
        </button>
        {isLoading && (
          <button
            type="button"
            onClick={stop}
            className="bg-gray-500 text-white px-4 py-2 rounded-lg"
          >
            Stop
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
  const { toolName, state } = invocation;

  if (state === 'result') {
    return (
      <div className="mt-3 p-3 bg-gray-50 dark:bg-gray-900 rounded border">
        <p className="text-sm font-medium text-gray-500 mb-2">
          Tool Call: {toolName}
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
        Calling {toolName}...
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
      <h1 className="text-2xl font-bold mb-4">Code Generator</h1>
      
      <form onSubmit={handleSubmit} className="mb-4">
        <textarea
          value={input}
          onChange={handleInputChange}
          placeholder="Describe the functionality you need..."
          className="w-full border rounded-lg p-3 h-32"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="mt-2 bg-blue-500 text-white px-4 py-2 rounded-lg"
        >
          Generate Code
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

## Advanced Features

### Multimodal Support

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
    system: 'You are a frontend design expert who can analyze UI screenshots and provide suggestions.',
  });

  return result.toDataStreamResponse();
}
```

### Edge Runtime Deployment

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

### Performance Optimization

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

## Summary

Best practices for building full-stack AI applications with Next.js and Vercel AI SDK:

1. **Unified API Layer**: Use Vercel AI SDK's `streamText` to handle different LLM providers uniformly.
2. **Streaming Responses**: Leverage built-in streaming support for real-time feedback.
3. **Tool Calling**: Define tools with the `tool()` function to let AI call external services.
4. **Frontend Hooks**: Use `useChat` / `useCompletion` to simplify frontend state management.
5. **Edge Deployment**: Leverage Edge Runtime to improve global access speed.

Vercel AI SDK dramatically reduces the complexity of AI application development, allowing you to focus on business logic rather than low-level implementation.