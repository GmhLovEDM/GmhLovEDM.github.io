---
title: "前端自动化测试策略：单元测试到 E2E 的全覆盖"
tag: testing
description: 构建完整的前端测试体系，从单元测试到端到端测试的全覆盖策略。
date: "2023-05-28T08:00:00.000Z"
---

## 目标

前端自动化测试是保证代码质量的关键环节。然而，很多团队的测试覆盖率很低，或者测试策略不合理。本文将系统性地介绍前端测试的完整策略，从单元测试到端到端测试，帮助团队构建可靠的测试体系。

## 背景

### 为什么需要测试

1. **防止回归**：确保新代码不会破坏现有功能
2. **代码重构**：安全地进行代码重构
3. **文档作用**：测试代码是活的文档
4. **设计指导**：测试驱动开发改善代码设计
5. **团队协作**：新成员快速了解系统行为

### 测试金字塔

```
        /\
       /  \        E2E 测试
      /    \       （少量，覆盖关键路径）
     /------\
    /        \     集成测试
   /          \    （适量，覆盖组件交互）
  /------------\
 /              \  单元测试
/                \ （大量，覆盖工具函数）
------------------
```

## 单元测试

### 测试框架选择

```javascript
// Vitest（推荐）
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    }
  }
})
```

### 工具函数测试

```typescript
// utils/math.ts
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// utils/math.test.ts
import { describe, it, expect } from 'vitest'
import { add, multiply, clamp } from './math'

describe('Math utilities', () => {
  describe('add', () => {
    it('should add two positive numbers', () => {
      expect(add(1, 2)).toBe(3)
    })
    
    it('should add negative numbers', () => {
      expect(add(-1, -2)).toBe(-3)
    })
    
    it('should add positive and negative numbers', () => {
      expect(add(1, -2)).toBe(-1)
    })
  })
  
  describe('multiply', () => {
    it('should multiply two numbers', () => {
      expect(multiply(2, 3)).toBe(6)
    })
    
    it('should handle zero', () => {
      expect(multiply(5, 0)).toBe(0)
    })
  })
  
  describe('clamp', () => {
    it('should return value if within range', () => {
      expect(clamp(5, 0, 10)).toBe(5)
    })
    
    it('should return min if value is below', () => {
      expect(clamp(-5, 0, 10)).toBe(0)
    })
    
    it('should return max if value is above', () => {
      expect(clamp(15, 0, 10)).toBe(10)
    })
  })
})
```

### React 组件测试

```jsx
// components/Button.tsx
import React from 'react'

interface ButtonProps {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  onClick?: () => void
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  onClick
}: ButtonProps) {
  const baseStyles = 'font-semibold rounded transition-colors'
  
  const variantStyles = {
    primary: 'bg-blue-500 text-white hover:bg-blue-600',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300',
    danger: 'bg-red-500 text-white hover:bg-red-600'
  }
  
  const sizeStyles = {
    sm: 'px-2 py-1 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg'
  }
  
  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

// components/Button.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Button } from './Button'

describe('Button Component', () => {
  it('should render children', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByText('Click me')).toBeInTheDocument()
  })
  
  it('should call onClick when clicked', () => {
    const handleClick = vi.fn()
    render(<Button onClick={handleClick}>Click me</Button>)
    
    fireEvent.click(screen.getByText('Click me'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })
  
  it('should be disabled when disabled prop is true', () => {
    render(<Button disabled>Click me</Button>)
    expect(screen.getByText('Click me')).toBeDisabled()
  })
  
  it('should apply correct variant styles', () => {
    const { rerender } = render(<Button variant="primary">Click</Button>)
    expect(screen.getByText('Click')).toHaveClass('bg-blue-500')
    
    rerender(<Button variant="danger">Click</Button>)
    expect(screen.getByText('Click')).toHaveClass('bg-red-500')
  })
  
  it('should apply correct size styles', () => {
    const { rerender } = render(<Button size="sm">Click</Button>)
    expect(screen.getByText('Click')).toHaveClass('px-2')
    
    rerender(<Button size="lg">Click</Button>)
    expect(screen.getByText('Click')).toHaveClass('px-6')
  })
})
```

## 集成测试

### 测试用户交互流程

