---
title: "用 AI 辅助写单测：从手写到生成的效率飞跃"
tag: ai
description: 探索如何利用 AI 工具自动生成单元测试，提升测试覆盖率和开发效率，同时保持测试质量。
date: "2025-02-28T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者掌握使用 AI 工具生成单元测试的方法和技巧，了解 AI 生成测试的优势和局限，建立高效的测试工作流程。

## 背景

单元测试是保证代码质量的重要手段，但手写测试耗时耗力。AI 工具的出现改变了这一现状——它们可以自动生成测试用例，覆盖边界情况，大幅提升开发效率。

### 为什么用 AI 写测试？

1. **提升效率**：AI 可以在几秒内生成测试用例
2. **覆盖全面**：AI 能够想到人工容易忽略的边界情况
3. **减少重复**：相似的测试可以批量生成
4. **保持专注**：开发者可以专注于核心业务逻辑

### AI 生成测试的局限

1. **业务逻辑**：AI 可能不理解复杂的业务规则
2. **集成测试**：需要人工设计测试场景
3. **断言选择**：AI 可能选择不恰当的断言
4. **维护成本**：生成的测试可能需要调整

## 一、AI 测试生成工具

### GitHub Copilot

```typescript
// 输入函数签名和注释
// Copilot 会自动生成测试

// 源代码
function calculateDiscount(price: number, discount: number): number {
  if (price < 0) throw new Error('Price cannot be negative');
  if (discount < 0 || discount > 100) throw new Error('Invalid discount');
  return price * (1 - discount / 100);
}

// Copilot 生成的测试
describe('calculateDiscount', () => {
  it('should calculate discount correctly', () => {
    expect(calculateDiscount(100, 10)).toBe(90);
  });

  it('should return full price for 0% discount', () => {
    expect(calculateDiscount(100, 0)).toBe(100);
  });

  it('should return 0 for 100% discount', () => {
    expect(calculateDiscount(100, 100)).toBe(0);
  });

  it('should throw error for negative price', () => {
    expect(() => calculateDiscount(-100, 10)).toThrow('Price cannot be negative');
  });

  it('should throw error for invalid discount', () => {
    expect(() => calculateDiscount(100, -10)).toThrow('Invalid discount');
    expect(() => calculateDiscount(100, 110)).toThrow('Invalid discount');
  });
});
```

### Cursor

```typescript
// Cursor 的 @test 命令
// 选中函数 → Cmd+K → "Generate tests"

// 源代码
async function fetchUserData(userId: string): Promise<User> {
  const response = await fetch(`/api/users/${userId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch user');
  }
  return response.json();
}

// Cursor 生成的测试
describe('fetchUserData', () => {
  const mockFetch = jest.fn();
  global.fetch = mockFetch;

  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should fetch user data successfully', async () => {
    const mockUser = { id: '1', name: 'John' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockUser),
    });

    const user = await fetchUserData('1');

    expect(user).toEqual(mockUser);
    expect(mockFetch).toHaveBeenCalledWith('/api/users/1');
  });

  it('should throw error when response is not ok', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    await expect(fetchUserData('1')).rejects.toThrow('Failed to fetch user');
  });

  it('should handle network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(fetchUserData('1')).rejects.toThrow('Network error');
  });
});
```

### Claude Code

```bash
# 使用 Claude Code 生成测试
> 为 src/utils/math.ts 中的所有函数编写单元测试

# Claude Code 会：
# 1. 分析源代码
# 2. 理解函数行为
# 3. 生成完整的测试文件
```

## 二、AI 生成测试的最佳实践

### 1. 提供清晰的上下文

```typescript
// 好的提示
/**
 * 生成测试用例，覆盖以下场景：
 * 1. 正常情况
 * 2. 边界值（0, 100）
 * 3. 无效输入（负数，超过100）
 * 4. 异步操作的成功和失败
 */

// 不好的提示
// "写测试"
```

### 2. 迭代式生成

```markdown
## 迭代步骤

### 第一轮
> 为 UserService 类生成基本测试

### 第二轮
> 添加更多边界情况测试

### 第三轮
> 添加异步操作和错误处理测试

### 第四轮
> 优化测试代码，添加 setup/teardown
```

### 3. 审查和调整

```typescript
// AI 生成的测试可能需要调整

// 原始生成
it('should work', () => {
  expect(result).toBeTruthy();
});

