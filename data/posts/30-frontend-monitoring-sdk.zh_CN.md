---
title: "前端监控 SDK 从零实现：错误捕获与上报实战"
tag: engineering
description: 从零开始实现一个前端监控 SDK，涵盖错误捕获、性能监控和数据上报的完整流程。
date: "2022-09-18T08:00:00.000Z"
---

## 目标

在生产环境中，前端应用的稳定性至关重要。当用户遇到页面崩溃、功能异常或性能问题时，我们需要第一时间获取错误信息并定位问题。本文将从零开始，实现一个完整的前端监控 SDK，包括错误捕获、性能数据采集和数据上报机制。

## 背景

### 为什么需要前端监控

1. **用户体验保障**：及时发现并修复影响用户体验的问题
2. **性能优化依据**：收集真实用户的性能数据
3. **故障快速定位**：减少问题排查时间
4. **数据驱动决策**：基于监控数据优化产品

### 监控的核心能力

一个完整的前端监控系统应该包含：

- **错误监控**：JavaScript 错误、资源加载失败、Promise 异常
- **性能监控**：页面加载时间、资源加载时间、API 响应时间
- **行为监控**：用户点击、页面访问、路由切换
- **环境信息**：浏览器、操作系统、网络状态、设备信息

## SDK 架构设计

```javascript
// monitor-sdk/src/index.js
class FrontendMonitor {
  constructor(config = {}) {
    this.config = {
      dsn: '',                    // 数据上报地址
      appId: '',                  // 应用 ID
      sampleRate: 1,              // 采样率
      maxQueueSize: 100,          // 最大队列长度
      flushInterval: 5000,        // 上报间隔
      enablePerformance: true,    // 是否启用性能监控
      enableBehavior: true,       // 是否启用行为监控
      enableConsole: false,       // 是否监控 console
      enableWhiteScreen: true,    // 是否启用白屏检测
      ...config
    }
    
    this.errorQueue = []
    this.performanceQueue = []
    this.behaviorQueue = []
    this.timer = null
    
    this.init()
  }
  
  init() {
    this.initErrorMonitor()
    this.initPerformanceMonitor()
    this.initBehaviorMonitor()
    this.startReportTimer()
    
    // 页面卸载时上报剩余数据
    window.addEventListener('beforeunload', () => {
      this.flush()
    })
  }
}
```

## 错误捕获模块

### JavaScript 错误捕获

```javascript
class FrontendMonitor {
  initErrorMonitor() {
    // 1. 捕获同步错误
    window.onerror = (message, source, lineno, colno, error) => {
      this.captureError({
        type: 'js_error',
        message,
        source,
        lineno,
        colno,
        stack: error?.stack,
        timestamp: Date.now()
      })
      return false // 阻止默认错误处理
    }
    
    // 2. 捕获未处理的 Promise 异常
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason
      this.captureError({
        type: 'promise_error',
        message: error?.message || String(error),
        stack: error?.stack,
        timestamp: Date.now()
      })
    })
    
    // 3. 捕获 Vue/React 框架错误（以 Vue 3 为例）
    if (window.__VUE__) {
      app.config.errorHandler = (err, instance, info) => {
        this.captureError({
          type: 'framework_error',
          message: err.message,
          stack: err.stack,
          info,
          componentName: instance?.name,
          timestamp: Date.now()
        })
      }
    }
  }
  
  captureError(errorInfo) {
    // 采样检查
    if (Math.random() > this.config.sampleRate) return
    
    // 去重检查
    if (this.isDuplicateError(errorInfo)) return
    
    // 补充环境信息
    const enrichedError = {
      ...errorInfo,
      ...this.getEnvironmentInfo(),
      url: window.location.href,
      userAgent: navigator.userAgent
    }
    
    this.errorQueue.push(enrichedError)
    
    // 超过队列大小限制时立即上报
    if (this.errorQueue.length >= this.config.maxQueueSize) {
      this.flush()
    }
  }
  
  isDuplicateError(error) {
    const lastError = this.errorQueue[this.errorQueue.length - 1]
    if (!lastError) return false
    
    return (
      lastError.message === error.message &&
      lastError.source === error.source &&
      lastError.lineno === error.lineno &&
      Date.now() - lastError.timestamp < 1000
    )
  }
}
```

### 资源加载错误捕获

```javascript
class FrontendMonitor {
  initResourceMonitor() {
    // 监听资源加载错误
    window.addEventListener('error', (event) => {
      const target = event.target
      
      // 只处理资源加载错误
      if (target !== window) {
        this.captureError({
          type: 'resource_error',
          source: target.src || target.href,
          tagName: target.tagName,
          timestamp: Date.now()
        })
      }
    }, true)
    
    // 监听资源性能数据
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.transferSize === 0 && entry.decodedBodySize > 0) {
          // 缓存命中，不处理
          continue
        }
        
        this.capturePerformance({
          type: 'resource',
          name: entry.name,
          duration: entry.duration,
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize
        })
      }
    })
    
    observer.observe({ entryTypes: ['resource'] })
  }
}
```

