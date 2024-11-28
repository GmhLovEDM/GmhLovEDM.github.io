---
title: "Backend API Design Standards: RESTful, GraphQL, and tRPC Comparison"
tag: architecture
description: A comprehensive comparison of RESTful, GraphQL, and tRPC API design paradigms, analyzing the pros, cons, and use cases of each approach.
date: "2024-11-28T08:00:00.000Z"
---

## Goal

This article aims to help developers deeply understand the core differences between three mainstream API design paradigms, choose the most suitable solution based on project needs, and master best practices for each.

## Background

API design is a critical part of software architecture. Choosing the right API paradigm directly impacts development efficiency, maintenance costs, and user experience. RESTful, GraphQL, and tRPC represent three different design philosophies.

### Evolution of Three Paradigms

1. **RESTful** (2000s): Resource-based HTTP interfaces
2. **GraphQL** (2015): Query language introduced by Facebook
3. **tRPC** (2021): TypeScript-first RPC framework

## 1. RESTful API

### Core Principles

REST (Representational State Transfer) is based on the concept of resources, using HTTP methods to operate resources:

```typescript
// RESTful API design examples

// Get user list
GET /api/users
GET /api/users?page=1&limit=10

// Get single user
GET /api/users/:id

// Create user
POST /api/users
Body: { name: "John", email: "john@example.com" }

// Update user
PUT /api/users/:id
Body: { name: "John Updated" }

// Delete user
DELETE /api/users/:id

// Get user's posts
GET /api/users/:id/posts
```

### Express.js Implementation

```typescript
import express from 'express';
import { z } from 'zod';

const app = express();
app.use(express.json());

// Data model
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

// In-memory storage
const users: Map<string, User> = new Map();

// Validation Schema
const CreateUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

// Routes
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

### RESTful Pros and Cons

**Pros**:
- Simple and intuitive, easy to understand
- Cache-friendly (HTTP caching)
- Widely supported, mature tool ecosystem
- Suitable for simple CRUD applications

**Cons**:
- Over-fetching: Returned data may contain unnecessary fields
- Under-fetching: May need multiple requests to get complete data
- Complex version management (v1, v2)
- Limited strong typing support

## 2. GraphQL API

### Core Concepts

GraphQL is a query language where clients can specify exactly the data they need:

```graphql
# Schema definition
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

### Apollo Server Implementation

```typescript
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';

// Type definitions
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

// Mock data
const users = [
  { id: '1', name: 'John', email: 'john@example.com' },
  { id: '2', name: 'Jane', email: 'jane@example.com' },
];

const posts = [
  { id: '1', title: 'Post 1', content: 'Content 1', authorId: '1' },
  { id: '2', title: 'Post 2', content: 'Content 2', authorId: '2' },
];

// Resolvers
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

### Client Query

```typescript
// Using Apollo Client
import { ApolloClient, InMemoryCache, gql } from '@apollo/client';

const client = new ApolloClient({
  uri: 'http://localhost:4000',
  cache: new InMemoryCache(),
});

// Query user with posts (fetch exactly the data needed)
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

// Usage
const { data } = await client.query({
  query: GET_USER_WITH_POSTS,
  variables: { id: '1' },
});
```

### GraphQL Pros and Cons

**Pros**:
- Precise data fetching, avoiding over/under-fetching
- Strong type system, automatic documentation generation
- Single endpoint, simplified API management
- Suitable for complex data relationships

**Cons**:
- Steep learning curve
- Complex caching (requires specialized caching strategies)
- Limited file upload support
- Query complexity control (preventing malicious queries)

## 3. tRPC API

### Core Concepts

tRPC is a TypeScript-first RPC framework providing end-to-end type safety:

```typescript
// Server
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();

