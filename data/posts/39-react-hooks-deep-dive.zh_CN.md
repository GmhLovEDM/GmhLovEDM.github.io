---
title: "React Hooks 深度解析：从 useState 到自定义 Hook"
tag: react
description: 深入理解 React Hooks 的工作原理，掌握从基础 Hook 到自定义 Hook 的完整知识体系。
date: "2023-01-10T08:00:00.000Z"
---

## 目标

React Hooks 是 React 16.8 引入的革命性特性，它让函数组件拥有了状态和生命周期等能力。然而，很多开发者对 Hooks 的理解停留在表面，导致代码出现各种问题。本文将深入解析 Hooks 的工作原理，从基础用法到高级技巧，帮助开发者真正掌握 Hooks。

## 背景

### 为什么需要 Hooks

在 Hooks 出现之前，React 组件有两种写法：

```jsx
// Class 组件
class UserProfile extends React.Component {
  state = { user: null, loading: true }
  
  componentDidMount() {
    this.fetchUser()
  }
  
  async fetchUser() {
    const user = await api.getUser(this.props.userId)
    this.setState({ user, loading: false })
  }
  
  render() {
    if (this.state.loading) return <Spinner />
    return <div>{this.state.user.name}</div>
  }
}
```

Class 组件的问题：
- 逻辑复用困难（HOC、Render Props 导致组件嵌套）
- 生命周期逻辑分散
- this 绑定问题
- 代码分割困难

Hooks 的出现解决了这些问题：

```jsx
// 函数组件 + Hooks
function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  
  useEffect(() => {
    async function fetchUser() {
      const user = await api.getUser(userId)
      setUser(user)
      setLoading(false)
    }
    fetchUser()
  }, [userId])
  
  if (loading) return <Spinner />
  return <div>{user.name}</div>
}
```

## 基础 Hooks

### useState：状态管理

```jsx
import { useState } from 'react'

function Counter() {
  // 基础用法
  const [count, setCount] = useState(0)
  
  // 惰性初始化
  const [state, setState] = useState(() => {
    // 只在首次渲染时执行
    return computeExpensiveValue()
  })
  
  // 函数式更新
  function increment() {
    setCount(prev => prev + 1) // 推荐：基于前一个状态
    setCount(count + 1) // 可能有问题：闭包陷阱
  }
  
  // 更新对象
  function updateUser() {
    setUser(prev => ({
      ...prev,
      name: 'John'
    }))
  }
  
  // 更新数组
  function addItem() {
    setItems(prev => [...prev, newItem])
  }
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={increment}>+1</button>
    </div>
  )
}
```

### useEffect：副作用处理

```jsx
import { useState, useEffect } from 'react'

function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  
  // 基础副作用
  useEffect(() => {
    // 组件挂载后执行
    document.title = `User: ${user?.name}`
    
    // 清理函数（组件卸载时执行）
    return () => {
      document.title = 'My App'
    }
  }, [user]) // 依赖数组
  
  // 数据获取
  useEffect(() => {
    let cancelled = false
    
    async function fetchUser() {
      try {
        const data = await api.getUser(userId)
        if (!cancelled) {
          setUser(data)
        }
      } catch (error) {
        console.error('Failed to fetch user:', error)
      }
    }
    
    fetchUser()
    
    // 清理函数：防止竞态条件
    return () => {
      cancelled = true
    }
  }, [userId])
  
  // 定时器
  useEffect(() => {
    const interval = setInterval(() => {
      // 定时执行
    }, 1000)
    
    // 清理定时器
    return () => clearInterval(interval)
  }, [])
  
  // 事件监听
  useEffect(() => {
    function handleResize() {
      // 处理窗口大小变化
    }
    
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  
  return <div>{user?.name}</div>
}
```

### useContext：上下文消费

```jsx
import { createContext, useContext, useState } from 'react'

// 创建上下文
const ThemeContext = createContext(null)

// 提供者组件
function ThemeProvider({ children }) {
  const [theme, setTheme] = useState('light')
  
  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light')
  }
  
  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

// 消费者组件
function ThemedButton() {
  const { theme, toggleTheme } = useContext(ThemeContext)
  
  return (
    <button onClick={toggleTheme}>
      Current theme: {theme}
    </button>
  )
}
```

## 规则与陷阱

### Hooks 的两条规则

