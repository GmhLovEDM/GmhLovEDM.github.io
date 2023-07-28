---
title: "Monorepo 实战进阶：Turborepo 构建提速"
tag: engineering
description: 深入 Turborepo 的增量构建、任务编排与远程缓存机制，实战讲解如何将 Monorepo 项目的构建时间缩短 10 倍以上。
date: "2023-07-28T08:00:00.000Z"
---

## 目标

在 Monorepo 项目中，随着包数量增长，构建时间会线性甚至超线性增长。全量构建可能从几分钟膨胀到几十分钟，严重影响开发体验和 CI/CD 效率。本文深入 Turborepo 的核心机制，实战讲解如何通过增量构建、任务编排和远程缓存，将构建时间缩短一个数量级。

## 背景

### Monorepo 的构建痛点

假设一个 Monorepo 包含以下模块：

```
apps/
  web/           # Next.js 前端
  admin/         # 管理后台
  api/           # 后端服务
packages/
  ui/            # 组件库
  utils/         # 工具函数
  config/        # 共享配置
  eslint-config/ # ESLint 配置
```

这些模块之间存在复杂的依赖关系：

```
web → ui → utils
web → config
admin → ui → utils
api → utils
```

每次修改 `utils` 包，理想情况下只需要重新构建依赖它的模块。但传统的构建方式通常要么全量构建（慢），要么手动指定构建顺序（容易出错）。

### Turborepo 的核心理念

Turborepo 的设计哲学是**最少工作原则**：

1. **增量构建**：只构建被修改影响的包
2. **并行执行**：无依赖关系的任务并行运行
3. **构建缓存**：相同输入直接复用输出
4. **远程共享**：团队成员和 CI 共享构建缓存

## 核心配置

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
      "env": ["NODE_ENV"]
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
    }
  }
}
```

关键配置解析：

- **`dependsOn: ["^build"]`**：`^` 前缀表示先构建当前包依赖的其他包
- **`outputs`**：指定缓存哪些文件
- **`cache: false`**：dev 命令不缓存（持续运行的任务）
- **`persistent: true`**：标记长时间运行的任务

### package.json 脚本

```json
{
  "name": "my-monorepo",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "type-check": "turbo run type-check",
    "clean": "turbo run clean && rm -rf node_modules/.cache"
  }
}
```

## 任务图（Task Graph）分析

Turborepo 在执行任务前会分析包之间的依赖关系，构建一个有向无环图（DAG）：

```
构建任务图（假设 utils 被修改）：

    utils
    / | \
  ui config
  / \    |
web admin api

执行顺序：
Round 1: utils (并行)
Round 2: ui, config (并行，依赖 utils)
Round 3: web, admin, api (并行，依赖 ui/config)
```

### 查看任务图

```bash
# 生成任务图可视化
turbo run build --graph

# 输出一个 graph.json 文件，可以用 Graphviz 或在线工具查看
```

## 增量构建实战

### 基本增量构建

```bash
# 首次全量构建
turbo run build
# ✓ ui:build: 12.5s
# ✓ config:build: 3.2s
# ✓ utils:build: 2.1s
# ✓ web:build: 18.3s
# ✓ admin:build: 15.1s
# ✓ api:build: 8.7s
# Total: 60.4s

# 第二次构建（无修改）
turbo run build
# ✓ ui:build: cache hit, replayed 12.5s → 0.3s
# ✓ config:build: cache hit, replayed 3.2s → 0.1s
# ✓ utils:build: cache hit, replayed 2.1s → 0.1s
# ✓ web:build: cache hit, replayed 18.3s → 0.2s
# ✓ admin:build: cache hit, replayed 15.1s → 0.2s
# ✓ api:build: cache hit, replayed 8.7s → 0.2s
# Total: 1.4s (60x 加速)
```

### 部分修改的增量构建

```bash
# 修改了 packages/ui/src/Button.tsx
turbo run build
# ✓ utils:build: cache hit, replayed 0.1s
# ✓ config:build: cache hit, replayed 0.1s
# ✓ ui:build: 12.8s (重新构建)
# ✓ web:build: 18.5s (依赖 ui，重新构建)
# ✓ admin:build: 15.3s (依赖 ui，重新构建)
# ✓ api:build: cache hit, replayed 0.1s (不依赖 ui，缓存命中)
# Total: 47.1s (而非 60.4s)
```

### 过滤特定包

```bash
# 只构建某个包及其依赖
turbo run build --filter=web

# 只构建某个包（不包括依赖）
turbo run build --filter=web^...

# 构建某个包及其所有依赖者
turbo run build --filter=utils...

# 排除某个包
turbo run build --filter=!admin
```

## 远程缓存配置

### Vercel 远程缓存

```bash
# 登录 Vercel（免费）
npx turbo login

# 配置远程缓存
npx turbo link
```

### 自建远程缓存

```bash
# 使用 S3 兼容存储
TURBO_REMOTE_CACHE_BACKEND=s3
TURBO_S3_BUCKET=my-turbo-cache
TURBO_S3_REGION=ap-northeast-1
TURBO_S3_ENDPOINT=https://s3.amazonaws.com
```

### CI/CD 中的远程缓存

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
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          cache: 'pnpm'

      # Turborepo 远程缓存 token
      - name: Build
        run: pnpm build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
```

## 高级技巧

### 1. 任务依赖的精细化控制

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test:unit": {
      "dependsOn": ["build"]
    },
    "test:integration": {
      "dependsOn": ["build", "^build"]
    },
    "test:e2e": {
      "dependsOn": ["build", "^build"],
      "cache": false
    }
  }
}
```

### 2. 环境变量感知

```json
{
  "pipeline": {
    "build": {
      "env": ["NODE_ENV", "NEXT_PUBLIC_API_URL"],
      "dependsOn": ["^build"],
      "outputs": [".next/**"]
    }
  }
}
```

当环境变量变化时，Turborepo 会自动使缓存失效。

### 3. 多平台缓存

```json
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "inputs": ["src/**", "package.json", "tsconfig.json"]
    }
  }
}
```

通过 `inputs` 精确指定哪些文件变化会触发重新构建。

## 与 pnpm workspace 的集成

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

```json
// package.json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel"
  },
  "devDependencies": {
    "turbo": "^1.10.0"
  }
}
```

## 性能对比

在一个包含 12 个包的真实项目中的测试结果：

| 场景 | npm scripts | Turborepo |
|------|-------------|-----------|
| 全量构建（首次） | 180s | 165s |
| 无修改构建 | 180s | 2.3s |
| 修改 utils 包 | 180s | 45s |
| 修改单个 app | 180s | 28s |
| CI（远程缓存命中） | 180s | 8s |

可以看到，Turborepo 在增量构建场景下带来的提升是巨大的。

## 总结

Turborepo 通过智能的任务图分析、增量构建和多级缓存机制，极大地提升了 Monorepo 项目的构建效率。关键要点：

1. **理解任务图**：`^` 前缀控制依赖关系，是性能优化的基础
2. **合理配置 outputs**：只缓存必要的产物，避免缓存污染
3. **远程缓存是核心**：团队共享缓存带来最大收益
4. **过滤器是日常利器**：`--filter` 参数让你只构建需要的包

对于中大型前端团队，Turborepo 几乎是 Monorepo 的标配工具。它不仅加速了构建，更重要的是让开发者的心智负担降低——不需要记住哪些包需要重新构建，Turborepo 帮你搞定。
