---
title: "MCP Server Development in Practice: Adding AI Capabilities to Your Tools"
tag: ai
description: Developing an MCP Server from scratch to make your tools and APIs callable by AI Agents, enabling true AI tool integration
date: "2025-07-25T10:00:00.000Z"
---

## Goal

MCP (Model Context Protocol) is an open protocol proposed by Anthropic, aiming to standardize how AI models interact with external tools. This article walks you through developing an MCP Server from scratch, making your tools and APIs callable by AI Agents -- a critical step in building the AI tool ecosystem.

## Background

### Why MCP Is Needed

Before MCP, every AI application had to implement its own tool calling logic:

- ChatGPT has its own Function Calling format.
- Claude has its own Tool Use format.
- Different AI frameworks have different tool definition approaches.

This means the same tool needs to be adapted repeatedly for different AI platforms. MCP's goal is to establish a unified protocol:

```
AI Model <-> MCP Protocol <-> MCP Server <-> Tools/APIs
```

### Core Concepts of MCP

| Concept | Description |
|---------|-------------|
| **Tools** | Functions/operations that AI can call |
| **Resources** | Data/context that AI can read |
| **Prompts** | Predefined prompt templates |
| **Sampling** | Mechanism for AI to request human input |

## MCP Server Development

### Project Structure

```
my-mcp-server/
├── src/
│   ├── index.ts          # Entry point
│   ├── tools/            # Tool definitions
│   │   ├── calculator.ts
│   │   ├── weather.ts
│   │   └── database.ts
│   ├── resources/        # Resource definitions
│   │   ├── config.ts
│   │   └── docs.ts
│   └── prompts/          # Prompt templates
│       └── templates.ts
├── package.json
└── tsconfig.json
```

### Basic MCP Server

```typescript
// src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'my-mcp-server',
  version: '1.0.0',
});

server.tool(
  'calculate',
  'Perform mathematical calculations',
  {
    expression: z.string().describe('Mathematical expression, e.g. "2 + 3 * 4"'),
  },
  async ({ expression }) => {
    try {
      const result = evaluateExpression(expression);
      return {
        content: [{ type: 'text', text: `Result: ${expression} = ${result}` }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Calculation error: ${error.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'get_weather',
  'Get weather information for a specified city',
  {
    city: z.string().describe('City name, e.g. "Beijing", "Shanghai"'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('Temperature unit'),
  },
  async ({ city, unit }) => {
    const weather = await fetchWeather(city, unit);
    return {
      content: [{
        type: 'text',
        text: `City: ${weather.city}\nCondition: ${weather.condition}\nTemperature: ${weather.temperature}${unit === 'celsius' ? '°C' : '°F'}\nHumidity: ${weather.humidity}\nWind Speed: ${weather.windSpeed}`,
      }],
    };
  }
);

server.resource(
  'config',
  'config://app',
  async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({
        appName: 'My MCP Server',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
      }),
    }],
  })
);

server.prompt(
  'review_code',
  'Code review prompt',
  {
    code: z.string().describe('Code to review'),
    language: z.string().describe('Programming language'),
  },
  ({ code, language }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please review the following ${language} code:

\`\`\`${language}
${code}
\`\`\`

Review dimensions:
1. Code quality and readability
2. Performance issues
3. Security vulnerabilities
4. Best practices
5. Improvement suggestions`,
      },
    }],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server running on stdio');
}

main().catch(console.error);
```

### Complex Tool Implementation

```typescript
// src/tools/database.ts
import { z } from 'zod';
import { pool } from '../db.js';

