---
title: "前端性能优化清单：首屏加载从 3s 降到 1s 的实战"
tag: performance
description: 从前端性能优化的完整清单到实战案例，分享将首屏加载时间从 3 秒降到 1 秒的具体方法。
date: "2022-07-12T08:00:00.000Z"
---

## 目标

掌握前端性能优化的核心方法，将首屏加载时间从 3 秒降低到 1 秒以内。

## 背景

### 为什么性能很重要？

```
Google 的研究数据：
- 页面加载时间从 1s 增加到 3s，跳出率增加 32%
- 页面加载时间从 1s 增加到 5s，跳出率增加 90%
- 页面加载时间从 1s 增加到 10s，跳出率增加 123%

每 100ms 的延迟，转化率下降 1%
```

### 性能指标

| 指标 | 全称 | 含义 | 目标值 |
|------|------|------|--------|
| FCP | First Contentful Paint | 首次内容绘制 | < 1.8s |
| LCP | Largest Contentful Paint | 最大内容绘制 | < 2.5s |
| FID | First Input Delay | 首次输入延迟 | < 100ms |
| CLS | Cumulative Layout Shift | 累积布局偏移 | < 0.1 |
| TTI | Time to Interactive | 可交互时间 | < 3.8s |

## 优化清单

### 1. 资源优化

#### 代码分割

```javascript
// 路由懒加载
const routes = [
    {
        path: '/',
        component: () => import('@/views/Home.vue')
    },
    {
        path: '/about',
        component: () => import('@/views/About.vue')
    }
]

// 组件懒加载
const HeavyComponent = defineAsyncComponent(() =>
    import('@/components/HeavyComponent.vue')
)

// 动态导入
const module = await import('./heavy-module.js')
```

#### Tree Shaking

```javascript
// 不好：导入整个库
import _ from 'lodash'
_.debounce(fn, 300)

// 好：只导入需要的
import debounce from 'lodash/debounce'
debounce(fn, 300)

// 或者使用 ES Module
import { debounce } from 'lodash-es'
```

#### 图片优化

```html
<!-- 使用 WebP 格式 -->
<picture>
    <source srcset="image.webp" type="image/webp">
    <img src="image.jpg" alt="图片">
</picture>

<!-- 响应式图片 -->
<img
    srcset="small.jpg 480w, medium.jpg 800w, large.jpg 1200w"
    sizes="(max-width: 600px) 480px, (max-width: 900px) 800px, 1200px"
    src="medium.jpg"
    alt="响应式图片"
>

<!-- 懒加载 -->
<img loading="lazy" src="image.jpg" alt="懒加载图片">
```

### 2. 构建优化

#### Vite 配置

```javascript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import compression from 'vite-plugin-compression'

export default defineConfig({
    plugins: [
        vue(),
        // Gzip 压缩
        compression({
            algorithm: 'gzip',
            ext: '.gz'
        }),
        // Brotli 压缩
        compression({
            algorithm: 'brotliCompress',
            ext: '.br'
        })
    ],
    build: {
        // 代码分割
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['vue', 'vue-router', 'pinia'],
                    utils: ['lodash-es', 'axios']
                }
            }
        },
        // 启用 CSS 代码分割
        cssCodeSplit: true,
        // 生成 sourcemap
        sourcemap: false
    }
})
```

#### 分析打包结果

```bash
# 安装分析工具
npm install rollup-plugin-visualizer --save-dev

# 配置
import { visualizer } from 'rollup-plugin-visualizer'

plugins: [
    visualizer({
        open: true,
        gzipSize: true
    })
]
```

### 3. 网络优化

#### HTTP 缓存

```nginx
# nginx.conf

# 静态资源：长期缓存
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# HTML：不缓存
location ~* \.html$ {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
}
```

#### CDN 加速

```html
<!-- 使用 CDN -->
<script src="https://cdn.jsdelivr.net/npm/vue@3.2.0/dist/vue.global.prod.js"></script>

<!-- 预加载关键资源 -->
<link rel="preload" href="/fonts/main.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preconnect" href="https://cdn.example.com">
```

#### HTTP/2

```nginx
# nginx.conf
listen 443 ssl http2;
```

### 4. 渲染优化

#### 关键渲染路径

```html
<head>
    <!-- 内联关键 CSS -->
    <style>
        /* 首屏需要的最小 CSS */
        body { margin: 0; font-family: sans-serif; }
        .header { height: 64px; background: #fff; }
    </style>

    <!-- 异步加载非关键 CSS -->
    <link rel="preload" href="/styles/main.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
    <noscript><link rel="stylesheet" href="/styles/main.css"></noscript>
</head>
```

#### 避免布局偏移

```css
/* 为图片设置固定尺寸 */
img {
    width: 100%;
    height: auto;
    aspect-ratio: 16/9;
}

/* 为广告预留空间 */
.ad-container {
    min-height: 250px;
}
```

#### 减少主线程工作

