---
title: "Exploring React 18: Suspense and Concurrent Mode in Action"
tag: react
description: 深入理解 React 18 的 Suspense 和并发特性，掌握新一代 React 应用开发范式。
date: "2022-09-03T08:00:00.000Z"
---

## Goal

React 18 introduced concurrent features (Concurrent Features), representing a major architectural upgrade for React. Suspense, as the core component of concurrent mode, provides us with an elegant way to handle asynchronous operations. This article takes a deep dive into Suspense's working principles, practical applications of concurrent mode, and how to safely migrate existing projects to React 18.

## Background

### The Pain Points of Traditional Asynchronous Handling

Before React 18, handling data loading typically required:

```jsx
// Traditional approach: manually managing loading state
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

This approach has several problems:
- Every component needs to duplicate loading state management logic
- The user experience is fragmented, with multiple components each showing their own loading states
- Data dependency relationships are difficult to manage
- Nested asynchronous operations cannot be handled elegantly

### Suspense's Solution

Suspense handles asynchronous state declaratively, allowing any child component in the tree to "pause" rendering until an asynchronous operation completes:

```jsx
// Suspense approach: declarative asynchronous handling
function UserProfile({ userId }) {
  // Use data directly, no manual loading state management needed
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

## How Suspense Works

### Core Concepts

Suspense's working mechanism can be summarized as:

1. A child component triggers an asynchronous operation (via a special hook or promise)
2. When the asynchronous operation is not yet complete, it throws a "promise"
3. Suspense catches this promise and displays the fallback
4. When the promise resolves, Suspense re-renders the child component

```jsx
// Simplified internal mechanism
function Suspense({ children, fallback }) {
  // Internal React state: whether waiting for a Promise
  const [isPending, setIsPending] = useState(false)

  // React catches the Promise thrown by child components
  // When the Promise is pending, display the fallback
  // When the Promise resolves, re-render the children
}
```

### Working with ErrorBoundary

Suspense can be combined with ErrorBoundary to handle errors elegantly:

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

## React 18 Concurrent Features

### createRoot and Concurrent Rendering

React 18's entry point upgraded from `ReactDOM.render` to `createRoot`:

```jsx
// React 17
import ReactDOM from 'react-dom'
ReactDOM.render(<App />, document.getElementById('root'))

// React 18
import { createRoot } from 'react-dom/client'
const root = createRoot(document.getElementById('root'))
root.render(<App />)
```

`createRoot` enables concurrent mode, allowing React to:
- Interrupt rendering to prioritize user interactions
- Render multiple versions of the UI in parallel
- Automatically batch state updates

### useTransition: Non-Urgent Updates

`useTransition` allows you to mark certain state updates as "non-urgent":

```jsx
import { useTransition, useState } from 'react'

function SearchResults() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [isPending, startTransition] = useTransition()

  function handleSearch(e) {
    // Urgent update: respond immediately to user input
    setQuery(e.target.value)

    // Non-urgent update: can be interrupted
    startTransition(() => {
      setResults(searchItems(e.target.value))
    })
  }

  return (
    <div>
      <input value={query} onChange={handleSearch} />
      
      {/* Show older results while isPending is true */}
      <div style={{ opacity: isPending ? 0.6 : 1 }}>
        <ResultList results={results} />
      </div>
    </div>
  )
}
```

### useDeferredValue: Deferred Updates

`useDeferredValue` creates a "deferred" version of a value:

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

## Suspense in Practice

### Data Fetching

```jsx
// Create a simple data fetching function
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

// Usage
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

### Multiple Suspense Boundaries

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

### Nested Suspense

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

## Migration Guide

### Upgrade Steps

1. **Upgrade dependencies**

```bash
npm install react@18 react-dom@18
```

2. **Update the entry point**

```jsx
// Old code
import ReactDOM from 'react-dom'
ReactDOM.render(<App />, document.getElementById('root'))

// New code
import { createRoot } from 'react-dom/client'
const root = createRoot(document.getElementById('root'))
root.render(<App />)
```

3. **Handle StrictMode changes**

React 18's StrictMode in development will:
- Render components twice (to detect side effects)
- Reset React's internal state before each render

```jsx
// Make sure useEffect has proper cleanup functions
useEffect(() => {
  const subscription = subscribe(id)
  return () => subscription.unsubscribe() // Must clean up
}, [id])
```

### Gradual Migration

You can introduce Suspense incrementally into existing projects:

```jsx
// Start by using Suspense in specific areas
function App() {
  return (
    <div>
      {/* Components using traditional approach remain unchanged */}
      <Header />
      
      {/* New components use Suspense */}
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard />
      </Suspense>
    </div>
  )
}
```

## Performance Optimization Tips

### 1. Avoid Unnecessary Suspense

```jsx
// Not recommended: wrapping the entire app in Suspense
function App() {
  return (
    <Suspense fallback={<Loading />}>
      <EntireApp />
    </Suspense>
  )
}

// Recommended: use Suspense at the right granularity
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

### 2. Prefer startTransition for Expensive Updates

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
          // User input responds immediately
          setFilter(e.target.value)
          // List filtering is deferred
          startTransition(() => {
            // Triggers re-render
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

## Summary

React 18's Suspense and concurrent features bring revolutionary changes to front-end development:

1. **Declarative asynchronous handling**: Say goodbye to manual loading state management
2. **Smooth user experience**: Avoid UI jank through non-urgent updates
3. **Flexible architecture**: Multiple Suspense boundaries enable fine-grained control
4. **Gradual migration**: Can be introduced incrementally into existing projects

Mastering these features enables you to build smoother, more maintainable React applications and lays a solid foundation for the future of front-end development.
