---
title: "LLM Frontend Development: Streaming Responses and Typewriter Effect Implementation"
tag: ai
description: An in-depth guide to implementing streaming responses and typewriter effects in LLM application frontends to enhance user experience.
date: "2025-04-08T08:00:00.000Z"
---

## Goal

This article aims to help developers understand the principles and implementation methods of streaming responses in LLM applications, master techniques for implementing typewriter effects on the frontend, and improve AI application user experience.

## Background

Large language model (LLM) responses typically take several seconds to tens of seconds. Making users wait for complete responses creates a poor experience. Streaming responses output results character by character, and combined with typewriter effects, can significantly improve user experience.

### Why Do We Need Streaming?

1. **Improved Perceived Performance**: Users can see output immediately
2. **Reduced Waiting Anxiety**: Continuous output feedback
3. **Enhanced Interactivity**: Can stop or copy midway
4. **Realism**: Similar to human typing feel

### Streaming Principle

```
Traditional Response:
[Wait for complete response] -> [Display all content at once]

Streaming Response:
[Start] -> [Character/block output] -> [Complete]
    |           |                    |
  Immediate   Continuous           Final
  Response     Update              Result
```

## 1. Backend Streaming Implementation

### SSE (Server-Sent Events)

```typescript
// Backend API
import { OpenAI } from 'openai';

const openai = new OpenAI();

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  // Set SSE response headers
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
// Backend WebSocket
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
// Using Vercel AI SDK
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

## 2. Frontend Streaming Implementation

### Using Fetch API

```typescript
// Basic streaming implementation
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
          // Parse error, skip
        }
      }
    }
  }

  return fullContent;
}
```

### Using Vercel AI SDK

```typescript
// React component
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
            placeholder="Type message..."
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

## 3. Typewriter Effect Implementation

### Basic Typewriter Effect

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

### Streaming Typewriter Effect

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

### Advanced Typewriter Effect

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

## 4. Complete Chat Component

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
      // Character by character display
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

      // Add assistant message placeholder
      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '',
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Read stream
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

              // Update assistant message
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMessage.id
                    ? { ...msg, content: assistantContent }
                    : msg
                )
              );
            } catch (e) {
              // Parse error
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
            placeholder="Type message..."
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg disabled:opacity-50"
          >
            {isLoading ? 'Generating...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 5. Performance Optimization

### 1. Virtual Scrolling

```typescript
// For long conversations, use virtual scrolling
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

### 2. Debounced Updates

```typescript
// Prevent performance issues from frequent updates
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

// Usage
function StreamingMessage({ content }: { content: string }) {
  const debouncedContent = useDebouncedValue(content, 50);
  return <span>{debouncedContent}</span>;
}
```

### 3. Cursor Optimization

```typescript
// Optimize cursor animation performance
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

// CSS animation
<style>{`
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
`}</style>
```

## 6. Error Handling

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

      // Handle stream...
    } catch (error) {
      if (retryCount < 3) {
        // Auto retry
        setRetryCount((prev) => prev + 1);
        setTimeout(handleSubmit, 1000 * retryCount);
      } else {
        setError('Request failed, please try again later');
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
            Retry
          </button>
        </div>
      )}
      {/* Chat interface */}
    </div>
  );
}
```

## 7. Best Practices

### 1. User Experience

```markdown
## User Experience Suggestions

### Feedback
- Display user message immediately after sending
- Show "Thinking..." state
- Typewriter effect displays character by character

### Interaction
- Support stopping generation
- Support copying messages
- Support regeneration

### State
- Display generation progress
- Display word count
- Display response time
```

### 2. Code Organization

```markdown
## Code Organization Suggestions

### Component Splitting
- ChatContainer: Container component
- ChatMessage: Message component
- TypewriterText: Typewriter component
- ChatInput: Input component

### Hooks Abstraction
- useChat: Chat logic
- useStreaming: Stream processing
- useTypewriter: Typewriter effect

### Utility Functions
- parseSSE: Parse SSE data
- formatMessage: Format messages
```

## Summary

Streaming responses and typewriter effects are key user experience features for LLM applications.

| Feature | Value | Implementation Difficulty |
|---------|-------|---------------------------|
| Streaming Response | Improved perceived performance | Medium |
| Typewriter Effect | Enhanced realism | Low |
| Error Handling | Ensured stability | Low |
| Performance Optimization | Smooth experience | Medium |

**Recommendations**:

1. **Prioritize Streaming**: This is the foundation of LLM applications
2. **Typewriter Effect is Optional**: Decide whether to enable based on scenario
3. **Error Handling is Important**: Network issues are common
4. **Performance Matters**: Long conversations need optimization
5. **User Experience First**: Continuously collect feedback for improvement

Streaming responses allow users to see AI output immediately, and combined with typewriter effects, create a better interactive experience. This guide will help you build better LLM applications.
