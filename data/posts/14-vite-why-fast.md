---
title: "Why Is Vite So Fast? Analyzing Its Principles and Advantages"
tag: vite
description: Deeply understand the core principles behind Vite's speed, from ESM native support to dependency pre-bundling, revealing the design philosophy of the next-generation frontend build tool.
date: "2022-01-25T08:00:00.000Z"
---

## Goal

Understand the core principles behind Vite's speed and why it can replace Webpack as the preferred choice for next-generation frontend build tools.

## Background

### Webpack's Problem

```bash
# A medium-sized React project
webpack startup time: 8.2 seconds
webpack HMR: 1.5 seconds

# After the project grows
webpack startup time: 45 seconds
webpack HMR: 5-8 seconds
```

The root cause of Webpack's slow startup: **It needs to bundle all modules before the development server can start.**

```
Webpack's workflow:
1. Read all source files
2. Parse dependency graph
3. Transform code (Babel, TypeScript, etc.)
4. Bundle into bundles
5. Start development server

Users have to wait for all 5 steps before seeing the page
```

### Vite's Solution

```
Vite's workflow:
1. Start development server (milliseconds)
2. Compile on-demand when browser requests
3. Use ESM native module loading

Users see the page almost instantly
```

## Core Principles Behind Vite's Speed

### 1. ESM Native Support

Modern browsers natively support ES Modules:

```html
<!-- Browser can run this code directly -->
<script type="module">
import { createApp } from './app.js'
import { router } from './router.js'

createApp(App).use(router).mount('#app')
</script>
```

```javascript
// app.js - Browser will automatically request this file
import { ref } from 'vue'
export function createApp() { /* ... */ }
```

**Key insight**: If browsers can run ESM directly, why do we need bundling?

### 2. Dependency Pre-bundling

ESM is great, but there's one problem: **Most npm packages are not in ESM format**.

```javascript
// lodash exports CJS modules
const _ = require('lodash')

// Vite's solution: dependency pre-bundling
// Use esbuild to convert CJS dependencies to ESM
// And merge small modules to reduce request count
```

```bash
# When Vite starts:
# 1. Scan package.json dependencies
# 2. Pre-bundle with esbuild (usually < 100ms)
# 3. Cache to node_modules/.vite

# Benefits of pre-bundling:
# - CJS → ESM conversion
# - Merge small modules (lodash has 600+ files)
# - Cache for faster subsequent startups
```

### 3. On-demand Compilation

```javascript
// Webpack: compile all files at startup
// src/
//   ├── App.tsx         ← compile
//   ├── components/
//   │   ├── Header.tsx  ← compile
//   │   ├── Footer.tsx  ← compile
//   │   └── ... (100 components) ← all compiled

// Vite: only compile files requested by browser
// Browser requests App.tsx → compile App.tsx
// Browser requests Header.tsx → compile Header.tsx
// Other files? Wait until browser needs them
```

## Performance Comparison

### Cold Startup Time

```
Project: React + TypeScript, 200 components

Webpack 5: 12.3 seconds
Vite: 0.8 seconds

Improvement: 93%
```

### Hot Module Replacement Time

```
Modify a component's styles

Webpack 5: 1.8 seconds
Vite: 0.1 seconds

Improvement: 94%
```

### Large Project Cold Startup

```
Project: Vue 3 + TypeScript, 1000 components

Webpack 5: 58 seconds
Vite: 2.1 seconds

Improvement: 96%
```

## Vite's Architecture

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
│  - Dependency pre-bundling          │
│  - TypeScript transpilation         │
│  - JSX transformation              │
└─────────────────────────────────────┘
```

## Vite Configuration Deep Dive

### Basic Configuration

```javascript
// vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
    plugins: [vue()],

    // Development server
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

    // Dependency pre-bundling
    optimizeDeps: {
        include: ['lodash', 'axios'],
        exclude: ['your-big-local-package']
    },

    // Build configuration
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

    // Aliases
    resolve: {
        alias: {
            '@': '/src'
        }
    }
})
```

### CSS Processing

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

| Feature | Vite | Webpack | CRA |
|---------|------|---------|-----|
| Cold startup | Fast | Slow | Slow |
| HMR | Extremely fast | Slow | Medium |
| Configuration complexity | Low | High | None (hidden) |
| Flexibility | High | Very high | Low |
| Ecosystem maturity | High | Very high | High |
| TypeScript | Native support | Needs loader | Built-in |
| ESM | Native support | Needs configuration | Not supported |

## Advantages in Real Projects

### 1. Fast Development Experience

```bash
# Start a new project
npm create vite@latest my-app -- --template vue-ts
cd my-app
npm install
npm run dev

# From creation to seeing the page: < 3 seconds
```

### 2. Seamless TypeScript Support

```typescript
// No need to configure tsconfig.json
// No need to install ts-loader
// Vite + esbuild supports it directly

// Write TypeScript directly, Vite handles it automatically
const greeting: string = 'Hello, World!'
```

### 3. Rich Plugin Ecosystem

```javascript
// Using Vite plugins
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

## When Shouldn't You Use Vite?

1. **Need to support IE11**: Vite doesn't support it
2. **Node.js below 14**: Vite requires Node.js 14+
3. **Need very complex build configurations**: Webpack is more flexible
4. **Legacy project migration**: If the project deeply depends on Webpack ecosystem

## Summary

The core reasons why Vite is fast:

1. **ESM native support**: Leverages browser capabilities, no bundling needed
2. **Dependency pre-bundling**: Uses esbuild (written in Go) for fast dependency processing
3. **On-demand compilation**: Only processes files requested by the browser
4. **esbuild replaces Babel**: esbuild written in Go is 100x faster than Babel

Vite is not "a faster Webpack" — it's a **completely different build philosophy**. It moves bundling work from the development phase to the build phase, qualitatively improving the development experience.

For new projects, Vite should be your default choice.
