---
title: "Building a Front-End Monitoring SDK from Scratch: Error Capture and Reporting"
tag: engineering
description: 从零开始实现一个前端监控 SDK，涵盖错误捕获、性能监控和数据上报的完整流程。
date: "2022-09-18T08:00:00.000Z"
---

## Goal

In production environments, the stability of front-end applications is critical. When users encounter page crashes, feature malfunctions, or performance issues, we need to capture error information and locate the problem as quickly as possible. This article walks through building a complete front-end monitoring SDK from scratch, covering error capture, performance data collection, and data reporting mechanisms.

## Background

### Why Front-End Monitoring Is Necessary

1. **User experience assurance**: Promptly discover and fix issues that impact user experience
2. **Performance optimization basis**: Collect real user performance data
3. **Rapid fault diagnosis**: Reduce problem investigation time
4. **Data-driven decisions**: Optimize the product based on monitoring data

### Core Capabilities of Monitoring

A complete front-end monitoring system should include:

- **Error monitoring**: JavaScript errors, resource loading failures, Promise exceptions
- **Performance monitoring**: Page load times, resource load times, API response times
- **Behavior monitoring**: User clicks, page visits, route transitions
- **Environment information**: Browser, operating system, network status, device info

## SDK Architecture Design

```javascript
// monitor-sdk/src/index.js
class FrontendMonitor {
  constructor(config = {}) {
    this.config = {
      dsn: '',                    // Data reporting endpoint
      appId: '',                  // Application ID
      sampleRate: 1,              // Sampling rate
      maxQueueSize: 100,          // Maximum queue length
      flushInterval: 5000,        // Reporting interval
      enablePerformance: true,    // Enable performance monitoring
      enableBehavior: true,       // Enable behavior monitoring
      enableConsole: false,       // Enable console monitoring
      enableWhiteScreen: true,    // Enable white screen detection
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
    
    // Flush remaining data when page unloads
    window.addEventListener('beforeunload', () => {
      this.flush()
    })
  }
}
```

## Error Capture Module

### JavaScript Error Capture

