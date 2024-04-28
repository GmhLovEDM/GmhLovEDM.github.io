---
title: "Frontend Monorepo 2024 Practice: pnpm workspace + Turborepo"
tag: engineering
description: Building modern frontend Monorepo with pnpm workspace and Turborepo, a complete practice guide from project structure to CI/CD.
date: "2024-04-28T08:00:00.000Z"
---

## Goal

Monorepo is an efficient way to manage multiple related projects. In 2024, pnpm workspace + Turborepo has become the best practice combination for frontend Monorepo. This article builds a production-grade Monorepo project from scratch, covering project structure design, dependency management, build optimization, and CI/CD configuration.

## Background

### Monorepo vs Polyrepo

```
Monorepo (single repository, multiple projects):
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

Polyrepo (multiple repositories):
  web-repo/
  admin-repo/
  api-repo/
  ui-repo/  ← Referenced via npm packages
```

### Why Choose pnpm

| Feature | npm | yarn | pnpm |
|---------|-----|------|------|
| Install speed | Slow | Medium | Extremely fast |
| Disk usage | High | High | Low (hard links) |
| Phantom dependencies | Yes | Yes | No |
| Workspace support | Basic | Supported | Excellent |
| Strictness | Low | Low | High |

### pnpm + Turborepo Advantages

- **pnpm**: Fast, disk-saving, strict dependency management
- **Turborepo**: Incremental builds, remote caching, task orchestration

## Project Initialization

### Create Monorepo

```bash
# Create project directory
mkdir my-monorepo && cd my-monorepo

# Initialize pnpm workspace
pnpm init

# Create workspace configuration
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF

# Create directory structure
mkdir -p apps/web apps/admin packages/ui packages/utils
```

### Root package.json

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

## Turborepo Configuration

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

## Shared Package Design

### utils Package

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

### ui Package

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
          Loading...
        </span>
      ) : (
        children
      )}
    </button>
  );
};
```

## Application Development

### Next.js Web Application

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
        <h1 className="text-2xl font-bold mb-4">Monorepo Example</h1>
        <p className="text-gray-600 mb-4">
          Today is {formatDate(new Date())}
        </p>
        <div className="flex gap-4">
          <Button variant="primary">Primary Button</Button>
          <Button variant="secondary">Secondary Button</Button>
        </div>
      </Card>
    </div>
  );
}
```

## CI/CD Configuration

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

## Development Experience

### Hot Reload Development

```bash
# Start all apps' dev servers
pnpm dev

# Start only specific app
pnpm --filter @my-org/web dev

# Start only specific app and its dependencies
pnpm --filter @my-org/web... dev
```

### IDE Configuration

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

## Common Issues

### Dependency Version Conflicts

```bash
# View dependency tree
pnpm why <package>

# Force all packages to use same version
pnpm dedupe
```

### Inter-Package Dependencies

```typescript
// Use workspace protocol
{
  "dependencies": {
    "@my-org/ui": "workspace:*",  // Links to local during development
    "@my-org/utils": "workspace:*"
  }
}
```

### Build Order

```json
// Turborepo automatically handles dependency order
// utils → ui → web/admin
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"]  // ^ means build dependencies first
    }
  }
}
```

## Conclusion

pnpm + Turborepo is the best practice for frontend Monorepo in 2024. Key takeaways:

1. **pnpm**: Fast, disk-saving, strict dependency management
2. **Turborepo**: Incremental builds, remote caching, intelligent task orchestration
3. **Workspace protocol**: Best practice for inter-package dependencies
4. **CI/CD optimization**: Leverage remote cache to accelerate builds
5. **Development experience**: Hot reload, IDE support, type safety

Monorepo is not a silver bullet. For small projects, it may increase complexity. But for medium to large teams and multi-application projects, Monorepo is an efficient way to manage code.
