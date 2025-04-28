---
title: "Vercel AI SDK in Practice: Quickly Building AI Chat Interfaces"
tag: ai
description: An in-depth guide to using Vercel AI SDK to quickly build AI chat interfaces, including streaming responses, multi-model support, and production deployment.
date: "2025-04-28T08:00:00.000Z"
---

## Goal

This article aims to help developers master the core techniques of using Vercel AI SDK to build AI chat applications, including frontend-backend integration, streaming responses, multi-model support, and production deployment.

## Background

Vercel AI SDK is a toolkit for building AI-driven user interfaces, providing standardized interfaces to connect various LLM providers and simplifying streaming response implementation.

### Vercel AI SDK Advantages

1. **Unified Interface**: Supports OpenAI, Anthropic, Google, and other LLMs
2. **Native Streaming Support**: Out-of-the-box streaming responses
3. **React Integration**: Provides React Hooks
4. **TypeScript Support**: Complete type definitions
5. **Production Ready**: Built-in error handling and retry

## 1. Environment Setup

### Project Initialization

```bash
# Create Next.js project
npx create-next-app@latest ai-chat --typescript --tailwind --app

# Install AI SDK
npm install ai @ai-sdk/openai @ai-sdk/anthropic

# Other dependencies
npm install @ai-sdk/react
```

### Environment Configuration

```env
# .env.local
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
```

## 2. Backend API Implementation

### Basic API Route

```typescript
// app/api/chat/route.ts
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

// Maximum duration allowed (seconds)
export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4'),
    system: 'You are a helpful assistant. Please answer questions in Chinese.',
    messages,
  });

  return result.toDataStreamResponse();
}
```

### Multi-Model Support

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
    system: 'You are a helpful assistant.',
    messages,
  });

  return result.toDataStreamResponse();
}
```

### Tool Calling

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
        description: 'Get weather information for a specified city',
        parameters: z.object({
          city: z.string().describe('City name'),
        }),
        execute: async ({ city }) => {
          // Here you can call a real weather API
          return {
            city,
            temperature: 25,
            condition: 'Sunny',
          };
        },
      }),
      calculate: tool({
        description: 'Calculate mathematical expression',
        parameters: z.object({
          expression: z.string().describe('Mathematical expression'),
        }),
        execute: async ({ expression }) => {
          try {
            const result = eval(expression);
            return { result };
          } catch (error) {
            return { error: 'Calculation error' };
          }
        },
      }),
    },
  });

  return result.toDataStreamResponse();
}
```

## 3. Frontend Implementation

### Basic Chat Interface

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
      {/* Header */}
      <header className="p-4 border-b">
        <h1 className="text-xl font-bold">AI Chat Assistant</h1>
      </header>

      {/* Message list */}
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
                {message.role === 'user' ? 'You' : 'AI'}
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

      {/* Input box */}
      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            placeholder="Type message..."
            className="flex-1 p-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Generating...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

### Advanced Chat Interface

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
    systemPrompt: 'You are a helpful assistant.',
  });

  const { messages, input, handleInputChange, handleSubmit, isLoading, setMessages } =
    useChat({
      api: `/api/chat/${settings.model}`,
      body: settings,
    });

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Clear conversation
  const handleClear = () => {
    setMessages([]);
  };

  // Export conversation
  const handleExport = () => {
    const content = messages
      .map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
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
      {/* Sidebar settings */}
      <div className="w-64 border-r p-4 space-y-4">
        <h2 className="font-bold">Settings</h2>
        
        <div>
          <label className="block text-sm mb-1">Model</label>
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
          <label className="block text-sm mb-1">System Prompt</label>
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
            Clear Conversation
          </button>
          <button
            onClick={handleExport}
            className="w-full p-2 border rounded hover:bg-gray-50"
          >
            Export Conversation
          </button>
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-gray-500 mt-20">
              <p className="text-lg">Start chatting with AI</p>
              <p className="text-sm">Type your question</p>
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
        {/* Render message content (supports Markdown) */}
        <div className="whitespace-pre-wrap">{message.content}</div>
        
        {/* Render tool call results */}
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
          placeholder="Type message... (Shift+Enter for newline)"
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
              Generating
            </span>
          ) : (
            'Send'
          )}
        </button>
      </div>
    </form>
  );
}
```

## 4. Streaming Response Handling

### Custom Streaming Display

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
      {/* Text content */}
      <div className="whitespace-pre-wrap">{message.content}</div>

      {/* Loading state */}
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
              Calling {toolInvocation.toolName}...
            </div>
          )}

          {toolInvocation.state === 'result' && (
            <div className="p-2 bg-white rounded text-sm">
              <p className="font-medium">{toolInvocation.toolName} result:</p>
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

### Typewriter Effect

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

## 5. Error Handling

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
      {/* Error message */}
      {error && (
        <div className="p-4 bg-red-50 border-l-4 border-red-500 text-red-700">
          <div className="flex justify-between">
            <p>{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-500 hover:text-red-700"
            >
              Close
            </button>
          </div>
          <button
            onClick={handleSubmit}
            className="mt-2 text-sm underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((message) => (
          <div key={message.id} className="mb-4">
            <p className="font-medium">{message.role === 'user' ? 'You' : 'AI'}</p>
            <p>{message.content}</p>
          </div>
        ))}
      </div>

      {/* Input box */}
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
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 6. Performance Optimization

### Message Virtualization

```tsx
// For long conversations, use virtualization
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

### Debounced Updates

```typescript
// Use useDebounce to prevent frequent updates
import { useDebounce } from 'use-debounce';

function DebouncedInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [debouncedValue] = useDebounce(value, 300);
  
  useEffect(() => {
    onChange(debouncedValue);
  }, [debouncedValue, onChange]);
  
  return <input value={value} onChange={(e) => onChange(e.target.value)} />;
}
```

## 7. Production Deployment

### Vercel Deployment

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
# Deploy to Vercel
vercel deploy
```

### Environment Variables

```bash
# Set in Vercel console
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### Performance Monitoring

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

## Summary

Vercel AI SDK is one of the best choices for building AI chat applications.

| Feature | Advantage | Use Case |
|---------|-----------|----------|
| Streaming | Out-of-the-box | Real-time chat |
| Multi-model | Flexible switching | Multi-model support |
| React Hooks | Simplified development | Frontend integration |
| TypeScript | Type safety | Large projects |

**Recommendations**:

1. **Start Simple**: Implement basic chat functionality first
2. **Leverage Hooks**: useChat simplifies most work
3. **Handle Errors**: Production environments must have error handling
4. **Performance Optimization**: Long conversations need virtualization
5. **Monitor and Log**: Record API call situations

Vercel AI SDK makes building AI chat applications simple and efficient. This practical guide will help you quickly build your own AI applications.
