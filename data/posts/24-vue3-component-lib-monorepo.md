---
title: "Building a Vue 3 Component Library from Scratch: Vite-based Monorepo Practice"
tag: vue
description: Build a Vue 3 component library based on Vite and Monorepo from scratch, covering project structure, build configuration, documentation site, and the complete workflow.
date: "2022-06-25T08:00:00.000Z"
---

## Goal

Build a complete Vue 3 component library supporting on-demand import, TypeScript type exports, and a documentation site.

## Background

### Why Build Your Own Component Library?

1. **Unify team standards**: Consistent component styles and API design
2. **Improve reuse rate**: Avoid reinventing the wheel
3. **Easy maintenance**: Unified version management and updates
4. **Technical accumulation**: Build team technical capabilities

### Technology Selection

| Tool | Purpose |
|------|---------|
| Vite | Build tool |
| Monorepo (pnpm workspaces) | Multi-package management |
| Vue 3 + TypeScript | Component development |
| Vitepress | Documentation site |

## Project Structure

```
my-component-lib/
├── packages/
│   ├── core/                    # Core package
│   │   ├── src/
│   │   │   ├── components/      # Components
│   │   │   │   ├── Button/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── Button.vue
│   │   │   │   │   └── types.ts
│   │   │   │   ├── Input/
│   │   │   │   └── Modal/
│   │   │   ├── composables/     # Composable functions
│   │   │   ├── utils/           # Utility functions
│   │   │   └── index.ts         # Entry file
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── styles/                  # Styles package
│   │   ├── src/
│   │   │   ├── variables.css
│   │   │   └── components/
│   │   └── package.json
│   └── docs/                    # Documentation site
│       ├── .vitepress/
│       ├── components/
│       └── package.json
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.json
```

## Monorepo Configuration

### 1. pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
```

### 2. Root package.json

```json
{
    "name": "my-component-lib",
    "private": true,
    "scripts": {
        "dev": "pnpm -r --parallel run dev",
        "build": "pnpm -r run build",
        "docs:dev": "pnpm --filter docs run dev",
        "docs:build": "pnpm --filter docs run build"
    },
    "devDependencies": {
        "typescript": "^4.9.0",
        "vue": "^3.2.0",
        "vite": "^3.0.0"
    }
}
```

## Component Development

### 1. Button Component

```typescript
// packages/core/src/components/Button/types.ts
import { ExtractPropTypes, PropType } from 'vue'

export type ButtonType = 'primary' | 'secondary' | 'danger' | 'text'
export type ButtonSize = 'small' | 'medium' | 'large'

export interface ButtonProps {
    type?: ButtonType
    size?: ButtonSize
    disabled?: boolean
    loading?: boolean
    icon?: string
}

export const buttonProps = {
    type: {
        type: String as PropType<ButtonType>,
        default: 'secondary'
    },
    size: {
        type: String as PropType<ButtonSize>,
        default: 'medium'
    },
    disabled: {
        type: Boolean,
        default: false
    },
    loading: {
        type: Boolean,
        default: false
    },
    icon: {
        type: String,
        default: ''
    }
} as const

export type ButtonEmits = {
    (e: 'click', event: MouseEvent): void
}
```

```vue
<!-- packages/core/src/components/Button/Button.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { buttonProps, ButtonEmits } from './types'

const props = withDefaults(defineProps<ReturnType<typeof buttonProps>>(), {
    type: 'secondary',
    size: 'medium',
    disabled: false,
    loading: false,
    icon: ''
})

const emit = defineEmits<ButtonEmits>()

const classes = computed(() => [
    'mc-button',
    `mc-button--${props.type}`,
    `mc-button--${props.size}`,
    {
        'mc-button--disabled': props.disabled,
        'mc-button--loading': props.loading
    }
])

function handleClick(event: MouseEvent) {
    if (props.disabled || props.loading) return
    emit('click', event)
}
</script>

<template>
    <button
        :class="classes"
        :disabled="disabled"
        @click="handleClick"
    >
        <span v-if="loading" class="mc-button__loading">
            <svg viewBox="0 0 24 24" class="mc-icon-spin">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
        </span>
        <span v-if="icon && !loading" class="mc-button__icon">
            {{ icon }}
        </span>
        <span class="mc-button__text">
            <slot />
        </span>
    </button>
</template>
```

### 2. Styles

```css
/* packages/styles/src/components/button.css */
.mc-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #d9d9d9;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 14px;
    line-height: 1.5;
}

/* Sizes */
.mc-button--small {
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
}

.mc-button--medium {
    height: 32px;
    padding: 0 16px;
}

.mc-button--large {
    height: 40px;
    padding: 0 24px;
    font-size: 16px;
}

