---
title: "Vercel AI SDK 实战：快速构建 AI 聊天界面"
tag: ai
description: 深入讲解如何使用 Vercel AI SDK 快速构建 AI 聊天界面，包括 Streaming 响应、多模型支持和生产部署。
date: "2025-04-28T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者掌握使用 Vercel AI SDK 构建 AI 聊天应用的核心技巧，包括前后端集成、Streaming 响应、多模型支持和生产部署。

## 背景

Vercel AI SDK 是一个用于构建 AI 驱动用户界面的工具包，它提供了标准化的接口来连接各种 LLM 提供商，并简化了 Streaming 响应的实现。

### Vercel AI SDK 的优势

1. **统一接口**：支持 OpenAI、Anthropic、Google 等多种 LLM
2. **Streaming 原生支持**：开箱即用的 Streaming 响应
3. **React 集成**：提供 React Hooks
4. **TypeScript 支持**：完整的类型定义
5. **生产就绪**：内置错误处理和重试

## 一、环境搭建

### 项目初始化

```bash
# 创建 Next.js 项目
npx create-next-app@latest ai-chat --typescript --tailwind --app

# 安装 AI SDK
npm install ai @ai-sdk/openai @ai-sdk/anthropic

# 其他依赖
npm install @ai-sdk/react
```

### 环境配置

```env
# .env.local
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

## 二、后端 API 实现

### 基础 API 路由

```typescript
// app/api/chat/route.ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

// 允许的最大持续时间（秒）
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4'),
    system: '你是一个有帮助的助手，请用中文回答问题。',
    messages,
  });

  return result.toDataStreamResponse();
}
```

### 多模型支持

```typescript
// app/api/chat/[model]/route.ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

const models = {
  'gpt-4': openai('gpt-4'),
  'gpt-3.5': openai('gpt-3.5-turbo'),
  'claude': anthropic('claude-3-opus-20240229'),
};

export async function POST(
  req: Request,
  { params }: { params: { model: string } }
) {
  const { messages } = await req.json();
  const model = models[params.model as keyof typeof models] || models['gpt-4'];

  const result = streamText({
    model,
    system: '你是一个有帮助的助手。',
    messages,
  });

  return result.toDataStreamResponse();
}
```

### 工具调用

```typescript
// app/api/chat-with-tools/route.ts
import { streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4'),
    messages,
    tools: {
      getWeather: tool({
        description: '获取指定城市的天气信息',
        parameters: z.object({
          city: z.string().describe('城市名称'),
        }),
        execute: async ({ city }) => {
          // 这里可以调用真实的天气 API
          return {
            city,
            temperature: 25,
            condition: '晴天',
          };
        },
      }),
      calculate: tool({
        description: '计算数学表达式',
        parameters: z.object({
          expression: z.string().describe('数学表达式'),
        }),
        execute: async ({ expression }) => {
          try {
            const result = eval(expression);
            return { result };
          } catch (error) {
            return { error: '计算错误' };
          }
        },
      }),
    },
  });

  return result.toDataStreamResponse();
}
```

## 三、前端实现

### 基础聊天界面

```tsx
// app/page.tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex flex-col h-screen">
      {/* 头部 */}
      <header className="p-4 border-b">
        <h1 className="text-xl font-bold">AI 聊天助手</h1>
      </header>

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`max-w-[70%] p-3 rounded-lg ${
                message.role === 'user'
                  ? 'bg-blue-500 text-white rounded-br-none'
                  : 'bg-gray-100 text-gray-800 rounded-bl-none'
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
              <p className="text-xs opacity-50 mt-1">
                {message.role === 'user' ? '你' : 'AI'}
              </p>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 p-3 rounded-lg rounded-bl-none">
              <div className="flex space-x-1">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100" />
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 输入框 */}
      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            placeholder="输入消息..."
            className="flex-1 p-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? '生成中...' : '发送'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

### 高级聊天界面

```tsx
// components/AdvancedChat.tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { useState, useRef, useEffect } from 'react';

interface ChatSettings {
  model: string;
  temperature: number;
  systemPrompt: string;
}

