---
title: "CSS-in-JS 还是 Tailwind？2022 年样式方案怎么选"
tag: css
description: 前端样式方案层出不穷，CSS-in-JS 和 Tailwind 是两大主流方向。本文分析各自的优缺点，帮你做出正确的选择。
date: "2022-06-05T08:00:00.000Z"
---

## 目标

理解 CSS-in-JS 和 Tailwind CSS 的设计理念，根据项目需求选择合适的样式方案。

## 背景

### 样式方案的演进

```
2010: CSS 文件（全局样式）
2012: CSS 预处理器（Sass/Less）
2014: CSS Modules（局部作用域）
2015: CSS-in-JS（styled-components）
2017: Utility-first CSS（Tailwind）
```

每种方案都在解决上一代的问题，但也都带来了新的问题。

## CSS-in-JS 代表：styled-components

### 核心理念

```javascript
// 将样式写在 JavaScript 中
import styled from 'styled-components'

const Button = styled.button`
    background: ${props => props.primary ? '#1890ff' : '#fff'};
    color: ${props => props.primary ? '#fff' : '#333'};
    border: 1px solid #d9d9d9;
    border-radius: 4px;
    padding: 8px 16px;
    cursor: pointer;

    &:hover {
        border-color: #1890ff;
    }
`

// 使用
<Button primary>主要按钮</Button>
<Button>次要按钮</Button>
```

### 优点

```javascript
// 1. 局部作用域，没有类名冲突
const StyledDiv = styled.div`
    color: red;
`
// 编译后生成唯一的类名：sc-bdfBwQ

// 2. 基于 props 动态样式
const Box = styled.div`
    width: ${props => props.width}px;
    height: ${props => props.height}px;
    background: ${props => props.theme.background};
`

// 3. 样式继承
const BaseButton = styled.button`
    padding: 8px 16px;
    border-radius: 4px;
`

const PrimaryButton = styled(BaseButton)`
    background: #1890ff;
    color: white;
`

// 4. 主题支持
import { ThemeProvider } from 'styled-components'

const theme = {
    primary: '#1890ff',
    background: '#f5f5f5'
}

<ThemeProvider theme={theme}>
    <App />
</ThemeProvider>
```

### 缺点

```javascript
// 1. 运行时性能开销
// 每次渲染都要解析模板字符串
// 生成新的 CSS 规则

// 2. 学习成本
// 需要学习新的语法和 API

// 3. 调试困难
// 生成的类名没有语义，调试时难以定位

// 4. 包体积
// styled-components 约 12KB (gzipped)
```

## Tailwind CSS

### 核心理念

```html
<!-- 直接在 HTML 中使用工具类 -->
<button class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
    主要按钮
</button>

<button class="bg-white text-gray-800 px-4 py-2 rounded border border-gray-300 hover:border-blue-500">
    次要按钮
</button>
```

### 优点

```html
<!-- 1. 开发速度快 -->
<!-- 不需要离开 HTML 就能完成样式 -->

<!-- 2. 没有类名 -->
<!-- 不需要想类名，减少认知负担 -->

<!-- 3. 设计系统一致 -->
<!-- 使用预定义的设计 token -->
<div class="p-4 m-2 text-sm font-medium text-gray-700">
    使用统一的设计系统
</div>

<!-- 4. 响应式友好 -->
<div class="w-full md:w-1/2 lg:w-1/3">
    响应式布局
</div>

<!-- 5. 暗黑模式 -->
<div class="bg-white dark:bg-gray-800 dark:text-white">
    暗黑模式支持
</div>
```

### 缺点

```html
<!-- 1. HTML 可读性差 -->
<div class="flex items-center justify-between p-4 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 border border-gray-200">
    <!-- 类名太多，难以阅读 -->
</div>

<!-- 2. 重复的类名 -->
<!-- 多个地方使用相同的样式，需要重复写类名 -->

<!-- 3. 复杂样式困难 -->
<!-- 动画、伪元素等复杂样式写起来很痛苦 -->
<style>
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
</style>

<!-- 4. 学习曲线 -->
<!-- 需要记住大量的工具类 -->
```

## 对比分析

### 1. 开发体验

```javascript
// CSS-in-JS
const Card = styled.div`
    background: white;
    border-radius: 8px;
    padding: 24px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