// 调整后
it('should return user with valid id', () => {
  const user = service.getUser('valid-id');
  expect(user).toBeDefined();
  expect(user.id).toBe('valid-id');
  expect(user.name).toBe('John');
});
```

### 4. 保持测试独立性

```typescript
// 好的测试：独立运行
describe('UserService', () => {
  let service: UserService;
  let mockDb: MockDatabase;

  beforeEach(() => {
    mockDb = new MockDatabase();
    service = new UserService(mockDb);
  });

  it('test 1', async () => {
    // 每个测试独立
  });

  it('test 2', async () => {
    // 不依赖其他测试
  });
});
```

## 三、实战案例

### 案例 1：React 组件测试

```typescript
// AI 生成的 React 组件测试
import { render, screen, fireEvent } from '@testing-library/react';
import { UserCard } from './UserCard';

describe('UserCard', () => {
  const mockUser = {
    id: '1',
    name: 'John Doe',
    email: 'john@example.com',
    avatar: '/avatar.jpg',
  };

  const mockOnEdit = jest.fn();
  const mockOnDelete = jest.fn();

  it('should render user information', () => {
    render(
      <UserCard
        user={mockUser}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
      />
    );

    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('john@example.com')).toBeInTheDocument();
    expect(screen.getByAltText('John Doe')).toHaveAttribute(
      'src',
      '/avatar.jpg'
    );
  });

  it('should call onEdit when edit button is clicked', () => {
    render(
      <UserCard
        user={mockUser}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
      />
    );

    fireEvent.click(screen.getByText('Edit'));
    expect(mockOnEdit).toHaveBeenCalledWith(mockUser.id);
  });

  it('should call onDelete when delete button is clicked', () => {
    render(
      <UserCard
        user={mockUser}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
      />
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(mockOnDelete).toHaveBeenCalledWith(mockUser.id);
  });

  it('should show confirmation dialog before delete', async () => {
    window.confirm = jest.fn(() => true);

    render(
      <UserCard
        user={mockUser}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
      />
    );

    fireEvent.click(screen.getByText('Delete'));
    expect(window.confirm).toHaveBeenCalled();
    expect(mockOnDelete).toHaveBeenCalledWith(mockUser.id);
  });
});
```

### 案例 2：API 测试

```typescript
// AI 生成的 API 测试
import request from 'supertest';
import app from '../app';
import { db } from '../database';

describe('User API', () => {
  beforeEach(async () => {
    await db.truncate();
  });

  describe('GET /api/users', () => {
    it('should return empty array when no users', async () => {
      const response = await request(app).get('/api/users');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('should return users', async () => {
      await db.users.create({ name: 'John', email: 'john@example.com' });

      const response = await request(app).get('/api/users');
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].name).toBe('John');
    });

    it('should support pagination', async () => {
      // 创建 15 个用户
      for (let i = 0; i < 15; i++) {
        await db.users.create({ name: `User ${i}`, email: `user${i}@example.com` });
      }

      const response = await request(app)
        .get('/api/users')
        .query({ page: 1, limit: 10 });

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(10);
      expect(response.body.total).toBe(15);
    });
  });

  describe('POST /api/users', () => {
    it('should create user', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ name: 'John', email: 'john@example.com' });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('John');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ name: 'John' });

      expect(response.status).toBe(400);
      expect(response.body.errors).toContain('email is required');
    });

    it('should validate email format', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ name: 'John', email: 'invalid-email' });

      expect(response.status).toBe(400);
      expect(response.body.errors).toContain('invalid email format');
    });
  });
});
```

### 案例 3：工具函数测试

```typescript
// AI 生成的工具函数测试
import {
  formatDate,
  validateEmail,
  calculateAge,
  debounce,
  deepClone,
} from './utils';

describe('formatDate', () => {
  it('should format date correctly', () => {
    const date = new Date('2024-01-15');
    expect(formatDate(date)).toBe('2024-01-15');
  });

  it('should handle invalid date', () => {
    expect(() => formatDate(new Date('invalid'))).toThrow('Invalid date');
  });
});

describe('validateEmail', () => {
  it('should validate correct email', () => {
    expect(validateEmail('test@example.com')).toBe(true);
  });

  it('should reject invalid email', () => {
    expect(validateEmail('invalid')).toBe(false);
    expect(validateEmail('test@')).toBe(false);
    expect(validateEmail('@example.com')).toBe(false);
  });
});

describe('calculateAge', () => {
  it('should calculate age correctly', () => {
    const birthDate = new Date('1990-01-01');
    const age = calculateAge(birthDate);
    expect(age).toBeGreaterThan(30);
  });

  it('should handle future date', () => {
    const futureDate = new Date('2030-01-01');
    expect(() => calculateAge(futureDate)).toThrow('Invalid birth date');
  });
});

describe('debounce', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should debounce function calls', () => {
    const mockFn = jest.fn();
    const debouncedFn = debounce(mockFn, 500);

    debouncedFn();
    debouncedFn();
    debouncedFn();

    expect(mockFn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(500);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});