export function AdvancedChat() {
  const [settings, setSettings] = useState<ChatSettings>({
    model: 'gpt-4',
    temperature: 0.7,
    systemPrompt: '你是一个有帮助的助手。',
  });

  const { messages, input, handleInputChange, handleSubmit, isLoading, setMessages } =
    useChat({
      api: `/api/chat/${settings.model}`,
      body: settings,
    });

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 清空对话
  const handleClear = () => {
    setMessages([]);
  };

  // 导出对话
  const handleExport = () => {
    const content = messages
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-${new Date().toISOString()}.txt`;
    a.click();
  };

  return (
    <div className="flex h-screen">
      {/* 侧边栏设置 */}
      <div className="w-64 border-r p-4 space-y-4">
        <h2 className="font-bold">设置</h2>
        
        <div>
          <label className="block text-sm mb-1">模型</label>
          <select
            value={settings.model}
            onChange={(e) =>
              setSettings((s) => ({ ...s, model: e.target.value }))
            }
            className="w-full p-2 border rounded"
          >
            <option value="gpt-4">GPT-4</option>
            <option value="gpt-3.5">GPT-3.5</option>
            <option value="claude">Claude</option>
          </select>
        </div>

        <div>
          <label className="block text-sm mb-1">
            Temperature: {settings.temperature}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={settings.temperature}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                temperature: parseFloat(e.target.value),
              }))
            }
            className="w-full"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">系统提示</label>
          <textarea
            value={settings.systemPrompt}
            onChange={(e) =>
              setSettings((s) => ({ ...s, systemPrompt: e.target.value }))
            }
            className="w-full p-2 border rounded h-24"
          />
        </div>

        <div className="space-y-2">
          <button
            onClick={handleClear}
            className="w-full p-2 border rounded hover:bg-gray-50"
          >
            清空对话
          </button>
          <button
            onClick={handleExport}
            className="w-full p-2 border rounded hover:bg-gray-50"
          >
            导出对话
          </button>
        </div>
      </div>

      {/* 主聊天区域 */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-gray-500 mt-20">
              <p className="text-lg">开始与 AI 对话</p>
              <p className="text-sm">输入你的问题</p>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          <div ref={messagesEndRef} />
        </div>

        <ChatInput
          input={input}
          onInputChange={handleInputChange}
          onSubmit={handleSubmit}
          isLoading={isLoading}
        />
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: any }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] p-4 rounded-2xl ${
          isUser
            ? 'bg-blue-500 text-white rounded-br-md'
            : 'bg-gray-100 text-gray-800 rounded-bl-md'
        }`}
      >
        {/* 渲染消息内容（支持 Markdown） */}
        <div className="whitespace-pre-wrap">{message.content}</div>
        
        {/* 渲染工具调用结果 */}
        {message.toolInvocations?.map((toolInvocation: any) => (
          <div
            key={toolInvocation.toolCallId}
            className="mt-2 p-2 bg-white/10 rounded text-sm"
          >
            <p className="font-mono">
              {toolInvocation.toolName}({JSON.stringify(toolInvocation.args)})
            </p>
            {toolInvocation.state === 'result' && (
              <pre className="mt-1 text-xs">
                {JSON.stringify(toolInvocation.result, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ChatInput({
  input,
  onInputChange,
  onSubmit,
  isLoading,
}: {
  input: string;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  isLoading: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="p-4 border-t bg-white">
      <div className="flex gap-2 max-w-4xl mx-auto">
        <input
          value={input}
          onChange={onInputChange}
          placeholder="输入消息... (Shift+Enter 换行)"
          className="flex-1 p-4 border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          className="px-6 py-4 bg-blue-500 text-white rounded-xl hover:bg-blue-600 disabled:opacity-50"
        >
          {isLoading ? (
            <span className="flex items-center">
              <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              生成中
            </span>
          ) : (
            '发送'
          )}
        </button>
      </div>
    </form>
  );
}
```

## 四、Streaming 响应处理

### 自定义 Streaming 显示

```tsx
// components/StreamingMessage.tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { useState, useEffect } from 'react';

export function StreamingMessage({ messageId }: { messageId: string }) {
  const { messages } = useChat();
  const message = messages.find((m) => m.id === messageId);

  if (!message) return null;

  return (
    <div className="p-4 bg-gray-100 rounded-lg">
      {/* 文本内容 */}
      <div className="whitespace-pre-wrap">{message.content}</div>

      {/* 加载状态 */}
      {message.toolInvocations?.map((toolInvocation) => (
        <div key={toolInvocation.toolCallId} className="mt-2">
          {toolInvocation.state === 'call' && (
            <div className="flex items-center text-sm text-gray-500">
              <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              调用 {toolInvocation.toolName}...
            </div>
          )}

          {toolInvocation.state === 'result' && (
            <div className="p-2 bg-white rounded text-sm">
              <p className="font-medium">{toolInvocation.toolName} 结果：</p>
              <pre className="mt-1 text-xs overflow-auto">
                {JSON.stringify(toolInvocation.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

### 打字机效果

```tsx
// components/TypewriterMessage.tsx
'use client';

import { useState, useEffect } from 'react';

export function TypewriterMessage({ content }: { content: string }) {
  const [displayedContent, setDisplayedContent] = useState('');
  const [isTyping, setIsTyping] = useState(true);

  useEffect(() => {
    if (!content) return;

    let index = 0;
    const timer = setInterval(() => {
      if (index < content.length) {
        setDisplayedContent(content.slice(0, index + 1));
        index++;
      } else {
        setIsTyping(false);
        clearInterval(timer);
      }
    }, 20);

    return () => clearInterval(timer);
  }, [content]);

  return (
    <span>
      {displayedContent}
      {isTyping && (
        <span className="inline-block w-0.5 h-4 bg-current animate-pulse ml-0.5" />
      )}
    </span>
  );
}
```

## 五、错误处理

```tsx
// components/ChatWithErrorHandling.tsx
'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export function ChatWithErrorHandling() {
  const [error, setError] = useState<string | null>(null);

  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
    onError: (error) => {
      setError(error.message);
    },
    onFinish: () => {
      setError(null);
    },
  });

  return (
    <div className="flex flex-col h-screen">
      {/* 错误提示 */}
      {error && (
        <div className="p-4 bg-red-50 border-l-4 border-red-500 text-red-700">
          <div className="flex justify-between">
            <p>{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-500 hover:text-red-700"
            >
              关闭
            </button>
          </div>
          <button
            onClick={handleSubmit}
            className="mt-2 text-sm underline hover:no-underline"
          >
            重试
          </button>
        </div>
      )}

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((message) => (
          <div key={message.id} className="mb-4">
            <p className="font-medium">{message.role === 'user' ? '你' : 'AI'}</p>
            <p>{message.content}</p>
          </div>
        ))}
      </div>

      {/* 输入框 */}
      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            className="flex-1 p-2 border rounded"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 bg-blue-500 text-white rounded"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 六、性能优化

### 消息虚拟化

```tsx
// 对于长对话，使用虚拟化
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualizedChat({ messages }: { messages: any[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
  });

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            <MessageBubble message={messages[virtualRow.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 防抖更新

```typescript
// 使用 useDebounce 防止频繁更新
import { useDebounce } from 'use-debounce';

function DebouncedInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [debouncedValue] = useDebounce(value, 300);
  
  useEffect(() => {
    onChange(debouncedValue);
  }, [debouncedValue, onChange]);
  
  return <input value={value} onChange={(e) => onChange(e.target.value)} />;
}
```

## 七、生产部署

### Vercel 部署

```json
// package.json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  }
}
```

```bash
# 部署到 Vercel
vercel deploy
```

### 环境变量

```bash
# 在 Vercel 控制台设置
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### 性能监控

```typescript
// app/api/chat/route.ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

export async function POST(req: Request) {
  const startTime = Date.now();
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4'),
    messages,
    onFinish: () => {
      const duration = Date.now() - startTime;
      console.log(`Response time: ${duration}ms`);
    },
  });

  return result.toDataStreamResponse();
}
```

## 总结

Vercel AI SDK 是构建 AI 聊天应用的最佳选择之一。

| 特性 | 优势 | 适用场景 |
|------|------|----------|
| Streaming | 开箱即用 | 实时聊天 |
| 多模型 | 灵活切换 | 多模型支持 |
| React Hooks | 简化开发 | 前端集成 |
| TypeScript | 类型安全 | 大型项目 |

**姐姐的建议**：

1. **从简单开始**：先实现基本聊天功能
2. **善用 Hooks**：useChat 简化了大部分工作
3. **处理错误**：生产环境必须有错误处理
4. **性能优化**：长对话需要虚拟化
5. **监控日志**：记录 API 调用情况

Vercel AI SDK 让构建 AI 聊天应用变得简单高效。希望这篇实战指南能帮助宝宝们快速构建自己的 AI 应用。
