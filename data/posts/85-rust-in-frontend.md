---
title: "Rust in Frontend: From SWC to Turbopack"
tag: engineering
description: Exploring the revolutionary applications of Rust in frontend engineering, with in-depth analysis of how tools like SWC, Turbopack, and Rspack are reshaping the frontend build toolchain.
date: "2024-08-22T08:00:00.000Z"
---

## Goal

This article aims to help frontend developers understand the current state and development trends of Rust in frontend engineering, learn about the design philosophy and actual effects of new tools like SWC, Turbopack, and Rspack, and provide a reference for technology selection.

## Background

The frontend build toolchain is undergoing a revolution. From the early Grunt/Gulp to Webpack's dominance, and then to Vite's rise, build tools have been pursuing faster development experiences. However, build tools written in JavaScript have approached their performance limits.

### Why Do We Need Rust?

JavaScript is a single-threaded interpreted language. Even with V8's JIT compilation optimization, it cannot compete with systems-level languages in CPU-intensive tasks. Rust, as a systems-level language focused on performance and safety, is becoming the new choice for build tools.

**Performance Comparison**:
- **JavaScript (Webpack)**: Relies on V8 engine, single-threaded
- **Rust (SWC/Turbopack)**: Compiled to native code, multi-threaded

Real-world data shows that build tools written in Rust are 10-100 times faster than their JavaScript counterparts.

## 1. SWC: The Speedy JavaScript/TypeScript Compiler

### What is SWC?

SWC (Speedy Web Compiler) is a JavaScript/TypeScript compiler written in Rust, designed to replace Babel and TypeScript's tsc.

### Core Features

```javascript
// SWC usage
const swc = require('@swc/core');

// Compile JavaScript
const output = await swc.transform('const a = 1;', {
  jsc: {
    parser: {
      syntax: 'ecmascript',
    },
    target: 'es2020',
  },
});

// Compile TypeScript
const tsOutput = await swc.transform(
  `interface User { name: string; }
   const user: User = { name: 'John' };`,
  {
    jsc: {
      parser: {
        syntax: 'typescript',
        tsx: true,
      },
    },
  }
);

// Compile JSX/TSX
const jsxOutput = await swc.transform(
  `const App = () => <div>Hello</div>;`,
  {
    jsc: {
      parser: {
        syntax: 'ecmascript',
        jsx: true,
      },
    },
  }
);
```

### SWC vs Babel

| Feature | SWC | Babel |
|---------|-----|-------|
| Language | Rust | JavaScript |
| Speed | 20-70x faster | Baseline |
| Configuration | Simple | Complex |
| Plugins | Rust/WASM | JavaScript |
| Ecosystem | Growing | Complete |

### SWC in Next.js

Next.js 13+ has made SWC the default compiler:

```javascript
// next.config.js
module.exports = {
  // Automatically uses SWC
  // No additional configuration needed
  
  // SWC compilation options
  swcMinify: true,
  experimental: {
    // Enable SWC's extra features
    forceSwcTransforms: true,
  },
};
```

### SWC Compilation Process

```
Source Code
    |
    v
+----------------+
| Lexical Analysis |  Decompose code into tokens
+--------+-------+
         |
         v
+----------------+
| Syntax Analysis |  Build AST (Abstract Syntax Tree)
+--------+-------+
         |
         v
+----------------+
| Code Transform  |  Apply plugins and transform rules
+--------+-------+
         |
         v
+----------------+
| Code Generation  |  Output target code
+----------------+
```

## 2. Turbopack: Vercel's Next-Generation Bundler

### What is Turbopack?

Turbopack is an incremental bundler developed by Vercel, the spiritual successor to Webpack, but written in Rust.

### Core Features

```bash
# Using Turbopack
npx create-next-app@latest my-app
cd my-app
npm run dev --turbo
```

### Performance Data

According to Vercel's official data:

```
Build performance comparison (large projects):
- Webpack 5:     42.3s
- Vite:          8.2s
- Turbopack:     0.8s

Memory usage:
- Webpack 5:     1.2GB
- Vite:          320MB
- Turbopack:     85MB
```

### Turbopack's Design Philosophy

1. **Incremental Computation**: Only recompile changed parts
2. **Multi-threaded**: Fully utilize multi-core CPUs
3. **Memory Optimization**: Efficient memory management
4. **Caching Mechanism**: Intelligent content caching

### Next.js Integration

```javascript
// next.config.js
module.exports = {
  // Turbopack is currently only available in development mode
  experimental: {
    turbo: {
      // Custom rules
      rules: {
        '*.svg': {
          loaders: ['@svgr/webpack'],
          as: '*.js',
        },
      },
    },
  },
};
```

### Turbopack vs Vite

| Feature | Turbopack | Vite |
|---------|-----------|------|
| Language | Rust | JavaScript + esbuild |
| HMR | Incremental updates | Full recompilation |
| Memory Usage | Lower | Medium |
| Ecosystem | Next.js exclusive | Universal |
| Maturity | Early | Mature |

## 3. Rspack: ByteDance's Rust Bundler

### What is Rspack?

Rspack is a high-performance bundler developed by ByteDance, compatible with the Webpack ecosystem but written in Rust.

### Core Advantages