```javascript
class FrontendMonitor {
  initErrorMonitor() {
    // 1. Capture synchronous errors
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
      return false // Prevent default error handling
    }
    
    // 2. Capture unhandled Promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason
      this.captureError({
        type: 'promise_error',
        message: error?.message || String(error),
        stack: error?.stack,
        timestamp: Date.now()
      })
    })
    
    // 3. Capture framework errors (Vue 3 example)
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
    // Sampling check
    if (Math.random() > this.config.sampleRate) return
    
    // Deduplication check
    if (this.isDuplicateError(errorInfo)) return
    
    // Enrich with environment information
    const enrichedError = {
      ...errorInfo,
      ...this.getEnvironmentInfo(),
      url: window.location.href,
      userAgent: navigator.userAgent
    }
    
    this.errorQueue.push(enrichedError)
    
    // Flush immediately when queue exceeds size limit
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

### Resource Loading Error Capture

```javascript
class FrontendMonitor {
  initResourceMonitor() {
    // Listen for resource loading errors
    window.addEventListener('error', (event) => {
      const target = event.target
      
      // Only handle resource loading errors
      if (target !== window) {
        this.captureError({
          type: 'resource_error',
          source: target.src || target.href,
          tagName: target.tagName,
          timestamp: Date.now()
        })
      }
    }, true)
    
    // Listen for resource performance data
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.transferSize === 0 && entry.decodedBodySize > 0) {
          // Cache hit, skip
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

### Console Monitoring

```javascript
class FrontendMonitor {
  initConsoleMonitor() {
    if (!this.config.enableConsole) return
    
    const originalConsole = {}
    const methods = ['log', 'warn', 'error', 'info']
    
    methods.forEach(method => {
      originalConsole[method] = console[method]
      
      console[method] = (...args) => {
        // Call original method
        originalConsole[method].apply(console, args)
        
        // Report console data
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

## Performance Monitoring Module

### Page Load Performance

```javascript
class FrontendMonitor {
  initPerformanceMonitor() {
    if (!this.config.enablePerformance) return
    
    // Wait for page load to complete
    window.addEventListener('load', () => {
      // Delay collection to ensure all performance data has been recorded
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
        // DNS lookup time
        dns: navigation.domainLookupEnd - navigation.domainLookupStart,
        // TCP connection time
        tcp: navigation.connectEnd - navigation.connectStart,
        // Time to first byte
        ttfb: navigation.responseStart - navigation.requestStart,
        // Content download time
        contentDownload: navigation.responseEnd - navigation.responseStart,
        // DOM parsing time
        domParse: navigation.domInteractive - navigation.responseEnd,
        // DOM completion time
        domComplete: navigation.domComplete - navigation.domInteractive,
        // Page fully loaded time
        loadComplete: navigation.loadEventEnd - navigation.startTime,
        // First paint time
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

### Web Vitals Core Metrics

```javascript
class FrontendMonitor {
  collectWebVitals() {
    // Largest Contentful Paint (LCP)
    this.observeLCP()
    
    // First Input Delay (FID)
    this.observeFID()
    
    // Cumulative Layout Shift (CLS)
    this.observeCLS()
    
    // Interaction to Next Paint (INP)
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
    
    // Report when page becomes hidden
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

## Data Reporting Module

### Reporting Strategy

```javascript
class FrontendMonitor {
  startReportTimer() {
    this.timer = setInterval(() => {
      this.flush()
    }, this.config.flushInterval)
  }
  
  flush() {
    // Report error data
    if (this.errorQueue.length > 0) {
      this.report('error', [...this.errorQueue])
      this.errorQueue = []
    }
    
    // Report performance data
    if (this.performanceQueue.length > 0) {
      this.report('performance', [...this.performanceQueue])
      this.performanceQueue = []
    }
    
    // Report behavior data
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
      // Prefer sendBeacon
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
        navigator.sendBeacon(this.config.dsn, blob)
      } else {
        // Fallback to fetch
        await fetch(this.config.dsn, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        })
      }
    } catch (error) {
      console.error('[Monitor] Report failed:', error)
      // On failure, re-add data to queue
      this.errorQueue.push(...data)
    }
  }
  
  generateTraceId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}
```

### Offline Data Caching

```javascript
class FrontendMonitor {
  cacheOfflineData(data) {
    try {
      const cached = localStorage.getItem('monitor_offline_data') || '[]'
      const queue = JSON.parse(cached)
      
      queue.push(...data)
      
      // Limit cache size
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

## White Screen Detection

```javascript
class FrontendMonitor {
  initWhiteScreenDetection() {
    if (!this.config.enableWhiteScreen) return
    
    // Method 1: Check whether critical elements exist
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
    
    // Check after page loads
    setTimeout(() => {
      if (!checkElement()) {
        // Continue monitoring
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

## Usage Example

```javascript
// Initialize the monitoring SDK
const monitor = new FrontendMonitor({
  dsn: 'https://monitor.example.com/collect',
  appId: 'my-web-app',
  sampleRate: 0.5, // 50% sampling
  enablePerformance: true,
  enableBehavior: true
})

// Manually report custom errors
monitor.captureError({
  type: 'business_error',
  message: 'Payment failed',
  extra: {
    orderId: '123456',
    amount: 99.00
  }
})

// Manually report performance data
monitor.capturePerformance({
  type: 'custom',
  name: 'api_response_time',
  duration: 250,
  url: '/api/user/info'
})
```

## Summary

Building a front-end monitoring SDK from scratch involves several key technical areas:

1. **Error capture**: Leveraging APIs like window.onerror, unhandledrejection, and PerformanceObserver
2. **Performance monitoring**: Collecting Core Web Vitals, page load times, and other critical metrics
3. **Data reporting**: Using sendBeacon with fetch fallback strategy to ensure reliable data transmission
4. **Offline caching**: Using localStorage to cache failed data for subsequent retry

A well-implemented front-end monitoring system helps teams quickly locate issues, optimize performance, and improve user experience -- making it an indispensable piece of infrastructure for modern front-end engineering.
