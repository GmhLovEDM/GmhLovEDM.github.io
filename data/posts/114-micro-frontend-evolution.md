---
title: "Micro-Frontend Architecture 2025: The Evolution from qiankun to Module Federation"
tag: engineering
description: An in-depth look at the technical evolution of micro-frontend architecture from qiankun to Module Federation 2.0 and best practices
date: "2025-08-30T10:00:00.000Z"
---

## Goal

Micro-frontend architecture has evolved from an "optional approach" to a "standard practice" for large frontend projects. But technology keeps advancing -- from qiankun's sandbox approach to Module Federation's native module sharing, the way micro-frontends are implemented has fundamentally changed. This article walks you through this evolution and provides best practice recommendations for 2025.

## Background

### Micro-Frontend Evolution Timeline

| Phase | Period | Representative | Core Feature |
|-------|--------|----------------|--------------|
| iframe Era | 2015-2018 | iframe nesting | Simple but poor UX |
| Sandbox Era | 2019-2022 | qiankun, single-spa | JS sandbox isolation |
| Module Federation Era | 2023- | Module Federation 2.0 | Native module sharing |

### Why Migrate from qiankun

Core issues with qiankun:

1. **Performance Overhead**: Each sub-application loads independently; the sandbox has runtime overhead.
2. **Incomplete Style Isolation**: CSS isolation relies on BEM naming or CSS Modules.
3. **Duplicate Dependencies**: Multiple sub-applications may load the same dependencies (e.g., React).
4. **Difficult Version Upgrades**: Tech stack versions between host and sub-applications need coordination.

## Module Federation 2.0

### Core Concepts

```javascript
// Host webpack.config.js
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
// Sub-application webpack.config.js
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

### Dynamic Remote Modules

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

## Migration in Practice

### Migrating from qiankun to Module Federation

```typescript
// Before: qiankun configuration
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

// After: Module Federation
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

### State Sharing

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

### Style Isolation

```css
/* Sub-applications use CSS Modules or scoped styles */
.button {
  background-color: var(--primary-color);
  color: white;
  padding: 8px 16px;
  border-radius: 4px;
}

/* Host application defines theme variables */
:root {
  --primary-color: #3b82f6;
  --secondary-color: #6b7280;
}
```

## Advanced Patterns

### Dependency Hoisting

```javascript
new ModuleFederationPlugin({
  name: 'host',
  shared: {
    react: { singleton: true, requiredVersion: '^18.0.0', eager: true },
    'react-dom': { singleton: true, requiredVersion: '^18.0.0', eager: true },
    '@design-system/core': { singleton: true, requiredVersion: '^2.0.0' },
  },
});
```

### Version Negotiation

```javascript
new ModuleFederationPlugin({
  name: 'app1',
  shared: {
    react: { singleton: true, requiredVersion: '>=17.0.0 <19.0.0' },
  },
});
```

### Error Boundaries

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
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function App() {
  return (
    <RemoteErrorBoundary fallback={<div>Module failed to load</div>}>
      <Suspense fallback={<div>Loading...</div>}>
        <RemoteModule />
      </Suspense>
    </RemoteErrorBoundary>
  );
}
```

## 2025 Best Practices

### Recommended Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Host Application                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Routing   │  │   State     │  │   Theming   │     │
│  │             │  │  Management │  │   System    │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                  Module Federation                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Sub-App 1  │  │  Sub-App 2  │  │  Sub-App 3  │     │
│  │  (React)    │  │  (Vue)      │  │  (React)    │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    Shared Layer                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ Design      │  │ Utility     │  │ Type        │     │
│  │ System      │  │ Functions   │  │ Definitions │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### Team Collaboration Guidelines

```markdown
# Micro-Frontend Collaboration Guidelines

## 1. Dependency Management
- Shared dependencies must be declared in the host application
- Sub-applications must not bundle shared dependencies already declared in the host
- Version upgrades need coordination across all sub-applications

## 2. Style Guidelines
- Sub-applications must use CSS Modules or Scoped Styles
- Global styles are defined in the host application
- CSS variables are used for theme customization

## 3. State Sharing
- Global state is shared via Zustand singleton
- Inter-app communication uses event bus or URL parameters
- Sub-applications should not directly manipulate host DOM

## 4. Build and Deployment
- Sub-applications build independently, outputting remoteEntry.js
- Host application handles aggregation and deployment
- Version numbers follow semantic versioning
```

## Summary

The evolution of micro-frontend architecture reflects the direction of frontend engineering:

1. **qiankun Era**: JS sandbox isolation with performance and complexity overhead.
2. **Module Federation 2.0**: Native module sharing with better performance and developer experience.
3. **2025 Trends**: Lighter solutions, less runtime overhead, better developer experience.

Migration recommendations:
- New projects should use Module Federation 2.0 directly.
- Existing qiankun projects can migrate gradually.
- Small-scale projects may consider simpler state-sharing solutions.

Micro-frontends are not a silver bullet, but for large teams needing independent deployment and heterogeneous tech stacks, they remain the best choice.