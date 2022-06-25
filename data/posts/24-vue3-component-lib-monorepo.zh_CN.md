---
title: "Vue 3 组件库从零搭建：基于 Vite 的 Monorepo 实践"
tag: vue
description: 从零搭建一个基于 Vite 和 Monorepo 的 Vue 3 组件库，涵盖项目结构、构建配置、文档站点等完整流程。
date: "2022-06-25T08:00:00.000Z"
---

## 目标

搭建一个完整的 Vue 3 组件库，支持按需导入、TypeScript 类型导出和文档站点。

## 背景

### 为什么要自己做组件库？

1. **统一团队规范**：组件风格、API 设计统一
2. **提高复用率**：避免重复造轮子
3. **便于维护**：统一的版本管理和更新
4. **技术积累**：沉淀团队的技术能力

### 技术选型

| 工具 | 用途 |
|------|------|
| Vite | 构建工具 |
| Monorepo (pnpm workspaces) | 多包管理 |
| Vue 3 + TypeScript | 组件开发 |
| Vitepress | 文档站点 |

## 项目结构

```
my-component-lib/
├── packages/
│   ├── core/                    # 核心包
│   │   ├── src/
│   │   │   ├── components/      # 组件
│   │   │   │   ├── Button/
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── Button.vue
│   │   │   │   │   └── types.ts
│   │   │   │   ├── Input/
│   │   │   │   └── Modal/
│   │   │   ├── composables/     # 组合式函数
│   │   │   ├── utils/           # 工具函数
│   │   │   └── index.ts         # 入口文件
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── styles/                  # 样式包
│   │   ├── src/
│   │   │   ├── variables.css
│   │   │   └── components/
│   │   └── package.json
│   └── docs/                    # 文档站点
│       ├── .vitepress/
│       ├── components/
│       └── package.json
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.json
```

## Monorepo 配置

### 1. pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
```

### 2. 根 package.json

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

## 组件开发

### 1. Button 组件

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

### 2. 样式

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

/* 尺寸 */
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

/* 类型 */
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

/* 状态 */
.mc-button--disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.mc-button--loading {
    pointer-events: none;
}

/* 加载动画 */
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

### 3. 入口文件

```typescript
// packages/core/src/index.ts
import type { App } from 'vue'

// 组件
import Button from './components/Button'
import Input from './components/Input'
import Modal from './components/Modal'

// 导出组件
export { Button, Input, Modal }

// 导出类型
export type { ButtonProps, ButtonType, ButtonSize } from './components/Button'

// 安装函数
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

## 构建配置

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

## 使用方式

### 1. 全量导入

```typescript
// main.ts
import { createApp } from 'vue'
import MyComponentLib from '@my-lib/core'
import '@my-lib/styles'

const app = createApp(App)
app.use(MyComponentLib)
app.mount('#app')

// 使用
// <mc-button type="primary">按钮</mc-button>
```

### 2. 按需导入

```typescript
// 使用 unplugin-vue-components
// vite.config.ts
import Components from 'unplugin-vue-components/vite'

export default defineConfig({
    plugins: [
        Components({
            resolvers: [
                // 自动注册组件
            ]
        })
    ]
})

// 或者手动导入
import { Button } from '@my-lib/core'
```

### 3. 直接导入组件

```vue
<script setup>
import { Button } from '@my-lib/core'
</script>

<template>
    <Button type="primary">按钮</Button>
</template>
```

## 文档站点

```typescript
// packages/docs/.vitepress/config.ts
import { defineConfig } from 'vitepress'

export default defineConfig({
    title: 'My Component Lib',
    description: 'Vue 3 组件库文档',
    themeConfig: {
        sidebar: [
            {
                text: '组件',
                items: [
                    { text: 'Button 按钮', link: '/components/button' },
                    { text: 'Input 输入框', link: '/components/input' },
                    { text: 'Modal 对话框', link: '/components/modal' }
                ]
            }
        ]
    }
})
```

```markdown
<!-- packages/docs/components/button.md -->
# Button 按钮

## 基础用法

<ClientOnly>
    <Button type="primary">主要按钮</Button>
    <Button type="secondary">次要按钮</Button>
    <Button type="danger">危险按钮</Button>
</ClientOnly>

## API

### Props

| 属性 | 说明 | 类型 | 默认值 |
|------|------|------|--------|
| type | 按钮类型 | 'primary' \| 'secondary' \| 'danger' \| 'text' | 'secondary' |
| size | 按钮大小 | 'small' \| 'medium' \| 'large' | 'medium' |
| disabled | 是否禁用 | boolean | false |
| loading | 是否加载中 | boolean | false |
```

## 发布到 npm

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
# 发布
cd packages/core
npm publish --access public
```

## 总结

1. **Monorepo 是组件库的最佳实践**：统一管理、共享依赖
2. **Vite 提供极速构建**：开发和构建都很快
3. **TypeScript 是必须的**：类型导出提升开发体验
4. **按需导入是标配**：unplugin-vue-components 自动注册
5. **文档驱动开发**：Vitepress 搭建文档站点

这套方案能让你快速搭建一个专业的 Vue 3 组件库。
