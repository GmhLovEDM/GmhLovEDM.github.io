---
title: "Next.js 14 Major Update: Server Actions Officially Stable"
tag: nextjs
description: Deep dive into Next.js 14's core updates, Server Actions from experimental to officially stable, and detailed explanations of Partial Prerendering, Metadata API, and other new features.
date: "2024-02-28T08:00:00.000Z"
---

## Goal

Next.js 14 is an important stable release, marking the maturity of App Router and Server Actions. This article deeply analyzes Next.js 14's core updates, helping developers understand the development pattern changes brought by new features and how to apply these updates in real projects.

## Background

### Next.js Evolution

```
Next.js 13.0 (2022.10): Introduced App Router (beta)
Next.js 13.3 (2023.04): App Router stable
Next.js 13.4 (2023.05): Server Actions (canary)
Next.js 13.5 (2023.09): App Router performance optimization
Next.js 14 (2023.10): Server Actions officially stable
```

### Core Changes in Version 14

- **Server Actions stable**: From experimental to production-ready
- **Partial Prerendering (PPR)**: Fusion of static and dynamic content
- **Server Actions + useOptimistic**: Built-in optimistic updates support
- **Turbopack Dev stable**: 700% faster build speeds

## Server Actions Officially Stable

### Basic Usage

```tsx
// app/actions/user.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

// Create user
export async function createUser(formData: FormData) {
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  // Server directly operates database
  await db.users.create({
    data: { name, email },
  });

  // Revalidate cache
  revalidatePath('/users');
  // Redirect page
  redirect('/users');
}

// Update user
export async function updateUser(id: string, formData: FormData) {
  const name = formData.get('name') as string;
  const email = formData.get('email') as string;

  await db.users.update({
    where: { id },
    data: { name, email },
  });

  revalidatePath(`/users/${id}`);
}

// Delete user
export async function deleteUser(id: string) {
  await db.users.delete({ where: { id } });
  revalidatePath('/users');
}
```

### Usage in Components

```tsx
// app/users/page.tsx
import { createUser, deleteUser } from '../actions/user';

export default async function UsersPage() {
  const users = await db.users.findMany();

  return (
    <div>
      <h1>User List</h1>

      {/* Form directly binds Server Action */}
      <form action={createUser}>
        <input name="name" placeholder="Name" required />
        <input name="email" type="email" placeholder="Email" required />
        <button type="submit">Create User</button>
      </form>

      {/* User list */}
      <ul>
        {users.map((user) => (
          <li key={user.id}>
            {user.name} - {user.email}
            <form action={deleteUser.bind(null, user.id)}>
              <button type="submit">Delete</button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## Partial Prerendering (PPR)

### PPR Core Concept

PPR allows mixing static and dynamic content in the same page:

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react';

// Static content: generated at build time
function StaticHeader() {
  return <h1>Dashboard</h1>;
}

// Dynamic content: generated at request time
async function DynamicStats() {
  const stats = await fetchStats(); // Fetch latest data on every request
  return (
    <div>
      <p>Total users: {stats.totalUsers}</p>
      <p>Active users: {stats.activeUsers}</p>
    </div>
  );
}

async function RecentActivity() {
  const activities = await fetchActivities(); // Dynamic data
  return (
    <ul>
      {activities.map((activity) => (
        <li key={activity.id}>{activity.description}</li>
      ))}
    </ul>
  );
}

// PPR page
export default function DashboardPage() {
  return (
    <div>
      {/* Static content: sent immediately */}
      <StaticHeader />

      {/* Dynamic content: streamed */}
      <Suspense fallback={<div>Loading stats...</div>}>
        <DynamicStats />
      </Suspense>

      <Suspense fallback={<div>Loading activity...</div>}>
        <RecentActivity />
      </Suspense>
    </div>
  );
}
```

### PPR Performance Advantage

```
Traditional SSR:
  Request → Wait for all data → Render complete HTML → Send
  Time: 3-5 seconds

PPR:
  Request → Send static HTML immediately → Stream dynamic content
  Time: 0.5-1 second
```

## useOptimistic Optimistic Updates

### Basic Usage

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
    addOptimisticTodo(text); // Update UI immediately
    await addTodo(text); // Server processing
  }

  return (
    <div>
      <form action={handleSubmit}>
        <input name="text" placeholder="New todo" />
        <button type="submit">Add</button>
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

### Complete Todo Application

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
      <h1>Todos</h1>
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
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
```

## Metadata API Enhancement

### Dynamic Metadata

```tsx
// app/posts/[id]/page.tsx
import type { Metadata } from 'next';

// Dynamic Metadata
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

### Batch Generate Metadata

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

## Performance Optimization

### Turbopack Dev

```bash
# Enable Turbopack
npx next dev --turbo

# Performance comparison
# Webpack: 8.2 seconds startup
# Turbopack: 1.2 seconds startup
```

### Static Export Optimization

```typescript
// next.config.js
module.exports = {
  output: 'export', // Static export
  images: {
    unoptimized: true, // Required for static export
  },
};
```

### Caching Strategy

```tsx
// Use unstable_cache for data caching
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
    revalidate: 3600, // 1 hour
  }
);

// Use revalidateTag to invalidate cache
import { revalidateTag } from 'next/cache';

export async function createPost(data) {
  await db.posts.create({ data });
  revalidateTag('posts'); // Invalidate all posts-related cache
}
```

## Migration Guide

### Migrating from Pages Router

```tsx
// Pages Router (old)
// pages/posts/[id].tsx
export async function getServerSideProps({ params }) {
  const post = await getPost(params.id);
  return { props: { post } };
}

export default function PostPage({ post }) {
  return <article>{post.content}</article>;
}

// App Router (new)
// app/posts/[id]/page.tsx
export default async function PostPage({ params }) {
  const post = await getPost(params.id);
  return <article>{post.content}</article>;
}
```

### Migrating from API Routes

```tsx
// Pages Router (old)
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

// App Router (new)
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

## Conclusion

Next.js 14 marks the maturity of React full-stack frameworks. Key takeaways:

1. **Server Actions stable**: New paradigm for form handling, simplifying frontend-backend interaction
2. **Partial Prerendering**: Perfect fusion of static and dynamic content
3. **useOptimistic**: Built-in optimistic update support
4. **Turbopack Dev**: Lightning-fast development experience

For new projects, it is recommended to use Next.js 14 + App Router + Server Actions directly. For existing projects, migration can be gradual based on actual circumstances.

Next.js's development direction is clear: server-first, type-safe, and extreme performance. Mastering these core features enables building production-grade modern web applications.
