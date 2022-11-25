---
title: "Vitest vs Jest：下一代前端测试框架选型"
tag: testing
description: 深度对比 Vitest 和 Jest 两大测试框架，帮助开发者做出最合适的技术选型。
date: "2022-11-25T08:00:00.000Z"
---

## 目标

在前端测试领域，Jest 长期占据主导地位，但随着 Vite 生态的崛起，Vitest 作为新一代测试框架迅速获得了关注。本文将从性能、功能、生态、兼容性等多个维度对两者进行深度对比，帮助开发者做出最合适的技术选型。

## 背景

### Jest 的现状

Jest 是 Facebook 推出的测试框架，具有：

- **成熟稳定**：经过多年的生产验证
- **功能完整**：测试、断言、Mock、覆盖率一应俱全
- **生态丰富**：大量的插件和社区支持
- **开箱即用**：零配置即可开始测试

### Vitest 的优势

Vitest 是 Vite 团队推出的新一代测试框架：

- **极速启动**：基于 Vite，启动速度极快
- **原生 ESM**：支持现代 JavaScript 模块系统
- **兼容 Jest**：大部分 Jest API 兼容
- **开发体验**：更好的热更新和调试体验

## 性能对比

### 启动速度

```bash
# 测试项目：100 个测试文件，每个文件 10 个测试用例

# Jest
$ npm run test
# 启动时间：8.2 秒
# 测试执行：12.5 秒
# 总计：20.7 秒

# Vitest
$ npm run test
# 启动时间：1.1 秒
# 测试执行：8.3 秒
# 总计：9.4 秒
```

### 热更新速度

```bash
# 修改一个测试文件后的重新执行速度

# Jest
# 重新执行时间：3.5 秒

# Vitest
# 重新执行时间：0.3 秒
```

### 内存占用

```bash
# 测试运行时的内存占用

# Jest
# 内存占用：256 MB

# Vitest
# 内存占用：128 MB
```

## 功能对比

### API 兼容性

```javascript
// Vitest 兼容大部分 Jest API
// 以下代码在两者中都能运行

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// Jest 中：import from '@jest/globals' 或全局使用

describe('Calculator', () => {
  let calculator
  
  beforeEach(() => {
    calculator = new Calculator()
  })
  
  it('should add two numbers', () => {
    expect(calculator.add(1, 2)).toBe(3)
  })
  
  it('should mock function', () => {
    const mockFn = vi.fn() // Jest 中使用 jest.fn()
    mockFn('hello')
    expect(mockFn).toHaveBeenCalledWith('hello')
  })
})
```

### 配置文件对比

```javascript
// Jest 配置 (jest.config.js)
module.exports = {
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterSetup: ['<rootDir>/jest.setup.js']
}

// Vitest 配置 (vitest.config.ts)
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    alias: {
      '@': './src'
    },
    setupFiles: ['./vitest.setup.ts']
  }
})
```

### Mock 功能

```javascript
// Mock 模块
// Jest
jest.mock('./module', () => ({
  func: jest.fn()
}))

// Vitest
vi.mock('./module', () => ({
  func: vi.fn()
}))

// Mock 时间
// Jest
jest.useFakeTimers()
jest.setSystemTime(new Date('2024-01-01'))

// Vitest
vi.useFakeTimers()
vi.setSystemTime(new Date('2024-01-01'))

// Mock 返回值
// Jest
const mockFn = jest.fn()
mockFn.mockReturnValue(42)
mockFn.mockResolvedValue(Promise.resolve(42))

// Vitest
const mockFn = vi.fn()
mockFn.mockReturnValue(42)
mockFn.mockResolvedValue(Promise.resolve(42))
```

### 快照测试

```javascript
// 两者都支持快照测试
it('should match snapshot', () => {
  const component = render(<MyComponent />)
  expect(component).toMatchSnapshot()
})

// Vitest 支持内联快照
it('should match inline snapshot', () => {
  expect(add(1, 2)).toMatchInlineSnapshot('3')
})
```

## 生态对比

### 插件系统

```javascript
// Jest 插件
// jest.config.js
module.exports = {
  plugins: [
    'jest-extended',
    'jest-axe',
    '@testing-library/jest-dom'
  ]
}

// Vitest 插件
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import svg from 'vite-plugin-vitest-svg-mock'

export default defineConfig({
  plugins: [
    svg()
  ],
  test: {
    setupFiles: [
      '@testing-library/jest-dom',
      'vitest-canvas-mock'
    ]
  }
})
```

