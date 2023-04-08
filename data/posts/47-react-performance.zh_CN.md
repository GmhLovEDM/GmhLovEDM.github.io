---
title: "React 性能优化：memo、useMemo、useCallback 的正确使用"
tag: react
description: 深入理解 React 性能优化的核心 API，掌握 memo、useMemo、useCallback 的最佳实践。
date: "2023-04-08T08:00:00.000Z"
---

## 目标

React 应用的性能优化是开发者经常面临的问题。memo、useMemo、useCallback 是 React 提供的三个核心性能优化 API，但很多开发者并不清楚它们的正确使用时机和方式。本文将深入解析这三个 API 的工作原理，帮助开发者写出真正高效的 React 代码。

## 背景

### 为什么需要性能优化

React 的渲染机制决定了当组件的 state 或 props 发生变化时，组件会重新渲染。在某些情况下，这种重新渲染是不必要的：

1. **父组件重渲染**：导致所有子组件都重新渲染
2. **昂贵的计算**：每次渲染都重复执行复杂计算
3. **引用变化**：导致依赖引用的子组件重新渲染

### 性能问题的表现

```jsx
// 问题示例
function Parent() {
  const [count, setCount] = useState(0)
  const [name, setName] = useState('John')
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* 每次 count 变化时，ExpensiveComponent 都会重新渲染 */}
      <ExpensiveComponent name={name} />
      
      {/* 每次渲染都会创建新的函数引用 */}
      <Button onClick={() => console.log('clicked')} />
    </div>
  )
}
```

## React.memo

### 基本用法

```jsx
import { memo } from 'react'

// memo：浅比较 props，避免不必要的重渲染
const ExpensiveComponent = memo(function ExpensiveComponent({ data, onItemClick }) {
  console.log('ExpensiveComponent rendered')
  
  // 昂贵的计算
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

### 自定义比较函数

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
    // 自定义比较逻辑
    // 返回 true 表示不需要重渲染
    return (
      prevProps.user.id === nextProps.user.id &&
      prevProps.user.name === nextProps.user.name
    )
  }
)
```

### 何时使用 memo

```jsx
// 场景 1：子组件接收稳定的 props
function Parent() {
  const [count, setCount] = useState(0)
  
  // 这个 props 是稳定的，子组件不需要重渲染
  const stableProps = useMemo(() => ({
    title: 'Static Title',
    description: 'Static Description'
  }), [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* 使用 memo 包裹 */}
      <StaticComponent {...stableProps} />
    </div>
  )
}

// 场景 2：列表项组件
function UserList({ users }) {
  return (
    <ul>
      {users.map(user => (
        // 每个列表项都是独立的，可以使用 memo
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

### 基本用法

```jsx
import { useMemo } from 'react'

