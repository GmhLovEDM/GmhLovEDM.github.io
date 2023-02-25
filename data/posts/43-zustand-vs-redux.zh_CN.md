---
title: "Zustand vs Redux Toolkit：React 状态管理选型指南"
tag: react
description: 深度对比 Zustand 和 Redux Toolkit 两大状态管理库，帮助开发者做出最合适的技术选型。
date: "2023-02-25T08:00:00.000Z"
---

## 目标

在 React 生态中，状态管理是一个永恒的话题。Redux 长期占据主导地位，但 Zustand 凭借其简洁的 API 和出色的性能迅速崛起。本文将从多个维度对两者进行深度对比，帮助开发者根据项目需求做出最合适的技术选型。

## 背景

### 状态管理的痛点

React 自带的 useState 和 useContext 在简单场景下足够使用，但在复杂应用中会遇到：

1. **Prop Drilling**：状态需要层层传递
2. **性能问题**：Context 变化导致所有消费者重渲染
3. **逻辑分散**：相关逻辑分散在多个组件中
4. **调试困难**：状态变化难以追踪

### 为什么需要状态管理库

- **集中管理**：所有状态存储在一个地方
- **性能优化**：精确的组件更新
- **开发体验**：完善的开发工具
- **可维护性**：清晰的状态流转

## Zustand

### 核心概念

```javascript
import { create } from 'zustand'

// 创建 store
const useStore = create((set, get) => ({
  // 状态
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
  
  // 异步 actions
  fetchUser: async (id) => {
    const user = await fetch(`/api/users/${id}`).then(r => r.json())
    set({ user })
  }
}))

// 使用
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

### 状态切片

```javascript
import { create } from 'zustand'

// 使用切片模式组织代码
const createSlice = (set, get) => ({
  // 用户切片
  user: null,
  setUser: (user) => set({ user }),
  logout: () => set({ user: null }),
  
  // 购物车切片
  cart: [],
  addToCart: (item) => set((state) => ({
    cart: [...state.cart, item]
  })),
  removeFromCart: (id) => set((state) => ({
    cart: state.cart.filter(item => item.id !== id)
  })),
  clearCart: () => set({ cart: [] }),
  
  // 计算属性
  getCartTotal: () => {
    const { cart } = get()
    return cart.reduce((total, item) => total + item.price, 0)
  }
})

const useStore = create(createSlice)
```

### 中间件

```javascript
import { create } from 'zustand'
import { persist, devtools, subscribeWithSelector } from 'zustand/middleware'

// 持久化中间件
const useStore = create(
  persist(
    (set, get) => ({
      count: 0,
      increment: () => set((state) => ({ count: state.count + 1 }))
    }),
    {
      name: 'counter-storage', // localStorage key
      partialize: (state) => ({ count: state.count }) // 只持久化 count
    }
  )
)

// 开发工具中间件
const useStore = create(
  devtools(
    (set) => ({
      count: 0,
      increment: () => set((state) => ({ count: state.count + 1 }))
    }),
    { name: 'CounterStore' }
  )
)

// 订阅中间件
const useStore = create(
  subscribeWithSelector((set) => ({
    count: 0,
    increment: () => set((state) => ({ count: state.count + 1 }))
  }))
)

// 组合多个中间件
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

### 性能优化

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

// 问题：每次 store 变化都会重渲染
function UserProfile() {
  const { firstName, lastName, age } = useStore()
  return (
    <div>
      <p>{firstName} {lastName}, {age}</p>
    </div>
  )
}

// 解决：使用 shallow 比较
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

// 或者使用选择器
function UserName() {
  const name = useStore(
    (state) => `${state.firstName} ${state.lastName}`
  )
  
  return <p>{name}</p>
}
```

## Redux Toolkit

### 核心概念

```javascript
import { createSlice, configureStore } from '@reduxjs/toolkit'
import { Provider, useDispatch, useSelector } from 'react-redux'