`

// Tailwind
// <div class="bg-white rounded-lg p-6 shadow-md">
```

**对比**：
- CSS-in-JS：样式集中，结构清晰
- Tailwind：HTML 稍长，但不需要写单独的样式文件

### 2. 性能

```
CSS-in-JS（运行时）：
- 首次渲染：需要解析模板字符串
- 后续渲染：需要比较 props 变化
- 包体积：~12KB

Tailwind（构建时）：
- 生成静态 CSS
- 只包含使用的类
- 通常 < 10KB

结论：Tailwind 在性能上更有优势
```

### 3. 可维护性

```javascript
// CSS-in-JS
// 样式和组件绑定，修改组件时会同步修改样式
const Button = styled.button`
    background: ${({ theme }) => theme.primary};
`

// Tailwind
// 样式分散在 HTML 中，修改设计系统时需要全局替换
// <button class="bg-blue-500">
```

### 4. 设计系统

```javascript
// CSS-in-JS：通过 theme provider
const theme = {
    colors: {
        primary: '#1890ff',
        secondary: '#722ed1'
    },
    spacing: {
        sm: '8px',
        md: '16px',
        lg: '24px'
    }
}

// Tailwind：通过配置文件
// tailwind.config.js
module.exports = {
    theme: {
        colors: {
            primary: '#1890ff',
            secondary: '#722ed1'
        },
        spacing: {
            'sm': '8px',
            'md': '16px',
            'lg': '24px'
        }
    }
}
```

## 选择指南

### 选择 CSS-in-JS 的场景

```
✓ 需要复杂的动态样式
✓ 组件库开发
✓ 团队熟悉 CSS-in-JS
✓ 需要主题切换
✓ 样式逻辑复杂
```

### 选择 Tailwind 的场景

```
✓ 快速原型开发
✓ 团队协作（减少样式冲突）
✓ 设计系统驱动
✓ 性能要求高
✓ 小型项目
```

### 混合使用

```javascript
// 可以同时使用两者
// Tailwind 处理基础样式
// CSS-in-JS 处理复杂逻辑

const StyledCard = styled.div`
    // 复杂的动画和伪类
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    animation: fadeIn 0.3s ease;
`

// 使用 Tailwind 处理基础样式
<div className="p-6 bg-white rounded-lg">
    <StyledCard>
        复杂样式内容
    </StyledCard>
</div>
```

## 其他方案

### 1. CSS Modules

```css
/* Button.module.css */
.primary {
    background: #1890ff;
    color: white;
}

.secondary {
    background: white;
    color: #333;
}
```

```javascript
import styles from './Button.module.css'

<button className={styles.primary}>主要按钮</button>
```

### 2. UnoCSS

```html
<!-- 按需生成的原子化 CSS -->
<button class="bg-blue-500 text-white px-4 py-2">
    类似 Tailwind，但按需生成
</button>
```

### 3. Vanilla Extract

```typescript
// 类型安全的 CSS-in-JS，构建时生成
import { style } from '@vanilla-extract/css'

export const button = style({
    background: 'blue',
    color: 'white'
})
```

## 实际项目建议

### 1. 新项目

```
小型项目 → Tailwind（快速开发）
中型项目 → Tailwind 或 CSS Modules
大型项目 → CSS-in-JS 或 Tailwind + CSS Modules
```

### 2. 迁移策略

```javascript
// 不要一次性重写，渐进式迁移
// 1. 新组件使用新方案
// 2. 逐步修改旧组件
// 3. 最后删除旧的样式文件
```

### 3. 团队决策

```
考虑因素：
1. 团队的技术栈偏好
2. 项目的规模和复杂度
3. 性能要求
4. 设计系统的复杂度
5. 长期维护成本
```

## 总结

1. **没有完美的方案**：每种方案都有其适用场景
2. **CSS-in-JS 适合复杂场景**：动态样式、主题系统、组件库
3. **Tailwind 适合快速开发**：原型、小项目、设计系统驱动
4. **性能考虑**：Tailwind 的构建时生成更有优势
5. **团队一致性**：选择团队熟悉且适合项目的方案

选择样式方案不是技术问题，而是团队协作和项目需求的平衡。
