---
title: "Zustand vs Redux Toolkit: A React State Management Selection Guide"
tag: react
description: A deep comparison of Zustand and Redux Toolkit, two leading state management libraries, to help developers make the right choice.
date: "2023-02-25T08:00:00.000Z"
---

## Goal

In the React ecosystem, state management is an evergreen topic. Redux has long held a dominant position, but Zustand has rapidly gained traction thanks to its minimalist API and excellent performance. This article provides a thorough, multi-dimensional comparison of both libraries so you can choose the tool that best fits your project's needs.

## Background

### The Pain Points of State Management

React's built-in `useState` and `useContext` work well enough for simple scenarios, but complex applications quickly run into trouble:

1. **Prop drilling** -- state must be threaded through many intermediate components that do not actually use it.
2. **Performance issues** -- a Context change forces every consumer component to re-render, even when it only depends on a small slice of the data.
3. **Scattered logic** -- related state logic ends up spread across many different components, making it hard to reason about.
4. **Hard to debug** -- tracing where and why state changed becomes increasingly difficult.

### Why Reach for a State Management Library

- **Centralized state** -- all state lives in one place, making it easy to inspect and understand.
- **Precise updates** -- only the components that actually depend on changed state re-render.
- **Developer experience** -- mature DevTools, middleware, and time-travel debugging.
- **Maintainability** -- a clear, predictable flow of data through the application.

## Zustand

### Core Concepts

```javascript
import { create } from 'zustand'

// Create a store
const useStore = create((set, get) => ({
  // State
  count: 0,
  user: null,
  todos: [],

  // Actions
  increment: () => set((state) => ({ count: state.count + 1 })),

  decrement: () => set((state) => ({ count: state.count - 1 })),

  setUser: (user) => set({ user }),

  addTodo: (todo) => set((state) => ({
    todos: [...state.todos, { id: Date.now(), text: todo, done: false }]
  })),

  toggleTodo: (id) => set((state) => ({
    todos: state.todos.map(todo =>
      todo.id === id ? { ...todo, done: !todo.done } : todo
    )
  })),

  // Async actions
  fetchUser: async (id) => {
    const user = await fetch(`/api/users/${id}`).then(r => r.json())
    set({ user })
  }
}))

// Usage
function Counter() {
  const { count, increment, decrement } = useStore()

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
    </div>
  )
}
```

What makes Zustand stand out is its simplicity. You call `create`, pass in a function that receives `set` and `get`, and return your initial state along with the actions that modify it. There are no reducers, no action types, no dispatch calls. The returned function is a React hook that subscribes the component to state updates.

### State Slices

```javascript
import { create } from 'zustand'

// Organize code using the slice pattern
const createSlice = (set, get) => ({
  // User slice
  user: null,
  setUser: (user) => set({ user }),
  logout: () => set({ user: null }),

  // Shopping cart slice
  cart: [],
  addToCart: (item) => set((state) => ({
    cart: [...state.cart, item]
  })),
  removeFromCart: (id) => set((state) => ({
    cart: state.cart.filter(item => item.id !== id)
  })),
  clearCart: () => set({ cart: [] }),

  // Computed property
  getCartTotal: () => {
    const { cart } = get()
    return cart.reduce((total, item) => total + item.price, 0)
  }
})

const useStore = create(createSlice)
```

The slice pattern lets you organize a large store into logical sections while keeping everything in a single flat state object. You can also split slices into separate files and merge them with the spread operator.

### Middleware

