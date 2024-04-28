---
title: "前端 Monorepo 2024 实战：pnpm workspace + Turborepo"
tag: engineering
description: 基于 pnpm workspace 和 Turborepo 搭建现代前端 Monorepo，从项目结构到 CI/CD 的完整实战指南。
date: "2024-04-28T08:00:00.000Z"
---

## 目标

Monorepo 是管理多个相关项目的高效方式。2024 年，pnpm workspace + Turborepo 已经成为前端 Monorepo 的最佳实践组合。本文从零搭建一个生产级 Monorepo 项目，涵盖项目结构设计、依赖管理、构建优化和 CI/CD 配置。

## 背景

### Monorepo vs Polyrepo

```
Monorepo（单仓库多项目）：
  repo/
    ├── apps/
    │   ├── web/
    │   ├── admin/
    │   └── api/
    ├── packages/
    │   ├── ui/
    │   ├── utils/
    │   └── config/
    └── package.json

Polyrepo（多仓库）：
  web-repo/
  admin-repo/
  api-repo/
  ui-repo/  ← 通过 npm 包引用
```

### 为什么选择 pnpm

| 特性 | npm | yarn | pnpm |
|------|-----|------|------|
| 安装速度 | 慢 | 中等 | 极快 |
| 磁盘占用 | 高 | 高 | 低（硬链接） |
| 幽灵依赖 | 有 | 有 | 无 |
| Workspace 支持 | 基础 | 支持 | 优秀 |
| 严格性 | 低 | 低 | 高 |

### pnpm + Turborepo 的优势

- **pnpm**：快速、节省磁盘、严格的依赖管理
- **Turborepo**：增量构建、远程缓存、任务编排

## 项目初始化

### 创建 Monorepo

```bash
# 创建项目目录
mkdir my-monorepo && cd my-monorepo

# 初始化 pnpm workspace
pnpm init

# 创建 workspace 配置
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF

# 创建目录结构
mkdir -p apps/web apps/admin packages/ui packages/utils
```

### 根目录 package.json

```json
{
  "name": "my-monorepo",
  "private": true,
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "clean": "turbo run clean && rm -rf node_modules/.cache",
    "prepare": "husky install"
  },
  "devDependencies": {
    "turbo": "^1.12.0",
    "husky": "^9.0.0",
    "lint-staged": "^15.0.0",
    "prettier": "^3.2.0"
  },
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```

## Turborepo 配置

### turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env.*"],
  "globalEnv": ["NODE_ENV"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**", "!.next/cache/**"],
      "env": ["NEXT_PUBLIC_*"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "type-check": {
      "dependsOn": ["^build"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

## 共享包设计

### utils 包

```typescript
// packages/utils/package.json
{
  "name": "@my-org/utils",
  "version": "0.0.1",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --dts",
    "dev": "tsup src/index.ts --dts --watch",
    "clean": "rm -rf dist",
    "type-check": "tsc --noEmit"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.3.0"
  }
}
```

```typescript
// packages/utils/src/index.ts
export * from './format';
export * from './validation';
export * from './helpers';
```

```typescript
// packages/utils/src/format.ts
export function formatDate(date: Date, format = 'YYYY-MM-DD'): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return format
    .replace('YYYY', year.toString())
    .replace('MM', month)
    .replace('DD', day);
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
}
```

```typescript
// packages/utils/src/validation.ts
export function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
```

### ui 包

```typescript
// packages/ui/package.json
{
  "name": "@my-org/ui",
  "version": "0.0.1",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --dts",
    "dev": "tsup src/index.ts --dts --watch",
    "clean": "rm -rf dist",
    "type-check": "tsc --noEmit"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0"
  }
}
```

```typescript
// packages/ui/src/index.ts
export * from './Button';
export * from './Input';
export * from './Card';
```

```typescript
// packages/ui/src/Button.tsx
import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  ...props
}) => {
  const baseStyles = 'font-semibold rounded-lg transition-colors';
  
  const variantStyles = {
    primary: 'bg-blue-500 text-white hover:bg-blue-600',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300',
    ghost: 'bg-transparent text-gray-600 hover:bg-gray-100',
  };

  const sizeStyles = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-base',
    lg: 'px-6 py-3 text-lg',
  };

  return (
    <button
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${
        loading ? 'opacity-50 cursor-not-allowed' : ''
      } ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="flex items-center gap-2">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
              fill="none"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          加载中...
        </span>
      ) : (
        children
      )}
    </button>
  );
};
```

## 应用开发

### Next.js Web 应用

```typescript
// apps/web/package.json
{
  "name": "@my-org/web",
  "version": "0.0.1",
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "clean": "rm -rf .next",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "@my-org/ui": "workspace:*",
    "@my-org/utils": "workspace:*",
    "next": "^14.1.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/react": "^18.2.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.3.0"
  }
}
```

```typescript
// apps/web/app/page.tsx
import { Button, Card } from '@my-org/ui';
import { formatDate } from '@my-org/utils';

export default function HomePage() {
  return (
    <div className="min-h-screen p-8">
      <Card>
        <h1 className="text-2xl font-bold mb-4">Monorepo 示例</h1>
        <p className="text-gray-600 mb-4">
          今天是 {formatDate(new Date())}
        </p>
        <div className="flex gap-4">
          <Button variant="primary">主要按钮</Button>
          <Button variant="secondary">次要按钮</Button>
        </div>
      </Card>
    </div>
  );
}
```

## CI/CD 配置

### GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

      - name: Lint
        run: pnpm lint

      - name: Test
        run: pnpm test

      - name: Type Check
        run: pnpm type-check

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: apps/web
```

## 开发体验

### 热重载开发

```bash
# 启动所有应用的开发服务器
pnpm dev

# 只启动特定应用
pnpm --filter @my-org/web dev

# 只启动特定应用及其依赖
pnpm --filter @my-org/web... dev
```

### IDE 配置

```json
// .vscode/settings.json
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "eslint.validate": ["typescript", "typescriptreact"]
}

// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Web",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/next",
      "runtimeArgs": ["dev", "--port", "3000"],
      "cwd": "${workspaceFolder}/apps/web"
    }
  ]
}
```

## 常见问题

### 依赖版本冲突

```bash
# 查看依赖树
pnpm why <package>

# 强制所有包使用同一版本
pnpm dedupe
```

### 包间依赖

```typescript
// 使用 workspace 协议
{
  "dependencies": {
    "@my-org/ui": "workspace:*",  // 开发时链接到本地
    "@my-org/utils": "workspace:*"
  }
}
```

### 构建顺序

```json
// Turborepo 自动处理依赖顺序
// utils → ui → web/admin
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"]  // ^ 表示先构建依赖
    }
  }
}
```

## 总结

pnpm + Turborepo 是 2024 年前端 Monorepo 的最佳实践。关键要点：

1. **pnpm**：快速、节省磁盘、严格的依赖管理
2. **Turborepo**：增量构建、远程缓存、智能任务编排
3. **workspace 协议**：包间依赖的最佳实践
4. **CI/CD 优化**：利用远程缓存加速构建
5. **开发体验**：热重载、IDE 支持、类型安全

Monorepo 不是银弹，对于小型项目可能增加复杂度。但对于中大型团队和多应用项目，Monorepo 是管理代码的高效方式。
