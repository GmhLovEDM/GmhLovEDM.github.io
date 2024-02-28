---
title: "Next.js 14 重大更新：Server Actions 正式稳定"
tag: nextjs
description: 深入 Next.js 14 的核心更新，Server Actions 从实验特性到正式稳定，以及 Partial Prerendering、Metadata API 等新特性详解。
date: "2024-02-28T08:00:00.000Z"
---

## 目标

Next.js 14 是一个重要的稳定版本，标志着 App Router 和 Server Actions 走向成熟。本文深入解析 Next.js 14 的核心更新，帮助开发者理解新特性带来的开发模式变化，以及如何在实际项目中应用这些更新。

## 背景

### Next.js 的演进

```
Next.js 13.0 (2022.10)：引入 App Router（beta）
Next.js 13.3 (2023.04)：App Router 稳定
Next.js 13.4 (2023.05)：Server Actions（canary）
Next.js 13.5 (2023.09)：App Router 性能优化
Next.js 14 (2023.10)：Server Actions 正式稳定
```

### 14 版本的核心变化

- **Server Actions 稳定**：从实验特性到生产就绪
- **部分预渲染（Partial Prerendering）**：静态与动态内容的融合
- **Server Actions + useOptimistic**：乐观更新内置支持
- **Turbopack Dev 稳定**：构建速度提升 700%

## Server Actions 正式稳定

### 基本用法

```tsx
// app/actions/user.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

// 创建用户
export async function createUser(formData: FormData) {
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  // 服务端直接操作数据库
  await db.users.create({
    data: { name, email },
  });

  // 重新验证缓存
  revalidatePath('/users');
  // 跳转页面
  redirect('/users');
}

// 更新用户
export async function updateUser(id: string, formData: FormData) {
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  await db.users.update({
    where: { id },
    data: { name, email },
  });

  revalidatePath(`/users/${id}`);
}

// 删除用户
export async function deleteUser(id: string) {
  await db.users.delete({ where: { id } });
  revalidatePath('/users');
}
```

### 在组件中使用

```tsx
// app/users/page.tsx
import { createUser, deleteUser } from '../actions/user';

export default async function UsersPage() {
  const users = await db.users.findMany();

  return (
    <div>
      <h1>用户列表</h1>

      {/* 表单直接绑定 Server Action */}
      <form action={createUser}>
        <input name="name" placeholder="姓名" required />
        <input name="email" type="email" placeholder="邮箱" required />
        <button type="submit">创建用户</button>
      </form>

      {/* 用户列表 */}
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {user.name} - {user.email}
            <form action={deleteUser.bind(null, user.id)}>
              <button type="submit">删除</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## 部分预渲染（Partial Prerendering）

### PPR 的核心理念

PPR 允许在同一个页面中混合静态和动态内容：

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react';

// 静态内容：构建时生成
function StaticHeader() {
  return <h1>仪表盘</h1>;
}

// 动态内容：请求时生成
async function DynamicStats() {
  const stats = await fetchStats(); // 每次请求都获取最新数据
  return (
    <div>
      <p>总用户: {stats.totalUsers}</p>
      <p>活跃用户: {stats.activeUsers}</p>
    </div>
  );
}

async function RecentActivity() {
  const activities = await fetchActivities(); // 动态数据
  return (
    <ul>
      {activities.map((activity) => (
        <li key={activity.id}>{activity.description}</li>
      ))}
    </ul>
  );
}

// PPR 页面
export default function DashboardPage() {
  return (
    <div>
      {/* 静态内容：立即发送 */}
      <StaticHeader />

      {/* 动态内容：流式发送 */}
      <Suspense fallback={<div>加载统计数据...</div>}>
        <DynamicStats />
      </Suspense>

      <Suspense fallback={<div>加载活动...</div>}>
        <RecentActivity />
      </Suspense>
    </div>
  );
}
```

### PPR 的性能优势

```
传统 SSR：
  请求 → 等待所有数据 → 渲染完整 HTML → 发送
  耗时: 3-5 秒

PPR：
  请求 → 立即发送静态 HTML → 流式发送动态内容
  耗时: 0.5-1 秒
```

## useOptimistic 乐观更新

### 基本用法

```tsx
'use client';

import { useOptimistic } from 'react';
import { addTodo } from './actions';

function TodoList({ todos }) {
  const [optimisticTodos, addOptimisticTodo] = useOptimistic(
    todos,
    (state, newTodo) => [
      ...state,
      { id: 'temp', text: newTodo, completed: false },
    ]
  );

  async function handleSubmit(formData) {
    const text = formData.get('text');
    addOptimisticTodo(text); // 立即更新 UI
    await addTodo(text); // 服务端处理
  }

  return (
    <div>
      <form action={handleSubmit}>
        <input name="text" placeholder="新待办" />
        <button type="submit">添加</button>
      </form>

      <ul>
        {optimisticTodos.map((todo) => (
          <li key={todo.id} style={{ opacity: todo.id === 'temp' ? 0.5 : 1 }}>
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### 完整的待办应用

```tsx
// app/todos/page.tsx
import { addTodo, toggleTodo, deleteTodo } from './actions';
import TodoList from './TodoList';

