---
title: "Serverless 实战：用云函数打造轻量后端"
tag: cloud
description: 从 Serverless 核心概念到云函数实战，讲解如何使用 AWS Lambda、Vercel Edge Functions 等构建轻量、弹性的后端服务。
date: "2024-04-18T08:00:00.000Z"
---

## 目标

Serverless（无服务器架构）让开发者无需管理服务器基础设施，专注于业务逻辑。云函数（Cloud Functions）是 Serverless 的核心实现，按需执行、按使用付费。本文讲解 Serverless 的核心概念和主流平台的实战应用。

## 背景

### 传统架构 vs Serverless

```
传统架构：
  开发者 → 服务器 → 运维 → 扩缩容 → 成本

Serverless 架构：
  开发者 → 云函数 → 自动扩缩容 → 按需付费
```

### Serverless 的核心优势

- **零运维**：无需管理服务器、操作系统
- **自动扩缩容**：从 0 到无限自动扩展
- **按需付费**：只为实际执行时间付费
- **快速部署**：秒级部署，快速迭代
- **高可用**：云厂商保证可用性

### 主流平台对比

| 平台 | 厂商 | 语言支持 | 冷启动 | 免费额度 |
|------|------|----------|--------|----------|
| AWS Lambda | Amazon | Node.js, Python, Go, Java | 100-500ms | 100 万次/月 |
| Cloud Functions | Google | Node.js, Python, Go | 100-300ms | 200 万次/月 |
| Azure Functions | Microsoft | Node.js, Python, C# | 100-500ms | 100 万次/月 |
| Vercel Edge Functions | Vercel | JavaScript, TypeScript | < 10ms | 100GB-Hrs/月 |
| Cloudflare Workers | Cloudflare | JavaScript, TypeScript | < 5ms | 10 万次/天 |

## AWS Lambda 实战

### 基本用法

```javascript
// handler.js
exports.handler = async (event) => {
  const response = {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      message: 'Hello from Lambda!',
      input: event,
    }),
  };
  return response;
};
```

### API Gateway + Lambda

```javascript
// 处理 HTTP 请求
exports.handler = async (event) => {
  const { httpMethod, path, body, queryStringParameters } = event;

  // 路由处理
  if (httpMethod === 'GET' && path === '/users') {
    const users = await getUsers();
    return {
      statusCode: 200,
      body: JSON.stringify(users),
    };
  }

  if (httpMethod === 'POST' && path === '/users') {
    const data = JSON.parse(body);
    const user = await createUser(data);
    return {
      statusCode: 201,
      body: JSON.stringify(user),
    };
  }

  return {
    statusCode: 404,
    body: JSON.stringify({ error: 'Not found' }),
  };
};

// 数据库操作
const { DynamoDB } = require('aws-sdk');
const dynamoDb = new DynamoDB.DocumentClient();

async function getUsers() {
  const result = await dynamoDb.scan({
    TableName: 'Users',
  }).promise();
  return result.Items;
}

async function createUser(data) {
  const params = {
    TableName: 'Users',
    Item: {
      id: Date.now().toString(),
      ...data,
      createdAt: new Date().toISOString(),
    },
  };
  await dynamoDb.put(params).promise();
  return params.Item;
}
```

### Serverless Framework 配置

```yaml
# serverless.yml
service: my-api

provider:
  name: aws
  runtime: nodejs18.x
  region: ap-northeast-1
  environment:
    TABLE_NAME: ${self:service}-users

functions:
  users:
    handler: handler.handler
    events:
      - httpApi:
          path: /users
          method: get
      - httpApi:
          path: /users
          method: post
    iamRoleStatements:
      - Effect: Allow
        Action:
          - dynamodb:Scan
          - dynamodb:PutItem
        Resource: arn:aws:dynamodb:${self:provider.region}:*:table/${self:provider.environment.TABLE_NAME}

resources:
  Resources:
    UsersTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: ${self:provider.environment.TABLE_NAME}
        AttributeDefinitions:
          - AttributeName: id
            AttributeType: S
        KeySchema:
          - AttributeName: id
            KeyType: HASH
        BillingMode: PAY_PER_REQUEST
```

## Vercel Edge Functions

### 基本用法

```typescript
// api/hello.ts (Pages Router)
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const { name = 'World' } = req.query;
  res.status(200).json({ message: `Hello ${name}!` });
}
```

### App Router 中使用

```typescript
// app/api/users/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  const users = await fetchUsers();
  return NextResponse.json(users);
}

export async function POST(request: Request) {
  const data = await request.json();
  const user = await createUser(data);
  return NextResponse.json(user, { status: 201 });
}
```

### Edge Runtime

```typescript
// app/api/edge/route.ts
export const runtime = 'edge';

export async function GET(request: Request) {
  // Edge Runtime 支持的 API
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || 'World';

  return new Response(`Hello ${name}!`, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 's-maxage=86400',
    },
  });
}
```

