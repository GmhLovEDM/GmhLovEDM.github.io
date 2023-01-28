---
title: "Next.js 13 App Router 初体验：告别 Pages Router 时代"
tag: nextjs
description: 深入探索 Next.js 13 的 App Router 架构，理解全新的布局系统和数据获取方式。
date: "2023-01-28T08:00:00.000Z"
---

## 目标

Next.js 13 引入了全新的 App Router 架构，这是 Next.js 自诞生以来最大的架构变革。它基于 React Server Components，提供了更灵活的布局系统、更高效的数据获取方式。本文将深入解析 App Router 的核心概念，帮助开发者顺利完成从 Pages Router 到 App Router 的迁移。

## 背景

### Pages Router 的局限性

在 Next.js 13 之前，我们使用 Pages Router：

```jsx
// pages/index.js
export async function getServerSideProps() {
  const data = await fetch('https://api.example.com/data')
  const posts = await data.json()
  
  return {
    props: { posts }
  }
}

export default function Home({ posts }) {
  return (
    <div>
      {posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </div>
  )
}
```

Pages Router 的问题：
- 布局嵌套需要手动处理
- 数据获取逻辑分散
- 客户端和服务端组件混合
- 加载状态处理复杂

### App Router 的解决方案

```jsx
// app/page.js - 全新的文件系统路由
async function Home() {
  const posts = await fetch('https://api.example.com/data').then(r => r.json())
  
  return (
    <div>
      {posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </div>
  )
}

export default Home
```

## App Router 核心概念

### 文件系统路由

```
app/
├── layout.js          # 根布局
├── page.js            # 首页
├── loading.js         # 加载状态
├── error.js           # 错误处理
├── not-found.js       # 404 页面
├── about/
│   └── page.js        # /about 路由
├── blog/
│   ├── page.js        # /blog 路由
│   └── [slug]/
│       └── page.js    # /blog/:slug 路由
└── dashboard/
    ├── layout.js      # 嵌套布局
    ├── page.js        # /dashboard 路由
    └── settings/
        └── page.js    # /dashboard/settings 路由
```

### 布局系统

```jsx
// app/layout.js - 根布局
export const metadata = {
  title: 'My App',
  description: 'A Next.js app with App Router',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <a href="/">Home</a>
          <a href="/about">About</a>
          <a href="/blog">Blog</a>
        </nav>
        
        <main>{children}</main>
        
        <footer>
          <p>&copy; 2023 My App</p>
        </footer>
      </body>
    </html>
  )
}

// app/dashboard/layout.js - 嵌套布局
export default function DashboardLayout({ children }) {
  return (
    <div className="dashboard">
      <aside>
        <nav>
          <a href="/dashboard">Overview</a>
          <a href="/dashboard/settings">Settings</a>
        </nav>
      </aside>
      
      <div className="dashboard-content">
        {children}
      </div>
    </div>
  )
}
```

### 数据获取

```jsx
// 服务端组件 - 直接 async/await
async function BlogList() {
  const posts = await fetch('https://api.example.com/posts', {
    // Next.js 扩展的 fetch 选项
    next: { revalidate: 3600 } // 每小时重新验证
  }).then(r => r.json())
  
  return (
    <ul>
      {posts.map(post => (
        <li key={post.id}>
          <a href={`/blog/${post.slug}`}>{post.title}</a>
        </li>
      ))}
    </ul>
  )
}

// 客户端组件 - 使用 useState/useEffect
'use client'

import { useState, useEffect } from 'react'

function BlogListClient() {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  
  useEffect(() => {
    async function fetchPosts() {
      const response = await fetch('/api/posts')
      const data = await response.json()
      setPosts(data)
      setLoading(false)
    }
    
    fetchPosts()
  }, [])
  
  if (loading) return <div>Loading...</div>
  
  return (
    <ul>
      {posts.map(post => (
        <li key={post.id}>
          <a href={`/blog/${post.slug}`}>{post.title}</a>
        </li>
      ))}
    </ul>
  )
}
```

## 加载与错误处理

### 加载状态

```jsx
// app/blog/loading.js
export default function BlogLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 bg-gray-200 rounded w-1/3 mb-4"></div>
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 bg-gray-200 rounded"></div>
        ))}
      </div>
    </div>
  )
}

// Suspense 包裹
import { Suspense } from 'react'
import BlogList from './BlogList'
import BlogLoading from './loading'

export default function BlogPage() {
  return (
    <div>
      <h1>Blog</h1>
      
      <Suspense fallback={<BlogLoading />}>
        <BlogList />
      </Suspense>
    </div>
  )
}
```

### 错误处理

```jsx
// app/blog/error.js
'use client'

export default function BlogError({ error, reset }) {
  return (
    <div>
      <h2>Something went wrong!</h2>
      <p>{error.message}</p>
      <button onClick={() => reset()}>Try again</button>
    </div>
  )
}

// app/error.js - 全局错误处理
'use client'

export default function Error({ error, reset }) {
  return (
    <div className="error-page">
      <h1>Oops!</h1>
      <p>Something went wrong</p>
      <button onClick={() => reset()}>Try again</button>
    </div>
  )
}

// app/not-found.js - 404 页面
export default function NotFound() {
  return (
    <div className="not-found">
      <h1>404</h1>
      <p>Page not found</p>
      <a href="/">Go back home</a>
    </div>
  )
}
```

## Server Components vs Client Components

### 服务端组件（默认）

