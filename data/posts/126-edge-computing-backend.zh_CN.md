---
title: "Edge Computing + 后端：边缘函数与全球部署"
tag: cloud
description: 深入探讨边缘计算在后端架构中的应用，涵盖边缘函数、全球部署策略与性能优化
date: "2026-04-20T10:00:00.000Z"
---

## 目标

边缘计算正在从概念走向实用。通过将计算任务推向离用户更近的边缘节点，可以显著降低延迟、提升用户体验。本文将探讨边缘计算在后端架构中的应用，以及如何构建全球部署的边缘应用。

## 背景

### 传统架构 vs 边缘架构

```
传统架构：
用户 → CDN → 源站服务器 → 数据库 → 响应

边缘架构：
用户 → 边缘节点（计算 + 缓存）→ 数据库 → 响应
```

### 边缘计算的优势

| 维度 | 传统架构 | 边缘架构 |
|------|---------|---------|
| 延迟 | 100-500ms | 10-50ms |
| 可用性 | 依赖源站 | 分布式高可用 |
| 成本 | 源站成本高 | 按需计费 |
| 扩展性 | 垂直扩展 | 水平扩展 |

### 主流边缘平台

| 平台 | 特点 | 适用场景 |
|------|------|---------|
| Cloudflare Workers | 性价比高，生态丰富 | API、全栈应用 |
| Vercel Edge Functions | Next.js 深度集成 | 前端应用 |
| Deno Deploy | TypeScript 原生支持 | 现代 Web 应用 |
| AWS Lambda@Edge | AWS 生态集成 | 企业级应用 |

## 边缘函数实现

### Cloudflare Workers

```typescript
// worker.ts
interface Env {
  DB: D1Database;
  KV: KVNamespace;
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/api/users') {
      return handleUsers(request, env);
    }
    
    if (url.pathname === '/api/products') {
      return handleProducts(request, env);
    }
    
    return new Response('Not Found', { status: 404 });
  },
};

async function handleUsers(request: Request, env: Env): Promise<Response> {
  const cacheKey = new Request(request.url, request);
  const cache = caches.default;
  
  let response = await cache.match(cacheKey);
  if (response) {
    return response;
  }
  
  const users = await env.DB.prepare(
    'SELECT * FROM users LIMIT 10'
  ).all();
  
  response = new Response(JSON.stringify(users.results), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
  
  await cache.put(cacheKey, response.clone());
  
  return response;
}

async function handleProducts(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  
  if (query) {
    const embedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: query,
    });
    
    const results = await env.DB.prepare(
      `SELECT * FROM products 
       ORDER BY vector_distance(embedding, ?) 
       LIMIT 5`
    ).bind(JSON.stringify(embedding.data)).all();
    
    return new Response(JSON.stringify(results.results));
  }
  
  const products = await env.DB.prepare(
    'SELECT * FROM products LIMIT 20'
  ).all();
  
  return new Response(JSON.stringify(products.results));
}
```

### Deno Deploy

```typescript
// main.ts
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const DB_URL = Deno.env.get("DATABASE_URL")!;

serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  
  if (url.pathname.startsWith("/api/image")) {
    return handleImage(req);
  }
  
  if (url.pathname.startsWith("/api/proxy")) {
    return handleProxy(req);
  }
  
  return new Response("Not Found", { status: 404 });
});

async function handleImage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const imageUrl = url.searchParams.get("url");
  const width = parseInt(url.searchParams.get("w") || "800");
  const quality = parseInt(url.searchParams.get("q") || "80");
  
  if (!imageUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }
  
  const response = await fetch(imageUrl);
  const imageBlob = await response.blob();
  
  const processedImage = await processImage(imageBlob, width, quality);
  
  return new Response(processedImage, {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000",
    },
  });
}

async function handleProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("target");
  
  if (!targetUrl) {
    return new Response("Missing target parameter", { status: 400 });
  }
  
  const proxyReq = new Request(targetUrl, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  
  return fetch(proxyReq);
}
```

## 全球部署策略

### 数据库设计

```sql
-- 全球分布式数据库设计
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    region TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_region ON users(region);

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price DECIMAL(10, 2),
    stock INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cache_metadata (
    key TEXT PRIMARY KEY,
    region TEXT NOT NULL,
    value_hash TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 缓存策略

```typescript
class EdgeCache {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.kv.get(key, 'json');
    return value as T | null;
  }

  async set<T>(key: string, value: T, ttl: number = 3600): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: ttl,
    });
  }

  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = 3600
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached) return cached;

    const value = await fetcher();
    await this.set(key, value, ttl);
    return value;
  }

  async multiLevelGet<T>(
    key: string,
    levels: Array<{ get: (k: string) => Promise<T | null>; set: (k: string, v: T) => Promise<void> }>
  ): Promise<T | null> {
    for (let i = 0; i < levels.length; i++) {
      const value = await levels[i].get(key);
      if (value) {
        for (let j = 0; j < i; j++) {
          await levels[j].set(key, value);
        }
        return value;
      }
    }
    return null;
  }
}
```

### 数据同步

```typescript
class EdgeSync {
  private regions: string[];
  private primaryRegion: string;

