---
title: "LLM 应用前端开发：Streaming 响应与打字机效果实现"
tag: ai
description: 深入讲解如何在前端实现 LLM 应用的 Streaming 响应和打字机效果，提升用户体验。
date: "2025-04-08T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者理解 LLM 应用中 Streaming 响应的原理和实现方式，掌握在前端实现打字机效果的技巧，提升 AI 应用的用户体验。

## 背景

大语言模型（LLM）的响应通常需要几秒到几十秒的时间。如果让用户等待完整响应，体验会很差。Streaming 响应可以逐字输出结果，配合打字机效果，能够显著提升用户体验。

### 为什么需要 Streaming？

1. **提升感知性能**：用户可以立即看到输出
2. **减少等待焦虑**：持续的输出反馈
3. **交互性增强**：可以中途停止或复制
4. **真实感**：类似人类打字的感觉

### Streaming 原理

```
传统响应：
[等待完整响应] → [一次性显示所有内容]

Streaming 响应：
[开始] → [逐字/逐块输出] → [完成]
    ↓        ↓           ↓
  立即响应  持续更新    最终结果
```

## 一、后端 Streaming 实现

### SSE (Server-Sent Events)

```typescript
// 后端 API
import { OpenAI } from 'openai';

const openai = new OpenAI();

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});
```

### WebSocket

```typescript
// 后端 WebSocket
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    const { messages } = JSON.parse(message);

    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        ws.send(JSON.stringify({ type: 'chunk', content }));
      }
    }

    ws.send(JSON.stringify({ type: 'done' }));
  });
});
```

### Vercel AI SDK

```typescript
// 使用 Vercel AI SDK
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai('gpt-4'),
    messages,
  });

  return result.toDataStreamResponse();
}
```

## 二、前端 Streaming 实现

### 使用 Fetch API

```typescript
// 基础 Streaming 实现
async function streamChat(messages: Message[]) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  let fullContent = '';

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') break;

        try {
          const { content } = JSON.parse(data);
          fullContent += content;
          updateUI(fullContent);
        } catch (e) {
          // 解析错误，跳过
        }
      }
    }
  }

  return fullContent;
}
```

### 使用 Vercel AI SDK

```typescript
// React 组件
import { useChat } from 'ai/react';

function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`mb-4 ${
              message.role === 'user' ? 'text-right' : 'text-left'
            }`}
          >
            <div
              className={`inline-block p-3 rounded-lg ${
                message.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-800'
              }`}
            >
              {message.content}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            className="flex-1 p-2 border rounded"
            placeholder="输入消息..."
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

## 三、打字机效果实现

### 基础打字机效果

```typescript
import { useState, useEffect, useRef } from 'react';

function TypewriterText({ text, speed = 50 }: { text: string; speed?: number }) {
  const [displayedText, setDisplayedText] = useState('');
  const indexRef = useRef(0);

  useEffect(() => {
    setDisplayedText('');
    indexRef.current = 0;

    const timer = setInterval(() => {
      if (indexRef.current < text.length) {
        setDisplayedText((prev) => prev + text[indexRef.current]);
        indexRef.current++;
      } else {
        clearInterval(timer);
      }
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed]);

  return <span>{displayedText}</span>;
}
```

### 流式打字机效果

```typescript
function StreamingTypewriter({ stream }: { stream: ReadableStream }) {
  const [text, setText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const read = async () => {
      setIsStreaming(true);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        setText((prev) => prev + chunk);
      }
      setIsStreaming(false);
    };

    read();

    return () => {
      reader.cancel();
    };
  }, [stream]);

  return (
    <div className="relative">
      <span>{text}</span>
      {isStreaming && <span className="animate-pulse">|</span>}
    </div>
  );
}
```

### 高级打字机效果

```typescript
function AdvancedTypewriter({
  text,
  speed = 30,
  onComplete,
  showCursor = true,
}: {
  text: string;
  speed?: number;
  onComplete?: () => void;
  showCursor?: boolean;
}) {
  const [displayedText, setDisplayedText] = useState('');
  const [isTyping, setIsTyping] = useState(true);
  const indexRef = useRef(0);

  useEffect(() => {
    if (!text) return;

    setDisplayedText('');
    indexRef.current = 0;
    setIsTyping(true);

    const typeChar = () => {
      if (indexRef.current < text.length) {
        setDisplayedText((prev) => prev + text[indexRef.current]);
        indexRef.current++;
        setTimeout(typeChar, speed);
      } else {
        setIsTyping(false);
        onComplete?.();
      }
    };

    typeChar();
  }, [text, speed, onComplete]);

  return (
    <span className="inline">
      {displayedText}
      {showCursor && isTyping && (
        <span className="inline-block w-0.5 h-4 bg-current animate-pulse ml-0.5" />
      )}
    </span>
  );
}
```

## 四、完整聊天组件

```typescript
// ChatMessage.tsx
import { useState, useEffect } from 'react';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

