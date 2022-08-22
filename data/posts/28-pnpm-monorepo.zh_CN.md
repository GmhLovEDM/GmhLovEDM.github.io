---
title: "用 pnpm 管理 Monorepo：告别 node_modules 地狱"
tag: nodejs
description: 详解如何使用 pnpm workspace 管理 monorepo 项目，解决依赖管理的痛点问题。
date: "2022-08-22T08:00:00.000Z"
---

## 目标

在大型前端项目中，monorepo（单一代码仓库）架构已经成为主流方案。然而，传统的 npm/yarn 在管理 monorepo 时存在诸多问题：磁盘空间浪费、依赖重复安装、幽灵依赖等。本文将深入介绍如何使用 pnpm 的 workspace 功能来高效管理 monorepo，从根本上解决这些痛点。

## 背景

### 传统包管理器的痛点

在使用 npm 或 yarn 的 monorepo 项目中，常见的问题包括：

1. **磁盘空间浪费**：每个包的 `node_modules` 中都存在大量重复的依赖副本
2. **安装速度慢**：依赖需要被重复下载和解压
3. **幽灵依赖（Phantom Dependencies）**：可以访问未在 `package.json` 中声明的依赖
4. **依赖提升问题**：hoisting 机制导致依赖版本不可控

```bash
# npm/yarn 的 node_modules 结构
project/
├── packages/
│   ├── app-a/
│   │   └── node_modules/  # 包含大量重复依赖
│   ├── app-b/
│   │   └── node_modules/  # 同样的依赖又被安装一次
│   └── shared/
│       └── node_modules/  # 又一份...
└── node_modules/          # 根目录还有一份
```

### pnpm 的解决方案

pnpm（Performant npm）通过以下技术创新解决了这些问题：

- **硬链接 + 符号链接**：所有包共享同一个全局 store，通过硬链接避免重复存储
- **严格的依赖隔离**：只有显式声明的依赖才能被访问
- **并行安装**：多包同时安装，大幅提升速度

```bash
# pnpm 的 node_modules 结构
project/
├── packages/
│   ├── app-a/
│   │   └── node_modules/  # 只有符号链接
│   ├── app-b/
│   │   └── node_modules/  # 只有符号链接
│   └── shared/
│       └── node_modules/  # 只有符号链接
└── node_modules/          # 符号链接到全局 store
```

## pnpm Workspace 配置

### 初始化 Monorepo

```bash
# 创建项目根目录
mkdir my-monorepo && cd my-monorepo

# 初始化 pnpm workspace
pnpm init

# 创建 workspace 配置文件
cat > pnpm-workspace.yaml << EOF
packages:
  - 'packages/*'
  - 'apps/*'
EOF
```

### 目录结构设计

```
my-monorepo/
├── pnpm-workspace.yaml      # workspace 配置
├── package.json              # 根 package.json
├── pnpm-lock.yaml            # 锁文件（只有一份）
├── packages/                 # 共享包
│   ├── utils/
│   │   ├── package.json
│   │   └── src/
│   ├── ui-components/
│   │   ├── package.json
│   │   └── src/
│   └── config/
│       └── package.json
└── apps/                     # 应用
    ├── web-app/
    │   ├── package.json
    │   └── src/
    └── admin-app/
        ├── package.json
        └── src/
```

### 配置包间依赖

在各个子包的 `package.json` 中声明依赖：

```json
// packages/utils/package.json
{
  "name": "@my/utils",
  "version": "1.0.0",
  "main": "./src/index.js",
  "types": "./src/index.d.ts"
}
```

```json
// apps/web-app/package.json
{
  "name": "@my/web-app",
  "version": "1.0.0",
  "dependencies": {
    "@my/utils": "workspace:*",
    "@my/ui-components": "workspace:*"
  }
}
```

`workspace:*` 表示使用 workspace 中的本地包，pnpm 会自动解析为正确的路径。

## 常用命令详解

### 安装依赖

```bash
# 安装所有包的依赖
pnpm install

# 只安装某个包的依赖（及其依赖的本地包）
pnpm install --filter @my/web-app

# 安装某个包及其所有依赖包
pnpm install --filter @my/web-app...

# 从根目录安装某个依赖到指定包
pnpm add lodash --filter @my/utils
```

### 运行脚本