describe('deepClone', () => {
  it('should deep clone objects', () => {
    const original = {
      a: 1,
      b: { c: 2 },
      d: [1, 2, 3],
    };

    const cloned = deepClone(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.b).not.toBe(original.b);
  });

  it('should handle circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;

    const cloned = deepClone(obj);
    expect(cloned.a).toBe(1);
    expect(cloned.self).toBe(cloned);
  });
});
```

## 四、提高测试质量

### 1. 测试覆盖分析

```bash
# 生成覆盖率报告
npm test -- --coverage

# 查看报告
open coverage/lcov-report/index.html
```

### 2. 代码变异测试

```typescript
// 使用 Stryker 进行变异测试
// stryker.conf.js
module.exports = {
  mutate: ['src/**/*.ts'],
  testRunner: 'jest',
  coverageAnalysis: 'perTest',
};
```

### 3. 测试审查清单

```markdown
## 测试审查清单

### 测试结构
- [ ] 测试名称清晰描述测试内容
- [ ] 使用 describe/it 正确组织
- [ ] 每个测试只测试一个功能点

### 测试数据
- [ ] 使用有意义的测试数据
- [ ] 覆盖边界情况
- [ ] 清理测试数据

### 断言
- [ ] 使用具体的断言
- [ ] 测试预期的行为
- [ ] 验证副作用

### 可维护性
- [ ] 避免测试重复
- [ ] 使用 setup/teardown
- [ ] 保持测试独立
```

## 五、工作流程优化

### 1. TDD + AI

```markdown
## TDD + AI 工作流

### Step 1: 写测试（人工）
- 定义测试场景
- 编写测试用例

### Step 2: AI 生成实现
> 根据测试生成实现代码

### Step 3: 审查和调整
- 检查代码质量
- 优化实现

### Step 4: 补充测试
> 为边界情况添加更多测试
```

### 2. 代码审查 + AI

```markdown
## 代码审查 + AI 工作流

### Step 1: 代码审查
- 发现潜在问题
- 标记需要测试的地方

### Step 2: AI 生成测试
> 为标记的代码生成测试

### Step 3: 人工审查
- 检查测试质量
- 调整测试场景

### Step 4: 合并代码
```

### 3. 重构 + AI

```markdown
## 重构 + AI 工作流

### Step 1: 确保现有测试通过
npm test

### Step 2: 重构代码
- 修改实现
- 保持接口不变

### Step 3: AI 补充测试
> 为新代码生成测试

### Step 4: 验证所有测试通过
npm test
```

## 六、常见问题和解决方案

### 问题 1：生成的测试不够深入

```typescript
// 解决方案：提供更详细的提示
/**
 * 生成测试，覆盖：
 * 1. 正常情况
 * 2. 边界值（0, MAX_VALUE）
 * 3. 无效输入（null, undefined, 空字符串）
 * 4. 异步操作超时
 * 5. 并发调用
 */
```

### 问题 2：测试依赖外部服务

```typescript
// 解决方案：Mock 外部依赖
jest.mock('./api', () => ({
  fetchUser: jest.fn(),
}));

it('should handle API error', async () => {
  (api.fetchUser as jest.Mock).mockRejectedValue(new Error('Network error'));
  
  await expect(service.getUser('1')).rejects.toThrow('Network error');
});
```

### 问题 3：测试代码重复

```typescript
// 解决方案：提取公共 helper
function createTestUser(overrides = {}) {
  return {
    id: '1',
    name: 'Test User',
    email: 'test@example.com',
    ...overrides,
  };
}

it('should process user', () => {
  const user = createTestUser({ name: 'Custom Name' });
  // ...
});
```

## 七、效率对比

```markdown
## 效率对比数据

### 传统方式
- 理解代码：10分钟
- 设计测试场景：15分钟
- 编写测试代码：30分钟
- 调试测试：10分钟
- 总计：65分钟

### AI 辅助方式
- 提供上下文：5分钟
- AI 生成测试：1分钟
- 审查调整：15分钟
- 调试测试：5分钟
- 总计：26分钟

### 效率提升：60%
```

## 总结

AI 辅助写测试是提升开发效率的有效方式，但需要正确使用。

| 方面 | 优势 | 注意事项 |
|------|------|----------|
| 效率 | 大幅提升 | 需要审查 |
| 覆盖率 | 更全面 | 可能有冗余 |
| 质量 | 基础保障 | 需要人工优化 |
| 维护 | 减少重复 | 可能需要调整 |

**姐姐的建议**：

1. **AI 是辅助**：测试设计仍需人工思考
2. **审查是必须**：AI 生成的测试需要审查
3. **迭代式生成**：从简单开始，逐步深入
4. **保持独立**：测试应该独立运行
5. **持续优化**：定期回顾和改进测试

AI 辅助写测试可以让你从重复性工作中解放出来，专注于更有价值的任务。希望这篇指南能帮助宝宝们建立高效的测试工作流程。