```jsx
// app/components/ServerComponent.js
// 这是服务端组件（默认）

async function ServerComponent() {
  // 可以直接使用 async/await
  const data = await fetchData()
  
  // 可以直接访问数据库
  const users = await db.query('SELECT * FROM users')
  
  // 不能使用 hooks
  // const [state, setState] = useState() // 错误
  
  // 不能使用浏览器 API
  // window.addEventListener() // 错误
  
  return (
    <div>
      <h1>Server Component</h1>
      <p>Data: {data}</p>
    </div>
  )
}
```

### 客户端组件

```jsx
// app/components/ClientComponent.js
'use client' // 必须添加这个指令

import { useState, useEffect } from 'react'

function ClientComponent() {
  const [count, setCount] = useState(0)
  const [mounted, setMounted] = useState(false)
  
  useEffect(() => {
    setMounted(true)
    // 可以使用浏览器 API
    console.log('Component mounted')
    
    return () => {
      console.log('Component unmounted')
    }
  }, [])
  
  return (
    <div>
      <h1>Client Component</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
      <p>Mounted: {mounted.toString()}</p>
    </div>
  )
}
```

### 混合使用

```jsx
// app/page.js - 组合服务端和客户端组件
import ServerComponent from './components/ServerComponent'
import ClientComponent from './components/ClientComponent'

export default function Home() {
  return (
    <div>
      <h1>Home Page</h1>
      
      {/* 服务端组件 */}
      <ServerComponent />
      
      {/* 客户端组件 */}
      <ClientComponent />
    </div>
  )
}
```

## 数据获取策略

### 静态数据

```jsx
// app/blog/[slug]/page.js
async function BlogPost({ params }) {
  const post = await fetch(`https://api.example.com/posts/${params.slug}`, {
    next: { tags: ['blog'] } // 标签用于按需重新验证
  }).then(r => r.json())
  
  return (
    <article>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.content }} />
    </article>
  )
}

// 静态生成
export async function generateStaticParams() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json())
  
  return posts.map(post => ({
    slug: post.slug
  }))
}

export default BlogPost
```

### 动态数据

```jsx
// app/dashboard/page.js
import { cookies } from 'next/headers'

async function Dashboard() {
  // 动态数据：每次请求都获取最新数据
  const cookieStore = cookies()
  const session = cookieStore.get('session')
  
  const user = await fetch('https://api.example.com/user', {
    headers: {
      Authorization: `Bearer ${session?.value}`
    }
  }).then(r => r.json())
  
  return (
    <div>
      <h1>Welcome, {user.name}!</h1>
      <p>Email: {user.email}</p>
    </div>
  )
}

// 强制动态渲染
export const dynamic = 'force-dynamic'

export default Dashboard
```

### 实时数据

```jsx
// app/realtime/page.js
async function RealtimeData() {
  // 实时数据：每秒重新验证
  const data = await fetch('https://api.example.com/realtime', {
    next: { revalidate: 1 }
  }).then(r => r.json())
  
  return (
    <div>
      <h1>Realtime Data</h1>
      <p>Value: {data.value}</p>
      <p>Updated at: {data.timestamp}</p>
    </div>
  )
}

export default RealtimeData
```

## API Routes

### Route Handlers

```jsx
// app/api/users/route.js
import { NextResponse } from 'next/server'

export async function GET() {
  const users = await db.query('SELECT * FROM users')
  
  return NextResponse.json(users)
}

export async function POST(request) {
  const body = await request.json()
  
  // 验证数据
  if (!body.name || !body.email) {
    return NextResponse.json(
      { error: 'Name and email are required' },
      { status: 400 }
    )
  }
  
  const user = await db.query(
    'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
    [body.name, body.email]
  )
  
  return NextResponse.json(user, { status: 201 })
}

// app/api/users/[id]/route.js
import { NextResponse } from 'next/server'

export async function GET(request, { params }) {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [params.id])
  
  if (!user) {
    return NextResponse.json(
      { error: 'User not found' },
      { status: 404 }
    )
  }
  
  return NextResponse.json(user)
}

export async function PUT(request, { params }) {
  const body = await request.json()
  
  const user = await db.query(
    'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING *',
    [body.name, body.email, params.id]
  )
  
  return NextResponse.json(user)
}

export async function DELETE(request, { params }) {
  await db.query('DELETE FROM users WHERE id = $1', [params.id])
  
  return NextResponse.json({ success: true })
}
```

## 迁移指南

### 从 Pages Router 迁移

```jsx
// 之前：pages/index.js
export async function getServerSideProps() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json())
  
  return {
    props: { posts }
  }
}

function Home({ posts }) {
  return (
    <div>
      {posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </div>
  )
}

export default Home

// 之后：app/page.js
async function Home() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json())
  
  return (
    <div>
      {posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </div>
  )
}

export default Home
```

### 渐进式迁移

```javascript
// next.config.js
module.exports = {
  // 渐进式迁移配置
  experimental: {
    appDir: true
  }
}
```

## 总结

Next.js 13 的 App Router 代表了 React 应用架构的未来方向：

1. **布局系统**：声明式、可嵌套的布局
2. **数据获取**：服务端组件直接 async/await
3. **错误处理**：文件系统级别的错误边界
4. **性能优化**：自动代码分割、流式渲染
5. **开发体验**：更简洁、更直观的代码组织

虽然 App Router 学习曲线较陡，但它带来的架构优势是显而易见的。建议新项目直接使用 App Router，现有项目可以渐进式迁移。
