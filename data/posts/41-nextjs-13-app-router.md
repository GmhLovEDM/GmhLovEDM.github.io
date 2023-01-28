---
title: "Next.js 13 App Router: Saying Goodbye to the Pages Router Era"
tag: nextjs
description: An in-depth exploration of Next.js 13's App Router architecture, understanding the new layout system and data fetching patterns.
date: "2023-01-28T08:00:00.000Z"
---

## Goal

Next.js 13 introduced the App Router architecture, representing the biggest architectural overhaul since Next.js was first created. Built on top of React Server Components, it provides a more flexible layout system, more efficient data fetching patterns, and a fundamentally better developer experience. This article dives deep into the core concepts of the App Router, helping developers successfully migrate from the Pages Router.

## Background

### The Limitations of the Pages Router

Before Next.js 13, we used the Pages Router:

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

While the Pages Router was revolutionary at the time, it had several significant limitations:

- **Layout nesting required manual handling**: Shared layouts had to be implemented with custom wrappers or higher-order components, leading to inconsistent patterns across projects.
- **Data fetching logic was scattered**: `getServerSideProps`, `getStaticProps`, and `getStaticPaths` existed outside the component tree, making it hard to see the relationship between data and UI at a glance.
- **Client and server components were mixed**: Everything was a client component by default, meaning all code -- including server-only logic like database queries -- was bundled and sent to the browser.
- **Loading states were complex**: Handling loading and error states required custom solutions or external libraries like NProgress.

### How App Router Solves These Problems

```jsx
// app/page.js - Brand new file-system routing
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

Notice how the App Router version is dramatically simpler: the component is `async`, it fetches data directly inside the component body, and there is no separate data-fetching function wrapping it. This is possible because components are server components by default -- they run on the server and their JavaScript is never sent to the client.

## Core Concepts of App Router

### File-System Routing

```
app/
├── layout.js          # Root layout
├── page.js            # Home page
├── loading.js         # Loading state
├── error.js           # Error handling
├── not-found.js       # 404 page
├── about/
│   └── page.js        # /about route
├── blog/
│   ├── page.js        # /blog route
│   └── [slug]/
│       └── page.js    # /blog/:slug route
└── dashboard/
    ├── layout.js      # Nested layout
    ├── page.js        # /dashboard route
    └── settings/
        └── page.js    # /dashboard/settings route
```

The file-system routing convention is intuitive: folders map to URL segments, and special files like `page.js`, `layout.js`, `loading.js`, and `error.js` have predefined roles. Dynamic segments use bracket syntax (`[slug]`), and nested folders automatically create nested routes. This convention eliminates the need for a centralized routing configuration file.

### The Layout System

```jsx
// app/layout.js - Root layout
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

// app/dashboard/layout.js - Nested layout
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

The layout system is one of the App Router's most powerful features. Layouts are nested automatically based on the file structure, and -- critically -- they do not re-render on navigation. When a user navigates from `/dashboard` to `/dashboard/settings`, only the `settings/page.js` component re-renders; the `dashboard/layout.js` stays mounted. This means shared state, DOM elements, and scroll positions are preserved naturally without any additional work.

### Data Fetching

```jsx
// Server Component - direct async/await
async function BlogList() {
  const posts = await fetch('https://api.example.com/posts', {
    // Next.js extended fetch options
    next: { revalidate: 3600 } // Revalidate every hour
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

// Client Component - uses useState/useEffect
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

This side-by-side comparison illustrates the fundamental shift. Server components can use `async/await` directly because they execute on the server where asynchronous operations are natural. Client components use the familiar `useState`/`useEffect` pattern for data that requires client-side interactivity or browser APIs. The key insight is that you choose the rendering strategy based on what each component needs, not as a one-size-fits-all decision.

## Loading and Error Handling

### Loading States

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

// Wrapping with Suspense
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

The `loading.js` file provides a built-in loading state for route segments. When a server component takes time to render (e.g., due to a slow database query), Next.js automatically shows the loading UI. You can also use React's `Suspense` component for more granular control, wrapping individual async components with their own loading indicators. This gives you fine-grained control over which parts of the page show loading states and which render immediately.

### Error Handling

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

// app/error.js - Global error handling
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

// app/not-found.js - 404 page
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

Error boundaries in the App Router are defined by the `error.js` file convention. Each `error.js` catches errors in its sibling and child `page.js` components. Note that error components must be client components (marked with `'use client'`) because they need to use state and event handlers for the reset functionality. This file-based approach to error handling is more organized than the manual `ErrorBoundary` class pattern used previously.

## Server Components vs. Client Components

### Server Components (Default)

```jsx
// app/components/ServerComponent.js
// This is a server component (default)

async function ServerComponent() {
  // Can use async/await directly
  const data = await fetchData()
  
  // Can directly access the database
  const users = await db.query('SELECT * FROM users')
  
  // Cannot use hooks
  // const [state, setState] = useState() // Error!
  
  // Cannot use browser APIs
  // window.addEventListener() // Error!
  
  return (
    <div>
      <h1>Server Component</h1>
      <p>Data: {data}</p>
    </div>
  )
}
```

### Client Components

```jsx
// app/components/ClientComponent.js
'use client' // Must add this directive