export function registerDatabaseTools(server: McpServer) {
  server.tool(
    'query_database',
    'Execute SQL query (read-only)',
    {
      sql: z.string().describe('SQL SELECT query'),
      params: z.array(z.string()).optional().describe('Query parameters'),
    },
    async ({ sql, params }) => {
      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        return {
          content: [{ type: 'text', text: 'Security restriction: Only SELECT queries allowed' }],
          isError: true,
        };
      }

      try {
        const result = await pool.query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ rows: result.rows, rowCount: result.rowCount }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Query error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_table_schema',
    'Get database table schema information',
    {
      tableName: z.string().describe('Table name'),
    },
    async ({ tableName }) => {
      const schema = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      return {
        content: [{
          type: 'text',
          text: `Table ${tableName} schema:\n\n${schema.rows.map(row =>
            `- ${row.column_name}: ${row.data_type} ${row.is_nullable === 'YES' ? '(nullable)' : '(not null)'} ${row.column_default ? `default: ${row.column_default}` : ''}`
          ).join('\n')}`,
        }],
      };
    }
  );
}
```

### Resources and Prompts

```typescript
// src/resources/docs.ts
export function registerDocResources(server: McpServer) {
  server.resource(
    'api-docs',
    'docs://api',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: `# API Documentation

## User Management

### GET /api/users
Get user list

### POST /api/users
Create new user

## Order Management

### GET /api/orders
Get order list

### POST /api/orders
Create new order
`,
      }],
    })
  );
}

// src/prompts/templates.ts
export function registerPromptTemplates(server: McpServer) {
  server.prompt(
    'analyze_data',
    'Data analysis and visualization suggestions',
    {
      dataDescription: z.string().describe('Data description'),
      question: z.string().describe('Analysis question'),
    },
    ({ dataDescription, question }) => ({
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: `You are a data analyst. Answer the user's question based on the provided data description and suggest appropriate visualization methods.

Data description: ${dataDescription}

Your answer should include:
1. Analysis conclusion
2. Supporting data evidence
3. Recommended visualization chart types
4. Possible insights and suggestions`,
          },
        },
        {
          role: 'user',
          content: { type: 'text', text: question },
        },
      ],
    })
  );
}
```

## Advanced Features

### Context Management

```typescript
interface ConversationContext {
  userId: string;
  sessionId: string;
  history: Array<{ role: string; content: string }>;
  userPreferences: Record<string, any>;
}

class ContextManager {
  private contexts: Map<string, ConversationContext> = new Map();

  getOrCreate(sessionId: string, userId: string): ConversationContext {
    if (!this.contexts.has(sessionId)) {
      this.contexts.set(sessionId, {
        userId, sessionId, history: [], userPreferences: {},
      });
    }
    return this.contexts.get(sessionId)!;
  }

  addToHistory(sessionId: string, role: string, content: string) {
    const ctx = this.contexts.get(sessionId);
    if (ctx) {
      ctx.history.push({ role, content });
      if (ctx.history.length > 50) ctx.history = ctx.history.slice(-50);
    }
  }
}
```

### Error Handling and Retry

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; delay?: number; backoff?: number } = {}
): Promise<T> {
  const { maxRetries = 3, delay = 1000, backoff = 2 } = options;
  let lastError: Error;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries) {
        const waitTime = delay * Math.pow(backoff, i);
        console.log(`Retry ${i + 1}/${maxRetries} after ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  throw lastError!;
}
```

## Testing and Debugging

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('MCP Server', () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createServer();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('should list available tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(3);
  });

  it('should calculate correctly', async () => {
    const result = await client.callTool({
      name: 'calculate',
      arguments: { expression: '2 + 3 * 4' },
    });
    expect(result.content[0].text).toContain('14');
  });

  it('should handle invalid expressions', async () => {
    const result = await client.callTool({
      name: 'calculate',
      arguments: { expression: 'invalid' },
    });
    expect(result.isError).toBe(true);
  });
});
```

## Summary

Core points for developing MCP Servers:

1. **Tool Definition**: Use Zod Schema to define clear tool parameters.
2. **Resource Provision**: Expose documents, configurations, and other resources to AI.
3. **Prompt Templates**: Predefine high-quality prompt templates.
4. **Security Controls**: Implement input validation, permission checks, and rate limiting.
5. **Error Handling**: Graceful error handling and retry mechanisms.

MCP is a critical step in standardizing the AI tool ecosystem. By developing MCP Servers, your tools can be called by any MCP-supporting AI application, dramatically expanding their usage scenarios.