```javascript
import { create } from 'zustand'
import { persist, devtools, subscribeWithSelector } from 'zustand/middleware'

// Persistence middleware
const useStore = create(
  persist(
    (set, get) => ({
      count: 0,
      increment: () => set((state) => ({ count: state.count + 1 }))
    }),
    {
      name: 'counter-storage', // localStorage key
      partialize: (state) => ({ count: state.count }) // Only persist count
    }
  )
)

// DevTools middleware
const useStore = create(
  devtools(
    (set) => ({
      count: 0,
      increment: () => set((state) => ({ count: state.count + 1 }))
    }),
    { name: 'CounterStore' }
  )
)

// Subscription middleware
const useStore = create(
  subscribeWithSelector((set) => ({
    count: 0,
    increment: () => set((state) => ({ count: state.count + 1 }))
  }))
)

// Composing multiple middleware
const useStore = create(
  devtools(
    persist(
      subscribeWithSelector((set) => ({
        count: 0,
        increment: () => set((state) => ({ count: state.count + 1 }))
      })),
      { name: 'counter-storage' }
    ),
    { name: 'CounterStore' }
  )
)
```

Zustand's middleware follows a composable wrapper pattern. `persist` handles localStorage or sessionStorage synchronization, `devtools` integrates with Redux DevTools, and `subscribeWithSelector` lets you subscribe to specific state slices with fine-grained control.

### Performance Optimization

```javascript
import { create } from 'zustand'
import { shallow } from 'zustand/shallow'

const useStore = create((set) => ({
  firstName: '',
  lastName: '',
  age: 0,
  setFirstName: (firstName) => set({ firstName }),
  setLastName: (lastName) => set({ lastName }),
  setAge: (age) => set({ age })
}))

// Problem: re-renders on every store change
function UserProfile() {
  const { firstName, lastName, age } = useStore()
  return (
    <div>
      <p>{firstName} {lastName}, {age}</p>
    </div>
  )
}

// Solution: use shallow comparison
function UserProfile() {
  const { firstName, lastName, age } = useStore(
    (state) => ({
      firstName: state.firstName,
      lastName: state.lastName,
      age: state.age
    }),
    shallow
  )

  return (
    <div>
      <p>{firstName} {lastName}, {age}</p>
    </div>
  )
}

// Or use a selector that derives a single value
function UserName() {
  const name = useStore(
    (state) => `${state.firstName} ${state.lastName}`
  )

  return <p>{name}</p>
}
```

By default, Zustand uses `Object.is` equality to determine whether a re-render is needed. When you select multiple fields into a new object, that object is a new reference on every call, triggering unnecessary re-renders. The `shallow` comparator performs a shallow equality check on each property, solving the problem. Alternatively, selectors that return primitive values avoid the issue entirely.

## Redux Toolkit

### Core Concepts

```javascript
import { createSlice, configureStore } from '@reduxjs/toolkit'
import { Provider, useDispatch, useSelector } from 'react-redux'

// Create a slice
const counterSlice = createSlice({
  name: 'counter',
  initialState: {
    value: 0
  },
  reducers: {
    increment: (state) => {
      state.value += 1 // Immer handles immutability internally
    },
    decrement: (state) => {
      state.value -= 1
    },
    incrementByAmount: (state, action) => {
      state.value += action.payload
    }
  }
})

export const { increment, decrement, incrementByAmount } = counterSlice.actions

// Configure the store
const store = configureStore({
  reducer: {
    counter: counterSlice.reducer
  }
})

// Provider
function App() {
  return (
    <Provider store={store}>
      <Counter />
    </Provider>
  )
}

// Usage
function Counter() {
  const count = useSelector((state) => state.counter.value)
  const dispatch = useDispatch()

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => dispatch(increment())}>+</button>
      <button onClick={() => dispatch(decrement())}>-</button>
    </div>
  )
}
```

Redux Toolkit wraps Redux with sensible defaults and eliminates much of the boilerplate. `createSlice` uses Immer under the hood, so you can write "mutating" logic that produces immutable updates. The store requires a `Provider` at the top of your component tree.

### Async Thunks

