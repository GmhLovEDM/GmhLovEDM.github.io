---
title: "Monorepo Advanced Practice: Turborepo Build Speedup"
tag: engineering
description: Deep dive into Turborepo's incremental builds, task orchestration, and remote caching mechanisms, with practical guidance on reducing Monorepo project build times by more than 10x.
date: "2023-07-28T08:00:00.000Z"
---

## Goal

In Monorepo projects, as the number of packages grows, build times can increase linearly or even super-linearly. Full builds can膨胀 from minutes to tens of minutes, severely impacting developer experience and CI/CD efficiency. This article provides a deep dive into Turborepo's core mechanisms, with practical guidance on reducing build times by an order of magnitude through incremental builds, task orchestration, and remote caching.

## Background

### Monorepo Build Pain Points

Assume a Monorepo contains the following modules:

```
apps/
  web/           # Next.js frontend
  admin/         # Admin dashboard
  api/           # Backend service
packages/
  ui/            # Component library
  utils/         # Utility functions
  config/        # Shared configuration
  eslint-config/ # ESLint configuration
```

These modules have complex dependency relationships:

```
web → ui → utils
web → config
admin → ui → utils
api → utils
```

Every time the `utils` package is modified, ideally only dependent modules need to be rebuilt. However, traditional build approaches either do full builds (slow) or require manually specifying build order (error-prone).

### Turborepo's Core Philosophy

Turborepo's design philosophy is the **Principle of Least Work**:

1. **Incremental builds**: Only build packages affected by modifications
2. **Parallel execution**: Tasks without dependencies run in parallel
3. **Build caching**: Identical inputs directly reuse outputs
4. **Remote sharing**: Team members and CI share build caches

## Core Configuration

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

Key configuration analysis:

- **`dependsOn: ["^build"]`**: The `^` prefix means first build other packages that the current package depends on
- **`outputs`**: Specifies which files to cache
- **`cache: false`**: Dev command is not cached (long-running tasks)
- **`persistent: true`**: Marks long-running tasks

### package.json Scripts

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

## Task Graph Analysis

Turborepo analyzes dependency relationships between packages before executing tasks, building a directed acyclic graph (DAG):

```
Build task graph (assuming utils is modified):

    utils
    / | \
  ui config
  / \    |
web admin api

Execution order:
Round 1: utils (parallel)
Round 2: ui, config (parallel, depend on utils)
Round 3: web, admin, api (parallel, depend on ui/config)
```

### Viewing the Task Graph

```bash
# Generate task graph visualization
turbo run build --graph

# Outputs a graph.json file that can be viewed with Graphviz or online tools
```

## Incremental Build Practice

### Basic Incremental Build

```bash
# First full build
turbo run build
# ✓ ui:build: 12.5s
# ✓ config:build: 3.2s
# ✓ utils:build: 2.1s
# ✓ web:build: 18.3s
# ✓ admin:build: 15.1s
# ✓ api:build: 8.7s
# Total: 60.4s

# Second build (no modifications)
turbo run build
# ✓ ui:build: cache hit, replayed 12.5s → 0.3s
# ✓ config:build: cache hit, replayed 3.2s → 0.1s
# ✓ utils:build: cache hit, replayed 2.1s → 0.1s
# ✓ web:build: cache hit, replayed 18.3s → 0.2s
# ✓ admin:build: cache hit, replayed 15.1s → 0.2s
# ✓ api:build: cache hit, replayed 8.7s → 0.2s
# Total: 1.4s (60x speedup)
```

### Incremental Build with Partial Changes

```bash
# Modified packages/ui/src/Button.tsx
turbo run build
# ✓ utils:build: cache hit, replayed 0.1s
# ✓ config:build: cache hit, replayed 0.1s
# ✓ ui:build: 12.8s (rebuilt)
# ✓ web:build: 18.5s (depends on ui, rebuilt)
# ✓ admin:build: 15.3s (depends on ui, rebuilt)
# ✓ api:build: cache hit, replayed 0.1s (doesn't depend on ui, cache hit)
# Total: 47.1s (instead of 60.4s)
```

### Filtering Specific Packages

```bash
# Only build a package and its dependencies
turbo run build --filter=web

# Only build a package (excluding dependencies)
turbo run build --filter=web^...

# Build a package and all its dependents
turbo run build --filter=utils...

# Exclude a package
turbo run build --filter=!admin
```

## Remote Cache Configuration

### Vercel Remote Cache

```bash
# Login to Vercel (free)
npx turbo login

# Configure remote cache
npx turbo link
```

### Self-Hosted Remote Cache

```bash
# Using S3-compatible storage
TURBO_REMOTE_CACHE_BACKEND=s3
TURBO_S3_BUCKET=my-turbo-cache
TURBO_S3_REGION=ap-northeast-1
TURBO_S3_ENDPOINT=https://s3.amazonaws.com
```

### Remote Cache in CI/CD

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

      # Turborepo remote cache token
      - name: Build
        run: pnpm build
        env:
          TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
          TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
```

## Advanced Techniques

### 1. Fine-Grained Task Dependency Control

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

### 2. Environment Variable Awareness

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

When environment variables change, Turborepo automatically invalidates the cache.

### 3. Multi-Platform Caching

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

Precisely specify which file changes trigger rebuilds through `inputs`.

## Integration with pnpm Workspace

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

## Performance Comparison

Test results in a real project with 12 packages:

| Scenario | npm scripts | Turborepo |
|----------|-------------|-----------|
| Full build (first time) | 180s | 165s |
| No modifications | 180s | 2.3s |
| Modified utils package | 180s | 45s |
| Modified single app | 180s | 28s |
| CI (remote cache hit) | 180s | 8s |

As you can see, Turborepo brings enormous improvements in incremental build scenarios.

## Conclusion

Turborepo significantly improves Monorepo project build efficiency through intelligent task graph analysis, incremental builds, and multi-level caching mechanisms. Key takeaways:

1. **Understand the task graph**: The `^` prefix controls dependency relationships and is fundamental to performance optimization
2. **Configure outputs appropriately**: Only cache necessary artifacts to avoid cache pollution
3. **Remote cache is the core**: Team-shared caching brings the greatest benefits
4. **Filters are a daily tool**: The `--filter` parameter lets you build only what you need

For medium to large frontend teams, Turborepo is almost a standard tool for Monorepo. It not only speeds up builds but, more importantly, reduces developer mental burden -- you don't need to remember which packages need rebuilding, Turborepo handles it for you.
