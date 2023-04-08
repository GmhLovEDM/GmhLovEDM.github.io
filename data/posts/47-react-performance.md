---
title: "React Performance Optimization: The Correct Usage of memo, useMemo, and useCallback"
tag: react
description: An in-depth look at React's core performance optimization APIs, covering best practices for memo, useMemo, and useCallback.
date: "2023-04-08T08:00:00.000Z"
---

## Goal

Performance optimization in React applications is a challenge that developers frequently encounter. `memo`, `useMemo`, and `useCallback` are three core APIs that React provides for performance optimization, yet many developers are unclear about when and how to use them correctly. This article provides a deep analysis of how these three APIs work under the hood, helping developers write truly efficient React code.

## Background

### Why Performance Optimization Matters

React's rendering mechanism dictates that when a component's state or props change, the component re-renders. In certain situations, this re-rendering is unnecessary:

1. **Parent component re-renders**: Causing all child components to re-render as well.
2. **Expensive computations**: Complex calculations being re-executed on every render.
3. **Reference instability**: Causing child components that depend on references to re-render.

### What Performance Problems Look Like

```jsx
// Problem example
function Parent() {
  const [count, setCount] = useState(0)
  const [name, setName] = useState('John')
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* ExpensiveComponent re-renders every time count changes */}
      <ExpensiveComponent name={name} />
      
      {/* A new function reference is created on every render */}
      <Button onClick={() => console.log('clicked')} />
    </div>
  )
}
```

## React.memo

### Basic Usage

```jsx
import { memo } from 'react'

// memo: shallow-compare props to avoid unnecessary re-renders
const ExpensiveComponent = memo(function ExpensiveComponent({ data, onItemClick }) {
  console.log('ExpensiveComponent rendered')
  
  // Expensive computation
  const processedData = data.map(item => ({
    ...item,
    fullName: `${item.firstName} ${item.lastName}`,
    timestamp: new Date(item.createdAt).toLocaleDateString()
  }))
  
  return (
    <ul>
      {processedData.map(item => (
        <li key={item.id} onClick={() => onItemClick(item.id)}>
          {item.fullName} - {item.timestamp}
        </li>
      ))}
    </ul>
  )
})
```

### Custom Comparison Function

```jsx
const UserCard = memo(
  function UserCard({ user, onUpdate }) {
    return (
      <div className="user-card">
        <img src={user.avatar} alt={user.name} />
        <h3>{user.name}</h3>
        <p>{user.email}</p>
        <button onClick={() => onUpdate(user.id)}>Update</button>
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Custom comparison logic
    // Returning true means no re-render is needed
    return (
      prevProps.user.id === nextProps.user.id &&
      prevProps.user.name === nextProps.user.name
    )
  }
)
```

### When to Use memo

```jsx
// Scenario 1: Child component receives stable props
function Parent() {
  const [count, setCount] = useState(0)
  
  // This props object is stable; the child does not need to re-render
  const stableProps = useMemo(() => ({
    title: 'Static Title',
    description: 'Static Description'
  }), [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* Wrapped with memo */}
      <StaticComponent {...stableProps} />
    </div>
  )
}

// Scenario 2: List item components
function UserList({ users }) {
  return (
    <ul>
      {users.map(user => (
        // Each list item is independent and can use memo
        <UserItem key={user.id} user={user} />
      ))}
    </ul>
  )
}

const UserItem = memo(function UserItem({ user }) {
  return (
    <li>
      <span>{user.name}</span>
      <span>{user.email}</span>
    </li>
  )
})
```

## useMemo

### Basic Usage

```jsx
import { useMemo } from 'react'

function DataProcessor({ data, filter, sortBy }) {
  // useMemo: cache the result of a computation
  const processedData = useMemo(() => {
    console.log('Processing data...')
    
    return data
      .filter(item => item.category === filter)
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name)
        if (sortBy === 'date') return new Date(a.date) - new Date(b.date)
        return 0
      })
      .map(item => ({
        ...item,
        fullName: `${item.firstName} ${item.lastName}`
      }))
  }, [data, filter, sortBy]) // dependency array
  
  return (
    <ul>
      {processedData.map(item => (
        <li key={item.id}>{item.fullName}</li>
      ))}
    </ul>
  )
}
```

### When to Use useMemo

