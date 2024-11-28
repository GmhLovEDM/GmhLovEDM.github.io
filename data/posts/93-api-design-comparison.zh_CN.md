---
title: "后端 API 设计规范：RESTful、GraphQL 与 tRPC 对比"
tag: architecture
description: 全面对比 RESTful、GraphQL 和 tRPC 三种 API 设计范式，分析各自的优缺点和适用场景。
date: "2024-11-28T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者深入理解三种主流 API 设计范式的核心差异，根据项目需求选择最合适的方案，并掌握各自的最佳实践。

## 背景

API 设计是软件架构中的关键环节。选择合适的 API 范式直接影响开发效率、维护成本和用户体验。RESTful、GraphQL 和 tRPC 代表了三种不同的设计哲学。

### 三种范式的演进

1. **RESTful**（2000年代）：基于资源的 HTTP 接口
2. **GraphQL**（2015）：Facebook 推出的查询语言
3. **tRPC**（2021）：TypeScript 优先的 RPC 框架

## 一、RESTful API

### 核心原则

REST（Representational State Transfer）基于资源的概念，使用 HTTP 方法操作资源：

```typescript
// RESTful API 设计示例

// 获取用户列表
GET /api/users
GET /api/users?page=1&limit=10

// 获取单个用户
GET /api/users/:id

// 创建用户
POST /api/users
Body: { name: "John", email: "john@example.com" }

// 更新用户
PUT /api/users/:id
Body: { name: "John Updated" }

// 删除用户
DELETE /api/users/:id

// 获取用户的帖子
GET /api/users/:id/posts
```

### Express.js 实现

```typescript
import express from 'express';
import { z } from 'zod';

const app = express();
app.use(express.json());

// 数据模型
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

// 内存存储
const users: Map<string, User> = new Map();

// 验证 Schema
const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

// 路由
app.get('/api/users', (req, res) => {
  const { page = '1', limit = '10' } = req.query;
  const pageNum = parseInt(page as string);
  const limitNum = parseInt(limit as string);
  
  const usersArray = Array.from(users.values());
  const start = (pageNum - 1) * limitNum;
  const end = start + limitNum;
  
  res.json({
    data: usersArray.slice(start, end),
    total: usersArray.length,
    page: pageNum,
    limit: limitNum,
  });
});

app.get('/api/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

app.post('/api/users', (req, res) => {
  const result = CreateUserSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.issues });
  }
  
  const user: User = {
    id: Date.now().toString(),
    ...result.data,
    createdAt: new Date(),
  };
  
  users.set(user.id, user);
  res.status(201).json(user);
});

app.put('/api/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const updatedUser = { ...user, ...req.body };
  users.set(req.params.id, updatedUser);
  res.json(updatedUser);
});

app.delete('/api/users/:id', (req, res) => {
  if (!users.has(req.params.id)) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  users.delete(req.params.id);
  res.status(204).send();
});

app.listen(3000);
```

### RESTful 优缺点

**优点**：
- 简单直观，易于理解
- 缓存友好（HTTP 缓存）
- 广泛支持，工具生态成熟
- 适合简单的 CRUD 应用

**缺点**：
- Over-fetching：返回的数据可能包含不需要的字段
- Under-fetching：可能需要多次请求获取完整数据
- 版本管理复杂（v1、v2）
- 强类型支持有限

## 二、GraphQL API

### 核心概念

GraphQL 是一种查询语言，客户端可以精确指定需要的数据：

```graphql
# Schema 定义
type User {
  id: ID!
  name: String!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  content: String!
  author: User!
}

type Query {
  users(page: Int, limit: Int): UserConnection!
  user(id: ID!): User
  posts: [Post!]!
}

type Mutation {
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): Boolean!
}

type UserConnection {
  edges: [User!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type PageInfo {
  hasNextPage: Boolean!
  endCursor: String
}

input CreateUserInput {
  name: String!
  email: String!
}

input UpdateUserInput {
  name: String
  email: String
}
```

### Apollo Server 实现

```typescript
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';

// 类型定义
const typeDefs = `
  type User {
    id: ID!
    name: String!
    email: String!
    posts: [Post!]!
  }

  type Post {
    id: ID!
    title: String!
    content: String!
    author: User!
  }

  type Query {
    users: [User!]!
    user(id: ID!): User
    posts: [Post!]!
  }

  type Mutation {
    createUser(name: String!, email: String!): User!
    updateUser(id: ID!, name: String, email: String): User!
    deleteUser(id: ID!): Boolean!
  }
