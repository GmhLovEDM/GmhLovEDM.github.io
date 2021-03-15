---
title: "jQuery 还能再战十年吗？一个老粉的反思"
tag: jquery
description: 从 jQuery 的辉煌到如今被现代框架取代，这篇文章深度分析 jQuery 的核心价值、历史局限性以及它在 2021 年及以后的真实定位。
date: "2021-03-15T08:00:00.000Z"
---

## 目标

这篇文章要回答一个很多人关心但不愿正面回答的问题：**jQuery 在 2021 年还有学习和使用的价值吗？** 如果有，它的适用边界在哪里？如果没有，我们应该如何优雅地告别它？

## 背景

### jQuery 的辉煌时代

2006 年，John Resig 发布了 jQuery 1.0。那是一个前端开发的蛮荒时代——浏览器兼容性噩梦（IE6/7/8 各自为政）、DOM API 繁琐难用、AJAX 需要手动处理 `XMLHttpRequest` 的各种状态。

jQuery 用一句 "Write Less, Do More" 横空出世，几乎统一了前端开发的方式：

```javascript
// 2008 年，获取一个元素并绑定事件
$('#myButton').click(function() {
    $.ajax({
        url: '/api/data',
        success: function(data) {
            $('#result').html(data);
        }
    });
});
```

这段代码在当时简直是魔法。不需要考虑浏览器差异，不需要写一堆兼容性代码，一个 `$` 符号搞定一切。

### 为什么我会"反思"

作为一个从 jQuery 时代走过来的开发者，我曾经以为它会永远是前端的标配。但现实是：

1. **React、Vue、Angular 的崛起**让 jQuery 的操作 DOM 思维模式变得过时
2. **ES6+ 的原生 API** 拾回了大量 jQuery 曾经填补的能力
3. **TypeScript 的普及**让 jQuery 的动态类型设计显得格格不入
4. **构建工具的标准化**让 jQuery 的" script 标签引入"方式不再主流

## 深度分析：jQuery 的核心价值

### 1. 选择器引擎 Sizzle

jQuery 最核心的贡献之一是 **Sizzle 选择器引擎**。它在 CSS 选择器被浏览器原生支持之前，就实现了完整的 CSS 选择器查询。

```javascript
// jQuery 选择器（2006 年就能用）
$('ul > li:first-child');
$('[data-type="user"]:not(.admin)');
```

但现代浏览器已经原生支持 `querySelector` 和 `querySelectorAll`：

```javascript
// 原生 JS（2021 年完全可以替代）
document.querySelectorAll('ul > li:first-child');
document.querySelectorAll('[data-type="user"]:not(.admin)');
```

**结论：选择器能力已被原生 API 追平。**

### 2. AJAX 封装

jQuery 的 `$.ajax()` 曾经是前端发请求的事实标准。它统一了不同浏览器的 `XMLHttpRequest` 实现差异。

```javascript
// jQuery AJAX
$.ajax({
    url: '/api/users',
    method: 'GET',
    dataType: 'json',
    success: function(data) { /* ... */ },
    error: function(xhr, status, error) { /* ... */ }
});
```

但 `fetch` API 已经成为 W3C 标准，所有现代浏览器都支持：

```javascript
// 原生 fetch
fetch('/api/users')
    .then(res => res.json())
    .then(data => { /* ... */ })
    .catch(error => { /* ... */ });

// 或者用 async/await 更优雅
async function getUsers() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();
    } catch (error) {
        // handle error
    }
}
```

**结论：fetch + Promise 已经比 jQuery AJAX 更现代、更灵活。**

### 3. DOM 操作

这是 jQuery 最后也是最顽固的阵地。它的链式调用、批量操作确实优雅：

```javascript
$('#list')
    .addClass('active')
    .find('li')
    .eq(0)
    .css('color', 'red')
    .end()
    .animate({ opacity: 0.5 }, 500);
```

