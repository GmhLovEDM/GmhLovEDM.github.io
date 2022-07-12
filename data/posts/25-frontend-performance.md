---
title: "Frontend Performance Optimization Checklist: From 3s to 1s First Screen Load"
tag: performance
description: From a complete frontend performance optimization checklist to practical cases, sharing specific methods to reduce first screen load time from 3 seconds to 1 second.
date: "2022-07-12T08:00:00.000Z"
---

## Goal

Master the core methods of frontend performance optimization and reduce first screen load time from 3 seconds to under 1 second.

## Background

### Why Is Performance Important?

```
Google's research data:
- Page load time from 1s to 3s, bounce rate increases 32%
- Page load time from 1s to 5s, bounce rate increases 90%
- Page load time from 1s to 10s, bounce rate increases 123%

Every 100ms delay, conversion rate drops 1%
```

### Performance Metrics

| Metric | Full Name | Meaning | Target |
|--------|-----------|---------|--------|
| FCP | First Contentful Paint | First content paint | < 1.8s |
| LCP | Largest Contentful Paint | Largest content paint | < 2.5s |
| FID | First Input Delay | First input delay | < 100ms |
| CLS | Cumulative Layout Shift | Cumulative layout shift | < 0.1 |
| TTI | Time to Interactive | Time to interactive | < 3.8s |

## Optimization Checklist

### 1. Resource Optimization

#### Code Splitting

```javascript
// Route lazy loading
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

// Component lazy loading
const HeavyComponent = defineAsyncComponent(() =>
    import('@/components/HeavyComponent.vue')
)

// Dynamic import
const module = await import('./heavy-module.js')
```

#### Tree Shaking

```javascript
// Bad: import entire library
import _ from 'lodash'
_.debounce(fn, 300)

// Good: import only what's needed
import debounce from 'lodash/debounce'
debounce(fn, 300)

// Or use ES Module
import { debounce } from 'lodash-es'
```

#### Image Optimization

```html
<!-- Use WebP format -->
<picture>
    <source srcset="image.webp" type="image/webp">
    <img src="image.jpg" alt="Image">
</picture>

<!-- Responsive images -->
<img
    srcset="small.jpg 480w, medium.jpg 800w, large.jpg 1200w"
    sizes="(max-width: 600px) 480px, (max-width: 900px) 800px, 1200px"
    src="medium.jpg"
    alt="Responsive image"
>

<!-- Lazy loading -->
<img loading="lazy" src="image.jpg" alt="Lazy loaded image">
```

### 2. Build Optimization

#### Vite Configuration

```javascript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import compression from 'vite-plugin-compression'

export default defineConfig({
    plugins: [
        vue(),
        // Gzip compression
        compression({
            algorithm: 'gzip',
            ext: '.gz'
        }),
        // Brotli compression
        compression({
            algorithm: 'brotliCompress',
            ext: '.br'
        })
    ],
    build: {
        // Code splitting
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor: ['vue', 'vue-router', 'pinia'],
                    utils: ['lodash-es', 'axios']
                }
            }
        },
        // Enable CSS code splitting
        cssCodeSplit: true,
        // Generate sourcemap
        sourcemap: false
    }
})
```

#### Analyzing Build Results

```bash
# Install analysis tool
npm install rollup-plugin-visualizer --save-dev

# Configuration
import { visualizer } from 'rollup-plugin-visualizer'

plugins: [
    visualizer({
        open: true,
        gzipSize: true
    })
]
```

### 3. Network Optimization

#### HTTP Caching

```nginx
# nginx.conf

# Static resources: long-term caching
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# HTML: no caching
location ~* \.html$ {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
}
```

#### CDN Acceleration

```html
<!-- Use CDN -->
<script src="https://cdn.jsdelivr.net/npm/vue@3.2.0/dist/vue.global.prod.js"></script>

<!-- Preload critical resources -->
<link rel="preload" href="/fonts/main.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preconnect" href="https://cdn.example.com">
```

#### HTTP/2

```nginx
# nginx.conf
listen 443 ssl http2;
```

### 4. Rendering Optimization

#### Critical Rendering Path

```html
<head>
    <!-- Inline critical CSS -->
    <style>
        /* Minimum CSS needed for first screen */
        body { margin: 0; font-family: sans-serif; }
        .header { height: 64px; background: #fff; }
    </style>

    <!-- Async load non-critical CSS -->
    <link rel="preload" href="/styles/main.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
    <noscript><link rel="stylesheet" href="/styles/main.css"></noscript>
</head>
```

#### Avoid Layout Shift

```css
/* Set fixed dimensions for images */
img {
    width: 100%;
    height: auto;
    aspect-ratio: 16/9;
}

/* Reserve space for ads */
.ad-container {
    min-height: 250px;
}
```

#### Reduce Main Thread Work

