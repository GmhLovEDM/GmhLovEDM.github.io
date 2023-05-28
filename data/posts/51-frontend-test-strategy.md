---
title: "Frontend Automated Testing Strategy: Full Coverage from Unit Tests to E2E"
tag: testing
description: Building a complete frontend testing system with full coverage strategies from unit tests to end-to-end tests.
date: "2023-05-28T08:00:00.000Z"
---

## Goal

Automated frontend testing is a critical component of ensuring code quality. However, many teams have low test coverage or adopt unreasonable testing strategies. This article systematically introduces a complete frontend testing strategy, from unit tests to end-to-end tests, helping teams build a reliable testing system.

## Background

### Why Testing Matters

1. **Preventing regressions**: Ensuring that new code does not break existing functionality.
2. **Safe refactoring**: Enabling confident code refactoring.
3. **Living documentation**: Test code serves as living documentation.
4. **Design guidance**: Test-driven development improves code design.
5. **Team collaboration**: New members can quickly understand system behavior.

### The Testing Pyramid

```
        /\
       /  \        E2E Tests
      /    \       (few, covering critical paths)
     /------\
    /        \     Integration Tests
   /          \    (moderate, covering component interactions)
  /------------\
 /              \  Unit Tests
/                \ (many, covering utility functions)
------------------
```

## Unit Tests

### Choosing a Test Framework

```javascript
// Vitest (recommended)
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

### Utility Function Testing

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

### React Component Testing

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

## Integration Tests

### Testing User Interaction Flows

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
    
    // Add a todo
    await user.type(screen.getByTestId('todo-input'), 'Buy groceries')
    await user.click(screen.getByTestId('add-button'))
    
    // Toggle the todo
    const checkbox = screen.getByRole('checkbox')
    await user.click(checkbox)
    
    expect(checkbox).toBeChecked()
    expect(screen.getByText('Buy groceries')).toHaveClass('line-through')
  })
  
  it('should delete a todo', async () => {
    const user = userEvent.setup()
    render(<TodoList />)
    
    // Add a todo
    await user.type(screen.getByTestId('todo-input'), 'Buy groceries')
    await user.click(screen.getByTestId('add-button'))
    
    // Delete the todo
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

### Testing API Calls

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

## E2E Tests

### Playwright Configuration

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

### Critical User Flow Testing

```typescript
// e2e/user-flow.spec.ts
import { test, expect } from '@playwright/test'

test.describe('User Registration Flow', () => {
  test('should complete registration successfully', async ({ page }) => {
    await page.goto('/register')
    
    // Fill out the form
    await page.fill('[data-testid="name-input"]', 'John Doe')
    await page.fill('[data-testid="email-input"]', 'john@example.com')
    await page.fill('[data-testid="password-input"]', 'Password123!')
    await page.fill('[data-testid="confirm-password-input"]', 'Password123!')
    
    // Submit the form
    await page.click('[data-testid="submit-button"]')
    
    // Verify success
    await expect(page).toHaveURL('/dashboard')
    await expect(page.locator('h1')).toContainText('Welcome, John Doe!')
  })
  
  test('should show validation errors for invalid input', async ({ page }) => {
    await page.goto('/register')
    
    // Submit empty form
    await page.click('[data-testid="submit-button"]')
    
    // Verify error messages
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
    // Browse products
    await page.goto('/products')
    await page.click('[data-testid="product-1"]')
    
    // Add to cart
    await page.click('[data-testid="add-to-cart"]')
    await expect(page.locator('[data-testid="cart-count"]')).toHaveText('1')
    
    // Go to cart
    await page.click('[data-testid="cart-link"]')
    await expect(page.locator('[data-testid="cart-item"]')).toBeVisible()
    
    // Proceed to checkout
    await page.click('[data-testid="checkout-button"]')
    await expect(page).toHaveURL('/checkout')
    
    // Fill in address
    await page.fill('[data-testid="address-input"]', '123 Main St')
    await page.fill('[data-testid="city-input"]', 'New York')
    await page.fill('[data-testid="zip-input"]', '10001')
    
    // Confirm order
    await page.click('[data-testid="confirm-order"]')
    await expect(page).toHaveURL('/order-confirmation')
    await expect(page.locator('h1')).toContainText('Order Confirmed!')
  })
})
```

## Testing Best Practices

### 1. Testing Pyramid Principle

```yaml
Unit Tests (70%):
  - Utility functions
  - Pure components
  - Redux reducers
  - Custom hooks

Integration Tests (20%):
  - Component interactions
  - API calls
  - Form validation
  - Route navigation

E2E Tests (10%):
  - Critical user flows
  - Shopping cart checkout
  - User registration and login
  - Payment flows
```

### 2. Test Naming Conventions

```typescript
// Organize tests using describe and it
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

### 3. Test Data Management

```typescript
// Use factory functions to create test data
function createTestUser(overrides = {}) {
  return {
    id: 1,
    name: 'Test User',
    email: 'test@example.com',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

// Use fixtures to manage test data
test.describe('User Management', () => {
  test.beforeEach(async ({ page }) => {
    // Set up test data
    await page.goto('/users')
  })
  
  test('should display user list', async ({ page }) => {
    const user = createTestUser({ name: 'John Doe' })
    // Test logic
  })
})
```

## CI/CD Integration

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

## Summary

Automated frontend testing is critical for ensuring code quality:

1. **Unit tests**: Cover utility functions and pure components.
2. **Integration tests**: Cover component interactions and API calls.
3. **E2E tests**: Cover critical user flows.
4. **Continuous integration**: Run tests on every commit.
5. **Testing standards**: Consistent naming and organizational conventions.

Building a comprehensive testing system requires time and investment, but it significantly improves code quality and team efficiency.
