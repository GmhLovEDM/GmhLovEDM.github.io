---
title: "SWR vs React Query: A Deep Comparison of Data Fetching Libraries"
tag: react
description: An in-depth comparison of SWR and React Query, two popular data fetching libraries, to help developers choose the best option for their needs.
date: "2023-04-22T08:00:00.000Z"
---

## Goal

In modern React applications, data fetching is a fundamental requirement. SWR and React Query are the two most popular data fetching libraries, and both provide caching, revalidation, error handling, and more. This article compares them across multiple dimensions to help developers make the right technical decision.

## Background

### The Problem with Traditional Data Fetching

```jsx
// Traditional approach: manually managing data fetching
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

Problems with this approach:
- Every component must repeat the same fetching logic.
- Caching, revalidation, and error handling must all be implemented manually.
- There is no unified state management layer.
- Performance optimization is difficult to achieve.

### How SWR and React Query Solve This

```jsx
// SWR approach
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

// React Query approach
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

## Core Feature Comparison

### SWR

```jsx
import useSWR, { useSWRConfig, preload } from 'swr'

// Basic usage
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

// Global configuration
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

// Preloading
preload('/api/users/1', fetcher) // Preload before the component mounts

// Optimistic updates
function TodoList() {
  const { data: todos, mutate } = useSWR('/api/todos')
  
  const addTodo = async (newTodo) => {
    // Optimistic update
    mutate(
      [...todos, newTodo],
      { revalidate: false } // Do not revalidate immediately
    )
    
    try {
      await fetch('/api/todos', {
        method: 'POST',
        body: JSON.stringify(newTodo)
      })
      
      // Revalidate to get the server state
      mutate()
    } catch (error) {
      // Rollback
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

// Create QueryClient
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      cacheTime: 30 * 60 * 1000, // 30 minutes
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

// Basic usage
function UserProfile({ userId }) {
  const { data: user, error, isLoading, isFetching } = useQuery({
    queryKey: ['user', userId],
    queryFn: async () => {
      const res = await fetch(`/api/users/${userId}`)
      if (!res.ok) throw new Error('Failed to fetch')
      return res.json()
    },
    enabled: !!userId, // Conditional query
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
    
    // Optimistic update
    onMutate: async (newTodo) => {
      await queryClient.cancelQueries({ queryKey: ['todos'] })
      
      const previousTodos = queryClient.getQueryData(['todos'])
      
      queryClient.setQueryData(['todos'], (old) => [
        ...old,
        newTodo
      ])
      
      return { previousTodos }
    },
    
    // Error rollback
    onError: (err, newTodo, context) => {
      queryClient.setQueryData(['todos'], context.previousTodos)
    },
    
    // Revalidate after success
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

## Feature Comparison

### Caching Strategies

```jsx
// SWR: global configuration
useSWR(key, fetcher, {
  dedupingInterval: 2000, // Deduplication interval
  focusThrottleInterval: 5000, // Focus throttle
  loadingTimeout: 3000, // Loading timeout
  errorRetryCount: 3, // Error retry count
  errorRetryInterval: 5000, // Error retry interval
  refreshInterval: 0, // Auto-refresh interval
  refreshWhenHidden: false, // Refresh when hidden
  revalidateOnFocus: true, // Revalidate on focus
  revalidateOnReconnect: true // Revalidate on reconnect
})

// React Query: more granular control
useQuery({
  queryKey: ['user', userId],
  queryFn: fetchUser,
  staleTime: 5 * 60 * 1000, // How long data stays fresh
  cacheTime: 30 * 60 * 1000, // How long data stays in cache
  refetchInterval: false, // Auto-refresh
  refetchIntervalInBackground: false, // Background refresh
  refetchOnWindowFocus: true, // Refetch on window focus
  refetchOnMount: true, // Refetch on mount
  refetchOnReconnect: true, // Refetch on reconnect
  retry: 3, // Retry count
  retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Retry delay
  enabled: true // Enable the query
})
```

### Data Transformation

```jsx
// SWR
function UserList() {
  const { data: users } = useSWR('/api/users', fetcher, {
    onSuccess: (data) => {
      console.log('Data fetched:', data)
    },
    onError: (error) => {
      console.error('Fetch error:', error)
    }
  })
  
  // Manual transformation
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
      // Automatic transformation
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

### Pagination

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
    keepPreviousData: true // Keep previous data while loading
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
// SWR: no built-in DevTools
// Requires third-party tools or custom implementation

// React Query: built-in DevTools
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

## Bundle Size

```bash
# SWR
swr: ~14 kB (gzipped)

# React Query
@tanstack/react-query: ~13 kB (gzipped)
@tanstack/react-query-devtools: ~7 kB (gzipped)
Total: ~20 kB (gzipped)
```

## Use Cases

### Choose SWR When

1. **Simple data fetching**: You only need basic caching and revalidation.
2. **Lightweight needs**: Bundle size is a concern.
3. **Next.js projects**: Better integration with the Next.js ecosystem.
4. **Static sites**: Suitable for SSG and ISR scenarios.

### Choose React Query When

1. **Complex data management**: You need rich caching strategies.
2. **Optimistic updates**: You need robust optimistic update support.
3. **Offline support**: You need offline caching and synchronization.
4. **Large-scale applications**: You need better DevTools and debugging support.
5. **TypeScript**: You need superior type support.

## Comparison Table

| Feature | SWR | React Query |
|---------|-----|-------------|
| Bundle Size | ~14 kB | ~20 kB |
| API Complexity | Simple | Moderate |
| Caching Strategy | Basic | Rich |
| Optimistic Updates | Supported | More Complete |
| DevTools | None | Built-in |
| Offline Support | Basic | Complete |
| TypeScript | Good | Excellent |
| Documentation | Good | Excellent |
| Community | Active | Active |

## Summary

Both SWR and React Query are excellent data fetching libraries:

1. **SWR**: Lightweight and simple, ideal for small to medium projects.
2. **React Query**: Feature-rich with comprehensive tooling, ideal for large projects.

Selection recommendations:

- **Simple scenarios**: SWR
- **Complex scenarios**: React Query
- **Next.js projects**: SWR
- **React projects**: React Query
- **Bundle size sensitive**: SWR
- **Feature-rich needs**: React Query

Regardless of which you choose, either library will significantly improve your data fetching development experience and application performance.