```jsx
// 规则 1：只在顶层使用 Hooks
function Component() {
  // 正确
  if (condition) {
    const [state, setState] = useState(null) // 错误！不能在条件语句中
  }
  
  // 正确
  const [state, setState] = useState(null)
}

// 规则 2：只在 React 函数中调用 Hooks
// 正确：React 函数组件
function MyComponent() {
  const [state, setState] = useState(null)
}

// 正确：自定义 Hook
function useCustomHook() {
  const [state, setState] = useState(null)
}

// 错误：普通函数
function helper() {
  const [state, setState] = useState(null) // 错误！
}
```

### 常见陷阱

```jsx
// 陷阱 1：闭包问题
function Counter() {
  const [count, setCount] = useState(0)
  
  function handleClick() {
    // 问题：count 被闭包捕获，永远是 0
    setTimeout(() => {
      alert(count) // 弹出 0
    }, 3000)
    
    // 解决：使用函数式更新
    setCount(prev => prev + 1)
  }
  
  return <button onClick={handleClick}>Click</button>
}

// 陷阱 2：useEffect 依赖问题
function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  
  useEffect(() => {
    // 问题：每次渲染都会创建新的 fetchUser 函数
    // 导致无限循环
    async function fetchUser() {
      const data = await api.getUser(userId)
      setUser(data)
    }
    
    fetchUser()
  }) // 错误：缺少依赖数组
  
  // 正确
  useEffect(() => {
    async function fetchUser() {
      const data = await api.getUser(userId)
      setUser(data)
    }
    
    fetchUser()
  }, [userId]) // 正确：添加依赖数组
  
  return <div>{user?.name}</div>
}

// 陷阱 3：useEffect 清理
function Timer() {
  useEffect(() => {
    const interval = setInterval(() => {
      console.log('tick')
    }, 1000)
    
    // 错误：忘记清理
    // return () => clearInterval(interval)
    
    // 正确：添加清理函数
    return () => clearInterval(interval)
  }, [])
}
```

## 自定义 Hook

### 基础自定义 Hook

```jsx
import { useState, useEffect } from 'react'

// 自定义 Hook：数据获取
function useFetch(url) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  useEffect(() => {
    let cancelled = false
    
    async function fetchData() {
      try {
        setLoading(true)
        const response = await fetch(url)
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }
        
        const data = await response.json()
        
        if (!cancelled) {
          setData(data)
          setError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setError(error)
          setData(null)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    
    fetchData()
    
    return () => {
      cancelled = true
    }
  }, [url])
  
  return { data, loading, error }
}

// 使用
function UserProfile({ userId }) {
  const { data: user, loading, error } = useFetch(`/api/users/${userId}`)
  
  if (loading) return <Spinner />
  if (error) return <ErrorMessage error={error} />
  return <div>{user.name}</div>
}
```

### 高级自定义 Hook

```jsx
// 自定义 Hook：本地存储
function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key)
      return item ? JSON.parse(item) : initialValue
    } catch (error) {
      console.error(error)
      return initialValue
    }
  })
  
  const setValue = (value) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value
      setStoredValue(valueToStore)
      window.localStorage.setItem(key, JSON.stringify(valueToStore))
    } catch (error) {
      console.error(error)
    }
  }
  
  return [storedValue, setValue]
}

// 自定义 Hook：防抖
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value)
  
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)
    
    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])
  
  return debouncedValue
}

// 自定义 Hook：窗口大小
function useWindowSize() {
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  })
  
  useEffect(() => {
    function handleResize() {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight
      })
    }
    
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  
  return windowSize
}

// 自定义 Hook：媒体查询
function useMediaQuery(query) {
  const [matches, setMatches] = useState(false)
  
  useEffect(() => {
    const media = window.matchMedia(query)
    
    // 初始化
    setMatches(media.matches)
    
    // 监听变化
    const listener = (e) => setMatches(e.matches)
    media.addEventListener('change', listener)
    
    return () => media.removeEventListener('change', listener)
  }, [query])
  
  return matches
}

// 使用
function ResponsiveComponent() {
  const isMobile = useMediaQuery('(max-width: 768px)')
  
  return (
    <div>
      {isMobile ? <MobileLayout /> : <DesktopLayout />}
    </div>
  )
}
```

## 性能优化

### useMemo 和 useCallback

```jsx
import { useMemo, useCallback } from 'react'

function ExpensiveComponent({ items, onItemClick }) {
  // useMemo：缓存计算结果
  const sortedItems = useMemo(() => {
    console.log('Sorting items...')
    return [...items].sort((a, b) => a.name.localeCompare(b.name))
  }, [items]) // 只有 items 变化时才重新计算
  
  // useCallback：缓存函数引用
  const handleClick = useCallback((id) => {
    console.log('Item clicked:', id)
    onItemClick(id)
  }, [onItemClick]) // 只有 onItemClick 变化时才重新创建
  
  return (
    <ul>
      {sortedItems.map(item => (
        <li key={item.id} onClick={() => handleClick(item.id)}>
          {item.name}
        </li>
      ))}
    </ul>
  )
}

// 父组件
function Parent() {
  const [items, setItems] = useState([])
  
  // useCallback 确保函数引用稳定
  const handleItemClick = useCallback((id) => {
    console.log('Clicked item:', id)
  }, [])
  
  return <ExpensiveComponent items={items} onItemClick={handleItemClick} />
}
```

