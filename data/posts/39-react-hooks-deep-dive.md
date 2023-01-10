---
title: "React Hooks Deep Dive: From useState to Custom Hooks"
tag: react
description: Deeply understand how React Hooks work, mastering the complete knowledge system from basic Hooks to custom Hooks.
date: "2023-01-10T08:00:00.000Z"
---

## Goal

React Hooks are a revolutionary feature introduced in React 16.8 that gave function components the ability to manage state and handle lifecycle events. However, many developers only have a surface-level understanding of Hooks, which leads to various problems in their code. This article provides a deep dive into how Hooks work, from basic usage to advanced techniques, helping developers truly master this essential React paradigm.

## Background

### Why Hooks Are Needed

Before Hooks existed, React components could be written in two ways:

```jsx
// Class Component
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

Class components come with several pain points:

- **Difficult logic reuse**: Higher-Order Components (HOCs) and Render Props lead to deeply nested component trees, commonly known as "wrapper hell."
- **Fragmented lifecycle logic**: Related logic gets scattered across `componentDidMount`, `componentDidUpdate`, and `componentWillUnmount`, making it hard to understand how a single feature is implemented.
- **`this` binding issues**: Developers must manually bind event handlers, which is error-prone and adds unnecessary boilerplate.
- **Code splitting challenges**: Splitting a class component's logic into smaller, composable pieces is non-trivial.

Hooks solved all of these problems in one stroke:

```jsx
// Function Component + Hooks
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

## Basic Hooks

### useState: State Management

```jsx
import { useState } from 'react'

function Counter() {
  // Basic usage
  const [count, setCount] = useState(0)
  
  // Lazy initialization
  const [state, setState] = useState(() => {
    // Only executed on the first render
    return computeExpensiveValue()
  })
  
  // Functional updates
  function increment() {
    setCount(prev => prev + 1) // Recommended: based on previous state
    setCount(count + 1) // Potentially problematic: closure trap
  }
  
  // Updating objects
  function updateUser() {
    setUser(prev => ({
      ...prev,
      name: 'John'
    }))
  }
  
  // Updating arrays
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

The key takeaways for `useState` are:

- **Lazy initialization**: Passing a function to `useState` allows you to compute expensive initial values only once, on the first render. This is especially useful when the initial state requires parsing localStorage, running a calculation, or making a synchronous heavy operation.
- **Functional updates**: Always prefer `setCount(prev => prev + 1)` over `setCount(count + 1)` when the new state depends on the previous state. This avoids stale closure bugs where `count` is frozen at the value from when the handler was created.
- **Immutable updates**: When updating objects or arrays, always spread the previous state and return a new reference. React relies on reference equality to detect changes, so mutating the existing state object directly will cause React to miss the update.

### useEffect: Side Effects

```jsx
import { useState, useEffect } from 'react'