```javascript
// rspack.config.js
module.exports = {
  // Fully compatible with Webpack configuration
  entry: './src/index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'builtin:swc-loader', // Uses built-in SWC
      },
    ],
  },
  // Rspack-specific optimizations
  optimization: {
    minimize: true,
    minimizer: 'builtin:swc-loader',
  },
};
```

### Rspack vs Webpack

```bash
# Performance comparison
# Webpack 5 build time: 45s
# Rspack build time: 3.2s

# Migration cost
# Webpack config -> Rspack config: Nearly 100% compatible
```

### Rspack Features

1. **Webpack Compatible**: Can directly reuse Webpack plugins
2. **SWC Built-in**: No additional compiler configuration needed
3. **Incremental Compilation**: Fast restarts in development mode
4. **Tree Shaking**: Better dead code elimination

## 4. Other Rust Frontend Tools

### Oxc (Oxidation Compiler)

```bash
# Oxc is a JavaScript/TypeScript toolchain
# Including parser, code generator, linter, etc.

# Install
npm install -D oxc

# Usage
npx oxc lint src/
npx oxc format src/
```

### Biome (formerly Rome)

```bash
# Biome is a unified formatting and linting tool
# Replaces ESLint + Prettier

# Install
npm install -D @biomejs/biome

# Usage
npx biome format src/
npx biome lint src/
npx biome check src/
```

### Rolldown

```bash
# Rolldown is a Rust-based Rollup replacement
# Developed by the Vite team

# Goal: Provide a faster bundler for Vite
```

## 5. Rust Frontend Toolchain Landscape

```
+-----------------------------------------------------------+
|                    Frontend Rust Toolchain                  |
+-----------------------------------------------------------+
|                                                             |
|  +----------------+  +----------------+  +----------------+  |
|  |   Compilation  |  |   Bundling     |  |   Formatting   |  |
|  |                |  |                |  |                |  |
|  |  SWC           |  | Turbopack      |  |  Biome         |  |
|  |  Oxc           |  | Rspack         |  |  Oxc           |  |
|  |                |  | Rolldown       |  |                |  |
|  +----------------+  +----------------+  +----------------+  |
|                                                             |
|  +----------------+  +----------------+  +----------------+  |
|  |   Linting      |  |   Testing      |  |   Tools        |  |
|  |                |  |                |  |                |  |
|  |  Biome         |  | Vitest         |  |  napi-rs       |  |
|  |  Oxc           |  |                |  |  SWC           |  |
|  +----------------+  +----------------+  +----------------+  |
|                                                             |
+-----------------------------------------------------------+
```

## 6. Migration Guide

### From Webpack to Rspack

```javascript
// webpack.config.js -> rspack.config.js
// Most configurations can be reused directly

// 1. Install Rspack
// npm install -D @rspack/cli @rspack/core

// 2. Rename config file
// webpack.config.js -> rspack.config.js

// 3. Replace loaders
// babel-loader -> builtin:swc-loader
// ts-loader -> builtin:swc-loader

// 4. Run
// npx rspack serve
// npx rspack build
```

### From Babel to SWC

```javascript
// .babelrc -> .swcrc
{
  "jsc": {
    "parser": {
      "syntax": "typescript",
      "tsx": true
    },
    "transform": {
      "react": {
        "runtime": "automatic"
      }
    }
  },
  "module": {
    "type": "commonjs"
  }
}
```

### From ESLint + Prettier to Biome

```bash
# 1. Install Biome
npm install -D @biomejs/biome

# 2. Initialize configuration
npx biome init

# 3. Migrate rules
npx biome migrate

# 4. Uninstall old tools
npm uninstall eslint prettier eslint-config-prettier
```

## 7. Practical Examples

### Using SWC to Speed Up Next.js Builds

```javascript
// next.config.js
const withSWC = require('@next/swc');

module.exports = withSWC({
  // SWC configuration
  swcLoader: {
    jsc: {
      parser: {
        syntax: 'typescript',
        tsx: true,
      },
      transform: {
        react: {
          runtime: 'automatic',
        },
      },
    },
  },
  
  // Performance optimization
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
});
```

### Using Rspack to Replace Webpack

```javascript
// rspack.config.js
const path = require('path');

module.exports = {
  mode: 'development',
  entry: './src/index.tsx',
  output: {
    filename: 'bundle.[contenthash].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: 'builtin:swc-loader',
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  optimization: {
    splitChunks: {
      chunks: 'all',
    },
  },
};
```

## Summary

Rust is reshaping the frontend toolchain. From compilers to bundlers, from formatting to linting, nearly all build tools are being rewritten in Rust.

| Tool | Replaces | Status | Recommendation |
|------|----------|--------|----------------|
| SWC | Babel | Production-ready | 5/5 |
| Turbopack | Webpack | Early | 4/5 |
| Rspack | Webpack | Mature | 5/5 |
| Biome | ESLint + Prettier | Mature | 4.5/5 |

**Recommendations**:

1. **New Projects**: Use Rust toolchain directly
2. **Existing Projects**: Migrate gradually, prioritize SWC and Biome
3. **Watch Trends**: Rust frontend tools are still rapidly evolving
4. **Learn Rust**: If you want to contribute deeply, you need Rust fundamentals

The rise of Rust frontend tools is not accidental but an inevitable trend driven by performance demands. Embracing this trend will keep you at the forefront of frontend engineering.