```jsx
// components/TodoList.tsx
import React, { useState } from 'react'

export function TodoList() {
  const [todos, setTodos] = useState<{ id: number; text: string; done: boolean }[]>([])
  const [input, setInput] = useState('')
  
  const addTodo = () => {
    if (input.trim()) {
      setTodos([...todos, { id: Date.now(), text: input, done: false }])
      setInput('')
    }
  }
  
  const toggleTodo = (id: number) => {
    setTodos(todos.map(todo =>
      todo.id === id ? { ...todo, done: !todo.done } : todo
    ))
  }
  
  const deleteTodo = (id: number) => {
    setTodos(todos.filter(todo => todo.id !== id))
  }
  
  return (
    <div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Add a todo..."
        data-testid="todo-input"
      />
      <button onClick={addTodo} data-testid="add-button">Add</button>
      
      <ul data-testid="todo-list">
        {todos.map(todo => (
          <li key={todo.id} data-testid={`todo-${todo.id}`}>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={() => toggleTodo(todo.id)}
            />
            <span style={{ textDecoration: todo.done ? 'line-through' : 'none' }}>
              {todo.text}
            </span>
            <button onClick={() => deleteTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
      
      <p data-testid="todo-count">{todos.length} todos</p>
    </div>
  )
}

// components/TodoList.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TodoList } from './TodoList'

describe('TodoList Integration', () => {
  it('should add a new todo', async () => {
    const user = userEvent.setup()
    render(<TodoList />)
    
    const input = screen.getByTestId('todo-input')
    const addButton = screen.getByTestId('add-button')
    
    await user.type(input, 'Buy groceries')
    await user.click(addButton)
    
    expect(screen.getByText('Buy groceries')).toBeInTheDocument()
    expect(screen.getByTestId('todo-count')).toHaveTextContent('1 todos')
  })
  
  it('should toggle todo completion', async () => {
    const user = userEvent.setup()
    render(<TodoList />)
    
    // 添加 todo
    await user.type(screen.getByTestId('todo-input'), 'Buy groceries')
    await user.click(screen.getByTestId('add-button'))
    
    // 勾选 todo
    const checkbox = screen.getByRole('checkbox')
    await user.click(checkbox)
    
    expect(checkbox).toBeChecked()
    expect(screen.getByText('Buy groceries')).toHaveClass('line-through')
  })
  
  it('should delete a todo', async () => {
    const user = userEvent.setup()
    render(<TodoList />)
    
    // 添加 todo
    await user.type(screen.getByTestId('todo-input'), 'Buy groceries')
    await user.click(screen.getByTestId('add-button'))
    
    // 删除 todo
    await user.click(screen.getByText('Delete'))
    
    expect(screen.queryByText('Buy groceries')).not.toBeInTheDocument()
    expect(screen.getByTestId('todo-count')).toHaveTextContent('0 todos')
  })
  
  it('should not add empty todos', async () => {
    const user = userEvent.setup()
    render(<TodoList />)
    
    await user.click(screen.getByTestId('add-button'))
    
    expect(screen.getByTestId('todo-count')).toHaveTextContent('0 todos')
  })
})
```

### 测试 API 调用

```jsx
// hooks/useUsers.ts
import { useState, useEffect } from 'react'

export function useUsers() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  useEffect(() => {
    fetch('/api/users')
      .then(res => res.json())
      .then(data => {
        setUsers(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message)
        setLoading(false)
      })
  }, [])
  
  return { users, loading, error }
}

// hooks/useUsers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useUsers } from './useUsers'

describe('useUsers Hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  
  it('should fetch users successfully', async () => {
    const mockUsers = [
      { id: 1, name: 'John' },
      { id: 2, name: 'Jane' }
    ]
    
    vi.spyOn(global, 'fetch').mockResolvedValue({
      json: () => Promise.resolve(mockUsers)
    })
    
    const { result } = renderHook(() => useUsers())
    
    expect(result.current.loading).toBe(true)
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    
    expect(result.current.users).toEqual(mockUsers)
    expect(result.current.error).toBeNull()
  })
  
  it('should handle fetch error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'))
    
    const { result } = renderHook(() => useUsers())
    
    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    
    expect(result.current.error).toBe('Network error')
    expect(result.current.users).toEqual([])
  })
})
```

## E2E 测试

### Playwright 配置

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI
  }
})
```

### 关键用户流程测试

```typescript
// e2e/user-flow.spec.ts
import { test, expect } from '@playwright/test'