### React.memo

```jsx
import { memo } from 'react'

// memo：浅比较 props，避免不必要的重渲染
const ExpensiveComponent = memo(function ExpensiveComponent({ data, onClick }) {
  console.log('ExpensiveComponent rendered')
  
  return (
    <div onClick={onClick}>
      {data.map(item => (
        <div key={item.id}>{item.name}</div>
      ))}
    </div>
  )
})

// 自定义比较函数
const CustomComponent = memo(
  function CustomComponent({ user, onUpdate }) {
    return (
      <div>
        <span>{user.name}</span>
        <button onClick={onUpdate}>Update</button>
      </div>
    )
  },
  (prevProps, nextProps) => {
    // 返回 true 表示不需要重渲染
    return prevProps.user.id === nextProps.user.id
  }
)
```

## 实战案例

### 表单 Hook

```jsx
function useForm(initialValues, validationRules) {
  const [values, setValues] = useState(initialValues)
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState({})
  
  const handleChange = (name, value) => {
    setValues(prev => ({ ...prev, [name]: value }))
    
    // 验证
    if (validationRules[name]) {
      const error = validationRules[name](value, values)
      setErrors(prev => ({
        ...prev,
        [name]: error
      }))
    }
  }
  
  const handleBlur = (name) => {
    setTouched(prev => ({ ...prev, [name]: true }))
  }
  
  const validate = () => {
    const newErrors = {}
    let isValid = true
    
    Object.keys(validationRules).forEach(name => {
      const error = validationRules[name](values[name], values)
      if (error) {
        newErrors[name] = error
        isValid = false
      }
    })
    
    setErrors(newErrors)
    return isValid
  }
  
  const reset = () => {
    setValues(initialValues)
    setErrors({})
    setTouched({})
  }
  
  return {
    values,
    errors,
    touched,
    handleChange,
    handleBlur,
    validate,
    reset
  }
}

// 使用
function RegistrationForm() {
  const { values, errors, touched, handleChange, handleBlur, validate } = useForm(
    { email: '', password: '', confirmPassword: '' },
    {
      email: (value) => {
        if (!value) return 'Email is required'
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Invalid email'
        return null
      },
      password: (value) => {
        if (!value) return 'Password is required'
        if (value.length < 6) return 'Password must be at least 6 characters'
        return null
      },
      confirmPassword: (value, values) => {
        if (!value) return 'Please confirm your password'
        if (value !== values.password) return 'Passwords do not match'
        return null
      }
    }
  )
  
  const handleSubmit = (e) => {
    e.preventDefault()
    if (validate()) {
      // 提交表单
      console.log('Form submitted:', values)
    }
  }
  
  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={values.email}
        onChange={(e) => handleChange('email', e.target.value)}
        onBlur={() => handleBlur('email')}
      />
      {touched.email && errors.email && <span>{errors.email}</span>}
      
      <input
        type="password"
        value={values.password}
        onChange={(e) => handleChange('password', e.target.value)}
        onBlur={() => handleBlur('password')}
      />
      {touched.password && errors.password && <span>{errors.password}</span>}
      
      <input
        type="password"
        value={values.confirmPassword}
        onChange={(e) => handleChange('confirmPassword', e.target.value)}
        onBlur={() => handleBlur('confirmPassword')}
      />
      {touched.confirmPassword && errors.confirmPassword && (
        <span>{errors.confirmPassword}</span>
      )}
      
      <button type="submit">Register</button>
    </form>
  )
}
```

## 总结

React Hooks 是现代 React 开发的核心，掌握 Hooks 能够让你写出更简洁、更易维护的代码：

1. **基础 Hooks**：useState、useEffect、useContext
2. **规则遵循**：只在顶层使用，只在 React 函数中调用
3. **陷阱规避**：闭包问题、依赖数组、清理函数
4. **自定义 Hook**：逻辑复用的最佳实践
5. **性能优化**：useMemo、useCallback、React.memo

通过深入理解 Hooks 的工作原理，你将能够更好地组织代码逻辑，提升开发效率和代码质量。
