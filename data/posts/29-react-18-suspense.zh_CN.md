---
title: "初探 React 18：Suspense 和并发模式初体验"
tag: react
description: 深入理解 React 18 的 Suspense 和并发特性，掌握新一代 React 应用开发范式。
date: "2022-09-03T08:00:00.000Z"
---

## 目标

React 18 引入了并发特性（Concurrent Features），这是 React 架构的一次重大升级。Suspense 作为并发模式的核心组件，为我们提供了优雅处理异步操作的能力。本文将深入解析 Suspense 的工作原理、并发模式的实际应用，以及如何在现有项目中安全地迁移到 React 18。

## 背景

### 传统异步处理的痛点

在 React 18 之前，处理数据加载通常需要：

```jsx
// 传统方式：手动管理加载状态
function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    fetchUser(userId)
      .then(data => setUser(data))
      .catch(err => setError(err))
      .finally(() => setLoading(false))
  }, [userId])

  if (loading) return <Spinner />
  if (error) return <ErrorMessage error={error} />
  return <UserCard user={user} />
}
```

这种方式存在以下问题：
- 每个组件都需要重复编写加载状态逻辑
- 用户体验碎片化，多个组件各自显示加载状态
- 数据依赖关系难以管理
- 无法优雅地处理嵌套异步操作

### Suspense 的解决方案

Suspense 通过声明式的方式处理异步状态，让组件树中的任何子组件可以"暂停"渲染，直到异步操作完成：

```jsx
// Suspense 方式：声明式异步处理
function UserProfile({ userId }) {
  // 直接使用数据，无需手动管理加载状态
  const user = use(fetchUser(userId))
  return <UserCard user={user} />
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <UserProfile userId={1} />
    </Suspense>
  )
}
```

## Suspense 工作原理

### 基础概念

Suspense 的工作原理可以概括为：

1. 子组件触发异步操作（通过特殊 hook 或 promise）
2. 异步操作未完成时，抛出一个"承诺"（Promise）
3. Suspense 捕获这个承诺，显示 fallback
4. 承诺完成后，Suspense 重新渲染子组件

```jsx
// 简化的内部原理
function Suspense({ children, fallback }) {
  // React 内部状态：是否在等待 Promise
  const [isPending, setIsPending] = useState(false)

  // React 会捕获子组件抛出的 Promise
  // 当 Promise pending 时，显示 fallback
  // 当 Promise resolve 时，重新渲染 children
}
```

### 与 ErrorBoundary 配合

Suspense 可以与 ErrorBoundary 配合，优雅处理错误：

```jsx
function App() {
  return (
    <ErrorBoundary fallback={<ErrorPage />}>
      <Suspense fallback={<LoadingPage />}>
        <UserProfile userId={1} />
      </Suspense>
    </ErrorBoundary>
  )
}
```

## React 18 并发特性

### createRoot 与并发渲染

React 18 的入口点从 `ReactDOM.render` 升级为 `createRoot`：

```jsx
// React 17
import ReactDOM from 'react-dom'
ReactDOM.render(<App />, document.getElementById('root'))

// React 18
import { createRoot } from 'react-dom/client'
const root = createRoot(document.getElementById('root'))
root.render(<App />)
```

`createRoot` 启用了并发模式，允许 React：
- 中断渲染，优先处理用户交互
- 并行渲染多个版本的 UI
- 自动批处理状态更新

### useTransition：非紧急更新

`useTransition` 允许你将某些状态更新标记为"非紧急"：

```jsx
import { useTransition, useState } from 'react'

function SearchResults() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [isPending, startTransition] = useTransition()

  function handleSearch(e) {
    // 紧急更新：立即响应用户输入
    setQuery(e.target.value)

    // 非紧急更新：可以被中断
    startTransition(() => {
      setResults(searchItems(e.target.value))
    })
  }

  return (
    <div>
      <input value={query} onChange={handleSearch} />
      
      {/* isPending 时显示较旧的结果 */}
      <div style={{ opacity: isPending ? 0.6 : 1 }}>
        <ResultList results={results} />
      </div>
    </div>
  )
}
```

### useDeferredValue：延迟更新

`useDeferredValue` 创建一个"延迟"版本的值：

```jsx
import { useDeferredValue, useMemo } from 'react'

function SearchPage({ query }) {
  const deferredQuery = useDeferredValue(query)
  const isStale = query !== deferredQuery

  const results = useMemo(
    () => searchItems(deferredQuery),
    [deferredQuery]
  )

  return (
    <div style={{ opacity: isStale ? 0.7 : 1 }}>
      <ResultList results={results} />
    </div>
  )
}
```