```javascript
// Use Web Worker for complex calculations
const worker = new Worker('/worker.js')
worker.postMessage({ data: largeDataSet })
worker.onmessage = (e) => {
    console.log('Calculation result:', e.data)
}

// Use requestAnimationFrame for animations
function animate() {
    // Animation logic
    requestAnimationFrame(animate)
}
requestAnimationFrame(animate)

// Use setTimeout for non-critical tasks
setTimeout(() => {
    // Non-critical logic
}, 0)
```

## Practical Case: From 3s to 1s

### Before Optimization

```
Performance metrics:
- FCP: 2.8s
- LCP: 3.2s
- TTI: 4.1s
- Bundle size: 1.2MB (gzipped: 380KB)
```

### Optimization Steps

#### Step 1: Analyze the Problem

```bash
# Use Lighthouse for analysis
npx lighthouse https://example.com --output html

# Use Chrome DevTools Performance panel
# View loading waterfall
```

#### Step 2: Code Splitting

```javascript
// Before: all routes bundled together
import Home from '@/views/Home.vue'
import About from '@/views/About.vue'
import User from '@/views/User.vue'

// After: route lazy loading
const Home = () => import(/* webpackChunkName: "home" */ '@/views/Home.vue')
const About = () => import(/* webpackChunkName: "about" */ '@/views/About.vue')
const User = () => import(/* webpackChunkName: "user" */ '@/views/User.vue')
```

#### Step 3: Image Optimization

```html
<!-- Before -->
<img src="hero.jpg" alt="Hero">

<!-- After -->
<picture>
    <source srcset="hero.webp" type="image/webp">
    <img src="hero.jpg" alt="Hero" loading="lazy" width="1200" height="600">
</picture>
```

#### Step 4: Third-party Library Optimization

```javascript
// Before
import moment from 'moment'  // 200KB
moment().format()

// After
import dayjs from 'dayjs'  // 2KB
dayjs().format()
```

#### Step 5: Enable Compression

```nginx
# nginx.conf
gzip on;
gzip_types text/plain text/css application/json application/javascript text/xml;
gzip_min_length 1024;
```

### After Optimization

```
Performance metrics:
- FCP: 0.9s ✓ (reduced 68%)
- LCP: 1.1s ✓ (reduced 66%)
- TTI: 1.8s ✓ (reduced 56%)
- Bundle size: 420KB (gzipped: 120KB)
```

## Monitoring and Alerting

### 1. Performance Monitoring

```javascript
// Use Performance Observer
const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        if (entry.name === 'largest-contentful-paint') {
            console.log('LCP:', entry.startTime)
            // Report to monitoring system
        }
    }
})

observer.observe({ type: 'largest-contentful-paint', buffered: true })

// Monitor FID
const fidObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
        console.log('FID:', entry.processingStart - entry.startTime)
    }
})
fidObserver.observe({ type: 'first-input', buffered: true })
```

### 2. Performance Budget

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

## Common Pitfalls

### 1. Over-optimization

```
Don't optimize:
- Microscopic improvements imperceptible to users
- Optimizations that increase code complexity
- One-time performance issues

Worth optimizing:
- Core metrics affecting user experience
- Quantifiable performance improvements
- Long-term maintainable optimization solutions
```

### 2. Ignoring Mobile

```
Mobile characteristics:
- Unstable network
- Weaker CPU performance
- Limited memory

Optimization focus:
- Reduce bundle size
- Optimize image sizes
- Reduce JavaScript execution time
```

## Optimization Checklist

```markdown
## Frontend Performance Optimization Checklist

### Resource Loading
- [ ] Code splitting (route lazy loading)
- [ ] Image optimization (WebP, responsive)
- [ ] Third-party library on-demand import
- [ ] Font optimization (font-display: swap)

### Build Optimization
- [ ] Enable Gzip/Brotli compression
- [ ] Enable Tree Shaking
- [ ] Analyze bundle size
- [ ] Set performance budget

### Network Optimization
- [ ] Configure HTTP caching
- [ ] Use CDN
- [ ] Enable HTTP/2
- [ ] Preload critical resources

### Rendering Optimization
- [ ] Inline critical CSS
- [ ] Async load non-critical resources
- [ ] Avoid layout shift
- [ ] Reduce main thread work

### Monitoring Alerting
- [ ] Performance metrics monitoring
- [ ] Set performance budget
- [ ] Regular performance audits
```

## Summary

1. **Performance optimization is a systematic engineering**: Needs comprehensive consideration from multiple dimensions
2. **Data-driven optimization**: Measure first, then optimize
3. **User experience priority**: Focus on user-perceived performance metrics
4. **Continuous optimization**: Performance optimization is not a one-time task
5. **Monitoring is important**: No optimization without monitoring

The core of performance optimization is **reducing user waiting time**. Every optimization point should be decided based on data and user perception.
