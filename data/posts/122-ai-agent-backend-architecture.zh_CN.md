---
title: "AI Agent 后端架构：多轮对话、记忆与工具调用"
tag: ai
description: 深入探讨 AI Agent 后端架构设计，涵盖多轮对话管理、记忆系统、工具调用与状态持久化
date: "2026-01-28T10:00:00.000Z"
---

## 目标

构建一个生产级的 AI Agent 后端需要解决很多工程问题：如何管理多轮对话？如何存储和检索记忆？如何安全地调用外部工具？如何保证状态一致性？本文将系统性地介绍 AI Agent 后端架构的设计与实现。

## 背景

### Agent 后端的核心挑战

| 挑战 | 说明 |
|------|------|
| 状态管理 | Agent 需要记住对话历史和上下文 |
| 工具调用 | 需要安全地调用外部 API 和服务 |
| 并发处理 | 多个用户同时与 Agent 交互 |
| 持久化 | 对话和记忆需要持久化存储 |
| 错误恢复 | 工具调用失败时需要优雅处理 |

### 技术栈选择

| 组件 | 选择 | 理由 |
|------|------|------|
| 运行时 | Node.js / Bun | 异步 I/O，适合 AI 应用 |
| 数据库 | PostgreSQL + Redis | 关系数据 + 缓存/会话 |
| 消息队列 | BullMQ | 异步任务处理 |
| LLM | OpenAI / Anthropic | 主流 LLM API |
| 向量数据库 | Pinecone / Weaviate | 记忆检索 |

## 核心架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                    AI Agent Backend                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   API       │  │   Agent     │  │   Tool      │     │
│  │   Gateway   │  │   Core      │  │   System    │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │             │
│         └────────────────┼────────────────┘             │
│                          │                              │
│              ┌───────────▼───────────┐                  │
│              │     State Manager     │                  │
│              └───────────┬───────────┘                  │
│                          │                              │
│         ┌────────────────┼────────────────┐             │
│         │                │                │             │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐     │
│  │  PostgreSQL │  │    Redis    │  │   Vector    │     │
│  │  (持久化)   │  │   (缓存)    │  │   DB        │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### 数据模型

```sql
-- 对话表
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    title VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- 消息表
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id),
    role VARCHAR(20) NOT NULL,
    content TEXT,
    tool_calls JSONB,
    tool_call_id VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Agent 状态表
CREATE TABLE agent_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id),
    agent_type VARCHAR(100) NOT NULL,
    state JSONB NOT NULL,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 工具调用记录
CREATE TABLE tool_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID REFERENCES messages(id),
    tool_name VARCHAR(100) NOT NULL,
    arguments JSONB NOT NULL,
    result JSONB,
    status VARCHAR(50) DEFAULT 'pending',
    error TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 记忆表
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);
```

## 核心组件实现

### Agent 核心

```typescript
// agent/core.ts
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

interface AgentConfig {
  model: string;
  apiKey: string;
  maxIterations: number;
  temperature: number;
}

interface AgentState {
  conversationId: string;
  messages: Array<HumanMessage | AIMessage | SystemMessage | ToolMessage>;
  toolResults: Map<string, any>;
  iterationCount: number;
}

class AIAgentCore {
  private llm: ChatOpenAI;
  private config: AgentConfig;
  private tools: Map<string, any> = new Map();

  constructor(config: AgentConfig) {
    this.config = config;
    this.llm = new ChatOpenAI({
      modelName: config.model,
      apiKey: config.apiKey,
      temperature: config.temperature,
    });
  }

  async run(
    conversationId: string,
    userMessage: string,
    history: Array<any>
  ): Promise<AgentResponse> {
    const state: AgentState = {
      conversationId,
      messages: this.buildMessages(userMessage, history),
      toolResults: new Map(),
      iterationCount: 0,
    };

    while (state.iterationCount < this.config.maxIterations) {
      state.iterationCount++;

      const response = await this.llm.invoke(state.messages);

      if (response.additional_kwargs?.tool_calls?.length > 0) {
        const toolResults = await this.executeToolCalls(
          response.additional_kwargs.tool_calls
        );

        state.messages.push(response);
        for (const result of toolResults) {
          state.messages.push(new ToolMessage({
            content: JSON.stringify(result.output),
            tool_call_id: result.toolCallId,
          }));
        }

        continue;
      }

      return {
        content: response.content as string,
        toolCalls: Array.from(state.toolResults.values()),
        iterations: state.iterationCount,
      };
    }

    throw new Error('Max iterations exceeded');
  }

  private buildMessages(userMessage: string, history: any[]): any[] {
    const messages = [
      new SystemMessage(this.getSystemPrompt()),
    ];

    for (const msg of history) {
      if (msg.role === 'user') {
        messages.push(new HumanMessage(msg.content));
      } else if (msg.role === 'assistant') {
        messages.push(new AIMessage(msg.content));
      }
    }

    messages.push(new HumanMessage(userMessage));

    return messages;
  }

  private getSystemPrompt(): string {
    return `你是一个智能助手。你可以使用以下工具来帮助用户：

${Array.from(this.tools.values())
  .map(tool => `- ${tool.name}: ${tool.description}`)
  .join('\n')}

在回答用户问题时：
1. 如果需要使用工具，请调用相应的工具
2. 如果不需要工具，直接回答用户问题
3. 保持回答简洁、准确
4. 如果不确定，诚实说明`;
  }

  private async executeToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.function.name);
      if (!tool) {
        results.push({
          toolCallId: toolCall.id,
          output: { error: `Unknown tool: ${toolCall.function.name}` },
        });
        continue;
      }

      try {
        const args = JSON.parse(toolCall.function.arguments);
        const output = await tool.invoke(args);
        results.push({ toolCallId: toolCall.id, output });
      } catch (error) {
        results.push({
          toolCallId: toolCall.id,
          output: { error: (error as Error).message },
        });
      }
    }

    return results;
  }

  registerTool(name: string, toolDef: any) {
    this.tools.set(name, toolDef);
  }
}

interface AgentResponse {
  content: string;
  toolCalls: any[];
  iterations: number;
}
```

