---
title: "Managing Monorepos with pnpm: Say Goodbye to node_modules Hell"
tag: nodejs
description: 详解如何使用 pnpm workspace 管理 monorepo 项目，解决依赖管理的痛点问题。
date: "2022-08-22T08:00:00.000Z"
---

## Goal

In large-scale front-end projects, monorepo (single repository) architecture has become the mainstream approach. However, traditional npm/yarn workflows come with numerous problems when managing monorepos: wasted disk space, duplicate dependency installations, phantom dependencies, and more. This article provides an in-depth introduction to using pnpm's workspace feature for efficient monorepo management, fundamentally solving these pain points.

## Background

### Pain Points of Traditional Package Managers

In monorepo projects using npm or yarn, common issues include:

1. **Disk space waste**: Each package's `node_modules` contains large numbers of duplicate dependency copies
2. **Slow installations**: Dependencies must be repeatedly downloaded and extracted
3. **Phantom Dependencies**: You can access dependencies not declared in `package.json`
4. **Dependency hoisting issues**: The hoisting mechanism leads to uncontrollable dependency versions

```bash
# npm/yarn node_modules structure
project/
├── packages/
│   ├── app-a/
│   │   └── node_modules/  # Contains many duplicate dependencies
│   ├── app-b/
│   │   └── node_modules/  # Same dependencies installed again
│   └── shared/
│       └── node_modules/  # Yet another copy...
└── node_modules/          # Another copy at the root level
```

### pnpm's Solution

pnpm (Performant npm) solves these problems through several technical innovations:

- **Hard links + symlinks**: All packages share a single global store, using hard links to avoid duplicate storage
- **Strict dependency isolation**: Only explicitly declared dependencies are accessible
- **Parallel installation**: Multiple packages install simultaneously, dramatically improving speed

```bash
# pnpm node_modules structure
project/
├── packages/
│   ├── app-a/
│   │   └── node_modules/  # Only contains symlinks
│   ├── app-b/
│   │   └── node_modules/  # Only contains symlinks
│   └── shared/
│       └── node_modules/  # Only contains symlinks
└── node_modules/          # Symlinks to global store
```

## pnpm Workspace Configuration

### Initializing a Monorepo

```bash
# Create project root directory
mkdir my-monorepo && cd my-monorepo

# Initialize pnpm workspace
pnpm init

# Create workspace configuration file
cat > pnpm-workspace.yaml << EOF
packages:
  - 'packages/*'
  - 'apps/*'
EOF
```

### Directory Structure Design

```
my-monorepo/
├── pnpm-workspace.yaml      # Workspace configuration
├── package.json              # Root package.json
├── pnpm-lock.yaml            # Lock file (only one)
├── packages/                 # Shared packages
│   ├── utils/
│   │   ├── package.json
│   │   └── src/
│   ├── ui-components/
│   │   ├── package.json
│   │   └── src/
│   └── config/
│       └── package.json
└── apps/                     # Applications
    ├── web-app/
    │   ├── package.json
    │   └── src/
    └── admin-app/
        ├── package.json
        └── src/
```

### Configuring Inter-Package Dependencies

Declare dependencies in each sub-package's `package.json`:

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

The `workspace:*` protocol tells pnpm to use local packages from the workspace, automatically resolving to the correct paths.

## Common Commands in Detail

### Installing Dependencies

```bash
# Install dependencies for all packages
pnpm install

# Install dependencies for a specific package (and its local dependencies)
pnpm install --filter @my/web-app

# Install a package and all its dependency packages
pnpm install --filter @my/web-app...

# Add a dependency to a specific package from the root
pnpm add lodash --filter @my/utils
```

### Running Scripts

```bash
# Run build script in all packages
pnpm -r run build

# Run a script in a specific package
pnpm --filter @my/utils run build

# Run test in all packages
pnpm -r run test

# Run in parallel (faster)
pnpm -r --parallel run build
```

### Adding/Removing Dependencies

```bash
# Add a dependency to a specific package
pnpm add axios --filter @my/web-app

# Add a dev dependency
pnpm add -D typescript --filter @my/utils

# Add an internal package dependency
pnpm add @my/utils --filter @my/web-app

# Add a dependency to all packages
pnpm add lodash -r
```

## Advanced Configuration

### Workspace Protocol Configuration

In `pnpm-workspace.yaml` you can configure more granular package matching rules:

```yaml
packages:
  # All packages under the packages directory
  - 'packages/*'
  
  # All packages under the apps directory
  - 'apps/*'
  
  # Support nested directories
  - 'packages/**/*'
  
  # Exclude specific directories
  - '!**/node_modules/**'
```

### Dependency Overrides

Manage dependency versions uniformly in the root `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      // Force all packages to use a specific version of a dependency
      "lodash": "^4.17.21",
      
      // Resolve security vulnerabilities
      "minimist": "^1.2.6"
    },
    
    // Allow specific dependencies to be phantom-accessed (not recommended)
    "peerDependencyRules": {
      "ignoreMissing": ["@types/react"]
    }
  }
}
```

### Workspace Package Linking

With the `link-workspace-packages` configuration, pnpm can automatically symlink workspace packages:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'

# Auto-link workspace packages
link-workspace-packages: true
prefer-workspace-packages: true
```

## Real-World Example: Building a Vue 3 Component Library

```bash
# Create monorepo structure
mkdir vue3-component-lib && cd vue3-component-lib
pnpm init

# Create workspace configuration
cat > pnpm-workspace.yaml << EOF
packages:
  - 'packages/*'
EOF

# Create component library packages
mkdir -p packages/button/src
mkdir -p packages/input/src
mkdir -p packages/example

# Initialize button component package
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

# Use in example project
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

## Performance Comparison

In real-world projects, the performance improvements of pnpm over npm/yarn:

| Metric | npm | yarn | pnpm |
|------|-----|------|------|
| Installation Time | 45s | 32s | 18s |
| Disk Usage | 2.3GB | 2.1GB | 890MB |
| node_modules Count | 15,432 | 14,876 | 3,241 |

## Common Issues and Solutions

### Issue 1: Package Not Found

```bash
# Error: Cannot find module '@my/utils'
# Cause: pnpm's strict dependency isolation
# Solution: Ensure dependencies are explicitly declared in package.json
pnpm add @my/utils --filter @my/web-app
```

### Issue 2: Version Inconsistency

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/*'

# Force all packages to use the same version
catalog:
  vue: ^3.3.0
  typescript: ^5.1.0
```

### Issue 3: Publishing Configuration

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
# Publish all packages
pnpm -r publish

# Publish a specific package only
pnpm --filter @my/button publish
```

## Summary

pnpm's workspace feature provides an excellent solution for monorepo projects:

1. **Disk efficiency**: Hard links and symlinks dramatically reduce disk usage
2. **Strict isolation**: Prevents phantom dependencies, making dependency relationships clearer
3. **Installation speed**: Parallel installation and caching mechanisms improve the development experience
4. **Flexible configuration**: Rich configuration options that adapt to various project needs

Adopting pnpm for monorepo management makes your project's dependency management more efficient and reliable, building a solid foundation for team collaboration and code reuse.
