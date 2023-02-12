---
title: "React Server Components 理解与实践"
tag: react
description: 深入理解 React Server Components 的工作原理，掌握其在 Next.js 中的最佳实践。
date: "2023-02-12T08:00:00.000Z"
---

## 目标

React Server Components（RSC）是 React 架构的一次革命性变革。它允许组件在服务器上渲染，减少了客户端 JavaScript 体积，提升了应用性能。本文将深入解析 RSC 的工作原理、优势、限制以及在 Next.js 中的实践。

## 背景

### 传统 React 的问题

传统的 React 应用采用客户端渲染（CSR）：

```jsx
// 传统方式：客户端渲染
function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  
  useEffect(() => {
    async function fetchUser() {
      const response = await fetch(`/api/users/${userId}`)
      const data = await response.json()
      setUser(data)
      setLoading(false)
    }
    
    fetchUser()
  }, [userId])
  
  if (loading) return <Spinner />
  
  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}
```

问题：
- 首屏加载需要下载大量 JavaScript
- 数据获取瀑布流
- SEO 不友好
- 客户端需要处理大量逻辑

### RSC 的解决方案

```jsx
// Server Component：在服务器上渲染
async function UserProfile({ userId }) {
  // 直接访问数据库
  const user = await db.query('SELECT * FROM users WHERE id = $1', [userId])
  
  // 只返回渲染后的 HTML
  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}
```

## 核心概念

### Server Component vs Client Component

```jsx
// Server Component（默认）
async function ServerComponent() {
  // 可以直接使用 async/await
  const data = await fetchData()
  
  // 可以直接访问数据库
  const users = await db.query('SELECT * FROM users')
  
  // 可以使用 Node.js API
  const fs = require('fs')
  const config = fs.readFileSync('./config.json', 'utf8')
  
  // 不能使用 hooks
  // const [state, setState] = useState() // 错误
  
  // 不能使用浏览器 API
  // window.addEventListener() // 错误
  
  return <div>{data}</div>
}

// Client Component
'use client'

import { useState, useEffect } from 'react'

function ClientComponent() {
  const [count, setCount] = useState(0)
  
  useEffect(() => {
    // 可以使用浏览器 API
    console.log('Mounted')
    
    return () => console.log('Unmounted')
  }, [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  )
}
```

### 组件边界

```jsx
// 组件树中的边界
function App() {
  return (
    <div>
      {/* Server Component */}
      <Header />
      
      {/* Client Component */}
      <InteractiveWidget />
      
      {/* Server Component */}
      <main>
        <Suspense fallback={<Loading />}>
          <AsyncContent />
        </Suspense>
      </main>
    </div>
  )
}

// 错误：Server Component 不能导入 Client Component
import ClientComponent from './ClientComponent'

function ServerComponent() {
  return <ClientComponent /> // 错误！
}

// 正确：通过 props 传递
function ServerComponent() {
  return <ClientComponent data={serverData} />
}
```

## 数据获取

### 直接数据库访问

```jsx
// 服务器组件直接访问数据库
async function UserList() {
  // 直接查询数据库
  const users = await db.query('SELECT * FROM users ORDER BY created_at DESC')
  
  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>
          <h3>{user.name}</h3>
          <p>{user.email}</p>
        </li>
      ))}
    </ul>
  )
}

// 服务器组件访问文件系统
async function ConfigDisplay() {
  const fs = require('fs/promises')
  const config = await fs.readFile('./config.json', 'utf8')
  const data = JSON.parse(config)
  
  return (
    <div>
      <h2>Configuration</h2>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}
```

### API 路由

```jsx
// app/api/users/route.js
import { NextResponse } from 'next/server'

export async function GET() {
  const users = await db.query('SELECT * FROM users')
  return NextResponse.json(users)
}

// 服务器组件使用 API
async function UserList() {
  const users = await fetch('http://localhost:3000/api/users').then(r => r.json())
  
  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
```

### 数据获取模式

```jsx
// 模式 1：直接数据库访问（推荐）
async function UserProfile({ userId }) {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [userId])
  return <UserCard user={user} />
}

// 模式 2：API 路由
async function UserProfile({ userId }) {
  const user = await fetch(`/api/users/${userId}`).then(r => r.json())
  return <UserCard user={user} />
}

// 模式 3：外部 API
async function UserProfile({ userId }) {
  const user = await fetch(`https://api.external.com/users/${userId}`).then(r => r.json())
  return <UserCard user={user} />
}
```

## 性能优化

### 自动代码分割

```jsx
// 服务器组件自动分割
function App() {
  return (
    <div>
      {/* 这个组件的代码不会发送到客户端 */}
      <ServerComponent />
      
      {/* 只有这个组件的代码发送到客户端 */}
      <ClientComponent />
    </div>
  )
}
```

### 流式渲染

```jsx
// 使用 Suspense 实现流式渲染
import { Suspense } from 'react'

async function App() {
  return (
    <div>
      <header>
        <h1>My App</h1>
      </header>
      
      <main>
        {/* 立即渲染的部分 */}
        <StaticContent />
        
        {/* 异步加载的部分 */}
        <Suspense fallback={<Loading />}>
          <AsyncContent />
        </Suspense>
      </main>
      
      <footer>
        <p>© 2023 My App</p>
      </footer>
    </div>
  )
}

async function AsyncContent() {
  // 模拟异步操作
  const data = await fetchData()
  
  return <div>{data}</div>
}
```

### 缓存策略

```jsx
// 使用 React 的缓存机制
import { cache } from 'react'

// 缓存数据库查询
const getUser = cache(async (userId) => {
  return db.query('SELECT * FROM users WHERE id = $1', [userId])
})