### Edge Middleware

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // 地理位置检测
  const country = request.geo?.country || 'US';

  // 重定向
  if (request.nextUrl.pathname === '/admin') {
    const token = request.cookies.get('token');
    if (!token) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  // A/B 测试
  const bucket = request.cookies.get('ab-test')?.value || 
    Math.random() > 0.5 ? 'a' : 'b';

  const response = NextResponse.next();
  response.cookies.set('ab-test', bucket);

  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/api/:path*'],
};
```

## Cloudflare Workers

### 基本用法

```javascript
// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 路由处理
    if (url.pathname === '/api/hello') {
      return new Response(
        JSON.stringify({ message: 'Hello from Workers!' }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // KV 存储
    if (url.pathname === '/api/counter') {
      const count = parseInt(await env.COUNTER_KV.get('count') || '0');
      await env.COUNTER_KV.put('count', (count + 1).toString());
      return new Response(JSON.stringify({ count: count + 1 }));
    }

    return new Response('Not found', { status: 404 });
  },
};
```

### Wrangler 配置

```toml
# wrangler.toml
name = "my-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
API_KEY = "my-api-key"

[[kv_namespaces]]
binding = "COUNTER_KV"
id = "your-kv-namespace-id"

[[durable_objects]]
class_name = "ChatRoom"
```

## 实战场景

### 1. 图片处理

```javascript
// 图片缩放和格式转换
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const imageUrl = url.searchParams.get('url');
    const width = parseInt(url.searchParams.get('width') || '300');
    const format = url.searchParams.get('format') || 'webp';

    // 使用 Cloudflare Image Resizing
    const response = await fetch(imageUrl, {
      cf: {
        image: {
          width,
          format,
          quality: 80,
        },
      },
    });

    return new Response(response.body, {
      headers: {
        'Content-Type': `image/${format}`,
        'Cache-Control': 's-maxage=86400',
      },
    });
  },
};
```

### 2. API 代理

```typescript
// Vercel 中的 API 代理
// app/api/proxy/[...path]/route.ts
export async function GET(
  request: Request,
  { params }: { params: { path: string[] } }
) {
  const targetUrl = `https://api.external.com/${params.path.join('/')}`;
  const response = await fetch(targetUrl, {
    headers: {
      'Authorization': `Bearer ${process.env.EXTERNAL_API_KEY}`,
    },
  });

  const data = await response.json();
  return NextResponse.json(data);
}
```

### 3. Webhook 处理

```javascript
// 处理 Stripe Webhook
// api/webhook/stripe.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      await handlePaymentSuccess(paymentIntent);
      break;
    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      await handlePaymentFailure(failedPayment);
      break;
  }

  res.status(200).json({ received: true });
}

async function handlePaymentSuccess(paymentIntent) {
  // 更新订单状态
  await db.orders.update({
    where: { stripeId: paymentIntent.id },
    data: { status: 'paid' },
  });
}
```

## 性能优化

### 1. 冷启动优化

```javascript
// 在全局作用域初始化
const dynamoDb = new DynamoDB.DocumentClient();

exports.handler = async (event) => {
  // 复用已初始化的客户端
  const result = await dynamoDb.scan({ TableName: 'Users' }).promise();
  return {
    statusCode: 200,
    body: JSON.stringify(result.Items),
  };
};
```

### 2. 连接池管理

```javascript
// 数据库连接池
let pool;

async function getPool() {
  if (!pool) {
    pool = await mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionLimit: 1, // Lambda 中限制为 1
    });
  }
  return pool;
}
```

### 3. 缓存策略

```javascript
// 使用 Redis 缓存
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
  const cacheKey = 'users';
  
  // 尝试从缓存获取
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.status(200).json(JSON.parse(cached));
  }

  // 缓存未命中，查询数据库
  const users = await getUsers();
  
  // 写入缓存
  await redis.setex(cacheKey, 3600, JSON.stringify(users));

  return res.status(200).json(users);
}
```

## 成本分析

### AWS Lambda 定价示例

```
每月 100 万次调用，平均执行时间 100ms：

请求费用：
  1,000,000 次 × $0.20/百万次 = $0.20

计算费用：
  1,000,000 次 × 100ms × $0.0000166667/GB-s
  = 1,000,000 × 0.1s × $0.0000166667
  = $1.67

总费用：$0.20 + $1.67 = $1.87/月

对比传统服务器：
  最小 EC2 实例: ~$10/月
  数据库: ~$15/月
  总计: ~$25/月
```

## 总结

Serverless 是构建轻量后端的理想选择。关键要点：

1. **平台选择**：根据语言、性能需求、成本选择合适的平台
2. **冷启动优化**：全局初始化、减小包体积、选择合适的运行时
3. **成本控制**：合理设置内存、优化执行时间、利用免费额度
4. **监控调试**：利用平台提供的日志和监控工具

Serverless 不是银弹，对于长连接、高并发、需要持久运行的场景，传统服务器可能更合适。但对于 API 服务、Webhook 处理、定时任务等场景，Serverless 是更好的选择。
