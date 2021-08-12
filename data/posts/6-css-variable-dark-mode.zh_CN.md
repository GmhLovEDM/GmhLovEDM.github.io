---
title: "用 CSS 变量打造一套深色模式主题"
tag: css
description: 用 CSS 变量实现深色模式切换，从设计规范到代码实现，打造一套可维护的主题系统。
date: "2021-08-12T08:00:00.000Z"
---

## 目标

实现一个**可扩展、易维护、性能优先**的深色模式方案。不是简单地反转颜色，而是建立一套完整的主题系统。

## 背景

### 深色模式的流行

2019 年 Apple 在 iOS 13 中引入了系统级深色模式，随后 Android 10 和 Windows 10 也跟进。深色模式从"好看"变成了"必须有"。

但很多前端开发者的实现方式是这样的：

```css
/* 暴力方式：两套完整的样式 */
body.light { /* 200 行颜色定义 */ }
body.dark  { /* 又 200 行颜色定义 */ }
```

这种方式的问题：
1. 代码重复严重
2. 新增组件时需要在两个地方都加样式
3. 维护成本随项目增长线性上升

**CSS 变量是解决这个问题的最佳方案。**

## CSS 变量基础

### 定义和使用

```css
:root {
    /* 主题色 */
    --color-primary: #1890ff;
    --color-success: #52c41a;
    --color-warning: #faad14;
    --color-error: #ff4d4f;

    /* 文本色 */
    --text-primary: rgba(0, 0, 0, 0.85);
    --text-secondary: rgba(0, 0, 0, 0.65);
    --text-disabled: rgba(0, 0, 0, 0.25);

    /* 背景色 */
    --bg-base: #ffffff;
    --bg-light: #fafafa;
    --bg-dark: #f0f2f5;

    /* 边框 */
    --border-color: #d9d9d9;
    --border-radius: 4px;
}

/* 使用变量 */
.button {
    background: var(--color-primary);
    color: white;
    border-radius: var(--border-radius);
}

.text-secondary {
    color: var(--text-secondary);
}
```

### 深色模式覆盖

```css
/* 通过 class 切换 */
body.dark {
    --text-primary: rgba(255, 255, 255, 0.85);
    --text-secondary: rgba(255, 255, 255, 0.65);
    --text-disabled: rgba(255, 255, 255, 0.25);

    --bg-base: #141414;
    --bg-light: #1f1f1f;
    --bg-dark: #262626;

    --border-color: #434343;
}

/* 或者通过媒体查询跟随系统 */
@media (prefers-color-scheme: dark) {
    :root:not(.light) {
        --text-primary: rgba(255, 255, 255, 0.85);
        --text-secondary: rgba(255, 255, 255, 0.65);
        /* ... 其他变量 */
    }
}
```

## 完整的主题系统设计

### 1. 设计 Token 分层

```css
:root {
    /* === 基础 Token（原始值） === */
    --gray-50: #fafafa;
    --gray-100: #f5f5f5;
    --gray-200: #e8e8e8;
    --gray-300: #d9d9d9;
    --gray-400: #bfbfbf;
    --gray-500: #8c8c8c;
    --gray-600: #595959;
    --gray-700: #434343;
    --gray-800: #262626;
    --gray-900: #141414;

    --blue-50: #e6f7ff;
    --blue-100: #bae7ff;
    --blue-200: #91d5ff;
    --blue-300: #69c0ff;
    --blue-400: #40a9ff;
    --blue-500: #1890ff;
    --blue-600: #096dd9;
    --blue-700: #0050b3;

    /* === 语义 Token（功能映射） === */
    --color-primary: var(--blue-500);
    --color-primary-hover: var(--blue-400);
    --color-primary-active: var(--blue-600);

    --color-bg-base: var(--gray-50);
    --color-bg-light: var(--gray-100);
    --color-bg-dark: var(--gray-200);

    --color-text-primary: var(--gray-900);
    --color-text-secondary: var(--gray-600);
    --color-text-disabled: var(--gray-400);

    --color-border: var(--gray-300);
    --color-border-light: var(--gray-200);
}

/* 深色模式：只覆盖语义 Token */
body.dark {
    --color-primary: var(--blue-500); /* 主色通常不变 */
    --color-primary-hover: var(--blue-400);
    --color-primary-active: var(--blue-600);

    --color-bg-base: var(--gray-900);
    --color-bg-light: var(--gray-800);
    --color-bg-dark: var(--gray-700);

    --color-text-primary: rgba(255, 255, 255, 0.85);
    --color-text-secondary: rgba(255, 255, 255, 0.65);
    --color-text-disabled: rgba(255, 255, 255, 0.25);

    --color-border: var(--gray-700);
    --color-border-light: var(--gray-800);
}
```