async function UserProfile({ userId }) {
  // 多个组件调用 getUser 只会执行一次查询
  const user = await getUser(userId)
  return <UserCard user={user} />
}

async function UserStats({ userId }) {
  const user = await getUser(userId) // 复用缓存
  return <Stats userId={user.id} />
}
```

## 实际案例

### 博客系统

```jsx
// app/blog/page.js
import { Suspense } from 'react'
import BlogList from './BlogList'
import BlogSidebar from './BlogSidebar'

export default function BlogPage() {
  return (
    <div className="blog-layout">
      <aside>
        <Suspense fallback={<SidebarLoading />}>
          <BlogSidebar />
        </Suspense>
      </aside>
      
      <main>
        <Suspense fallback={<BlogListLoading />}>
          <BlogList />
        </Suspense>
      </main>
    </div>
  )
}

// app/blog/BlogList.js
async function BlogList() {
  const posts = await db.query(
    'SELECT * FROM posts WHERE status = $1 ORDER BY created_at DESC',
    ['published']
  )
  
  return (
    <div className="blog-list">
      {posts.map(post => (
        <article key={post.id} className="blog-post">
          <h2>
            <a href={`/blog/${post.slug}`}>{post.title}</a>
          </h2>
          <p className="excerpt">{post.excerpt}</p>
          <div className="meta">
            <span>{post.author}</span>
            <span>{new Date(post.created_at).toLocaleDateString()}</span>
          </div>
        </article>
      ))}
    </div>
  )
}

// app/blog/BlogSidebar.js
async function BlogSidebar() {
  const categories = await db.query(
    'SELECT * FROM categories ORDER BY name'
  )
  
  const recentPosts = await db.query(
    'SELECT * FROM posts ORDER BY created_at DESC LIMIT 5'
  )
  
  return (
    <div className="blog-sidebar">
      <section>
        <h3>Categories</h3>
        <ul>
          {categories.map(category => (
            <li key={category.id}>
              <a href={`/blog/category/${category.slug}`}>
                {category.name}
              </a>
            </li>
          ))}
        </ul>
      </section>
      
      <section>
        <h3>Recent Posts</h3>
        <ul>
          {recentPosts.map(post => (
            <li key={post.id}>
              <a href={`/blog/${post.slug}`}>{post.title}</a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
```

### 电商产品页

```jsx
// app/products/[id]/page.js
import { Suspense } from 'react'
import ProductDetails from './ProductDetails'
import ProductReviews from './ProductReviews'
import RelatedProducts from './RelatedProducts'

async function ProductPage({ params }) {
  return (
    <div className="product-page">
      <Suspense fallback={<ProductDetailsLoading />}>
        <ProductDetails productId={params.id} />
      </Suspense>
      
      <Suspense fallback={<ProductReviewsLoading />}>
        <ProductReviews productId={params.id} />
      </Suspense>
      
      <Suspense fallback={<RelatedProductsLoading />}>
        <RelatedProducts productId={params.id} />
      </Suspense>
    </div>
  )
}

// app/products/[id]/ProductDetails.js
async function ProductDetails({ productId }) {
  const product = await db.query(
    'SELECT * FROM products WHERE id = $1',
    [productId]
  )
  
  const images = await db.query(
    'SELECT * FROM product_images WHERE product_id = $1 ORDER BY sort_order',
    [productId]
  )
  
  return (
    <div className="product-details">
      <div className="product-images">
        {images.map(image => (
          <img key={image.id} src={image.url} alt={product.name} />
        ))}
      </div>
      
      <div className="product-info">
        <h1>{product.name}</h1>
        <p className="price">${product.price}</p>
        <p className="description">{product.description}</p>
        
        <AddToCartButton productId={product.id} />
      </div>
    </div>
  )
}

// 客户端组件：添加到购物车
'use client'

import { useState } from 'react'

function AddToCartButton({ productId }) {
  const [loading, setLoading] = useState(false)
  
  async function handleAddToCart() {
    setLoading(true)
    
    try {
      await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, quantity: 1 })
      })
      
      // 显示成功提示
      alert('Added to cart!')
    } catch (error) {
      console.error('Failed to add to cart:', error)
    } finally {
      setLoading(false)
    }
  }
  
  return (
    <button onClick={handleAddToCart} disabled={loading}>
      {loading ? 'Adding...' : 'Add to Cart'}
    </button>
  )
}
```

## 常见问题

### 问题 1：组件间通信

```jsx
// 服务端组件不能使用 Context
// 错误
function ServerComponent() {
  return (
    <ThemeContext.Provider value="dark">
      <ClientComponent />
    </ThemeContext.Provider>
  )
}

// 正确：在客户端组件中使用 Context
'use client'

import { ThemeContext } from './ThemeContext'

function App() {
  return (
    <ThemeContext.Provider value="dark">
      <ClientComponent />
    </ThemeContext.Provider>
  )
}
```

### 问题 2：状态管理

```jsx
// 服务端组件不能使用 useState
// 错误
function ServerComponent() {
  const [count, setCount] = useState(0)
  return <div>{count}</div>
}

// 正确：将状态逻辑移到客户端组件
'use client'

import { useState } from 'react'

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div>
      <p>{count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  )
}

// 服务器组件使用客户端组件
async function ServerComponent() {
  return <Counter />
}
```

## 总结

React Server Components 代表了 React 架构的未来方向：

1. **性能优势**：减少客户端 JavaScript 体积，提升首屏加载速度
2. **开发体验**：直接访问数据库和文件系统，简化数据获取
3. **安全性**：敏感逻辑在服务器执行，不暴露给客户端
4. **SEO 友好**：服务端渲染，搜索引擎可索引
5. **渐进式迁移**：可以与客户端组件混合使用

掌握 RSC 能够让你构建出更高效、更安全的 React 应用。