```jsx
// Scenario 1: Expensive computation
function ExpensiveComponent({ items }) {
  const sortedItems = useMemo(() => {
    // Sorting is an expensive operation
    return [...items].sort((a, b) => a.value - b.value)
  }, [items])
  
  return (
    <ul>
      {sortedItems.map(item => (
        <li key={item.id}>{item.value}</li>
      ))}
    </ul>
  )
}

// Scenario 2: Creating stable object references
function Parent() {
  const [count, setCount] = useState(0)
  
  // A new object is created on every render
  const options = { theme: 'dark', language: 'en' }
  
  // Using useMemo to create a stable object reference
  const stableOptions = useMemo(() => ({
    theme: 'dark',
    language: 'en'
  }), [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* Without useMemo: child re-renders every time the parent re-renders */}
      <ChildComponent options={options} />
      
      {/* With useMemo: child only re-renders when options actually change */}
      <MemoizedChild options={stableOptions} />
    </div>
  )
}

const MemoizedChild = memo(function ChildComponent({ options }) {
  console.log('Child rendered')
  return <div>{options.theme}</div>
})
```

### Do Not Overuse useMemo

```jsx
// Wrong: using useMemo unnecessarily
function Component({ value }) {
  // Simple computation, no need for useMemo
  const doubled = useMemo(() => value * 2, [value])
  
  // Simple object, no need for useMemo
  const style = useMemo(() => ({ color: 'red' }), [])
  
  return (
    <div style={style}>
      {doubled}
    </div>
  )
}

// Correct: only use useMemo when necessary
function Component({ value }) {
  // Simple computation, just use it directly
  const doubled = value * 2
  
  // Simple object, create it directly
  const style = { color: 'red' }
  
  return (
    <div style={style}>
      {doubled}
    </div>
  )
}
```

## useCallback

### Basic Usage

```jsx
import { useCallback } from 'react'

function TodoList({ todos, onAddTodo, onToggleTodo }) {
  // useCallback: cache a function reference
  const handleAddTodo = useCallback((text) => {
    onAddTodo({
      id: Date.now(),
      text,
      done: false
    })
  }, [onAddTodo]) // depends on onAddTodo
  
  const handleToggleTodo = useCallback((id) => {
    onToggleTodo(id)
  }, [onToggleTodo]) // depends on onToggleTodo
  
  return (
    <div>
      <AddTodoForm onAdd={handleAddTodo} />
      
      <ul>
        {todos.map(todo => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={handleToggleTodo}
          />
        ))}
      </ul>
    </div>
  )
}

const AddTodoForm = memo(function AddTodoForm({ onAdd }) {
  const [text, setText] = useState('')
  
  const handleSubmit = (e) => {
    e.preventDefault()
    if (text.trim()) {
      onAdd(text)
      setText('')
    }
  }
  
  return (
    <form onSubmit={handleSubmit}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add todo..."
      />
      <button type="submit">Add</button>
    </form>
  )
})

const TodoItem = memo(function TodoItem({ todo, onToggle }) {
  return (
    <li>
      <input
        type="checkbox"
        checked={todo.done}
        onChange={() => onToggle(todo.id)}
      />
      <span style={{ textDecoration: todo.done ? 'line-through' : 'none' }}>
        {todo.text}
      </span>
    </li>
  )
})
```

### When to Use useCallback

```jsx
// Scenario 1: Child component receives a callback
function Parent() {
  const [count, setCount] = useState(0)
  
  // Without useCallback: a new function is created on every render
  const handleClick = () => {
    console.log('clicked')
  }
  
  // With useCallback: the function reference is stable
  const stableHandleClick = useCallback(() => {
    console.log('clicked')
  }, [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* Without memo: child re-renders */}
      <ChildComponent onClick={handleClick} />
      
      {/* With memo: child does not re-render */}
      <MemoizedChild onClick={stableHandleClick} />
    </div>
  )
}

const MemoizedChild = memo(function ChildComponent({ onClick }) {
  console.log('Child rendered')
  return <button onClick={onClick}>Click me</button>
})
```

### Relationship with useMemo

```jsx
// The relationship between useMemo and useCallback
function Component({ items }) {
  // useMemo caches a value
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => a.value - b.value)
  }, [items])
  
  // useCallback caches a function
  const handleSort = useCallback(() => {
    // sorting logic
  }, [])
  
  // This is equivalent to using useMemo to cache a function
  const handleSort2 = useMemo(() => {
    return () => {
      // sorting logic
    }
  }, [])
}
```

## Practical Examples

### Optimizing List Rendering