但这种命令式的 DOM 操作方式本身就是问题所在。现代框架的核心理念是**声明式渲染**——你只需描述状态，框架自动更新 DOM：

```html
<!-- Vue 3 -->
<template>
  <ul :class="{ active: isActive }">
    <li v-for="(item, index) in list" :key="item.id" :style="{ color: index === 0 ? 'red' : '' }">
      {{ item.name }}
    </li>
  </ul>
</template>
```

## jQuery 在 2021 年的真实定位

### 仍然适合的场景

1. **遗留项目维护**：大量企业级项目仍在使用 jQuery，贸然重构成本极高
2. **简单的静态页面**：纯展示型网站、落地页，不需要 SPA 的复杂度
3. **WordPress 插件开发**：WordPress 生态仍然重度依赖 jQuery
4. **jQuery 插件生态**：如 DataTable、Slick Carousel 等成熟插件

### 不再适合的场景

1. **中大型 SPA 应用**：状态管理、组件化、路由等能力 jQuery 不具备
2. **移动端开发**：jQuery 的 DOM 操作模式对性能不友好
3. **TypeScript 项目**：jQuery 的类型定义不够完善
4. **SSR/SSG 需求**：jQuery 依赖 DOM，在 Node.js 环境无法使用

## 一个有趣的实验：jQuery 能做的事，原生 JS 需要多少行？

让我们对比一些常见操作：

### 淡入效果

```javascript
// jQuery
$('#el').fadeIn(300);

// 原生 JS（需要更多代码）
function fadeIn(el, duration) {
    el.style.opacity = 0;
    el.style.display = 'block';
    el.style.transition = `opacity ${duration}ms`;
    requestAnimationFrame(() => {
        el.style.opacity = 1;
    });
}
```

### 事件委托

```javascript
// jQuery
$(document).on('click', '.dynamic-item', function() { /* ... */ });

// 原生 JS
document.addEventListener('click', function(e) {
    if (e.target.closest('.dynamic-item')) {
        // handle
    }
});
```

可以看到，jQuery 确实更简洁，但原生 JS 的能力已经完全覆盖。**多写几行代码换来的是零依赖和更好的性能**，这笔账在 2021 年是划算的。

## 我的建议

### 对于新手开发者

**不要从 jQuery 开始学起。** 直接学习现代 JavaScript（ES6+）和一个主流框架（Vue/React）。jQuery 的思维模式（操作 DOM）和现代前端的核心理念（数据驱动）是不同的方向。

### 对于有经验的开发者

1. **不要在新项目中引入 jQuery**——除非有明确的理由（如必须使用某个 jQuery 插件）
2. **学会原生 JS 的替代方案**——`fetch`、`querySelector`、`classList`、`IntersectionObserver` 等
3. **如果维护老项目**，不必急于移除 jQuery，但可以逐步用原生 API 替换

### 一个务实的迁移策略

```javascript
// 步骤 1：逐步替换选择器
// Before
const $el = $('.my-class');
// After
const el = document.querySelector('.my-class');

// 步骤 2：替换 AJAX
// Before
$.get('/api/data', callback);
// After
fetch('/api/data').then(res => res.json()).then(callback);

// 步骤 3：替换 DOM 操作
// Before
$el.addClass('active').text('Hello');
// After
el.classList.add('active');
el.textContent = 'Hello';

// 步骤 4：移除 jQuery 引用
```

## 结论

jQuery 还能再战十年吗？**作为一个库，它可以继续维护和使用，但它不会再成为前端开发的主流。** 就像 jQuery 淘汰了 Prototype.js 和 MooTools 一样，时代的车轮已经向前。

jQuery 的历史贡献不可磨灭——它教会了整个行业什么叫"开发者体验"，什么叫"链式调用"，什么叫"插件生态"。这些思想深深影响了后来的每一个前端框架。

但 2021 年的前端开发，需要的是组件化、声明式、类型安全、工程化。jQuery 是一个优秀的工具，但它是上一个时代的工具。

**致敬 jQuery，然后继续前行。**