### console 监控

```javascript
class FrontendMonitor {
  initConsoleMonitor() {
    if (!this.config.enableConsole) return
    
    const originalConsole = {}
    const methods = ['log', 'warn', 'error', 'info']
    
    methods.forEach(method => {
      originalConsole[method] = console[method]
      
      console[method] = (...args) => {
        // 调用原始方法
        originalConsole[method].apply(console, args)
        
        // 上报 console 数据
        this.captureBehavior({
          type: 'console',
          method,
          args: args.map(arg => {
            try {
              return typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
            } catch {
              return '[Unserializable]'
            }
          }).join(' '),
          timestamp: Date.now()
        })
      }
    })
  }
}
```

## 性能监控模块

### 页面加载性能

```javascript
class FrontendMonitor {
  initPerformanceMonitor() {
    if (!this.config.enablePerformance) return
    
    // 等待页面加载完成
    window.addEventListener('load', () => {
      // 延迟收集，确保所有性能数据已记录
      setTimeout(() => {
        this.collectPagePerformance()
        this.collectWebVitals()
      }, 1000)
    })
  }
  
  collectPagePerformance() {
    const timing = performance.timing
    const navigation = performance.getEntriesByType('navigation')[0]
    
    if (navigation) {
      this.capturePerformance({
        type: 'page_load',
        // DNS 查询时间
        dns: navigation.domainLookupEnd - navigation.domainLookupStart,
        // TCP 连接时间
        tcp: navigation.connectEnd - navigation.connectStart,
        // 请求响应时间
        ttfb: navigation.responseStart - navigation.requestStart,
        // 内容下载时间
        contentDownload: navigation.responseEnd - navigation.responseStart,
        // DOM 解析时间
        domParse: navigation.domInteractive - navigation.responseEnd,
        // DOM 完成时间
        domComplete: navigation.domComplete - navigation.domInteractive,
        // 页面完全加载时间
        loadComplete: navigation.loadEventEnd - navigation.startTime,
        // 首次渲染时间
        firstPaint: this.getFirstPaint()
      })
    }
  }
  
  getFirstPaint() {
    const entries = performance.getEntriesByType('paint')
    const fp = entries.find(e => e.name === 'first-paint')
    return fp ? fp.startTime : 0
  }
}
```

### Web Vitals 核心指标

```javascript
class FrontendMonitor {
  collectWebVitals() {
    // Largest Contentful Paint (LCP)
    this.observeLCP()
    
    // First Input Delay (FID)
    this.observeFID()
    
    // Cumulative Layout Shift (CLS)
    this.observeCLS()
    
    // Interaction to Next Paint (INP) - React 18 新增
    this.observeINP()
  }
  
  observeLCP() {
    let lcpValue = 0
    
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      const lastEntry = entries[entries.length - 1]
      lcpValue = lastEntry.startTime
    })
    
    observer.observe({ type: 'largest-contentful-paint', buffered: true })
    
    // 页面离开时上报
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.capturePerformance({
          type: 'web_vital',
          metric: 'LCP',
          value: lcpValue,
          rating: this.getLCPRating(lcpValue)
        })
        observer.disconnect()
      }
    })
  }
  
  observeFID() {
    const observer = new PerformanceObserver((list) => {
      const firstInput = list.getEntries()[0]
      
      this.capturePerformance({
        type: 'web_vital',
        metric: 'FID',
        value: firstInput.processingStart - firstInput.startTime,
        rating: this.getFIDRating(firstInput.processingStart - firstInput.startTime)
      })
    })
    
    observer.observe({ type: 'first-input', buffered: true })
  }
  
  observeCLS() {
    let clsValue = 0
    let sessionValue = 0
    let sessionEntries = []
    
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          const firstEntry = sessionEntries[0]
          const lastEntry = sessionEntries[sessionEntries.length - 1]
          
          if (sessionValue && entry.startTime - lastEntry.startTime < 1000 && entry.startTime - firstEntry.startTime < 5000) {
            sessionValue += entry.value
            sessionEntries.push(entry)
          } else {
            sessionValue = entry.value
            sessionEntries = [entry]
          }
          
          if (sessionValue > clsValue) {
            clsValue = sessionValue
          }
        }
      }
    })
    
    observer.observe({ type: 'layout-shift', buffered: true })
    
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.capturePerformance({
          type: 'web_vital',
          metric: 'CLS',
          value: clsValue,
          rating: this.getCLSRating(clsValue)
        })
        observer.disconnect()
      }
    })
  }
  
  getLCPRating(value) {
    if (value <= 2500) return 'good'
    if (value <= 4000) return 'needs-improvement'
    return 'poor'
  }
  
  getFIDRating(value) {
    if (value <= 100) return 'good'
    if (value <= 300) return 'needs-improvement'
    return 'poor'
  }
  
  getCLSRating(value) {
    if (value <= 0.1) return 'good'
    if (value <= 0.25) return 'needs-improvement'
    return 'poor'
  }
}
```