const appRouter = t.router({
  // Get user
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

  // Create user
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

  // Get user list
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

// Export route type
export type AppRouter = typeof appRouter;
```

### Next.js Integration

```typescript
// pages/api/trpc/[trpc].ts
import { createNextApiHandler } from '@trpc/server/adapters/next';
import { appRouter } from '../../../server/router';

export default createNextApiHandler({
  router: appRouter,
});

// Client
// lib/trpc.ts
import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../server/router';

export const trpc = createTRPCReact<AppRouter>();

// Usage
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

### tRPC Pros and Cons

**Pros**:
- End-to-end type safety (no code generation needed)
- Gentle learning curve (similar to function calls)
- Deep TypeScript integration
- Automatic API documentation
- Excellent performance

**Cons**:
- Requires TypeScript
- Not suitable for cross-language APIs
- Relatively new ecosystem
- Not suitable for public APIs

## 4. Comparative Analysis

### Core Differences

| Dimension | RESTful | GraphQL | tRPC |
|-----------|---------|---------|------|
| Type Safety | Manual/Code generation | Schema enforced | Compile-time checks |
| Data Fetching | Fixed structure | Flexible queries | Flexible queries |
| Endpoints | Multiple | Single | No endpoint concept |
| Learning Curve | Low | Medium | Low |
| Ecosystem | Complete | Growing | Growing |

### Performance Comparison

```typescript
// RESTful - May over-fetch
GET /api/users/1
// Returns: { id, name, email, avatar, bio, createdAt, updatedAt, ... }

// GraphQL - Precise fetching
query {
  user(id: "1") {
    name
    email
  }
}
// Returns only: { name, email }

// tRPC - Precise fetching
trpc.getUser.query({ id: "1", select: ["name", "email"] })
// Returns only: { name, email }
```

### Use Cases

| Scenario | RESTful | GraphQL | tRPC |
|----------|---------|---------|------|
| Simple CRUD | Recommended | Possible | Recommended |
| Complex Data Relationships | Possible | Recommended | Recommended |
| Multiple Clients | Possible | Recommended | Possible |
| Public APIs | Recommended | Possible | Not Recommended |
| Microservices | Recommended | Recommended | Possible |
| Mobile Apps | Possible | Recommended | Possible |

## 5. Hybrid Strategies

### RESTful + GraphQL

```typescript
// Keep existing RESTful API
// Also provide GraphQL endpoint
app.use('/graphql', graphqlHTTP({
  schema: schema,
  graphiql: true,
}));

// RESTful for simple operations
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// GraphQL for complex queries
app.use('/graphql', graphqlHTTP({ schema }));
```

### tRPC + RESTful

```typescript
// tRPC for internal service communication (type-safe)
// RESTful for public APIs
app.use('/trpc', trpcExpressHandler({ router: appRouter }));
app.use('/api', restRouter);
```

## 6. Selection Decision Tree

```
Need API?
    |
    +-- Public API or Internal API?
    |       |
    |       +-- Public API
    |       |       |
    |       |       +-- Need cross-language support?
    |       |       |       |
    |       |       |       +-- Yes -> RESTful
    |       |       |       +-- No -> GraphQL
    |       |       |
    |       |       +-- Client types?
    |       |               |
    |       |               +-- Web -> GraphQL or RESTful
    |       |               +-- Mobile -> GraphQL
    |       |
    |       +-- Internal API
    |               |
    |               +-- Using TypeScript?
    |               |       |
    |               |       +-- Yes -> tRPC
    |               |       +-- No -> RESTful or GraphQL
    |               |
    |               +-- Complex data relationships?
    |                       |
    |                       +-- Yes -> GraphQL
    |                       +-- No -> tRPC or RESTful
```

## 7. Best Practices

### RESTful Best Practices

```typescript
// 1. Use plural nouns
GET /users        // Good
GET /user         // Bad

// 2. Use HTTP status codes
200 OK
201 Created
400 Bad Request
404 Not Found

// 3. Support pagination
GET /users?page=1&limit=10

// 4. Use filters
GET /users?status=active&role=admin

// 5. Version management
GET /v1/users
```

### GraphQL Best Practices

```typescript
// 1. Use DataLoader to solve N+1 problem
const userLoader = new DataLoader(async (ids) => {
  const users = await db.user.findMany({
    where: { id: { in: ids } },
  });
  return ids.map(id => users.find(u => u.id === id));
});

// 2. Limit query depth
const depthLimit = require('graphql-depth-limit');
const depthLimitRule = depthLimit(10);

// 3. Use Persisted Queries
// 4. Implement query complexity analysis
```

### tRPC Best Practices

```typescript
// 1. Use Context to share data
const createContext = ({ req }: CreateContextParams) => ({
  db,
  session: getSession(req),
});

// 2. Use Middleware
const publicProcedure = t.procedure.use(async ({ ctx, next }) => {
  // Middleware that doesn't require authentication
  return next({ ctx });
});

const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});

// 3. Organize routes
const userRouter = t.router({
  getUser: publicProcedure.query(...),
  updateUser: protectedProcedure.mutation(...),
});

const appRouter = t.router({
  user: userRouter,
  post: postRouter,
});
```

## Summary

| Paradigm | Best Scenario | Core Advantage |
|----------|---------------|----------------|
| RESTful | Public APIs, simple CRUD | Simple, widely supported |
| GraphQL | Complex data queries, multiple clients | Flexible, type-safe |
| tRPC | TypeScript internal services | End-to-end type safety |

**Recommendations**:

1. **No Silver Bullet**: Choose based on project needs
2. **RESTful is Safe**: When unsure, REST is a solid choice
3. **GraphQL for Complex Scenarios**: Consider when data relationships are complex
4. **tRPC for TypeScript Projects**: Type safety is a huge advantage
5. **Can Mix and Match**: Use different approaches for different scenarios

Choosing an API paradigm is an important architectural decision. This comparison will help you make the right choice.