`;

// 模拟数据
const users = [
  { id: '1', name: 'John', email: 'john@example.com' },
  { id: '2', name: 'Jane', email: 'jane@example.com' },
];

const posts = [
  { id: '1', title: 'Post 1', content: 'Content 1', authorId: '1' },
  { id: '2', title: 'Post 2', content: 'Content 2', authorId: '2' },
];

// Resolver
const resolvers = {
  Query: {
    users: () => users,
    user: (_, { id }) => users.find(u => u.id === id),
    posts: () => posts,
  },
  User: {
    posts: (parent) => posts.filter(p => p.authorId === parent.id),
  },
  Post: {
    author: (parent) => users.find(u => u.id === parent.authorId),
  },
  Mutation: {
    createUser: (_, { name, email }) => {
      const newUser = {
        id: Date.now().toString(),
        name,
        email,
      };
      users.push(newUser);
      return newUser;
    },
    updateUser: (_, { id, name, email }) => {
      const user = users.find(u => u.id === id);
      if (!user) throw new Error('User not found');
      
      if (name) user.name = name;
      if (email) user.email = email;
      
      return user;
    },
    deleteUser: (_, { id }) => {
      const index = users.findIndex(u => u.id === id);
      if (index === -1) return false;
      
      users.splice(index, 1);
      return true;
    },
  },
};

const server = new ApolloServer({ typeDefs, resolvers });
const { url } = await startStandaloneServer(server, { listen: { port: 4000 } });
console.log(`Server ready at ${url}`);
```

### 客户端查询

```typescript
// 使用 Apollo Client
import { ApolloClient, InMemoryCache, gql } from '@apollo/client';

const client = new ApolloClient({
  uri: 'http://localhost:4000',
  cache: new InMemoryCache(),
});

// 查询用户及其帖子（精确获取需要的数据）
const GET_USER_WITH_POSTS = gql`
  query GetUserWithPosts($id: ID!) {
    user(id: $id) {
      id
      name
      email
      posts {
        id
        title
        content
      }
    }
  }
`;

// 使用
const { data } = await client.query({
  query: GET_USER_WITH_POSTS,
  variables: { id: '1' },
});
```

### GraphQL 优缺点

**优点**：
- 精确的数据获取，避免 Over/Under-fetching
- 强类型系统，自动生成文档
- 单一端点，简化 API 管理
- 适合复杂的数据关系

**缺点**：
- 学习曲线较陡
- 缓存复杂（需要专门的缓存策略）
- 文件上传支持有限
- 查询复杂度控制（防止恶意查询）

## 三、tRPC API

### 核心概念

tRPC 是一个 TypeScript 优先的 RPC 框架，提供端到端的类型安全：

```typescript
// 服务端
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();

const appRouter = t.router({
  // 获取用户
  getUser: t.procedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const user = await db.user.findUnique({
        where: { id: input.id },
      });
      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }
      return user;
    }),

  // 创建用户
  createUser: t.procedure
    .input(
      z.object({
        name: z.string().min(2),
        email: z.string().email(),
      })
    )
    .mutation(async ({ input }) => {
      const user = await db.user.create({
        data: input,
      });
      return user;
    }),

  // 获取用户列表
  listUsers: t.procedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(10),
      })
    )
    .query(async ({ input }) => {
      const { page, limit } = input;
      const skip = (page - 1) * limit;

      const [users, total] = await Promise.all([
        db.user.findMany({
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        db.user.count(),
      ]);

      return {
        users,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }),
});

// 导出路由类型
export type AppRouter = typeof appRouter;
```

### Next.js 集成

```typescript
// pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { appRouter } from '../../../server/router';

export default createNextApiHandler({
  router: appRouter,
});

// 客户端
// lib/trpc.ts
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../server/router';

export const trpc = createTRPCReact<AppRouter>();

// 使用
function UserProfile({ userId }: { userId: string }) {
  const { data: user, isLoading } = trpc.getUser.useQuery({
    id: userId,
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <h1>{user?.name}</h1>
      <p>{user?.email}</p>
    </div>
  );
}

function CreateUserForm() {
  const createUser = trpc.createUser.useMutation();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    
    await createUser.mutateAsync({
      name: formData.get('name') as string,
      email: formData.get('email') as string,
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" placeholder="Name" />
      <input name="email" placeholder="Email" type="email" />
      <button type="submit" disabled={createUser.isLoading}>
        {createUser.isLoading ? 'Creating...' : 'Create User'}
      </button>
    </form>
  );
}
```

### tRPC 优缺点

**优点**：
- 端到端类型安全（无需代码生成）
- 学习曲线平缓（类似函数调用）
- 与 TypeScript 深度集成
- 自动 API 文档
- 性能优秀

**缺点**：
- 需要 TypeScript
- 不适合跨语言 API
- 生态相对较新
- 不适合公共 API

## 四、对比分析

### 核心差异

| 维度 | RESTful | GraphQL | tRPC |
|------|---------|---------|------|
| 类型安全 | 手动/代码生成 | Schema 强制 | 编译时检查 |
| 数据获取 | 固定结构 | 灵活查询 | 灵活查询 |
| 端点 | 多个 | 单一 | 无端点概念 |
| 学习曲线 | 低 | 中 | 低 |
| 生态系统 | 完整 | 成长中 | 成长中 |