```javascript
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'

// Create an async thunk
export const fetchUser = createAsyncThunk(
  'user/fetchUser',
  async (userId, { rejectWithValue }) => {
    try {
      const response = await fetch(`/api/users/${userId}`)
      if (!response.ok) {
        throw new Error('Network response was not ok')
      }
      return await response.json()
    } catch (error) {
      return rejectWithValue(error.message)
    }
  }
)

const userSlice = createSlice({
  name: 'user',
  initialState: {
    data: null,
    loading: false,
    error: null
  },
  reducers: {
    clearUser: (state) => {
      state.data = null
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchUser.pending, (state) => {
        state.loading = true
        state.error = null
      })
      .addCase(fetchUser.fulfilled, (state, action) => {
        state.loading = false
        state.data = action.payload
      })
      .addCase(fetchUser.rejected, (state, action) => {
        state.loading = false
        state.error = action.payload
      })
  }
})

// Usage
function UserProfile({ userId }) {
  const dispatch = useDispatch()
  const { data: user, loading, error } = useSelector((state) => state.user)

  useEffect(() => {
    dispatch(fetchUser(userId))
  }, [dispatch, userId])

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

`createAsyncThunk` handles the three phases of async operations -- pending, fulfilled, and rejected -- with dedicated reducer cases. This pattern makes loading and error states explicit and easy to manage.

### RTK Query

```javascript
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

// Create an API slice
export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
  tagTypes: ['User', 'Post'],
  endpoints: (builder) => ({
    // Get user list
    getUsers: builder.query({
      query: () => '/users',
      providesTags: ['User']
    }),

    // Get a single user
    getUserById: builder.query({
      query: (id) => `/users/${id}`,
      providesTags: (result, error, id) => [{ type: 'User', id }]
    }),

    // Create a user
    createUser: builder.mutation({
      query: (newUser) => ({
        url: '/users',
        method: 'POST',
        body: newUser
      }),
      invalidatesTags: ['User']
    }),

    // Update a user
    updateUser: builder.mutation({
      query: ({ id, ...updates }) => ({
        url: `/users/${id}`,
        method: 'PUT',
        body: updates
      }),
      invalidatesTags: (result, error, { id }) => [{ type: 'User', id }]
    }),

    // Delete a user
    deleteUser: builder.mutation({
      query: (id) => ({
        url: `/users/${id}`,
        method: 'DELETE'
      }),
      invalidatesTags: ['User']
    })
  })
})

// Export hooks
export const {
  useGetUsersQuery,
  useGetUserByIdQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useDeleteUserMutation
} = apiSlice

// Usage
function UserList() {
  const { data: users, isLoading, error } = useGetUsersQuery()

  if (isLoading) return <Spinner />
  if (error) return <ErrorMessage error={error} />

  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}