```javascript
// 使用 Web Worker 处理复杂计算
const worker = new Worker('/worker.js')
worker.postMessage({ data: largeDataSet })
worker.onmessage = (e) => {
    console.log('计算结果:', e.data)
}

// 使用 requestAnimationFrame 做动画
function animate() {
    // 动画逻辑
    requestAnimationFrame(animate)
}
requestAnimationFrame(animate)

// 使用 setTimeout 做非关键任务
setTimeout(() => {
    // 非关键逻辑
}, 0)
```

## 实战案例：从 3s 到 1s

### 优化前

```
性能指标：
- FCP: 2.8s
- LCP: 3.2s
- TTI: 4.1s
- 包体积: 1.2MB (gzipped: 380KB)
```

### 优化步骤

#### 第一步：分析问题

```bash
# 使用 Lighthouse 分析
npx lighthouse https://example.com --output html

# 使用 Chrome DevTools Performance 面板
# 查看加载瀑布图
```

#### 第二步：代码分割

```javascript
// 优化前：所有路由打包在一起
import Home from '@/views/Home.vue'
import About from '@/views/About.vue'
import User from '@/views/User.vue'

// 优化后：路由懒加载
const Home = () => import(/* webpackChunkName: "home" */ '@/views/Home.vue')
const About = () => import(/* webpackChunkName: "about" */ '@/views/About.vue')
const User = () => import(/* webpackChunkName: "user" */ '@/views/User.vue')
```

#### 第三步：图片优化

```html
<!-- 优化前 -->
<img src="hero.jpg" alt="Hero">

<!-- 优化后 -->
<picture>
    <source srcset="hero.webp" type="image/webp">
    <img src="hero.jpg" alt="Hero" loading="lazy" width="1200" height="600">
</picture>
```

#### 第四步：第三方库优化

```javascript
// 优化前
import moment from 'moment'  // 200KB
moment().format()

// 优化后
import dayjs from 'dayjs'  // 2KB
dayjs().format()
```

#### 第五步：启用压缩

```nginx
# nginx.conf
gzip on;
gzip_types text/plain text/css application/json application/javascript text/xml;
gzip_min_length 1024;
```

### 优化后

```
性能指标：
- FCP: 0.9s ✓ (降低 68%)
- LCP: 1.1s ✓ (降低 66%)
- TTI: 1.8s ✓ (降低 56%)
- 包体积: 420KB (gzipped: 120KB)
```

## 监控和告警

### 1. 性能监控

```javascript
// 使用 Performance Observer
const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        if (entry.name === 'largest-contentful-paint') {
            console.log('LCP:', entry.startTime)
            // 上报到监控系统
        }
    }
})

observer.observe({ type: 'largest-contentful-paint', buffered: true })

// 监控 FID
const fidObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        console.log('FID:', entry.processingStart - entry.startTime)
    }
})
fidObserver.observe({ type: 'first-input', buffered: true })
```

### 2. 性能预算

```json
// performance-budget.json
{
    "budgets": [
        {
            "type": "initial",
            "maximumWarning": "200kb",
            "maximumError": "300kb"
        },
        {
            "type": "bundle",
            "name": "vendor",
            "maximumWarning": "100kb",
            "maximumError": "150kb"
        }
    ]
}
```

## 常见误区

### 1. 过度优化

```
不要优化：
- 用户感知不到的微小提升
- 增加代码复杂度的优化
- 一次性的性能问题

值得优化：
- 影响用户体验的核心指标
- 可量化的性能提升
- 长期维护的优化方案
```

### 2. 忽略移动端

```
移动端的特点：
- 网络不稳定
- CPU 性能较弱
- 内存有限

优化重点：
- 减少包体积
- 优化图片大小
- 减少 JavaScript 执行时间
```

## 优化清单

```markdown
## 前端性能优化清单

### 资源加载
- [ ] 代码分割（路由懒加载）
- [ ] 图片优化（WebP、响应式）
- [ ] 第三方库按需导入
- [ ] 字体优化（font-display: swap）

### 构建优化
- [ ] 启用 Gzip/Brotli 压缩
- [ ] 启用 Tree Shaking
- [ ] 分析打包体积
- [ ] 设置性能预算

### 网络优化
- [ ] 配置 HTTP 缓存
- [ ] 使用 CDN
- [ ] 启用 HTTP/2
- [ ] 预加载关键资源

### 渲染优化
- [ ] 内联关键 CSS
- [ ] 异步加载非关键资源
- [ ] 避免布局偏移
- [ ] 减少主线程工作

### 监控告警
- [ ] 性能指标监控
- [ ] 设置性能预算
- [ ] 定期性能审计
```

## 总结

1. **性能优化是系统工程**：需要从多个维度综合考虑
2. **数据驱动优化**：先测量，再优化
3. **用户体验优先**：关注用户感知的性能指标
4. **持续优化**：性能优化不是一次性的任务
5. **监控很重要**：没有监控就没有优化

性能优化的核心是**减少用户等待的时间**。每一个优化点都应该基于数据和用户感知来决策。
