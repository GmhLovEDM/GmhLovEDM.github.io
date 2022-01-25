---
title: "Vite 为什么这么快？浅析其原理与优势"
tag: vite
description: 深入理解 Vite 快速的核心原理，从 ESM 原生支持到依赖预构建，揭秘下一代前端构建工具的设计哲学。
date: "2022-01-25T08:00:00.000Z"
---

## 目标

理解 Vite 快速的核心原理，以及它为什么能替代 Webpack 成为新一代前端构建工具的首选。

## 背景

### Webpack 的问题

```bash
# 一个中型 React 项目
webpack 启动时间：8.2 秒
webpack 热更新：1.5 秒

# 项目变大后
webpack 启动时间：45 秒
webpack 热更新：5-8 秒
```

Webpack 启动慢的根本原因：**它需要在开发服务器启动前，把所有模块打包成 bundle。**

```
Webpack 的流程：
1. 读取所有源文件
2. 解析依赖关系图
3. 转换代码（Babel、TypeScript 等）
4. 打包成 bundle
5. 启动开发服务器

用户需要等完这 5 步才能看到页面
```

### Vite 的解决方案

```
Vite 的流程：
1. 启动开发服务器（毫秒级）
2. 浏览器请求时才按需编译
3. 使用 ESM 原生模块加载

用户几乎瞬间看到页面
```

## Vite 快速的核心原理

### 1. ESM 原生支持

现代浏览器原生支持 ES Modules：

```html
<!-- 浏览器可以直接运行这段代码 -->
<script type="module">
import { createApp } from './app.js'
import { router } from './router.js'

createApp(App).use(router).mount('#app')
</script>
```

```javascript
// app.js - 浏览器会自动请求这个文件
import { ref } from 'vue'
export function createApp() { /* ... */ }
```

**关键洞察**：既然浏览器能直接运行 ESM，为什么还需要打包？

### 2. 依赖预构建

ESM 虽好，但有一个问题：**npm 包大多不是 ESM 格式**。

```javascript
// lodash 导出的是 CJS 模块
const _ = require('lodash')

// Vite 的解决方案：依赖预构建
// 使用 esbuild 把 CJS 依赖转换成 ESM
// 并合并小模块减少请求数
```

```bash
# Vite 启动时会：
# 1. 扫描 package.json 的依赖
# 2. 用 esbuild 预构建（通常 < 100ms）
# 3. 缓存到 node_modules/.vite

# 预构建的好处：
# - CJS → ESM 转换
# - 合并小模块（lodash 有 600+ 个文件）
# - 缓存，下次启动更快
```

### 3. 按需编译

```javascript
// Webpack：启动时编译所有文件
// src/
//   ├── App.tsx         ← 编译
//   ├── components/
//   │   ├── Header.tsx  ← 编译
//   │   ├── Footer.tsx  ← 编译
//   │   └── ... (100 个组件) ← 全部编译

// Vite：只编译浏览器请求的文件
// 浏览器请求 App.tsx → 编译 App.tsx
// 浏览器请求 Header.tsx → 编译 Header.tsx
// 其他文件？等浏览器需要时再说
```

## 性能对比

### 冷启动时间

```
项目：React + TypeScript，200 个组件

Webpack 5：12.3 秒
Vite：0.8 秒

提升：93%
```

### 热更新时间

```
修改一个组件的样式

Webpack 5：1.8 秒
Vite：0.1 秒

提升：94%
```

### 大项目冷启动

```
项目：Vue 3 + TypeScript，1000 个组件

Webpack 5：58 秒
Vite：2.1 秒

提升：96%
```

## Vite 的架构

```
┌─────────────────────────────────────┐
│           Vite Dev Server           │
│  ┌─────────────────────────────┐    │
│  │    HTTP Server (connect)    │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │      Plugin Pipeline        │    │
│  │  - resolveId                │    │
│  │  - load                     │    │
│  │  - transform                │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │   Module Graph (on-demand)  │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────┐
│           esbuild                   │
│  - 依赖预构建                       │
│  - TypeScript 转译                  │
│  - JSX 转换                         │
└─────────────────────────────────────┘
```

## Vite 配置详解

### 基础配置

```javascript
// vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
    plugins: [vue()],

    // 开发服务器
    server: {
        port: 3000,
        open: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8080',
                changeOrigin: true
            }
        }
    },

    // 依赖预构建
    optimizeDeps: {
        include: ['lodash', 'axios'],
        exclude: ['your-big-local-package']
    },

    // 构建配置
    build: {
        outDir: 'dist',
        sourcemap: true,
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['vue', 'vue-router'],
                    utils: ['lodash', 'axios']
                }
            }
        }
    },

    // 别名
    resolve: {
        alias: {
            '@': '/src'
        }
    }
})
```

### CSS 处理

```javascript
export default defineConfig({
    css: {
        preprocessorOptions: {
            scss: {
                additionalData: `@import "@/styles/variables.scss";`
            }
        },
        modules: {
            localsConvention: 'camelCase'
        }
    }
})
```

## Vite vs Webpack vs Create React App

| 特性 | Vite | Webpack | CRA |
|------|------|---------|-----|
| 冷启动 | 快 | 慢 | 慢 |
| 热更新 | 极快 | 慢 | 中等 |
| 配置复杂度 | 低 | 高 | 无（隐藏） |
| 灵活性 | 高 | 极高 | 低 |
| 生态成熟度 | 高 | 极高 | 高 |
| TypeScript | 原生支持 | 需要 loader | 内置 |
| ESM | 原生支持 | 需要配置 | 不支持 |

## 实际项目中的优势

### 1. 快速的开发体验

```bash
# 启动一个新项目
npm create vite@latest my-app -- --template vue-ts
cd my-app
npm install
npm run dev

# 从创建到看到页面：< 3 秒
```

### 2. 无缝的 TypeScript 支持

```typescript
// 不需要配置 tsconfig.json
// 不需要安装 ts-loader
// Vite + esbuild 直接支持

// 直接写 TypeScript，Vite 会自动处理
const greeting: string = 'Hello, World!'
```

### 3. 丰富的插件生态

```javascript
// 使用 Vite 插件
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'

export default defineConfig({
    plugins: [
        vue(),
        vueJsx(),
        Components({
            resolvers: [ElementPlusResolver()]
        }),
        AutoImport({
            imports: ['vue', 'vue-router'],
            dts: 'src/auto-imports.d.ts'
        })
    ]
})
```

## 什么时候不应该用 Vite？

1. **需要支持 IE11**：Vite 不支持
2. **Node.js 低于 14**：Vite 要求 Node.js 14+
3. **需要非常复杂的构建配置**：Webpack 更灵活
4. **遗留项目迁移**：如果项目深度依赖 Webpack 生态

## 总结

Vite 快速的核心原因：

1. **ESM 原生支持**：利用浏览器能力，不需要打包
2. **依赖预构建**：用 esbuild（Go 编写）快速处理依赖
3. **按需编译**：只处理浏览器请求的文件
4. **esbuild 替代 Babel**：Go 编写的 esbuild 比 Babel 快 100 倍

Vite 不是"更快的 Webpack"，而是一种**完全不同的构建理念**。它把打包的工作从开发阶段移到了构建阶段，让开发体验得到了质的提升。

对于新项目，Vite 应该是你的默认选择。