export function ChatMessage({ role, content, isStreaming }: ChatMessageProps) {
  const [displayedContent, setDisplayedContent] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    if (isStreaming) {
      setIsTyping(true);
      setDisplayedContent(content);
    } else {
      // 逐字显示
      let index = 0;
      const timer = setInterval(() => {
        if (index < content.length) {
          setDisplayedContent(content.slice(0, index + 1));
          index++;
        } else {
          clearInterval(timer);
          setIsTyping(false);
        }
      }, 20);

      return () => clearInterval(timer);
    }
  }, [content, isStreaming]);

  return (
    <div
      className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'} mb-4`}
    >
      <div
        className={`max-w-[70%] p-4 rounded-lg ${
          role === 'user'
            ? 'bg-blue-500 text-white rounded-br-none'
            : 'bg-gray-100 text-gray-800 rounded-bl-none'
        }`}
      >
        <div className="whitespace-pre-wrap">
          {displayedContent}
          {isTyping && (
            <span className="inline-block w-2 h-4 bg-current animate-pulse ml-1" />
          )}
        </div>
      </div>
    </div>
  );
}

// ChatContainer.tsx
export function ChatContainer() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMessage],
        }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';

      // 添加助手消息占位
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '',
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // 读取 Stream
      while (true) {
        const { done, value } = await reader!.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;

            try {
              const { content } = JSON.parse(data);
              assistantContent += content;

              // 更新助手消息
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessage.id
                    ? { ...msg, content: assistantContent }
                    : msg
                )
              );
            } catch (e) {
              // 解析错误
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            role={message.role as 'user' | 'assistant'}
            content={message.content}
            isStreaming={isLoading && message.role === 'assistant'}
          />
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="flex-1 p-3 border rounded-lg"
            placeholder="输入消息..."
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg disabled:opacity-50"
          >
            {isLoading ? '生成中...' : '发送'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 五、性能优化

### 1. 虚拟滚动

```typescript
// 对于长对话，使用虚拟滚动
import { FixedSizeList } from 'react-window';

function VirtualChatList({ messages }: { messages: Message[] }) {
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => (
    <div style={style}>
      <ChatMessage
        role={messages[index].role as 'user' | 'assistant'}
        content={messages[index].content}
      />
    </div>
  );

  return (
    <FixedSizeList
      height={600}
      width="100%"
      itemCount={messages.length}
      itemSize={100}
    >
      {Row}
    </FixedSizeList>
  );
}
```

### 2. 防抖更新

```typescript
// 防止频繁更新导致的性能问题
function useDebouncedValue(value: string, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// 使用
function StreamingMessage({ content }: { content: string }) {
  const debouncedContent = useDebouncedValue(content, 50);
  return <span>{debouncedContent}</span>;
}
```

### 3. 光标优化

```typescript
// 优化光标动画性能
function Cursor() {
  return (
    <span
      className="inline-block w-0.5 h-4 bg-current"
      style={{
        animation: 'blink 1s step-end infinite',
      }}
    />
  );
}

// CSS 动画
<style>{`
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
`}</style>
```

## 六、错误处理

```typescript
function ChatWithErrorHandling() {
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 处理 Stream...
    } catch (error) {
      if (retryCount < 3) {
        // 自动重试
        setRetryCount((prev) => prev + 1);
        setTimeout(handleSubmit, 1000 * retryCount);
      } else {
        setError('请求失败，请稍后重试');
      }
    }
  };

  return (
    <div>
      {error && (
        <div className="p-4 bg-red-100 text-red-700 rounded mb-4">
          {error}
          <button
            onClick={() => {
              setError(null);
              setRetryCount(0);
            }}
            className="ml-2 underline"
          >
            重试
          </button>
        </div>
      )}
      {/* 聊天界面 */}
    </div>
  );
}
```

## 七、最佳实践

### 1. 用户体验

```markdown
## 用户体验建议

### 反馈
- 发送后立即显示用户消息
- 显示"正在思考..."状态
- 打字机效果逐字显示

### 交互
- 支持停止生成
- 支持复制消息
- 支持重新生成

### 状态
- 显示生成进度
- 显示字数统计
- 显示响应时间
```

### 2. 代码组织

```markdown
## 代码组织建议

### 组件拆分
- ChatContainer: 容器组件
- ChatMessage: 消息组件
- TypewriterText: 打字机组件
- ChatInput: 输入组件

### Hooks 抽象
- useChat: 聊天逻辑
- useStreaming: Stream 处理
- useTypewriter: 打字机效果

### 工具函数
- parseSSE: 解析 SSE 数据
- formatMessage: 格式化消息
```

## 总结

Streaming 响应和打字机效果是 LLM 应用的关键用户体验特性。

| 特性 | 价值 | 实现难度 |
|------|------|----------|
| Streaming 响应 | 提升感知性能 | 中等 |
| 打字机效果 | 增强真实感 | 低 |
| 错误处理 | 保证稳定性 | 低 |
| 性能优化 | 流畅体验 | 中等 |

**姐姐的建议**：

1. **优先实现 Streaming**：这是 LLM 应用的基础
2. **打字机效果可选**：根据场景决定是否启用
3. **错误处理重要**：网络问题很常见
4. **性能要关注**：长对话需要优化
5. **用户体验第一**：持续收集反馈改进

Streaming 响应让用户能够立即看到 AI 的输出，配合打字机效果，能够创造更好的交互体验。希望这篇指南能帮助宝宝们构建更好的 LLM 应用。
