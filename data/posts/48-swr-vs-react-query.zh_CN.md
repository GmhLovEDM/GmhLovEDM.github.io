---
title: "SWR vs React Query：数据请求库深度对比"
tag: react
description: 深度对比 SWR 和 React Query 两大数据请求库，帮助开发者选择最适合的方案。
date: "2023-04-22T08:00:00.000Z"
---

## 目标

在现代 React 应用中，数据请求是一个核心需求。SWR 和 React Query 是两个最流行的数据请求库，它们都提供了缓存、重新验证、错误处理等功能。本文将从多个维度对两者进行深度对比，帮助开发者做出最合适的技术选型。

## 背景

### 传统数据请求的问题

```jsx
// 传统方式：手动管理数据请求
function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  useEffect(() => {
    let cancelled = false
    
    async function fetchUser() {
      try {
        setLoading(true)
        const response = await fetch(`/api/users/${userId}`)
        
        if (!response.ok) {
          throw new Error('Failed to fetch user')
        }
        
        const data = await response.json()
        
        if (!cancelled) {
          setUser(data)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
          setUser(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    
    fetchUser()
    
    return () => {
      cancelled = true
    }
  }, [userId])
  
  if (loading) return <Spinner />
  if (error) return <ErrorMessage error={error} />
  
  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}
```

问题：
- 每个组件都要重复编写请求逻辑
- 缓存、重新验证、错误处理都需要手动实现
- 缺乏统一的状态管理
- 性能优化困难

### SWR 和 React Query 的解决方案

```jsx
// SWR 方式
function UserProfile({ userId }) {
  const { data: user, error, isLoading } = useSWR(`/api/users/${userId}`)
  
  if (isLoading) return <Spinner />
  if (error) return <ErrorMessage error={error} />
  
  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}

// React Query 方式
function UserProfile({ userId }) {
  const { data: user, error, isLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn: () => fetch(`/api/users/${userId}`).then(r => r.json())
  })
  
  if (isLoading) return <Spinner />
  if (error) return <ErrorMessage error={error} />
  
  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  )
}
```

## 核心特性对比

### SWR

```jsx
import useSWR, { useSWRConfig, preload } from 'swr'

// 基础用法
function UserProfile({ userId }) {
  const { data, error, isLoading, isValidating } = useSWR(
    `/api/users/${userId}`,
    fetcher,
    {
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      refreshInterval: 0,
      dedupingInterval: 2000
    }
  )
  
  return <div>{data?.name}</div>
}

// 全局配置
function App() {
  return (
    <SWRConfig
      value={{
        fetcher: async (url) => {
          const res = await fetch(url)
          return res.json()
        },
        refreshInterval: 30000,
        revalidateOnFocus: true
      }}
    >
      <UserProfile />
      <TodoList />
    </SWRConfig>
  )
}

// 预加载
preload('/api/users/1', fetcher) // 在组件挂载前预加载

// 乐观更新
function TodoList() {
  const { data: todos, mutate } = useSWR('/api/todos')
  
  const addTodo = async (newTodo) => {
    // 乐观更新
    mutate(
      [...todos, newTodo],
      { revalidate: false } // 不立即重新验证
    )
    
    try {
      await fetch('/api/todos', {
        method: 'POST',
        body: JSON.stringify(newTodo)
      })
      
      // 重新验证以获取服务器状态
      mutate()
    } catch (error) {
      // 回滚
      mutate(todos)
    }
  }
  
  return (
    <div>
      <AddTodoForm onAdd={addTodo} />
      <ul>
        {todos?.map(todo => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </div>
  )
}
```

### React Query

```jsx
import { useQuery, useMutation, useQueryClient, QueryClient, QueryClientProvider } from '@tanstack/react-query'

// 创建 QueryClient
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 分钟
      cacheTime: 30 * 60 * 1000, // 30 分钟
      refetchOnWindowFocus: true,
      retry: 3
    }
  }
})

// Provider
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <UserProfile />
      <TodoList />
    </QueryClientProvider>
  )
}

// 基础用法
function UserProfile({ userId }) {
  const { data: user, error, isLoading, isFetching } = useQuery({
    queryKey: ['user', userId],
    queryFn: async () => {
      const res = await fetch(`/api/users/${userId}`)
      if (!res.ok) throw new Error('Failed to fetch')
      return res.json()
    },
    enabled: !!userId, // 条件查询
    staleTime: 5 * 60 * 1000,
    cacheTime: 30 * 60 * 1000
  })
  
  return <div>{user?.name}</div>
}

// Mutation
function TodoList() {
  const queryClient = useQueryClient()
  
  const { data: todos } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos
  })
  
  const addTodoMutation = useMutation({
    mutationFn: addTodo,
    
    // 乐观更新
    onMutate: async (newTodo) => {
      await queryClient.cancelQueries({ queryKey: ['todos'] })
      
      const previousTodos = queryClient.getQueryData(['todos'])
      
      queryClient.setQueryData(['todos'], (old) => [
        ...old,
        newTodo
      ])
      
      return { previousTodos }
    },
    
    // 错误回滚
    onError: (err, newTodo, context) => {
      queryClient.setQueryData(['todos'], context.previousTodos)
    },
    
    // 成功后重新验证
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['todos'] })
    }
  })
  
  return (
    <div>
      <button 
        onClick={() => addTodoMutation.mutate({ text: 'New Todo' })}
        disabled={addTodoMutation.isLoading}
      >
        {addTodoMutation.isLoading ? 'Adding...' : 'Add Todo'}
      </button>
      
      <ul>
        {todos?.map(todo => (
          <li key={todo.id}>{todo.text}</li>
        ))}
      </ul>
    </div>
  )
}
```