### 2. 组件级主题变量

```css
:root {
    /* 按钮 */
    --btn-height: 32px;
    --btn-padding: 0 16px;
    --btn-font-size: 14px;
    --btn-border-radius: var(--radius-sm);

    /* 输入框 */
    --input-height: 32px;
    --input-padding: 0 12px;
    --input-border: 1px solid var(--color-border);
    --input-border-radius: var(--radius-sm);

    /* 卡片 */
    --card-padding: 24px;
    --card-bg: var(--color-bg-base);
    --card-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    --card-border-radius: var(--radius-md);
}

/* 深色模式的卡片阴影调整 */
body.dark .card {
    --card-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
```

### 3. 颜色对比度检查

深色模式必须保证足够的对比度（WCAG AA 标准：至少 4.5:1）：

```javascript
function getContrastRatio(color1, color2) {
    const getLuminance = (r, g, b) => {
        const [rs, gs, bs] = [r, g, b].map(c => {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };

    const l1 = getLuminance(...color1);
    const l2 = getLuminance(...color2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

// 测试对比度
const ratio = getContrastRatio([255, 255, 255], [20, 20, 20]);
console.log(`对比度: ${ratio.toFixed(2)}:1`); // 约 18.1:1，符合 WCAG AAA
```

## 主题切换实现

### 方案 1：Class 切换

```javascript
class ThemeManager {
    constructor() {
        this.theme = localStorage.getItem('theme') || 'light';
        this.apply();
    }

    toggle() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        this.apply();
        localStorage.setItem('theme', this.theme);
    }

    apply() {
        document.body.classList.remove('light', 'dark');
        document.body.classList.add(this.theme);
    }

    // 跟随系统
    followSystem() {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.theme = mediaQuery.matches ? 'dark' : 'light';
        this.apply();

        mediaQuery.addEventListener('change', (e) => {
            this.theme = e.matches ? 'dark' : 'light';
            this.apply();
        });
    }
}

const themeManager = new ThemeManager();
```

### 方案 2：CSS 媒体查询自动切换

```css
/* 默认浅色模式 */
:root {
    --color-bg-base: #ffffff;
    --color-text-primary: #000000;
}

/* 跟随系统偏好 */
@media (prefers-color-scheme: dark) {
    :root {
        --color-bg-base: #141414;
        --color-text-primary: #ffffff;
    }
}

/* 允许用户手动覆盖 */
body.light {
    --color-bg-base: #ffffff;
    --color-text-primary: #000000;
}

body.dark {
    --color-bg-base: #141414;
    --color-text-primary: #ffffff;
}
```

## 常见陷阱

### 1. 图片在深色模式下太亮

```css
/* 为图片添加深色模式适配 */
body.dark img:not(.no-filter) {
    filter: brightness(0.8);
}

/* 或者使用 mix-blend-mode */
body.dark .logo {
    mix-blend-mode: screen;
}
```

### 2. 阴影在深色模式下不可见

```css
:root {
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.1);
    --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.1);
}

body.dark {
    /* 深色模式下阴影需要更强 */
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.4);
    /* 或者使用边框代替阴影 */
}
```

### 3. SVG 图标颜色

```css
/* 浅色模式 */
.icon {
    fill: var(--color-text-primary);
}

/* 深色模式 - 使用 currentColor */
.icon {
    fill: currentColor;
    color: var(--color-text-primary);
}
```

## 总结

1. **CSS 变量是主题系统的基石**：一次定义，到处使用
2. **分层设计**：基础 Token → 语义 Token → 组件 Token
3. **深色模式不是简单反转**：需要考虑对比度、阴影、图片适配
4. **跟随系统 + 手动覆盖**：提供最佳用户体验
5. **性能优先**：CSS 变量切换是零成本的，不需要重绘整个页面

用 CSS 变量构建主题系统，你的代码会更干净、更易维护、更易扩展。