## 数据上报模块

### 上报策略

```javascript
class FrontendMonitor {
  startReportTimer() {
    this.timer = setInterval(() => {
      this.flush()
    }, this.config.flushInterval)
  }
  
  flush() {
    // 上报错误数据
    if (this.errorQueue.length > 0) {
      this.report('error', [...this.errorQueue])
      this.errorQueue = []
    }
    
    // 上报性能数据
    if (this.performanceQueue.length > 0) {
      this.report('performance', [...this.performanceQueue])
      this.performanceQueue = []
    }
    
    // 上报行为数据
    if (this.behaviorQueue.length > 0) {
      this.report('behavior', [...this.behaviorQueue])
      this.behaviorQueue = []
    }
  }
  
  async report(type, data) {
    if (!this.config.dsn) {
      console.warn('[Monitor] DSN not configured')
      return
    }
    
    const payload = {
      type,
      data,
      appId: this.config.appId,
      timestamp: Date.now(),
      traceId: this.generateTraceId()
    }
    
    try {
      // 优先使用 sendBeacon
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon(this.config.dsn, blob)
      } else {
        // 降级到 fetch
        await fetch(this.config.dsn, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        })
      }
    } catch (error) {
      console.error('[Monitor] Report failed:', error)
      // 失败时重新加入队列
      this.errorQueue.push(...data)
    }
  }
  
  generateTraceId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}
```

### 离线数据缓存

```javascript
class FrontendMonitor {
  cacheOfflineData(data) {
    try {
      const cached = localStorage.getItem('monitor_offline_data') || '[]'
      const queue = JSON.parse(cached)
      
      queue.push(...data)
      
      // 限制缓存大小
      if (queue.length > this.config.maxQueueSize) {
        queue.splice(0, queue.length - this.config.maxQueueSize)
      }
      
      localStorage.setItem('monitor_offline_data', JSON.stringify(queue))
    } catch (error) {
      console.error('[Monitor] Cache offline data failed:', error)
    }
  }
  
  flushOfflineData() {
    try {
      const cached = localStorage.getItem('monitor_offline_data')
      if (cached) {
        const queue = JSON.parse(cached)
        if (queue.length > 0) {
          this.report('offline', queue)
          localStorage.removeItem('monitor_offline_data')
        }
      }
    } catch (error) {
      console.error('[Monitor] Flush offline data failed:', error)
    }
  }
}
```

## 白屏检测

```javascript
class FrontendMonitor {
  initWhiteScreenDetection() {
    if (!this.config.enableWhiteScreen) return
    
    // 方法 1：检测关键元素是否存在
    const checkElement = () => {
      const root = document.getElementById('root')
      const body = document.body
      
      if (!root || root.innerHTML.length === 0 || body.children.length <= 1) {
        this.captureError({
          type: 'white_screen',
          message: 'White screen detected',
          timestamp: Date.now()
        })
        return true
      }
      return false
    }
    
    // 页面加载后检测
    setTimeout(() => {
      if (!checkElement()) {
        // 持续监测
        const observer = new MutationObserver(() => {
          checkElement()
        })
        
        observer.observe(document.body, {
          childList: true,
          subtree: true
        })
      }
    }, 3000)
  }
}
```

## 使用示例

```javascript
// 初始化监控 SDK
const monitor = new FrontendMonitor({
  dsn: 'https://monitor.example.com/collect',
  appId: 'my-web-app',
  sampleRate: 0.5, // 50% 采样
  enablePerformance: true,
  enableBehavior: true
})

// 手动上报自定义错误
monitor.captureError({
  type: 'business_error',
  message: '支付失败',
  extra: {
    orderId: '123456',
    amount: 99.00
  }
})

// 手动上报性能数据
monitor.capturePerformance({
  type: 'custom',
  name: 'api_response_time',
  duration: 250,
  url: '/api/user/info'
})
```

## 总结

从零实现前端监控 SDK 涉及多个技术要点：

1. **错误捕获**：利用 window.onerror、unhandledrejection、PerformanceObserver 等 API
2. **性能监控**：收集 Core Web Vitals、页面加载时间等关键指标
3. **数据上报**：使用 sendBeacon + fetch 降级策略，确保数据可靠传输
4. **离线缓存**：利用 localStorage 缓存失败的数据，后续重试

一个完善的前端监控系统能够帮助团队快速定位问题、优化性能、提升用户体验，是现代前端工程化不可或缺的基础设施。