  constructor(regions: string[], primaryRegion: string) {
    this.regions = regions;
    this.primaryRegion = primaryRegion;
  }

  async write(key: string, value: any): Promise<void> {
    await this.writeToRegion(this.primaryRegion, key, value);
    
    const syncPromises = this.regions
      .filter(r => r !== this.primaryRegion)
      .map(region => this.syncToRegion(region, key, value));
    
    Promise.allSettled(syncPromises).then(results => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error(`Sync to region ${index} failed:`, result.reason);
        }
      });
    });
  }

  async read(key: string, region: string): Promise<any> {
    const value = await this.readFromRegion(region, key);
    this.checkConsistency(key, region, value);
    return value;
  }

  private async writeToRegion(region: string, key: string, value: any): Promise<void> {
    await fetch(`https://${region}.api.example.com/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
  }

  private async readFromRegion(region: string, key: string): Promise<any> {
    const response = await fetch(`https://${region}.api.example.com/data?key=${key}`);
    return response.json();
  }

  private async syncToRegion(region: string, key: string, value: any): Promise<void> {
    await this.writeToRegion(region, key, value);
  }

  private async checkConsistency(key: string, region: string, localValue: any): Promise<void> {
    const primaryValue = await this.readFromRegion(this.primaryRegion, key);
    if (JSON.stringify(localValue) !== JSON.stringify(primaryValue)) {
      await this.syncToRegion(region, key, primaryValue);
    }
  }
}
```

## 高级场景

### 边缘 AI 推理

```typescript
async function handleAIRequest(request: Request, env: Env): Promise<Response> {
  const { text } = await request.json();
  
  const result = await env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
    messages: [
      { role: 'system', content: '你是一个助手' },
      { role: 'user', content: text },
    ],
    max_tokens: 512,
  });
  
  return new Response(JSON.stringify(result));
}

async function getEmbedding(text: string, env: Env): Promise<number[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: text,
  });
  
  return result.data[0];
}

async function classifyImage(image: ArrayBuffer, env: Env): Promise<any> {
  const result = await env.AI.run('@cf/microsoft/resnet-50', {
    image: [...new Uint8Array(image)],
  });
  
  return result;
}
```

### 实时协作

```typescript
class EdgeWebSocket {
  private state: DurableObjectState;
  private sessions: Map<string, WebSocket> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }
    
    return new Response('Expected WebSocket', { status: 426 });
  }

  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    
    this.handleSession(server);
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleSession(ws: WebSocket): void {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, ws);
    
    ws.accept();
    
    ws.addEventListener('message', (event) => {
      this.handleMessage(sessionId, event.data as string);
    });
    
    ws.addEventListener('close', () => {
      this.sessions.delete(sessionId);
      this.broadcast(JSON.stringify({
        type: 'user_left',
        userId: sessionId,
      }));
    });
    
    ws.send(JSON.stringify({
      type: 'welcome',
      sessionId,
      users: Array.from(this.sessions.keys()),
    }));
  }

  private handleMessage(senderId: string, message: string): void {
    const data = JSON.parse(message);
    
    this.sessions.forEach((ws, sessionId) => {
      if (sessionId !== senderId) {
        ws.send(JSON.stringify({
          ...data,
          userId: senderId,
        }));
      }
    });
  }

  private broadcast(message: string): void {
    this.sessions.forEach((ws) => {
      ws.send(message);
    });
  }
}
```

## 总结

边缘计算在后端架构中的核心价值：

1. **低延迟**：计算任务在用户附近执行
2. **高可用**：分布式架构，无单点故障
3. **成本优化**：按需计费，无需维护服务器
4. **全球覆盖**：轻松实现全球部署
5. **AI 就绪**：边缘 AI 推理成为可能

边缘计算的最佳实践：
- 选择合适的边缘平台
- 设计好数据同步策略
- 实现多级缓存
- 考虑冷启动优化
- 监控和告警

边缘计算正在重新定义后端架构。作为后端工程师，理解边缘计算的原理和实践，将帮助你构建更快、更可靠、更具扩展性的应用。