function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  
  // Basic side effect
  useEffect(() => {
    // Runs after component mounts or when dependencies change
    document.title = `User: ${user?.name}`
    
    // Cleanup function (runs before unmount or re-run)
    return () => {
      document.title = 'My App'
    }
  }, [user]) // Dependency array
  
  // Data fetching
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
    
    // Cleanup: prevents race conditions
    return () => {
      cancelled = true
    }
  }, [userId])
  
  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      // Execute periodically
    }, 1000)
    
    // Always clean up timers
    return () => clearInterval(interval)
  }, [])
  
  // Event listeners
  useEffect(() => {
    function handleResize() {
      // Handle window resize
    }
    
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  
  return <div>{user?.name}</div>
}
```

The `useEffect` hook has three critical patterns to master:

1. **Empty dependency array (`[]`)**: The effect runs only once on mount and cleans up on unmount. Use this for initialization logic that should not repeat.
2. **With dependencies (`[dep1, dep2]`)**: The effect re-runs whenever any dependency changes. This is the most common pattern for data fetching and subscriptions.
3. **Cleanup functions**: Always return a cleanup function when your effect sets up subscriptions, timers, or event listeners. This prevents memory leaks and stale references.

The **race condition prevention pattern** using a `cancelled` flag is essential for async data fetching. Without it, if `userId` changes rapidly, a slow response from the first request could overwrite the data from a newer, more relevant request.

### useContext: Context Consumption

```jsx
import { createContext, useContext, useState } from 'react'

// Create context
const ThemeContext = createContext(null)

// Provider component
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

// Consumer component
function ThemedButton() {
  const { theme, toggleTheme } = useContext(ThemeContext)
  
  return (
    <button onClick={toggleTheme}>
      Current theme: {theme}
    </button>
  )
}
```

`useContext` replaces the verbose `Context.Consumer` render prop pattern. When the context value changes, all consuming components re-render. For performance-sensitive scenarios, consider splitting contexts or using `useMemo` within the provider to avoid unnecessary re-renders of downstream components.

## Rules and Pitfalls

### The Two Rules of Hooks

```jsx
// Rule 1: Only call Hooks at the top level
function Component() {
  // WRONG
  if (condition) {
    const [state, setState] = useState(null) // Error! Not at the top level
  }
  
  // CORRECT
  const [state, setState] = useState(null)
}

// Rule 2: Only call Hooks from React functions
// CORRECT: React function component
function MyComponent() {
  const [state, setState] = useState(null)
}

// CORRECT: Custom Hook
function useCustomHook() {
  const [state, setState] = useState(null)
}

// WRONG: Regular function
function helper() {
  const [state, setState] = useState(null) // Error!
}
```

These rules exist because React tracks Hook calls by their order of execution within a component. If you call Hooks conditionally or inside loops, the call order changes between renders, and React cannot correctly match state to Hooks. The ESLint plugin `eslint-plugin-react-hooks` enforces these rules automatically in your development workflow.

### Common Pitfalls

```jsx
// Pitfall 1: Closure problems
function Counter() {
  const [count, setCount] = useState(0)
  
  function handleClick() {
    // Problem: count is captured by closure, always 0
    setTimeout(() => {
      alert(count) // Alerts 0
    }, 3000)
    
    // Solution: use functional update
    setCount(prev => prev + 1)
  }
  
  return <button onClick={handleClick}>Click</button>
}

// Pitfall 2: useEffect dependency issues
function UserProfile({ userId }) {
  const [user, setUser] = useState(null)
  
  useEffect(() => {
    // Problem: creates a new fetchUser function every render
    // causing infinite loop
    async function fetchUser() {
      const data = await api.getUser(userId)
      setUser(data)
    }
    
    fetchUser()
  }) // Error: missing dependency array
  
  // Correct
  useEffect(() => {
    async function fetchUser() {
      const data = await api.getUser(userId)
      setUser(data)
    }
    
    fetchUser()
  }, [userId]) // Correct: dependency array provided
  
  return <div>{user?.name}</div>
}

// Pitfall 3: useEffect cleanup
function Timer() {
  useEffect(() => {
    const interval = setInterval(() => {
      console.log('tick')
    }, 1000)
    
    // Wrong: forgetting cleanup
    // return () => clearInterval(interval)
    
    // Correct: add cleanup function
    return () => clearInterval(interval)
  }, [])
}
```

The closure problem is one of the most common sources of bugs in React. When you capture `count` in a closure (like inside `setTimeout`), it freezes at the value it had when the closure was created. Using functional updates (`prev => prev + 1`) avoids this entirely by always working with the latest state.

Missing the dependency array in `useEffect` causes it to run after every single render. For data-fetching effects, this creates an infinite loop: fetch sets state, state triggers re-render, re-render triggers another fetch, and so on. Always include a dependency array, even if it is empty.

## Custom Hooks

### Basic Custom Hook

```jsx
import { useState, useEffect } from 'react'

// Custom Hook: data fetching
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

// Usage
function UserProfile({ userId }) {
  const { data: user, loading, error } = useFetch(`/api/users/${userId}`)
  
  if (loading) return <Spinner />
  if (error) return <ErrorMessage error={error} />
  return <div>{user.name}</div>
}
```

This `useFetch` hook encapsulates the entire data-fetching lifecycle: loading state, error handling, cleanup on unmount, and automatic refetching when the URL changes. It demonstrates the core power of custom hooks -- extracting reusable stateful logic without changing the component hierarchy. Any component that needs data fetching can now use `useFetch` with a single line.

### Advanced Custom Hooks

```jsx
// Custom Hook: local storage
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

// Custom Hook: debounce
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

// Custom Hook: window size
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

// Custom Hook: media query
function useMediaQuery(query) {
  const [matches, setMatches] = useState(false)
  
  useEffect(() => {
    const media = window.matchMedia(query)
    
    // Initialize
    setMatches(media.matches)
    
    // Listen for changes
    const listener = (e) => setMatches(e.matches)
    media.addEventListener('change', listener)
    
    return () => media.removeEventListener('change', listener)
  }, [query])
  
  return matches
}

// Usage
function ResponsiveComponent() {
  const isMobile = useMediaQuery('(max-width: 768px)')
  
  return (
    <div>
      {isMobile ? <MobileLayout /> : <DesktopLayout />}
    </div>
  )
}
```

These advanced hooks demonstrate the versatility of the custom hook pattern. `useLocalStorage` bridges React state with browser persistence, automatically syncing values to localStorage. `useDebounce` is invaluable for search inputs and resize handlers, preventing excessive re-renders or API calls. `useWindowSize` and `useMediaQuery` enable truly responsive components that adapt to screen size without relying solely on CSS.

Notice how each hook follows the same structure: initialize state, set up an effect with proper cleanup, and return values that the consuming component needs.

## Performance Optimization

### useMemo and useCallback

```jsx
import { useMemo, useCallback } from 'react'

function ExpensiveComponent({ items, onItemClick }) {
  // useMemo: cache computation results
  const sortedItems = useMemo(() => {
    console.log('Sorting items...')
    return [...items].sort((a, b) => a.name.localeCompare(b.name))
  }, [items]) // Only recomputes when items change
  
  // useCallback: cache function references
  const handleClick = useCallback((id) => {
    console.log('Item clicked:', id)
    onItemClick(id)
  }, [onItemClick]) // Only recreates when onItemClick changes
  
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

// Parent component
function Parent() {
  const [items, setItems] = useState([])
  
  // useCallback ensures stable function reference
  const handleItemClick = useCallback((id) => {
    console.log('Clicked item:', id)
  }, [])
  
  return <ExpensiveComponent items={items} onItemClick={handleItemClick} />
}
```

`useMemo` prevents expensive computations from running on every render. Without it, sorting a large array would execute on every re-render even if the array hasn't changed. `useCallback` maintains a stable function reference across renders, which is critical when passing callbacks to memoized children. Without `useCallback`, a new function instance is created on every render, defeating `React.memo` optimizations.

### React.memo

```jsx
import { memo } from 'react'

// memo: shallow compare props to avoid unnecessary re-renders
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

// Custom comparison function
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
    // Return true to skip re-render
    return prevProps.user.id === nextProps.user.id
  }
)
```

`React.memo` is a higher-order component that wraps a function component and skips re-rendering when its props are shallowly equal to the previous props. The custom comparison function gives you fine-grained control: returning `true` means "the props are equal, skip re-render." This is useful when the default shallow comparison is too aggressive or too lenient for your use case.

## Practical Example: Form Hook

```jsx
function useForm(initialValues, validationRules) {
  const [values, setValues] = useState(initialValues)
  const [errors, setErrors] = useState({})
  const [touched, setTouched] = useState({})
  
  const handleChange = (name, value) => {
    setValues(prev => ({ ...prev, [name]: value }))
    
    // Validate
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

// Usage
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
      // Submit the form
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

This `useForm` hook is a practical demonstration of the power of custom hooks. It manages form values, validation errors, and touched state in a single, reusable hook. The validation rules are passed as a map of functions, making the hook flexible enough to handle any form structure. The `touched` state ensures that error messages only appear after the user has interacted with a field, providing a better user experience. This pattern is similar to what libraries like Formik and React Hook Form provide under the hood.

## Conclusion

React Hooks are the core of modern React development. Mastering them enables you to write cleaner, more maintainable code:

1. **Basic Hooks**: `useState`, `useEffect`, and `useContext` cover the vast majority of use cases and form the foundation of every React application.
2. **Follow the Rules**: Always call Hooks at the top level and only from React functions. The ESLint plugin helps enforce this automatically.
3. **Avoid Pitfalls**: Watch out for closure traps, missing dependency arrays, and forgotten cleanup functions. These are the most common sources of bugs.
4. **Custom Hooks**: They are the best practice for logic reuse, replacing HOCs and Render Props with a simpler, more composable pattern.
5. **Performance Optimization**: Use `useMemo`, `useCallback`, and `React.memo` judiciously. Profile first, then optimize only where it matters.

By deeply understanding how Hooks work under the hood, you will be able to organize your code logic more effectively, boosting both your development efficiency and code quality.