/* Types */
.mc-button--primary {
    background: #1890ff;
    border-color: #1890ff;
    color: white;
}

.mc-button--primary:hover {
    background: #40a9ff;
    border-color: #40a9ff;
}

.mc-button--secondary {
    background: white;
    color: #333;
}

.mc-button--secondary:hover {
    border-color: #1890ff;
    color: #1890ff;
}

.mc-button--danger {
    background: #ff4d4f;
    border-color: #ff4d4f;
    color: white;
}

.mc-button--text {
    border: none;
    background: transparent;
    color: #1890ff;
    padding: 0;
}

/* States */
.mc-button--disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.mc-button--loading {
    pointer-events: none;
}

/* Loading animation */
.mc-icon-spin {
    width: 14px;
    height: 14px;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}
```

### 3. Entry File

```typescript
// packages/core/src/index.ts
import type { App } from 'vue'

// Components
import Button from './components/Button'
import Input from './components/Input'
import Modal from './components/Modal'

// Export components
export { Button, Input, Modal }

// Export types
export type { ButtonProps, ButtonType, ButtonSize } from './components/Button'

// Install function
const components = [Button, Input, Modal]

export function install(app: App): void {
    components.forEach(component => {
        app.use(component)
    })
}

export default {
    install
}
```

## Build Configuration

```typescript
// packages/core/vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
    plugins: [
        vue(),
        dts({
            insertTypesEntry: true,
            clean: true
        })
    ],
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            name: 'MyComponentLib',
            formats: ['es', 'umd', 'cjs'],
            fileName: (format) => `index.${format}.js`
        },
        rollupOptions: {
            external: ['vue'],
            output: {
                globals: {
                    vue: 'Vue'
                },
                dir: 'dist',
                preserveModules: true,
                preserveModulesRoot: 'src'
            }
        }
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src')
        }
    }
})
```

## Usage Methods

### 1. Full Import

```typescript
// main.ts
import { createApp } from 'vue'
import MyComponentLib from '@my-lib/core'
import '@my-lib/styles'

const app = createApp(App)
app.use(MyComponentLib)
app.mount('#app')

// Usage
// <mc-button type="primary">Button</mc-button>
```

### 2. On-demand Import

```typescript
// Using unplugin-vue-components
// vite.config.ts
import Components from 'unplugin-vue-components/vite'

export default defineConfig({
    plugins: [
        Components({
            resolvers: [
                // Auto-register components
            ]
        })
    ]
})

// Or manual import
import { Button } from '@my-lib/core'
```

### 3. Direct Component Import

```vue
<script setup>
import { Button } from '@my-lib/core'
</script>

<template>
    <Button type="primary">Button</Button>
</template>
```

## Documentation Site

```typescript
// packages/docs/.vitepress/config.ts
import { defineConfig } from 'vitepress'

export default defineConfig({
    title: 'My Component Lib',
    description: 'Vue 3 Component Library Documentation',
    themeConfig: {
        sidebar: [
            {
                text: 'Components',
                items: [
                    { text: 'Button', link: '/components/button' },
                    { text: 'Input', link: '/components/input' },
                    { text: 'Modal', link: '/components/modal' }
                ]
            }
        ]
    }
})
```

```markdown
<!-- packages/docs/components/button.md -->
# Button

## Basic Usage

<ClientOnly>
    <Button type="primary">Primary Button</Button>
    <Button type="secondary">Secondary Button</Button>
    <Button type="danger">Danger Button</Button>
</ClientOnly>

## API

### Props

| Property | Description | Type | Default |
|----------|-------------|------|---------|
| type | Button type | 'primary' \| 'secondary' \| 'danger' \| 'text' | 'secondary' |
| size | Button size | 'small' \| 'medium' \| 'large' | 'medium' |
| disabled | Whether disabled | boolean | false |
| loading | Whether loading | boolean | false |
```

## Publishing to npm

```json
// packages/core/package.json
{
    "name": "@my-lib/core",
    "version": "1.0.0",
    "main": "dist/index.cjs.js",
    "module": "dist/index.es.js",
    "types": "dist/index.d.ts",
    "files": ["dist"],
    "peerDependencies": {
        "vue": "^3.2.0"
    }
}
```

```bash
# Publish
cd packages/core
npm publish --access public
```

## Summary

1. **Monorepo is best practice for component libraries**: Unified management, shared dependencies
2. **Vite provides ultra-fast builds**: Fast for both development and production
3. **TypeScript is essential**: Type exports enhance development experience
4. **On-demand import is standard**: unplugin-vue-components auto-registration
5. **Documentation-driven development**: Vitepress for documentation site

This approach lets you quickly build a professional Vue 3 component library.