function CreateUserForm() {
  const [createUser, { isLoading }] = useCreateUserMutation()

  async function handleSubmit(e) {
    e.preventDefault()
    const formData = new FormData(e.target)

    await createUser({
      name: formData.get('name'),
      email: formData.get('email')
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" placeholder="Name" />
      <input name="email" placeholder="Email" />
      <button type="submit" disabled={isLoading}>
        {isLoading ? 'Creating...' : 'Create User'}
      </button>
    </form>
  )
}
```

RTK Query is Redux Toolkit's built-in data fetching and caching layer. It eliminates boilerplate around loading states, caching, and cache invalidation. The tag system automatically refetches data when related mutations occur, keeping your UI in sync without manual cache management.

## Performance Comparison

### Bundle Size

```bash
# Zustand
zustand: ~1.1 kB (gzipped)

# Redux Toolkit
@reduxjs/toolkit: ~12 kB (gzipped)
react-redux: ~2.8 kB (gzipped)
redux: ~2.2 kB (gzipped)
Total: ~17 kB (gzipped)
```

Zustand weighs in at roughly 1.1 kB gzipped -- about one-fifteenth the size of a full Redux Toolkit setup. For bundle-size-sensitive applications, this difference matters.

### Render Performance

```javascript
// Zustand: precise updates
function Counter() {
  // Only re-renders when count changes
  const count = useStore((state) => state.count)
  return <div>{count}</div>
}

// Redux: every useSelector runs by default
function Counter() {
  const count = useSelector((state) => state.counter.value)
  return <div>{count}</div>
}
```

Both libraries support selector-based subscription, but Zustand's default behavior is leaner out of the box. Redux requires the React-Redux `useSelector` hook and careful selector design to avoid unnecessary re-renders.

## When to Choose Which

### Choose Zustand When

1. **Small to medium projects** -- the minimalist API lets you get started fast with almost no boilerplate.
2. **Performance-sensitive applications** -- the tiny bundle and efficient re-rendering make it ideal for resource-constrained environments.
3. **Simple state needs** -- you do not require elaborate middleware chains or normalized entity adapters.
4. **TypeScript** -- Zustand offers excellent type inference without additional configuration.

### Choose Redux Toolkit When

1. **Large projects** -- you need enforced conventions for state management that scale across many teams.
2. **Team collaboration** -- Redux DevTools provide a superior debugging experience with time-travel and action logging.
3. **Complex async workflows** -- RTK Query handles API request caching, invalidation, and loading states out of the box.
4. **Existing Redux codebase** -- you already have a Redux setup and want a modern, batteries-included approach.

### Comparison Table

| Feature | Zustand | Redux Toolkit |
|---------|---------|---------------|
| Bundle size | ~1.1 kB | ~17 kB |
| Learning curve | Low | Medium |
| API complexity | Simple | Medium |
| DevTools | Supported | Excellent |
| Middleware | Simple | Rich ecosystem |
| TypeScript | Excellent | Good |
| Community | Growing | Mature |
| Performance | Excellent | Good |

## Real-World Example: Todo App

```javascript
// Zustand version
import { create } from 'zustand'

const useTodoStore = create((set) => ({
  todos: [],

  addTodo: (text) => set((state) => ({
    todos: [...state.todos, { id: Date.now(), text, done: false }]
  })),

  toggleTodo: (id) => set((state) => ({
    todos: state.todos.map(todo =>
      todo.id === id ? { ...todo, done: !todo.done } : todo
    )
  })),

  deleteTodo: (id) => set((state) => ({
    todos: state.todos.filter(todo => todo.id !== id)
  }))
}))

// Redux Toolkit version
import { createSlice, configureStore } from '@reduxjs/toolkit'
import { Provider, useDispatch, useSelector } from 'react-redux'

const todoSlice = createSlice({
  name: 'todos',
  initialState: { items: [] },
  reducers: {
    addTodo: (state, action) => {
      state.items.push({
        id: Date.now(),
        text: action.payload,
        done: false
      })
    },
    toggleTodo: (state, action) => {
      const todo = state.items.find(todo => todo.id === action.payload)
      if (todo) {
        todo.done = !todo.done
      }
    },
    deleteTodo: (state, action) => {
      state.items = state.items.filter(todo => todo.id !== action.payload)
    }
  }
})

const store = configureStore({
  reducer: { todos: todoSlice.reducer }
})
```

The side-by-side comparison makes the ergonomic difference clear. The Zustand version defines everything in a single function with no boilerplate. The Redux Toolkit version requires a slice, a configured store, and a Provider, but gains structured reducers and DevTools integration.

## Conclusion

Zustand and Redux Toolkit each have their strengths, and the right choice depends on your project:

1. **Zustand** -- concise, efficient, and lightweight. Ideal for small to medium projects where you want minimal overhead and maximum developer speed.
2. **Redux Toolkit** -- feature-complete with a mature ecosystem. Best for large-scale applications that benefit from established conventions, structured reducers, and powerful tooling like RTK Query.

Whichever you pick, the most important thing is to establish clear state management conventions early, ensuring your codebase remains maintainable as it grows.