test.describe('User Registration Flow', () => {
  test('should complete registration successfully', async ({ page }) => {
    await page.goto('/register')
    
    // 填写表单
    await page.fill('[data-testid="name-input"]', 'John Doe')
    await page.fill('[data-testid="email-input"]', 'john@example.com')
    await page.fill('[data-testid="password-input"]', 'Password123!')
    await page.fill('[data-testid="confirm-password-input"]', 'Password123!')
    
    // 提交表单
    await page.click('[data-testid="submit-button"]')
    
    // 验证成功
    await expect(page).toHaveURL('/dashboard')
    await expect(page.locator('h1')).toContainText('Welcome, John Doe!')
  })
  
  test('should show validation errors for invalid input', async ({ page }) => {
    await page.goto('/register')
    
    // 提交空表单
    await page.click('[data-testid="submit-button"]')
    
    // 验证错误消息
    await expect(page.locator('[data-testid="name-error"]')).toBeVisible()
    await expect(page.locator('[data-testid="email-error"]')).toBeVisible()
    await expect(page.locator('[data-testid="password-error"]')).toBeVisible()
  })
  
  test('should show error for existing email', async ({ page }) => {
    await page.goto('/register')
    
    await page.fill('[data-testid="name-input"]', 'John Doe')
    await page.fill('[data-testid="email-input"]', 'existing@example.com')
    await page.fill('[data-testid="password-input"]', 'Password123!')
    await page.fill('[data-testid="confirm-password-input"]', 'Password123!')
    
    await page.click('[data-testid="submit-button"]')
    
    await expect(page.locator('[data-testid="email-error"]')).toContainText('Email already exists')
  })
})

test.describe('Shopping Cart Flow', () => {
  test('should add item to cart and checkout', async ({ page }) => {
    // 浏览商品
    await page.goto('/products')
    await page.click('[data-testid="product-1"]')
    
    // 添加到购物车
    await page.click('[data-testid="add-to-cart"]')
    await expect(page.locator('[data-testid="cart-count"]')).toHaveText('1')
    
    // 进入购物车
    await page.click('[data-testid="cart-link"]')
    await expect(page.locator('[data-testid="cart-item"]')).toBeVisible()
    
    // 结算
    await page.click('[data-testid="checkout-button"]')
    await expect(page).toHaveURL('/checkout')
    
    // 填写地址
    await page.fill('[data-testid="address-input"]', '123 Main St')
    await page.fill('[data-testid="city-input"]', 'New York')
    await page.fill('[data-testid="zip-input"]', '10001')
    
    // 确认订单
    await page.click('[data-testid="confirm-order"]')
    await expect(page).toHaveURL('/order-confirmation')
    await expect(page.locator('h1')).toContainText('Order Confirmed!')
  })
})
```

## 测试最佳实践

### 1. 测试金字塔原则

```yaml
单元测试 (70%):
  - 工具函数
  - 纯组件
  - Redux reducers
  - 自定义 hooks

集成测试 (20%):
  - 组件交互
  - API 调用
  - 表单验证
  - 路由导航

E2E 测试 (10%):
  - 关键用户流程
  - 购物车结算
  - 用户注册登录
  - 支付流程
```

### 2. 测试命名规范

```typescript
// 使用 describe 和 it 组织测试
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user with valid data', () => {})
    it('should throw error for invalid email', () => {})
    it('should hash password before saving', () => {})
  })
  
  describe('getUser', () => {
    it('should return user by id', () => {})
    it('should throw error for non-existent user', () => {})
  })
})
```

### 3. 测试数据管理

```typescript
// 使用工厂函数创建测试数据
function createTestUser(overrides = {}) {
  return {
    id: 1,
    name: 'Test User',
    email: 'test@example.com',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

// 使用 fixture 管理测试数据
test.describe('User Management', () => {
  test.beforeEach(async ({ page }) => {
    // 准备测试数据
    await page.goto('/users')
  })
  
  test('should display user list', async ({ page }) => {
    const user = createTestUser({ name: 'John Doe' })
    // 测试逻辑
  })
})
```

## CI/CD 集成

```yaml
# .github/workflows/test.yml
name: Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Run unit tests
        run: pnpm test:unit
      
      - name: Run integration tests
        run: pnpm test:integration
      
      - name: Run E2E tests
        run: pnpm test:e2e
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
```

## 总结

前端自动化测试是保证代码质量的关键：

1. **单元测试**：覆盖工具函数和纯组件
2. **集成测试**：覆盖组件交互和 API 调用
3. **E2E 测试**：覆盖关键用户流程
4. **持续集成**：每次提交都运行测试
5. **测试规范**：统一的命名和组织规范

建立完善的测试体系需要时间和投入，但它能够显著提升代码质量和团队效率。