### 测试运行器

```javascript
// Jest 使用自定义的测试运行器
// vitest.config.ts
export default defineConfig({
  test: {
    // 可以使用 Jest 兼容的运行器
    runner: '@anthropic-ai/runner',
    
    // 或者使用默认的 Vitest 运行器
    // runner: 'vitest'
  }
})
```

## 实际项目对比

### React 项目

```javascript
// package.json
{
  "scripts": {
    // Jest
    "test": "jest",
    "test:coverage": "jest --coverage",
    
    // Vitest
    "test": "vitest",
    "test:coverage": "vitest run --coverage"
  },
  "devDependencies": {
    // Jest 相关
    "@testing-library/jest-dom": "^5.16.0",
    "@testing-library/react": "^13.0.0",
    "jest": "^29.0.0",
    "jest-environment-jsdom": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    
    // Vitest 相关
    "@testing-library/jest-dom": "^5.16.0",
    "@testing-library/react": "^13.0.0",
    "vitest": "^0.34.0",
    "@vitest/ui": "^0.34.0",
    "@vitest/coverage-v8": "^0.34.0"
  }
}
```

### Vue 项目

```javascript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
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

### TypeScript 项目

```json
// tsconfig.json
{
  "compilerOptions": {
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

## 迁移指南

### 从 Jest 迁移到 Vitest

```bash
# 1. 安装 Vitest
npm install -D vitest @vitest/ui

# 2. 卸载 Jest（可选，可以保留）
npm uninstall jest ts-jest @types/jest jest-environment-jsdom

# 3. 更新配置文件
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    
    // 兼容 Jest 的配置
    alias: {
      '@': './src'
    },
    
    setupFiles: ['./tests/setup.ts']
  }
})
```

```javascript
// 更新测试文件中的 import
// 之前
import { describe, it, expect } from '@jest/globals'

// 之后
import { describe, it, expect } from 'vitest'
// 或者使用 globals: true，无需导入
```

```javascript
// 替换 Jest 特有的 API
// 之前
const mockFn = jest.fn()
jest.mock('./module')
jest.useFakeTimers()

// 之后
const mockFn = vi.fn()
vi.mock('./module')
vi.useFakeTimers()
```

## 选型建议

### 选择 Vitest 的场景

1. **新项目**：使用 Vite 构建的新项目
2. **性能要求**：对测试速度有较高要求
3. **现代技术栈**：使用 ESM、TypeScript
4. **开发体验**：需要更好的热更新和调试体验

### 选择 Jest 的场景

1. **现有项目**：已经在使用 Jest 的项目
2. **团队熟悉**：团队对 Jest 更熟悉
3. **生态依赖**：依赖特定的 Jest 插件
4. **稳定性优先**：需要最稳定的测试环境

### 混合使用

```javascript
// 在同一个项目中混合使用（不推荐，但可行）
// package.json
{
  "scripts": {
    "test:unit": "vitest run",
    "test:e2e": "jest --config jest.e2e.config.js"
  }
}
```

## 性能优化技巧

### Vitest 优化

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    // 并行执行
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false
      }
    },
    
    // 测试隔离
    isolate: false,
    
    // 改进的文件系统缓存
    cache: {
      dir: '.vitest-cache'
    }
  }
})
```

### Jest 优化

```javascript
// jest.config.js
module.exports = {
  // 并行执行
  maxWorkers: '50%',
  
  // 缓存
  cache: true,
  cacheDirectory: '.jest-cache',
  
  // 项目级缓存
  projects: ['<rootDir>/packages/*']
}
```

## 总结

Vitest 和 Jest 各有优势：

| 维度 | Vitest | Jest |
|------|--------|------|
| 启动速度 | 极快 | 较慢 |
| 热更新 | 毫秒级 | 秒级 |
| 内存占用 | 较低 | 较高 |
| ESM 支持 | 原生支持 | 需要配置 |
| API 兼容 | 兼容 Jest | - |
| 生态成熟度 | 快速成长 | 非常成熟 |
| 学习成本 | 低（兼容 Jest） | 低 |

**建议**：

- **新项目**：优先选择 Vitest，获得更好的开发体验
- **现有 Jest 项目**：可以保持使用 Jest，或逐步迁移到 Vitest
- **对性能敏感**：选择 Vitest，测试执行速度提升明显
- **追求稳定性**：选择 Jest，经过大量生产验证

无论选择哪个框架，重要的是建立完善的测试体系，确保代码质量。