// 创建 slice
const counterSlice = createSlice({
  name: 'counter',
  initialState: {
    value: 0
  },
  reducers: {
    increment: (state) => {
      state.value += 1 // Immer 内部处理
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

// 配置 store
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

// 使用
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

### 异步 Thunks

```javascript
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'

// 创建异步 thunk
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

// 使用
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

### RTK Query

```javascript
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

// 创建 API slice
export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
  tagTypes: ['User', 'Post'],
  endpoints: (builder) => ({
    // 获取用户列表
    getUsers: builder.query({
      query: () => '/users',
      providesTags: ['User']
    }),
    
    // 获取单个用户
    getUserById: builder.query({
      query: (id) => `/users/${id}`,
      providesTags: (result, error, id) => [{ type: 'User', id }]
    }),
    
    // 创建用户
    createUser: builder.mutation({
      query: (newUser) => ({
        url: '/users',
        method: 'POST',
        body: newUser
      }),
      invalidatesTags: ['User']
    }),
    
    // 更新用户
    updateUser: builder.mutation({
      query: ({ id, ...updates }) => ({
        url: `/users/${id}`,
        method: 'PUT',
        body: updates
      }),
      invalidatesTags: (result, error, { id }) => [{ type: 'User', id }]
    }),
    
    // 删除用户
    deleteUser: builder.mutation({
      query: (id) => ({
        url: `/users/${id}`,
        method: 'DELETE'
      }),
      invalidatesTags: ['User']
    })
  })
})

// 导出 hooks
export const {
  useGetUsersQuery,
  useGetUserByIdQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useDeleteUserMutation
} = apiSlice

// 使用
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

## 性能对比

### Bundle 大小

```bash
# Zustand
zustand: ~1.1 kB (gzipped)

# Redux Toolkit
@reduxjs/toolkit: ~12 kB (gzipped)
react-redux: ~2.8 kB (gzipped)
redux: ~2.2 kB (gzipped)
总计: ~17 kB (gzipped)
```

### 渲染性能

```javascript
// Zustand：精确更新
function Counter() {
  // 只在 count 变化时重渲染
  const count = useStore((state) => state.count)
  return <div>{count}</div>
}

// Redux：默认所有 useSelector 都会执行
function Counter() {
  const count = useSelector((state) => state.counter.value)
  return <div>{count}</div>
}
```

## 选型建议

### 选择 Zustand 的场景

1. **小型项目**：简洁的 API，快速上手
2. **性能敏感**：更小的 bundle，更少的重渲染
3. **简单状态**：不需要复杂的中间件
4. **TypeScript**：更好的类型推断

### 选择 Redux Toolkit 的场景

1. **大型项目**：需要严格的状态管理规范
2. **团队协作**：Redux DevTools 提供更好的调试体验
3. **复杂异步**：RTK Query 处理 API 请求
4. **现有项目**：已经使用 Redux 的项目

### 对比表格

| 特性 | Zustand | Redux Toolkit |
|------|---------|---------------|
| Bundle 大小 | ~1.1 kB | ~17 kB |
| 学习曲线 | 低 | 中等 |
| API 复杂度 | 简单 | 中等 |
| DevTools | 支持 | 优秀 |
| 中间件 | 简单 | 丰富 |
| TypeScript | 优秀 | 良好 |
| 社区生态 | 成长中 | 成熟 |
| 性能 | 优秀 | 良好 |

## 实际项目对比

### Todo 应用

```javascript
// Zustand 版本
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

// Redux Toolkit 版本
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

## 总结

Zustand 和 Redux Toolkit 各有优势，选择取决于项目需求：

1. **Zustand**：简洁、高效、轻量，适合中小型项目
2. **Redux Toolkit**：功能完整、生态成熟，适合大型项目

无论选择哪个，重要的是建立清晰的状态管理规范，确保代码的可维护性。