```bash
# 在所有包中运行 build 脚本
pnpm -r run build

# 在指定包中运行脚本
pnpm --filter @my/utils run build

# 在所有包中运行 test
pnpm -r run test

# 并行运行（更快）
pnpm -r --parallel run build
```

### 添加/删除依赖

```bash
# 添加依赖到指定包
pnpm add axios --filter @my/web-app

# 添加 dev 依赖
pnpm add -D typescript --filter @my/utils

# 添加内部包依赖
pnpm add @my/utils --filter @my/web-app

# 在所有包中添加依赖
pnpm add lodash -r
```

## 高级配置

### 协议配置

在 `pnpm-workspace.yaml` 中可以配置更精细的包匹配规则：

```yaml
packages:
  # 所有 packages 目录下的包
  - 'packages/*'
  
  # apps 目录下的所有包
  - 'apps/*'
  
  # 支持嵌套目录
  - 'packages/**/*'
  
  # 排除特定目录
  - '!**/node_modules/**'
```

### 依赖覆盖

在根 `package.json` 中统一管理依赖版本：

```json
{
  "pnpm": {
    "overrides": {
      // 强制所有包使用特定版本的依赖
      "lodash": "^4.17.21",
      
      // 解决安全漏洞
      "minimist": "^1.2.6"
    },
    
    // 允许特定依赖被幽灵访问（不推荐）
    "peerDependencyRules": {
      "ignoreMissing": ["@types/react"]
    }
  }
}
```

### 脚本链接

通过 `link-workspace-packages` 配置，可以让 pnpm 自动将 workspace 包符号链接：

```yaml
packages:
  - 'packages/*'
  - 'apps/*'

# 自动链接 workspace 包
link-workspace-packages: true
prefer-workspace-packages: true
```

## 实际案例：搭建 Vue 3 组件库

```bash
# 创建 monorepo 结构
mkdir vue3-component-lib && cd vue3-component-lib
pnpm init

# 创建 workspace 配置
cat > pnpm-workspace.yaml << EOF
packages:
  - 'packages/*'
EOF

# 创建组件库包
mkdir -p packages/button/src
mkdir -p packages/input/src
mkdir -p packages/example

# 初始化按钮组件包
cat > packages/button/package.json << EOF
{
  "name": "@my/button",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "module": "./dist/index.es.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "vite build",
    "dev": "vite"
  },
  "dependencies": {
    "@my/utils": "workspace:*"
  },
  "devDependencies": {
    "vue": "^3.2.0",
    "vite": "^3.0.0"
  }
}
EOF

# 在示例项目中使用
cat > packages/example/package.json << EOF
{
  "name": "@my/example",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "@my/button": "workspace:*",
    "@my/input": "workspace:*"
  },
  "devDependencies": {
    "vue": "^3.2.0",
    "vite": "^3.0.0"
  }
}
EOF
```

## 性能对比

实际项目中，pnpm 相比 npm/yarn 的性能提升：

| 指标 | npm | yarn | pnpm |
|------|-----|------|------|
| 安装时间 | 45s | 32s | 18s |
| 磁盘占用 | 2.3GB | 2.1GB | 890MB |
| node_modules 数量 | 15,432 | 14,876 | 3,241 |

## 常见问题与解决方案

### 问题 1：包找不到

```bash
# 错误：Cannot find module '@my/utils'
# 原因：pnpm 严格的依赖隔离
# 解决：确保在 package.json 中显式声明依赖
pnpm add @my/utils --filter @my/web-app
```

### 问题 2：版本不一致

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/*'

# 强制所有包使用相同版本
catalog:
  vue: ^3.3.0
  typescript: ^5.1.0
```

### 问题 3：发布配置

```json
// packages/button/package.json
{
  "name": "@my/button",
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "files": ["dist", "README.md"]
}
```

```bash
# 发布所有包
pnpm -r publish

# 只发布特定包
pnpm --filter @my/button publish
```

## 总结

pnpm 的 workspace 功能为 monorepo 项目提供了完美的解决方案：

1. **磁盘效率**：通过硬链接和符号链接，大幅减少磁盘占用
2. **严格隔离**：避免幽灵依赖，让依赖关系更清晰
3. **安装速度**：并行安装和缓存机制，提升开发体验
4. **灵活配置**：丰富的配置选项，适应各种项目需求

采用 pnpm 管理 monorepo，能够让你的项目依赖管理变得更加高效、可靠，为团队协作和代码复用打下坚实的基础。