import { useState, useEffect } from 'react'

function ClientComponent() {
  const [count, setCount] = useState(0)
  const [mounted, setMounted] = useState(false)
  
  useEffect(() => {
    setMounted(true)
    // Can use browser APIs
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

### Composing Both

```jsx
// app/page.js - Composing server and client components
import ServerComponent from './components/ServerComponent'
import ClientComponent from './components/ClientComponent'

export default function Home() {
  return (
    <div>
      <h1>Home Page</h1>
      
      {/* Server Component */}
      <ServerComponent />
      
      {/* Client Component */}
      <ClientComponent />
    </div>
  )
}
```

The `'use client'` directive is the boundary between server and client. Everything in a file marked with `'use client'` -- including its imports -- is part of the client bundle. Everything without it stays on the server. This is not just a rendering hint; it is a bundler boundary that determines what JavaScript code ships to the browser.

A common and recommended pattern is to keep most of your component tree as server components and only mark specific interactive components as client components. This "use client as little as possible" approach minimizes the JavaScript bundle size while preserving interactivity where it matters.

## Data Fetching Strategies

### Static Data

```jsx
// app/blog/[slug]/page.js
async function BlogPost({ params }) {
  const post = await fetch(`https://api.example.com/posts/${params.slug}`, {
    next: { tags: ['blog'] } // Tags enable on-demand revalidation
  }).then(r => r.json())
  
  return (
    <article>
      <h1>{post.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: post.content }} />
    </article>
  )
}

// Static generation
export async function generateStaticParams() {
  const posts = await fetch('https://api.example.com/posts').then(r => r.json())
  
  return posts.map(post => ({
    slug: post.slug
  }))
}

export default BlogPost
```

`generateStaticParams` tells Next.js to pre-render these pages at build time, producing static HTML that can be served from a CDN. The `tags` option in `fetch` enables on-demand revalidation -- you can trigger a revalidation for all pages tagged with `'blog'` by calling `revalidateTag('blog')` from an API route or webhook. This gives you the performance of static generation with the freshness of dynamic rendering.

### Dynamic Data

```jsx
// app/dashboard/page.js
import { cookies } from 'next/headers'

async function Dashboard() {
  // Dynamic data: fetch fresh data on every request
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

// Force dynamic rendering
export const dynamic = 'force-dynamic'

export default Dashboard
```

When a page depends on request-specific data like cookies, headers, or search params, you should opt into dynamic rendering. The `export const dynamic = 'force-dynamic'` directive tells Next.js to render this page on every request rather than at build time or during static generation. This is essential for authenticated pages, personalized content, and any page that varies per user.

### Real-Time Data

```jsx
// app/realtime/page.js
async function RealtimeData() {
  // Real-time data: revalidate every second
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

Time-based revalidation is set directly on the `fetch` call. With `revalidate: 1`, the page is regenerated at most once per second. This is useful for dashboards or feeds that need near-real-time data without the complexity of WebSockets or client-side polling.

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
  
  // Validate data
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

Route Handlers replace the `pages/api` convention with a more explicit, HTTP-method-based approach. Each exported function (`GET`, `POST`, `PUT`, `DELETE`) corresponds directly to an HTTP method. The `NextResponse` utility provides a clean API for constructing responses with proper status codes and headers. The routing structure maps naturally to RESTful patterns, making the codebase intuitive to navigate.

## Migration Guide

### Migrating from Pages Router

```jsx
// Before: pages/index.js
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

// After: app/page.js
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

The migration for data-fetching is straightforward: remove `getServerSideProps` and fetch data directly in the component. The props are no longer passed down -- the component accesses data directly from its own scope. For complex cases involving shared state or client-side interactivity, you may need to split components into server and client parts.

### Gradual Migration

```javascript
// next.config.js
module.exports = {
  // Gradual migration configuration
  experimental: {
    appDir: true
  }
}
```

In Next.js 13, the App Router was opt-in via the `experimental.appDir` flag. Starting with Next.js 13.4, the App Router became stable and is available by default. Both routers can coexist in the same project, allowing you to migrate page by page. Routes in the `app/` directory use the App Router, while routes in the `pages/` directory continue using the Pages Router. This means you can adopt the App Router incrementally without a disruptive rewrite.

## Conclusion

Next.js 13's App Router represents the future direction of React application architecture:

1. **Layout system**: Declarative, nestable layouts that persist across navigations and do not re-render, preserving state and scroll position naturally.
2. **Data fetching**: Server components use `async/await` directly, eliminating the need for `getServerSideProps` and making data dependencies explicit within the component tree.
3. **Error handling**: File-system-level error boundaries with the `error.js` convention provide organized, scoped error recovery.
4. **Performance optimization**: Automatic code splitting, streaming rendering, and server-only components drastically reduce the client JavaScript bundle.
5. **Developer experience**: Cleaner, more intuitive code organization that matches how developers think about applications and their data flow.

While the App Router has a steeper learning curve than the Pages Router, its architectural advantages are significant and lasting. For new projects, use the App Router from the start. For existing projects, a gradual migration strategy allows you to adopt it incrementally without a full rewrite. The investment in learning the App Router pays dividends in better performance, cleaner code, and a more maintainable architecture.
