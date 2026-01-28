---
title: "AI Agent Backend Architecture: Multi-Turn Dialogue, Memory, and Tool Calling"
tag: ai
description: An in-depth exploration of AI Agent backend architecture design, covering multi-turn dialogue management, memory systems, tool calling, and state persistence
date: "2026-01-28T10:00:00.000Z"
---

## Goal

Building a production-grade AI Agent backend requires solving many engineering problems: How do you manage multi-turn dialogues? How do you store and retrieve memory? How do you safely call external tools? How do you ensure state consistency? This article systematically introduces the design and implementation of AI Agent backend architecture.

## Background

### Core Challenges of Agent Backends

| Challenge | Description |
|-----------|-------------|
| State Management | Agents need to remember conversation history and context |
| Tool Calling | Need to safely call external APIs and services |
| Concurrency | Multiple users interacting with Agent simultaneously |
| Persistence | Conversations and memory need persistent storage |
| Error Recovery | Graceful handling when tool calls fail |

### Technology Stack Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js / Bun | Async I/O, suitable for AI applications |
| Database | PostgreSQL + Redis | Relational data + caching/sessions |
| Message Queue | BullMQ | Async task processing |
| LLM | OpenAI / Anthropic | Mainstream LLM APIs |
| Vector Database | Pinecone / Weaviate | Memory retrieval |

## Core Architecture

### System Architecture Diagram

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
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐     │
│  │  PostgreSQL │  │    Redis    │  │   Vector    │     │
│  │ (Persistent)│  │  (Cache)    │  │     DB      │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### Data Models

```sql
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    title VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

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

CREATE TABLE agent_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id),
    agent_type VARCHAR(100) NOT NULL,
    state JSONB NOT NULL,
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

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

## Core Component Implementation

### Agent Core

```typescript
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
    this.llm = new ChatOpenAI({ modelName: config.model, apiKey: config.apiKey, temperature: config.temperature });
  }

  async run(conversationId: string, userMessage: string, history: Array<any>): Promise<AgentResponse> {
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
        const toolResults = await this.executeToolCalls(response.additional_kwargs.tool_calls);
        state.messages.push(response);
        for (const result of toolResults) {
          state.messages.push(new ToolMessage({ content: JSON.stringify(result.output), tool_call_id: result.toolCallId }));
        }
        continue;
      }

      return { content: response.content as string, toolCalls: Array.from(state.toolResults.values()), iterations: state.iterationCount };
    }

    throw new Error('Max iterations exceeded');
  }

  private buildMessages(userMessage: string, history: any[]): any[] {
    const messages = [new SystemMessage(this.getSystemPrompt())];
    for (const msg of history) {
      if (msg.role === 'user') messages.push(new HumanMessage(msg.content));
      else if (msg.role === 'assistant') messages.push(new AIMessage(msg.content));
    }
    messages.push(new HumanMessage(userMessage));
    return messages;
  }

  private getSystemPrompt(): string {
    return `You are an intelligent assistant. You can use the following tools to help users:

${Array.from(this.tools.values()).map(t => `- ${t.name}: ${t.description}`).join('\n')}

When answering user questions:
1. If you need to use a tool, call the appropriate tool
2. If no tool is needed, answer the user's question directly
3. Keep answers concise and accurate
4. If unsure, be honest`;
  }

  private async executeToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];
    for (const toolCall of toolCalls) {
      const t = this.tools.get(toolCall.function.name);
      if (!t) { results.push({ toolCallId: toolCall.id, output: { error: `Unknown tool: ${toolCall.function.name}` } }); continue; }
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const output = await t.invoke(args);
        results.push({ toolCallId: toolCall.id, output });
      } catch (error) {
        results.push({ toolCallId: toolCall.id, output: { error: (error as Error).message } });
      }
    }
    return results;
  }

  registerTool(name: string, toolDef: any) { this.tools.set(name, toolDef); }
}