## Suspense 实战应用

### 数据获取

```jsx
// 创建一个简单的数据获取函数
function fetchData(url) {
  let status = 'pending'
  let result = null
  let error = null

  const promise = fetch(url)
    .then(res => res.json())
    .then(data => {
      status = 'success'
      result = data
    })
    .catch(err => {
      status = 'error'
      error = err
    })

  return {
    read() {
      if (status === 'pending') throw promise
      if (status === 'error') throw error
      return result
    }
  }
}

// 使用
const userResource = fetchData('/api/user/1')

function UserProfile() {
  const user = userResource.read()
  return <div>{user.name}</div>
}

function App() {
  return (
    <Suspense fallback={<Spinner />}>
      <UserProfile />
    </Suspense>
  )
}
```

### 多个 Suspense 边界

```jsx
function Dashboard() {
  return (
    <div className="dashboard">
      <header>
        <Suspense fallback={<HeaderSkeleton />}>
          <Header />
        </Suspense>
      </header>

      <main>
        <Suspense fallback={<ContentSkeleton />}>
          <Content />
        </Suspense>
      </main>

      <aside>
        <Suspense fallback={<SidebarSkeleton />}>
          <Sidebar />
        </Suspense>
      </aside>
    </div>
  )
}
```

### 嵌套 Suspense

```jsx
function UserProfile({ userId }) {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <UserHeader userId={userId} />
      
      <Suspense fallback={<PostsSkeleton />}>
        <UserPosts userId={userId} />
      </Suspense>
      
      <Suspense fallback={<FriendsSkeleton />}>
        <UserFriends userId={userId} />
      </Suspense>
    </Suspense>
  )
}
```

## 迁移指南

### 升级步骤

1. **升级依赖**

```bash
npm install react@18 react-dom@18
```

2. **更新入口点**

```jsx
// 旧代码
import ReactDOM from 'react-dom'
ReactDOM.render(<App />, document.getElementById('root'))

// 新代码
import { createRoot } from 'react-dom/client'
const root = createRoot(document.getElementById('root'))
root.render(<App />)
```

3. **处理 StrictMode 变化**

React 18 的 StrictMode 在开发环境下会：
- 组件会渲染两次（检测副作用）
- 每次渲染前重置 React 内部状态

```jsx
// 确保 useEffect 有正确的清理函数
useEffect(() => {
  const subscription = subscribe(id)
  return () => subscription.unsubscribe() // 必须清理
}, [id])
```

### 渐进式迁移

可以在现有项目中逐步引入 Suspense：

```jsx
// 先在局部使用 Suspense
function App() {
  return (
    <div>
      {/* 传统方式的组件保持不变 */}
      <Header />
      
      {/* 新组件使用 Suspense */}
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard />
      </Suspense>
    </div>
  )
}
```

## 性能优化技巧

### 1. 避免不必要的 Suspense

```jsx
// 不推荐：整个应用都用 Suspense
function App() {
  return (
    <Suspense fallback={<Loading />}>
      <EntireApp />
    </Suspense>
  )
}

// 推荐：在合适的粒度使用 Suspense
function App() {
  return (
    <div>
      <Header />
      <Suspense fallback={<MainSkeleton />}>
        <MainContent />
      </Suspense>
    </div>
  )
}
```

### 2. 优先使用 startTransition

```jsx
function FilteredList({ items }) {
  const [filter, setFilter] = useState('')
  const [isPending, startTransition] = useTransition()

  const filteredItems = items.filter(item => 
    item.name.includes(filter)
  )

  return (
    <div>
      <input 
        value={filter}
        onChange={e => {
          // 用户输入立即响应
          setFilter(e.target.value)
          // 列表过滤延迟处理
          startTransition(() => {
            // 触发重新渲染
          })
        }}
      />
      
      <div style={{ opacity: isPending ? 0.5 : 1 }}>
        {filteredItems.map(item => (
          <ListItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
```

## 总结

React 18 的 Suspense 和并发特性为前端开发带来了革命性的变化：

1. **声明式异步处理**：告别手动管理加载状态
2. **流畅的用户体验**：通过非紧急更新避免 UI 卡顿
3. **灵活的架构**：多个 Suspense 边界实现精细化控制
4. **渐进式迁移**：可以在现有项目中逐步引入

掌握这些特性，能够让你构建出更流畅、更易维护的 React 应用，为未来的前端开发奠定坚实基础。