### 性能对比

```typescript
// RESTful - 可能 Over-fetching
GET /api/users/1
// 返回: { id, name, email, avatar, bio, createdAt, updatedAt, ... }

// GraphQL - 精确获取
query {
  user(id: "1") {
    name
    email
  }
}
// 只返回: { name, email }

// tRPC - 精确获取
trpc.getUser.query({ id: "1", select: ["name", "email"] })
// 只返回: { name, email }
```

### 适用场景

| 场景 | RESTful | GraphQL | tRPC |
|------|---------|---------|------|
| 简单 CRUD | 推荐 | 可以 | 推荐 |
| 复杂数据关系 | 可以 | 推荐 | 推荐 |
| 多客户端 | 可以 | 推荐 | 可以 |
| 公共 API | 推荐 | 可以 | 不推荐 |
| 微服务 | 推荐 | 推荐 | 可以 |
| 移动端 | 可以 | 推荐 | 可以 |

## 五、混合使用策略

### RESTful + GraphQL

```typescript
// 保持现有的 RESTful API
// 同时提供 GraphQL 端点
app.use('/graphql', graphqlHTTP({
  schema: schema,
  graphiql: true,
}));

// RESTful 用于简单操作
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// GraphQL 用于复杂查询
app.use('/graphql', graphqlHTTP({ schema }));
```

### tRPC + RESTful

```typescript
// tRPC 用于内部服务间通信（类型安全）
// RESTful 用于公开 API
app.use('/trpc', trpcExpressHandler({ router: appRouter }));
app.use('/api', restRouter);
```

## 六、选型决策树

```
需要 API？
    │
    ├─ 是公开 API 还是内部 API？
    │       │
    │       ├─ 公开 API
    │       │       │
    │       │       ├─ 需要跨语言支持？
    │       │       │       │
    │       │       │       ├─ 是 → RESTful
    │       │       │       └─ 否 → GraphQL
    │       │       │
    │       │       └─ 客户端类型？
    │       │               │
    │       │               ├─ Web → GraphQL 或 RESTful
    │       │               └─ 移动端 → GraphQL
    │       │
    │       └─ 内部 API
    │               │
    │               ├─ 使用 TypeScript？
    │               │       │
    │               │       ├─ 是 → tRPC
    │               │       └─ 否 → RESTful 或 GraphQL
    │               │
    │               └─ 数据关系复杂？
    │                       │
    │                       ├─ 是 → GraphQL
    │                       └─ 否 → tRPC 或 RESTful
```

## 七、最佳实践

### RESTful 最佳实践

```typescript
// 1. 使用名词复数
GET /users        // 好
GET /user         // 不好

// 2. 使用 HTTP 状态码
200 OK
201 Created
400 Bad Request
404 Not Found

// 3. 支持分页
GET /users?page=1&limit=10

// 4. 使用过滤器
GET /users?status=active&role=admin

// 5. 版本管理
GET /v1/users
```

### GraphQL 最佳实践

```typescript
// 1. 使用 DataLoader 解决 N+1 问题
const userLoader = new DataLoader(async (ids) => {
  const users = await db.user.findMany({
    where: { id: { in: ids } },
  });
  return ids.map(id => users.find(u => u.id === id));
});

// 2. 限制查询深度
const depthLimit = require('graphql-depth-limit');
const depthLimitRule = depthLimit(10);

// 3. 使用 Persisted Queries
// 4. 实现查询复杂度分析
```

### tRPC 最佳实践

```typescript
// 1. 使用 Context 共享数据
const createContext = ({ req }: CreateContextParams) => ({
  db,
  session: getSession(req),
});

// 2. 使用 Middleware
const publicProcedure = t.procedure.use(async ({ ctx, next }) => {
  // 不需要认证的中间件
  return next({ ctx });
});

const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// 3. 组织路由
const userRouter = t.router({
  getUser: publicProcedure.query(...),
  updateUser: protectedProcedure.mutation(...),
});

const appRouter = t.router({
  user: userRouter,
  post: postRouter,
});
```

## 总结

| 范式 | 最佳场景 | 核心优势 |
|------|----------|----------|
| RESTful | 公共 API、简单 CRUD | 简单、广泛支持 |
| GraphQL | 复杂数据查询、多客户端 | 灵活、类型安全 |
| tRPC | TypeScript 内部服务 | 端到端类型安全 |

**姐姐的建议**：

1. **没有银弹**：根据项目需求选择
2. **RESTful 是安全选择**：当不确定时，REST 是稳妥的
3. **GraphQL 适合复杂场景**：数据关系复杂时考虑
4. **tRPC 适合 TypeScript 项目**：类型安全是巨大优势
5. **可以混合使用**：不同场景使用不同方案

选择 API 范式是一个重要的架构决策，希望这篇对比能帮助宝宝们做出正确的选择。
