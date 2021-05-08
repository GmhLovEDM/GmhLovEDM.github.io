---
title: "CSS Grid 布局实战：从入门到真香"
tag: css
description: CSS Grid 是现代 Web 布局的终极武器。本文从实际场景出发，深入讲解 Grid 的核心概念、常见布局模式和实战技巧。
date: "2021-05-08T08:00:00.000Z"
---

## 目标

让读者真正理解 CSS Grid 的设计哲学，掌握 5 种最常见的 Grid 布局模式，并能在实际项目中灵活运用。

## 背景

### Flexbox 之后，为什么还需要 Grid？

Flexbox 诞生于 2012 年，解决了一维布局（行或列）的问题。但在实际开发中，我们经常需要同时控制行和列：

```css
/* Flexbox 做不了的事：精确控制二维网格 */
/* 比如：第一行占 2 个单元格，第二行占 3 个单元格 */
```

2017 年，CSS Grid Layout Module Level 1 正式成为 W3C 推荐标准。它的核心理念是：**把布局逻辑从 HTML 结构中解放出来，完全用 CSS 控制。**

## Grid 的核心概念

### 1. 网格容器与网格项

```css
.container {
    display: grid;
    grid-template-columns: 200px 1fr 200px; /* 三列 */
    grid-template-rows: auto 1fr auto;       /* 三行 */
    gap: 16px;                                /* 间距 */
}
```

### 2. fr 单位：Grid 的灵魂

`fr`（fraction）代表剩余空间的一个比例份额：

```css
/* 三列等宽 */
grid-template-columns: 1fr 1fr 1fr;

/* 第一列固定 200px，剩余空间两等分 */
grid-template-columns: 200px 1fr 1fr;

/* 第一列占剩余空间的 2 份，第二列占 1 份 */
grid-template-columns: 200px 2fr 1fr;
```

### 3. repeat() 与 auto-fill/auto-fit

```css
/* 重复的列定义 */
grid-template-columns: repeat(3, 1fr);

/* 自动填充：容器能放多少列就放多少列 */
grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));

/* auto-fill vs auto-fit 的区别 */
/* auto-fill：即使没有内容，也保留空的网格轨道 */
/* auto-fit：没有内容的轨道会被折叠 */
```

## 5 种实战布局模式

### 模式 1：圣杯布局（Holy Grail Layout）

这是最经典的三栏布局，Header + Main + Footer，左右两栏固定宽度，中间自适应：

```css
.layout-holy-grail {
    display: grid;
    grid-template-areas:
        "header  header  header"
        "sidebar content aside"
        "footer  footer  footer";
    grid-template-columns: 200px 1fr 200px;
    grid-template-rows: auto 1fr auto;
    min-height: 100vh;
}

.header  { grid-area: header; }
.sidebar { grid-area: sidebar; }
.content { grid-area: content; }
.aside   { grid-area: aside; }
.footer  { grid-area: footer; }
```

**优点**：语义清晰、响应式友好、不需要任何 hack。

### 模式 2：卡片网格（Card Grid）

电商网站的商品列表：

```css
.card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 24px;
    padding: 24px;
}

.card {
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}
```

这个布局会自动根据容器宽度决定放多少列卡片，每列最小 280px，最大自适应。响应式完全不需要媒体查询。

### 模式 3：杂志式布局（Magazine Layout）

不规则的网格布局，适合文章列表或图片展示：

```css
.magazine-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: 200px;
    gap: 16px;
}

/* 第一个元素占两行两列 */
.magazine-grid .featured {
    grid-column: 1 / 3;
    grid-row: 1 / 3;
}

/* 第二个元素占两列 */
.magazine-grid .wide {
    grid-column: span 2;
}
```

### 模式 4：响应式导航栏

```css
.navbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    padding: 0 24px;
    height: 64px;
}

.navbar__logo {
    /* logo 自然在左侧 */
}

.navbar__links {
    display: flex;
    justify-content: center;
    gap: 24px;
}

.navbar__actions {
    /* 按钮组在右侧 */
    justify-self: end;
}

@media (max-width: 768px) {
    .navbar {
        grid-template-columns: 1fr auto;
    }
    .navbar__links {
        display: none; /* 移动端隐藏 */
    }
}
```

### 模式 5：等高卡片

Flexbox 做等高卡片需要额外处理，Grid 天然支持：

```css
.equal-height-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 24px;
}

.card {
    /* 所有卡片自动等高，不需要额外处理 */
    display: grid; /* 嵌套 Grid 做内部布局 */
    grid-template-rows: auto 1fr auto; /* 图片固定，内容自适应，按钮固定底部 */
}
```

## Grid vs Flexbox：到底用哪个？

| 场景 | 推荐 | 原因 |
|------|------|------|
| 一维排列（行或列） | Flexbox | 简单直接 |
| 二维布局（行+列） | Grid | 精确控制 |
| 内容优先（不确定大小） | Flexbox | 灵活分配 |
| 布局优先（确定结构） | Grid | 结构清晰 |
| 组件内部对齐 | Flexbox | 简单 |
| 页面级布局 | Grid | 强大 |

**实际开发中，两者往往配合使用：Grid 负责页面级布局，Flexbox 负责组件内部对齐。**

## 浏览器兼容性（2021 年）

| 浏览器 | 支持版本 |
|--------|----------|
| Chrome | 57+ |
| Firefox | 52+ |
| Safari | 10.1+ |
| Edge | 16+ |
| IE | 11（部分支持，语法不同） |

**2021 年，Grid 的兼容性已经完全不需要担心。** 唯一需要注意的是 IE 的旧语法，但除非你要支持 IE11，否则可以忽略。

## 实用技巧

### 1. 命名网格线

```css
.layout {
    display: grid;
    grid-template-columns: [sidebar-start] 250px [sidebar-end content-start] 1fr [content-end];
}

.sidebar {
    grid-column: sidebar-start / sidebar-end;
}
```

### 2. 隐式网格

当内容超出预定义的行数时，Grid 会自动创建新的行：

```css
.container {
    display: grid;
    grid-template-rows: auto auto; /* 只定义了两行 */
    /* 第三个及以后的项目会自动创建新的行 */
    grid-auto-rows: min-content; /* 新行的最小高度 */
}
```

### 3. 对齐方式

```css
.container {
    display: grid;
    /* 整个网格在容器中的对齐 */
    justify-content: center; /* 水平居中 */
    align-content: center;   /* 垂直居中 */

    /* 网格项在各自单元格中的对齐 */
    justify-items: center;
    align-items: center;
}

.item {
    /* 单个网格项覆盖容器的对齐设置 */
    justify-self: end;
    align-self: start;
}
```

## 总结

CSS Grid 不是一个需要死记硬背的属性集合，而是一种**布局思维方式**的转变：

1. 从"浮动 + 定位"到"二维网格"
2. 从"计算宽度"到"比例分配"
3. 从"媒体查询堆砌"到"自适应网格"
4. 从"HTML 决定布局"到"CSS 控制结构"

一旦你接受了这种思维方式，你会发现很多之前需要几十行代码才能实现的布局，现在只需要几行 CSS。