### 记忆系统

```typescript
// memory/store.ts
import { Pool } from 'pg';
import { OpenAIEmbeddings } from '@langchain/openai';

interface Memory {
  id: string;
  userId: string;
  type: 'fact' | 'preference' | 'interaction';
  content: string;
  embedding?: number[];
  metadata: Record<string, any>;
  createdAt: Date;
  expiresAt?: Date;
}

class MemoryStore {
  private pool: Pool;
  private embeddings: OpenAIEmbeddings;

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
    this.embeddings = new OpenAIEmbeddings({
      modelName: 'text-embedding-3-small',
    });
  }

  async add(memory: Omit<Memory, 'id' | 'embedding' | 'createdAt'>): Promise<Memory> {
    const embedding = await this.embeddings.embedQuery(memory.content);

    const result = await this.pool.query(
      `INSERT INTO memories (user_id, type, content, embedding, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        memory.userId,
        memory.type,
        memory.content,
        JSON.stringify(embedding),
        JSON.stringify(memory.metadata),
        memory.expiresAt,
      ]
    );

    return result.rows[0];
  }

  async search(
    userId: string,
    query: string,
    options: { limit?: number; type?: string } = {}
  ): Promise<Memory[]> {
    const { limit = 10, type } = options;

    const queryEmbedding = await this.embeddings.embedQuery(query);

    let sql = `
      SELECT *, 1 - (embedding <=> $1::vector) as similarity
      FROM memories
      WHERE user_id = $2
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    const params: any[] = [JSON.stringify(queryEmbedding), userId];

    if (type) {
      sql += ` AND type = $${params.length + 1}`;
      params.push(type);
    }

    sql += ` ORDER BY similarity DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async getRecent(userId: string, count: number = 10): Promise<Memory[]> {
    const result = await this.pool.query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, count]
    );
    return result.rows;
  }

  async delete(id: string): Promise<void> {
    await this.pool.query('DELETE FROM memories WHERE id = $1', [id]);
  }

  async cleanup(): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM memories WHERE expires_at < NOW()'
    );
    return result.rowCount || 0;
  }
}
```

### 工具系统

```typescript
// tools/registry.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodSchema;
  execute: (args: any) => Promise<any>;
  permissions?: string[];
}

class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(toolDef: ToolDefinition) {
    this.tools.set(toolDef.name, toolDef);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toLangChainTools(): any[] {
    return this.getAll().map(toolDef =>
      tool(
        async (args) => {
          return await toolDef.execute(args);
        },
        {
          name: toolDef.name,
          description: toolDef.description,
          schema: toolDef.schema,
        }
      )
    );
  }

  checkPermission(toolName: string, userPermissions: string[]): boolean {
    const toolDef = this.tools.get(toolName);
    if (!toolDef?.permissions) return true;
    return toolDef.permissions.some(p => userPermissions.includes(p));
  }
}

const registry = new ToolRegistry();

registry.register({
  name: 'search_products',
  description: '搜索商品',
  schema: z.object({
    query: z.string().describe('搜索关键词'),
    category: z.string().optional().describe('商品类别'),
    limit: z.number().optional().describe('返回数量'),
  }),
  execute: async (args) => {
    const response = await fetch(`${process.env.API_URL}/products/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return response.json();
  },
});

registry.register({
  name: 'create_order',
  description: '创建订单',
  permissions: ['order:create'],
  schema: z.object({
    productId: z.string().describe('商品 ID'),
    quantity: z.number().describe('数量'),
    address: z.string().describe('收货地址'),
  }),
  execute: async (args) => {
    const response = await fetch(`${process.env.API_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return response.json();
  },
});

export { registry };
```

## 高级功能

### 对话管理

```typescript
// conversation/manager.ts
class ConversationManager {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  async create(userId: string, title?: string): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO conversations (user_id, title)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, title || '新对话']
    );
    return result.rows[0].id;
  }

  async getHistory(conversationId: string, limit: number = 50): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT role, content, tool_calls, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [conversationId, limit]
    );
    return result.rows;
  }

  async addMessage(
    conversationId: string,
    role: string,
    content: string,
    metadata?: any
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4)`,
      [conversationId, role, content, JSON.stringify(metadata || {})]
    );

    await this.pool.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId]
    );
  }

  async getConversations(userId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT id, title, status, created_at, updated_at
       FROM conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId]
    );
    return result.rows;
  }
}
```

### 错误处理和重试

```typescript
// utils/retry.ts
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delay?: number;
    backoff?: number;
    retryOn?: (error: Error) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    delay = 1000,
    backoff = 2,
    retryOn = () => true,
  } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries && retryOn(lastError)) {
        const waitTime = delay * Math.pow(backoff, attempt);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  throw lastError!;
}
```

## 总结

AI Agent 后端架构的核心要点：

1. **对话管理**：存储和检索对话历史，支持多轮对话
2. **记忆系统**：向量数据库 + 语义搜索，实现长期记忆
3. **工具系统**：安全的工具注册和调用机制
4. **状态持久化**：Agent 状态的持久化和恢复
5. **错误处理**：优雅的错误处理和重试机制

构建生产级 AI Agent 后端需要考虑：
- 安全性：工具调用的权限控制
- 可扩展性：支持新工具和新能力的接入
- 可观测性：完整的日志和监控
- 性能：缓存、异步处理、批量操作

这些架构模式将帮助你构建可靠、高效的 AI Agent 后端系统。