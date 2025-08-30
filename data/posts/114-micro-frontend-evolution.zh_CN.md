---
title: "前端微前端架构 2025：qiankun 到 Module Federation 的演进"
tag: engineering
description: 深入探讨微前端架构从 qiankun 到 Module Federation 2.0 的技术演进与最佳实践
date: "2025-08-30T10:00:00.000Z"
---

## 目标

微前端架构已经从"可选方案"变成了大型前端项目的"标配"。但技术在不断演进——从 qiankun 的沙箱方案到 Module Federation 的原生模块共享，微前端的实现方式发生了根本性的变化。本文将带你了解这场技术演进，并给出 2025 年的最佳实践建议。

## 背景

### 微前端的演进历程

| 阶段 | 时间 | 代表方案 | 核心特点 |
|------|------|----------|----------|
| iframe 时代 | 2015-2018 | iframe 嵌套 | 简单但体验差 |
| 沙箱时代 | 2019-2022 | qiankun、single-spa | JS 沙箱隔离 |
| 模块联邦时代 | 2023- | Module Federation 2.0 | 原生模块共享 |

### 为什么从 qiankun 迁移

qiankun 的核心问题：

1. **性能开销**：每个子应用都需要独立加载，沙箱有运行时开销
2. **样式隔离不完善**：CSS 隔离依赖 BEM 命名或 CSS Modules
3. **依赖重复**：多个子应用可能加载相同的依赖（如 React）
4. **版本升级困难**：主应用和子应用的技术栈版本需要协调

## Module Federation 2.0

### 核心概念

```javascript
// 主应用 webpack.config.js
const { ModuleFederationPlugin } = require('webpack').container;

module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: 'host',
      remotes: {
        app1: 'app1@http://localhost:3001/remoteEntry.js',
        app2: 'app2@http://localhost:3002/remoteEntry.js',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^18.0.0' },
        'react-dom': { singleton: true, requiredVersion: '^18.0.0' },
      },
    }),
  ],
};
```

```javascript
// 子应用 webpack.config.js
const { ModuleFederationPlugin } = require('webpack').container;

module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: 'app1',
      filename: 'remoteEntry.js',
      exposes: {
        './Button': './src/components/Button',
        './utils': './src/utils',
      },
      shared: {
        react: { singleton: true, requiredVersion: '^18.0.0' },
        'react-dom': { singleton: true, requiredVersion: '^18.0.0' },
      },
    }),
  ],
};
```

### 动态远程模块

```typescript
async function loadRemoteModule(scope: string, module: string) {
  await __webpack_init_sharing__('default');
  const container = window[scope];
  await container.init(__webpack_share_scopes__.default);

  const factory = await container.get(module);
  return factory();
}

const RemoteButton = React.lazy(() => loadRemoteModule('app1', './Button'));

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <RemoteButton />
    </Suspense>
  );
}
```

## 迁移实战

### 从 qiankun 迁移到 Module Federation

```typescript
// 迁移前：qiankun 配置
import { registerMicroApps, start } from 'qiankun';

registerMicroApps([
  {
    name: 'app1',
    entry: '//localhost:3001',
    container: '#subapp-container',
    activeRule: '/app1',
    props: { token: 'xxx' },
  },
]);

start();

// 迁移后：Module Federation
import { Suspense, lazy } from 'react';

const App1 = lazy(() => import('app1/App'));

function MicroFrontendRouter() {
  return (
    <Routes>
      <Route path="/app1/*" element={
        <Suspense fallback={<PageLoader />}>
          <App1 />
        </Suspense>
      } />
    </Routes>
  );
}
```

### 状态共享方案

```typescript
import { createStore } from 'zustand';

interface GlobalState {
  user: User | null;
  theme: 'light' | 'dark';
  setUser: (user: User | null) => void;
  setTheme: (theme: 'light' | 'dark') => void;
}

const useGlobalStore = createStore<GlobalState>((set) => ({
  user: null,
  theme: 'light',
  setUser: (user) => set({ user }),
  setTheme: (theme) => set({ theme }),
}));

export default useGlobalStore;
```

### 样式隔离

```css
/* 子应用使用 CSS Modules 或 scoped styles */
.button {
  background-color: var(--primary-color);
  color: white;
  padding: 8px 16px;
  border-radius: 4px;
}

/* 主应用定义主题变量 */
:root {
  --primary-color: #3b82f6;
  --secondary-color: #6b7280;
}
```

## 高级模式

### 依赖提升

```javascript
new ModuleFederationPlugin({
  name: 'host',
  shared: {
    react: {
      singleton: true,
      requiredVersion: '^18.0.0',
      eager: true,
    },
    'react-dom': {
      singleton: true,
      requiredVersion: '^18.0.0',
      eager: true,
    },
    '@design-system/core': {
      singleton: true,
      requiredVersion: '^2.0.0',
    },
  },
});
```

### 版本协商

```javascript
new ModuleFederationPlugin({
  name: 'app1',
  shared: {
    react: {
      singleton: true,
      requiredVersion: '>=17.0.0 <19.0.0',
    },
  },
});
```

### 错误边界

```tsx
class RemoteErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function App() {
  return (
    <RemoteErrorBoundary fallback={<div>模块加载失败</div>}>
      <Suspense fallback={<div>加载中...</div>}>
        <RemoteModule />
      </Suspense>
    </RemoteErrorBoundary>
  );
}
```

## 2025 年最佳实践

### 推荐架构

```
┌─────────────────────────────────────────────────────────┐
│                    主应用 (Host)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   路由      │  │  状态管理   │  │  主题系统   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                  Module Federation                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  子应用 1   │  │  子应用 2   │  │  子应用 3   │     │
│  │  (React)    │  │  (Vue)      │  │  (React)    │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    共享层                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  设计系统   │  │  工具函数   │  │  类型定义   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### 团队协作规范

```markdown
# 微前端协作规范

## 1. 依赖管理
- 共享依赖必须在主应用中声明
- 子应用不得打包已在主应用中声明的共享依赖
- 版本升级需要协调所有子应用

## 2. 样式规范
- 子应用必须使用 CSS Modules 或 Scoped Styles
- 全局样式统一在主应用中定义
- 使用 CSS 变量实现主题定制

## 3. 状态共享
- 全局状态通过 Zustand 单例共享
- 子应用间通信通过事件总线或 URL 参数
- 避免子应用直接操作主应用的 DOM

## 4. 构建部署
- 子应用独立构建，输出 remoteEntry.js
- 主应用负责聚合和部署
- 版本号遵循语义化版本规范
```

## 总结

微前端架构的演进反映了前端工程化的发展方向：

1. **qiankun 时代**：通过 JS 沙箱实现隔离，但有性能和复杂度开销
2. **Module Federation 2.0**：原生模块共享，性能更好，开发体验更佳
3. **2025 趋势**：更轻量的方案，更少的运行时开销，更好的开发体验

迁移建议：
- 新项目直接使用 Module Federation 2.0
- 存量 qiankun 项目可以逐步迁移
- 小规模项目可以考虑更简单的共享状态方案

微前端不是银弹，但对于需要独立部署、技术栈异构的大型团队，它仍然是最佳选择。