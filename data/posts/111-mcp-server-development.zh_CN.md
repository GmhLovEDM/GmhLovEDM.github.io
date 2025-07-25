---
title: "MCP Server 开发实战：为你的工具接入 AI 能力"
tag: ai
description: 从零开发 MCP Server，让你的工具和 API 能够被 AI Agent 调用，实现真正的 AI 工具集成
date: "2025-07-25T10:00:00.000Z"
---

## 目标

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，旨在标准化 AI 模型与外部工具之间的交互方式。本文将带你从零开发一个 MCP Server，让你的工具和 API 能够被 AI Agent 调用——这是构建 AI 工具生态的关键一步。

## 背景

### 为什么需要 MCP

在 MCP 出现之前，每个 AI 应用都需要自己实现工具调用的逻辑：

- ChatGPT 有自己的 Function Calling 格式
- Claude 有自己的 Tool Use 格式
- 不同的 AI 框架有不同的工具定义方式

这意味着同一个工具需要为不同的 AI 平台重复适配。MCP 的目标是建立一个统一的协议：

```
AI 模型 ←→ MCP 协议 ←→ MCP Server ←→ 工具/API
```

### MCP 的核心概念

| 概念 | 说明 |
|------|------|
| **Tools** | AI 可以调用的函数/操作 |
| **Resources** | AI 可以读取的数据/上下文 |
| **Prompts** | 预定义的提示词模板 |
| **Sampling** | AI 请求人类输入的机制 |

## MCP Server 开发

### 项目结构

```
my-mcp-server/
├── src/
│   ├── index.ts          # 入口文件
│   ├── tools/            # 工具定义
│   │   ├── calculator.ts
│   │   ├── weather.ts
│   │   └── database.ts
│   ├── resources/        # 资源定义
│   │   ├── config.ts
│   │   └── docs.ts
│   └── prompts/          # 提示词模板
│       └── templates.ts
├── package.json
└── tsconfig.json
```

### 基础 MCP Server

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
  '执行数学计算',
  {
    expression: z.string().describe('数学表达式，如 "2 + 3 * 4"'),
  },
  async ({ expression }) => {
    try {
      const result = evaluateExpression(expression);
      return {
        content: [
          {
            type: 'text',
            text: `计算结果: ${expression} = ${result}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `计算错误: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  'get_weather',
  '获取指定城市的天气信息',
  {
    city: z.string().describe('城市名称，如 "北京"、"上海"'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius').describe('温度单位'),
  },
  async ({ city, unit }) => {
    const weather = await fetchWeather(city, unit);
    return {
      content: [
        {
          type: 'text',
          text: `城市: ${weather.city}
天气: ${weather.condition}
温度: ${weather.temperature}${unit === 'celsius' ? '°C' : '°F'}
湿度: ${weather.humidity}
风速: ${weather.windSpeed}`,
        },
      ],
    };
  }
);

server.resource(
  'config',
  'config://app',
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          appName: 'My MCP Server',
          version: '1.0.0',
          environment: process.env.NODE_ENV || 'development',
        }),
      },
    ],
  })
);

server.prompt(
  'review_code',
  '代码审查提示词',
  {
    code: z.string().describe('要审查的代码'),
    language: z.string().describe('编程语言'),
  },
  ({ code, language }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `请审查以下 ${language} 代码：

\`\`\`${language}
${code}
\`\`\`

请从以下维度进行审查：
1. 代码质量和可读性
2. 性能问题
3. 安全漏洞
4. 最佳实践
5. 改进建议`,
        },
      },
    ],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server running on stdio');
}

main().catch(console.error);
```

### 复杂工具实现

```typescript
// src/tools/database.ts
import { z } from 'zod';
import { pool } from '../db.js';

export function registerDatabaseTools(server: McpServer) {
  server.tool(
    'query_database',
    '执行 SQL 查询（只读）',
    {
      sql: z.string().describe('SQL SELECT 查询语句'),
      params: z.array(z.string()).optional().describe('查询参数'),
    },
    async ({ sql, params }) => {
      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        return {
          content: [{ type: 'text', text: '安全限制：只允许 SELECT 查询' }],
          isError: true,
        };
      }

      try {
        const result = await pool.query(sql, params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                rows: result.rows,
                rowCount: result.rowCount,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `查询错误: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_table_schema',
    '获取数据库表结构信息',
    {
      tableName: z.string().describe('表名'),
    },
    async ({ tableName }) => {
      const schema = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position
      `, [tableName]);

      return {
        content: [
          {
            type: 'text',
            text: `表 ${tableName} 的结构：

${schema.rows.map(row => 
  `- ${row.column_name}: ${row.data_type} ${row.is_nullable === 'YES' ? '(可空)' : '(非空)'} ${row.column_default ? `默认值: ${row.column_default}` : ''}`
).join('\n')}`,
          },
        ],
      };
    }
  );
}
```

### 资源和提示词

```typescript
// src/resources/docs.ts
export function registerDocResources(server: McpServer) {
  server.resource(
    'api-docs',
    'docs://api',
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: `# API 文档

## 用户管理

### GET /api/users
获取用户列表

### POST /api/users
创建新用户

## 订单管理

### GET /api/orders
获取订单列表

### POST /api/orders
创建新订单
`,
        },
      ],
    })
  );
}

// src/prompts/templates.ts
export function registerPromptTemplates(server: McpServer) {
  server.prompt(
    'analyze_data',
    '数据分析和可视化建议',
    {
      dataDescription: z.string().describe('数据描述'),
      question: z.string().describe('分析问题'),
    },
    ({ dataDescription, question }) => ({
      messages: [
        {
          role: 'system',
          content: {
            type: 'text',
            text: `你是一位数据分析师。请根据提供的数据描述回答问题，并建议合适的可视化方式。

数据描述：${dataDescription}

回答问题时请包含：
1. 分析结论
2. 支持结论的数据依据
3. 推荐的可视化图表类型
4. 可能的洞察和建议`,
          },
        },
        {
          role: 'user',
          content: {
            type: 'text',
            text: question,
          },
        },
      ],
    })
  );
}
```

## 高级功能

### 上下文管理

```typescript
// src/context.ts
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
        userId,
        sessionId,
        history: [],
        userPreferences: {},
      });
    }
    return this.contexts.get(sessionId)!;
  }

  addToHistory(sessionId: string, role: string, content: string) {
    const ctx = this.contexts.get(sessionId);
    if (ctx) {
      ctx.history.push({ role, content });
      if (ctx.history.length > 50) {
        ctx.history = ctx.history.slice(-50);
      }
    }
  }
}
```

### 错误处理和重试

```typescript
// src/utils/retry.ts
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    delay?: number;
    backoff?: number;
  } = {}
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

## 测试和调试

```typescript
// tests/server.test.ts
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

## 总结

开发 MCP Server 的核心要点：

1. **工具定义**：使用 Zod Schema 定义清晰的工具参数
2. **资源提供**：将文档、配置等作为资源暴露给 AI
3. **提示词模板**：预定义高质量的提示词模板
4. **安全控制**：实现输入验证、权限检查、速率限制
5. **错误处理**：优雅的错误处理和重试机制

MCP 是 AI 工具生态标准化的重要一步。通过开发 MCP Server，你的工具可以被任何支持 MCP 的 AI 应用调用，大大扩展了工具的使用场景。