export default async function TodosPage() {
  const todos = await db.todos.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return (
    <div>
      <h1>待办事项</h1>
      <TodoList todos={todos} />
    </div>
  );
}

// app/todos/TodoList.tsx
'use client';

import { useOptimistic } from 'react';
import { toggleTodo, deleteTodo } from './actions';

export default function TodoList({ todos }) {
  const [optimisticTodos, toggleOptimistic, deleteOptimistic] = useOptimistic(
    todos,
    (state, action) => {
      if (action.type === 'toggle') {
        return state.map((todo) =>
          todo.id === action.id
            ? { ...todo, completed: !todo.completed }
            : todo
        );
      }
      if (action.type === 'delete') {
        return state.filter((todo) => todo.id !== action.id);
      }
      if (action.type === 'add') {
        return [
          { id: 'temp', text: action.text, completed: false },
          ...state,
        ];
      }
      return state;
    }
  );

  return (
    <div>
      {optimisticTodos.map((todo) => (
        <div key={todo.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => {
              toggleOptimistic({ type: 'toggle', id: todo.id });
              toggleTodo(todo.id);
            }}
          />
          <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
            {todo.text}
          </span>
          <button
            onClick={() => {
              deleteOptimistic({ type: 'delete', id: todo.id });
              deleteTodo(todo.id);
            }}
          >
            删除
          </button>
        </div>
      ))}
    </div>
  );
}
```

## Metadata API 增强

### 动态 Metadata

```tsx
// app/posts/[id]/page.tsx
import type { Metadata } from 'next';

// 动态 Metadata
export async function generateMetadata({ params }): Promise<Metadata> {
  const post = await getPost(params.id);

  return {
    title: post.title,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      images: [post.coverImage],
    },
  };
}

export default async function PostPage({ params }) {
  const post = await getPost(params.id);
  return <article>{post.content}</article>;
}
```

### 批量生成 Metadata

```tsx
// app/posts/sitemap.ts
export default async function sitemap() {
  const posts = await db.posts.findMany();

  return posts.map((post) => ({
    url: `https://example.com/posts/${post.id}`,
    lastModified: post.updatedAt,
    changeFrequency: 'weekly',
    priority: 0.8,
  }));
}
```

## 性能优化

### Turbopack Dev

```bash
# 启用 Turbopack
npx next dev --turbo

# 性能对比
# Webpack: 8.2 秒启动
# Turbopack: 1.2 秒启动
```

### 静态导出优化

```typescript
// next.config.js
module.exports = {
  output: 'export', // 静态导出
  images: {
    unoptimized: true, // 静态导出时必须
  },
};
```

### 缓存策略

```tsx
// 使用 unstable_cache 进行数据缓存
import { unstable_cache } from 'next/cache';

const getPosts = unstable_cache(
  async () => {
    return db.posts.findMany({
      orderBy: { createdAt: 'desc' },
    });
  },
  ['posts'],
  {
    tags: ['posts'],
    revalidate: 3600, // 1 小时
  }
);

// 使用 revalidateTag 失效缓存
import { revalidateTag } from 'next/cache';

export async function createPost(data) {
  await db.posts.create({ data });
  revalidateTag('posts'); // 失效所有 posts 相关缓存
}
```

## 迁移指南

### 从 Pages Router 迁移

```tsx
// Pages Router (旧)
// pages/posts/[id].tsx
export async function getServerSideProps({ params }) {
  const post = await getPost(params.id);
  return { props: { post } };
}

export default function PostPage({ post }) {
  return <article>{post.content}</article>;
}

// App Router (新)
// app/posts/[id]/page.tsx
export default async function PostPage({ params }) {
  const post = await getPost(params.id);
  return <article>{post.content}</article>;
}
```

### 从 API Routes 迁移

```tsx
// Pages Router (旧)
// pages/api/users.ts
export default async function handler(req, res) {
  if (req.method === 'GET') {
    const users = await db.users.findMany();
    res.json(users);
  } else if (req.method === 'POST') {
    const user = await db.users.create({ data: req.body });
    res.json(user);
  }
}

// App Router (新)
// app/api/users/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  const users = await db.users.findMany();
  return NextResponse.json(users);
}

export async function POST(request) {
  const data = await request.json();
  const user = await db.users.create({ data });
  return NextResponse.json(user);
}
```

## 总结

Next.js 14 标志着 React 全栈框架的成熟。关键要点：

1. **Server Actions 稳定**：表单处理的新范式，简化前后端交互
2. **Partial Prerendering**：静态与动态内容的完美融合
3. **useOptimistic**：内置的乐观更新支持
4. **Turbopack Dev**：极速的开发体验

对于新项目，建议直接使用 Next.js 14 + App Router + Server Actions。对于已有项目，可以根据实际情况逐步迁移。

Next.js 的发展方向已经清晰：服务端优先、类型安全、极致性能。掌握这些核心特性，就能构建出生产级的现代 Web 应用。