interface AgentResponse { content: string; toolCalls: any[]; iterations: number; }
```

### Memory System

```typescript
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
    this.embeddings = new OpenAIEmbeddings({ modelName: 'text-embedding-3-small' });
  }

  async add(memory: Omit<Memory, 'id' | 'embedding' | 'createdAt'>): Promise<Memory> {
    const embedding = await this.embeddings.embedQuery(memory.content);
    const result = await this.pool.query(
      `INSERT INTO memories (user_id, type, content, embedding, metadata, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [memory.userId, memory.type, memory.content, JSON.stringify(embedding), JSON.stringify(memory.metadata), memory.expiresAt]
    );
    return result.rows[0];
  }

  async search(userId: string, query: string, options: { limit?: number; type?: string } = {}): Promise<Memory[]> {
    const { limit = 10, type } = options;
    const queryEmbedding = await this.embeddings.embedQuery(query);

    let sql = `SELECT *, 1 - (embedding <=> $1::vector) as similarity FROM memories WHERE user_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`;
    const params: any[] = [JSON.stringify(queryEmbedding), userId];

    if (type) { sql += ` AND type = $${params.length + 1}`; params.push(type); }
    sql += ` ORDER BY similarity DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);
    return result.rows;
  }

  async getRecent(userId: string, count: number = 10): Promise<Memory[]> {
    const result = await this.pool.query(
      `SELECT * FROM memories WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT $2`,
      [userId, count]
    );
    return result.rows;
  }

  async delete(id: string): Promise<void> { await this.pool.query('DELETE FROM memories WHERE id = $1', [id]); }
  async cleanup(): Promise<number> { const result = await this.pool.query('DELETE FROM memories WHERE expires_at < NOW()'); return result.rowCount || 0; }
}
```

### Tool System

```typescript
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

  register(toolDef: ToolDefinition) { this.tools.set(toolDef.name, toolDef); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }
  getAll(): ToolDefinition[] { return Array.from(this.tools.values()); }

  toLangChainTools(): any[] {
    return this.getAll().map(toolDef =>
      tool(async (args) => await toolDef.execute(args), { name: toolDef.name, description: toolDef.description, schema: toolDef.schema })
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
  description: 'Search products',
  schema: z.object({ query: z.string().describe('Search keywords'), category: z.string().optional().describe('Product category'), limit: z.number().optional().describe('Number of results') }),
  execute: async (args) => { const response = await fetch(`${process.env.API_URL}/products/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) }); return response.json(); },
});

registry.register({
  name: 'create_order',
  description: 'Create order',
  permissions: ['order:create'],
  schema: z.object({ productId: z.string().describe('Product ID'), quantity: z.number().describe('Quantity'), address: z.string().describe('Shipping address') }),
  execute: async (args) => { const response = await fetch(`${process.env.API_URL}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) }); return response.json(); },
});

export { registry };
```

## Advanced Features

### Conversation Management

```typescript
class ConversationManager {
  private pool: Pool;

  constructor() { this.pool = new Pool({ connectionString: process.env.DATABASE_URL }); }

  async create(userId: string, title?: string): Promise<string> {
    const result = await this.pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userId, title || 'New Conversation']);
    return result.rows[0].id;
  }

  async getHistory(conversationId: string, limit: number = 50): Promise<any[]> {
    const result = await this.pool.query(`SELECT role, content, tool_calls, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT $2`, [conversationId, limit]);
    return result.rows;
  }

  async addMessage(conversationId: string, role: string, content: string, metadata?: any): Promise<void> {
    await this.pool.query(`INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4)`, [conversationId, role, content, JSON.stringify(metadata || {})]);
    await this.pool.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
  }

  async getConversations(userId: string): Promise<any[]> {
    const result = await this.pool.query(`SELECT id, title, status, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
    return result.rows;
  }
}
```

### Error Handling and Retry

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; delay?: number; backoff?: number; retryOn?: (error: Error) => boolean } = {}
): Promise<T> {
  const { maxRetries = 3, delay = 1000, backoff = 2, retryOn = () => true } = options;
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

## Summary

Core points of AI Agent backend architecture:

1. **Conversation Management**: Store and retrieve conversation history, support multi-turn dialogue.
2. **Memory System**: Vector database + semantic search for long-term memory.
3. **Tool System**: Safe tool registration and calling mechanisms.
4. **State Persistence**: Agent state persistence and recovery.
5. **Error Handling**: Graceful error handling and retry mechanisms.

Building a production-grade AI Agent backend requires considering:
- Security: Permission control for tool calls
- Extensibility: Support for new tools and capabilities
- Observability: Complete logging and monitoring
- Performance: Caching, async processing, batch operations

These architecture patterns will help you build reliable, efficient AI Agent backend systems.