function DataProcessor({ data, filter, sortBy }) {
  // useMemo：缓存计算结果
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
  }, [data, filter, sortBy]) // 依赖数组
  
  return (
    <ul>
      {processedData.map(item => (
        <li key={item.id}>{item.fullName}</li>
      ))}
    </ul>
  )
}
```

### 何时使用 useMemo

```jsx
// 场景 1：昂贵的计算
function ExpensiveComponent({ items }) {
  const sortedItems = useMemo(() => {
    // 排序是昂贵的操作
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

// 场景 2：创建稳定的对象引用
function Parent() {
  const [count, setCount] = useState(0)
  
  // 每次渲染都会创建新的对象
  const options = { theme: 'dark', language: 'en' }
  
  // 使用 useMemo 创建稳定的对象引用
  const stableOptions = useMemo(() => ({
    theme: 'dark',
    language: 'en'
  }), [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* 不使用 useMemo：每次父组件重渲染，子组件都会重渲染 */}
      <ChildComponent options={options} />
      
      {/* 使用 useMemo：只有当 options 变化时，子组件才重渲染 */}
      <MemoizedChild options={stableOptions} />
    </div>
  )
}

const MemoizedChild = memo(function ChildComponent({ options }) {
  console.log('Child rendered')
  return <div>{options.theme}</div>
})
```

### 不要滥用 useMemo

```jsx
// 错误：不必要地使用 useMemo
function Component({ value }) {
  // 简单计算，不需要 useMemo
  const doubled = useMemo(() => value * 2, [value])
  
  // 简单对象，不需要 useMemo
  const style = useMemo(() => ({ color: 'red' }), [])
  
  return (
    <div style={style}>
      {doubled}
    </div>
  )
}

// 正确：只在需要时使用 useMemo
function Component({ value }) {
  // 简单计算，直接使用
  const doubled = value * 2
  
  // 简单对象，直接创建
  const style = { color: 'red' }
  
  return (
    <div style={style}>
      {doubled}
    </div>
  )
}
```

## useCallback

### 基本用法

```jsx
import { useCallback } from 'react'

function TodoList({ todos, onAddTodo, onToggleTodo }) {
  // useCallback：缓存函数引用
  const handleAddTodo = useCallback((text) => {
    onAddTodo({
      id: Date.now(),
      text,
      done: false
    })
  }, [onAddTodo]) // 依赖 onAddTodo
  
  const handleToggleTodo = useCallback((id) => {
    onToggleTodo(id)
  }, [onToggleTodo]) // 依赖 onToggleTodo
  
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

### 何时使用 useCallback

```jsx
// 场景 1：子组件接收回调函数
function Parent() {
  const [count, setCount] = useState(0)
  
  // 没有 useCallback：每次渲染创建新函数
  const handleClick = () => {
    console.log('clicked')
  }
  
  // 使用 useCallback：函数引用稳定
  const stableHandleClick = useCallback(() => {
    console.log('clicked')
  }, [])
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
      
      {/* 不使用 memo：子组件会重渲染 */}
      <ChildComponent onClick={handleClick} />
      
      {/* 使用 memo：子组件不会重渲染 */}
      <MemoizedChild onClick={stableHandleClick} />
    </div>
  )
}

const MemoizedChild = memo(function ChildComponent({ onClick }) {
  console.log('Child rendered')
  return <button onClick={onClick}>Click me</button>
})
```

### 与 useMemo 的关系

```jsx
// useMemo 和 useCallback 的关系
function Component({ items }) {
  // useMemo 缓存值
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => a.value - b.value)
  }, [items])
  
  // useCallback 缓存函数
  const handleSort = useCallback(() => {
    // 排序逻辑
  }, [])
  
  // 等价于 useMemo 缓存函数
  const handleSort2 = useMemo(() => {
    return () => {
      // 排序逻辑
    }
  }, [])
}
```

## 实战案例

### 优化列表渲染

```jsx
// 优化前：每次父组件重渲染，所有列表项都重渲染
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

// 优化后：使用 memo 和 useCallback
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

### 优化表单

```jsx
// 优化表单性能
function UserForm() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    age: ''
  })
  
  const [errors, setErrors] = useState({})
  
  // 使用 useCallback 缓存事件处理函数
  const handleChange = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }, [])
  
  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    // 验证逻辑
    const newErrors = {}
    if (!formData.name) newErrors.name = 'Name is required'
    if (!formData.email) newErrors.email = 'Email is required'
    
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
    
    // 提交表单
    console.log('Submitting:', formData)
  }, [formData])
  
  // 使用 useMemo 缓存验证规则
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

## 性能分析工具

### React DevTools

```jsx
// 使用 React DevTools 分析性能
// 1. 打开 React DevTools
// 2. 点击 "Profiler" 标签
// 3. 录制性能数据
// 4. 分析重渲染情况
```

### 自定义性能监控

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

// 使用
const MonitoredComponent = withPerformanceMonitor(ExpensiveComponent)
```

## 总结

memo、useMemo、useCallback 是 React 性能优化的核心工具：

1. **memo**：缓存组件，避免不必要的重渲染
2. **useMemo**：缓存计算结果，避免重复计算
3. **useCallback**：缓存函数引用，避免子组件重渲染

**使用原则**：

- 不要过早优化：先测量，再优化
- 只在必要时使用：简单计算不需要 useMemo
- 关注组件树：优化关键路径上的组件
- 结合使用：memo + useMemo + useCallback

掌握这些工具的正确使用时机，能够让你的 React 应用运行得更流畅。