## 功能对比

### 缓存策略

```jsx
// SWR：全局配置
useSWR(key, fetcher, {
  dedupingInterval: 2000, // 去重间隔
  focusThrottleInterval: 5000, // 聚焦节流
  loadingTimeout: 3000, // 加载超时
  errorRetryCount: 3, // 错误重试次数
  errorRetryInterval: 5000, // 错误重试间隔
  refreshInterval: 0, // 自动刷新间隔
  refreshWhenHidden: false, // 隐藏时刷新
  revalidateOnFocus: true, // 聚焦时重新验证
  revalidateOnReconnect: true // 重连时重新验证
})

// React Query：更细粒度的控制
useQuery({
  queryKey: ['user', userId],
  queryFn: fetchUser,
  staleTime: 5 * 60 * 1000, // 数据新鲜时间
  cacheTime: 30 * 60 * 1000, // 缓存时间
  refetchInterval: false, // 自动刷新
  refetchIntervalInBackground: false, // 后台刷新
  refetchOnWindowFocus: true, // 窗口聚焦时刷新
  refetchOnMount: true, // 挂载时刷新
  refetchOnReconnect: true, // 重连时刷新
  retry: 3, // 重试次数
  retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // 重试延迟
  enabled: true // 启用查询
})
```

### 数据转换

```jsx
// SWR
function UserList() {
  const { data: users } = useSWR('/api/users', fetcher, {
    // 数据转换
    onSuccess: (data) => {
      console.log('Data fetched:', data)
    },
    onError: (error) => {
      console.error('Fetch error:', error)
    }
  })
  
  // 手动转换
  const sortedUsers = users?.slice().sort((a, b) => a.name.localeCompare(b.name))
  
  return (
    <ul>
      {sortedUsers?.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}

// React Query
function UserList() {
  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
    select: (data) => {
      // 自动转换数据
      return data
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(user => ({
          ...user,
          displayName: `${user.firstName} ${user.lastName}`
        }))
    }
  })
  
  return (
    <ul>
      {users?.map(user => (
        <li key={user.id}>{user.displayName}</li>
      ))}
    </ul>
  )
}
```

### 分页

```jsx
// SWR
function UserList() {
  const [page, setPage] = useState(1)
  
  const { data, error, isLoading } = useSWR(
    `/api/users?page=${page}&limit=10`,
    fetcher
  )
  
  return (
    <div>
      <ul>
        {data?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
      
      <button 
        onClick={() => setPage(p => Math.max(1, p - 1))}
        disabled={page === 1}
      >
        Previous
      </button>
      
      <span>Page {page}</span>
      
      <button 
        onClick={() => setPage(p => p + 1)}
        disabled={data?.users.length < 10}
      >
        Next
      </button>
    </div>
  )
}

// React Query
function UserList() {
  const [page, setPage] = useState(1)
  
  const { data, error, isLoading } = useQuery({
    queryKey: ['users', page],
    queryFn: () => fetchUsers(page, 10),
    keepPreviousData: true // 保持之前的数据
  })
  
  return (
    <div>
      <ul>
        {data?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
      
      <button 
        onClick={() => setPage(p => Math.max(1, p - 1))}
        disabled={page === 1}
      >
        Previous
      </button>
      
      <span>Page {page}</span>
      
      <button 
        onClick={() => setPage(p => p + 1)}
        disabled={data?.users.length < 10}
      >
        Next
      </button>
    </div>
  )
}
```

### DevTools

```jsx
// SWR：无内置 DevTools
// 需要使用第三方工具或自定义实现

// React Query：内置 DevTools
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <App />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

## Bundle 大小

```bash
# SWR
swr: ~14 kB (gzipped)

# React Query
@tanstack/react-query: ~13 kB (gzipped)
@tanstack/react-query-devtools: ~7 kB (gzipped)
总计: ~20 kB (gzipped)
```

## 适用场景

### 选择 SWR 的场景

1. **简单数据请求**：只需要基本的缓存和重新验证
2. **轻量级需求**：对 bundle 大小敏感
3. **Next.js 项目**：与 Next.js 生态集成更好
4. **静态站点**：适合 SSG 和 ISR 场景

### 选择 React Query 的场景

1. **复杂数据管理**：需要丰富的缓存策略
2. **乐观更新**：需要完善的乐观更新支持
3. **离线支持**：需要离线缓存和同步
4. **大规模应用**：需要更好的 DevTools 和调试支持
5. **TypeScript**：需要更好的类型支持

## 对比表格

| 特性 | SWR | React Query |
|------|-----|-------------|
| Bundle 大小 | ~14 kB | ~20 kB |
| API 复度 | 简单 | 中等 |
| 缓存策略 | 基础 | 丰富 |
| 乐观更新 | 支持 | 更完善 |
| DevTools | 无 | 内置 |
| 离线支持 | 基础 | 完善 |
| TypeScript | 良好 | 优秀 |
| 文档 | 良好 | 优秀 |
| 社区 | 活跃 | 活跃 |

## 总结

SWR 和 React Query 都是优秀的数据请求库：

1. **SWR**：轻量、简单，适合中小型项目
2. **React Query**：功能丰富、工具完善，适合大型项目

选择建议：

- **简单场景**：SWR
- **复杂场景**：React Query
- **Next.js 项目**：SWR
- **React 项目**：React Query
- **对 bundle 大小敏感**：SWR
- **需要丰富功能**：React Query

无论选择哪个，都能显著提升数据请求的开发体验和应用性能。