```jsx
// Before optimization: every parent re-render causes all list items to re-render
function TodoList({ todos }) {
  const [filter, setFilter] = useState('all')
  
  const filteredTodos = todos.filter(todo => {
    if (filter === 'active') return !todo.done
    if (filter === 'completed') return todo.done
    return true
  })
  
  return (
    <div>
      <FilterBar filter={filter} onFilterChange={setFilter} />
      
      <ul>
        {filteredTodos.map(todo => (
          <TodoItem key={todo.id} todo={todo} />
        ))}
      </ul>
    </div>
  )
}

// After optimization: using memo and useCallback
function TodoList({ todos }) {
  const [filter, setFilter] = useState('all')
  
  const filteredTodos = useMemo(() => {
    return todos.filter(todo => {
      if (filter === 'active') return !todo.done
      if (filter === 'completed') return todo.done
      return true
    })
  }, [todos, filter])
  
  const handleFilterChange = useCallback((newFilter) => {
    setFilter(newFilter)
  }, [])
  
  return (
    <div>
      <FilterBar filter={filter} onFilterChange={handleFilterChange} />
      
      <ul>
        {filteredTodos.map(todo => (
          <TodoItem key={todo.id} todo={todo} />
        ))}
      </ul>
    </div>
  )
}

const FilterBar = memo(function FilterBar({ filter, onFilterChange }) {
  return (
    <div>
      {['all', 'active', 'completed'].map(f => (
        <button
          key={f}
          onClick={() => onFilterChange(f)}
          style={{ fontWeight: filter === f ? 'bold' : 'normal' }}
        >
          {f}
        </button>
      ))}
    </div>
  )
})

const TodoItem = memo(function TodoItem({ todo }) {
  return (
    <li>
      <input type="checkbox" checked={todo.done} readOnly />
      <span>{todo.text}</span>
    </li>
  )
})
```

### Optimizing Forms

```jsx
// Optimizing form performance
function UserForm() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    age: ''
  })
  
  const [errors, setErrors] = useState({})
  
  // Use useCallback to cache event handlers
  const handleChange = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }, [])
  
  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    // Validation logic
    const newErrors = {}
    if (!formData.name) newErrors.name = 'Name is required'
    if (!formData.email) newErrors.email = 'Email is required'
    
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    
    // Submit form
    console.log('Submitting:', formData)
  }, [formData])
  
  // Use useMemo to cache validation rules
  const validationRules = useMemo(() => ({
    name: (value) => value.length >= 2 ? null : 'Name must be at least 2 characters',
    email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'Invalid email',
    age: (value) => value >= 18 ? null : 'Must be at least 18'
  }), [])
  
  return (
    <form onSubmit={handleSubmit}>
      <FormField
        label="Name"
        value={formData.name}
        error={errors.name}
        onChange={(value) => handleChange('name', value)}
        validate={validationRules.name}
      />
      
      <FormField
        label="Email"
        value={formData.email}
        error={errors.email}
        onChange={(value) => handleChange('email', value)}
        validate={validationRules.email}
      />
      
      <FormField
        label="Age"
        type="number"
        value={formData.age}
        error={errors.age}
        onChange={(value) => handleChange('age', value)}
        validate={validationRules.age}
      />
      
      <button type="submit">Submit</button>
    </form>
  )
}

const FormField = memo(function FormField({ label, value, error, onChange, validate }) {
  const handleChange = useCallback((e) => {
    onChange(e.target.value)
  }, [onChange])
  
  return (
    <div>
      <label>{label}</label>
      <input
        value={value}
        onChange={handleChange}
        className={error ? 'error' : ''}
      />
      {error && <span className="error-message">{error}</span>}
    </div>
  )
})
```

## Performance Profiling Tools

### React DevTools

```jsx
// Using React DevTools to analyze performance
// 1. Open React DevTools
// 2. Click on the "Profiler" tab
// 3. Record performance data
// 4. Analyze re-render situations
```

### Custom Performance Monitoring

```jsx
function withPerformanceMonitor(WrappedComponent) {
  return function PerformanceMonitoredComponent(props) {
    const renderCount = useRef(0)
    const lastRenderTime = useRef(Date.now())
    
    useEffect(() => {
      const currentTime = Date.now()
      const timeSinceLastRender = currentTime - lastRenderTime.current
      
      console.log(`${WrappedComponent.name} rendered ${renderCount.current} times`)
      console.log(`Time since last render: ${timeSinceLastRender}ms`)
      
      renderCount.current++
      lastRenderTime.current = currentTime
    })
    
    return <WrappedComponent {...props} />
  }
}

// Usage
const MonitoredComponent = withPerformanceMonitor(ExpensiveComponent)
```

## Summary

`memo`, `useMemo`, and `useCallback` are the core tools for React performance optimization:

1. **memo**: Caches components to avoid unnecessary re-renders.
2. **useMemo**: Caches computation results to avoid redundant calculations.
3. **useCallback**: Caches function references to prevent child component re-renders.

**Guiding principles**:

- Do not optimize prematurely: measure first, then optimize.
- Use only when necessary: simple computations do not need useMemo.
- Focus on the component tree: optimize components on the critical path.
- Use them in combination: `memo` + `useMemo` + `useCallback`.

Mastering when to use these tools correctly will help your React application run more smoothly.
