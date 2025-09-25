---
title: "前端可观测性：OpenTelemetry 在前端的落地"
tag: engineering
description: 探讨前端可观测性的完整方案，涵盖 OpenTelemetry 集成、性能监控、错误追踪与用户行为分析
date: "2025-09-25T10:00:00.000Z"
---

## 目标

前端监控长期停留在"错误上报"层面，缺乏系统性的可观测性方案。OpenTelemetry 作为 CNCF 的可观测性标准，正在从后端延伸到前端。本文将介绍如何在前端落地 OpenTelemetry，构建完整的可观测性体系。

## 背景

### 传统前端监控的局限

| 工具 | 能力 | 局限 |
|------|------|------|
| Sentry | 错误追踪 | 只关注错误，缺乏性能数据 |
| Google Analytics | 用户行为 | 无法关联技术指标 |
| Lighthouse | 性能评分 | 静态测试，无法反映真实用户 |

### OpenTelemetry 的优势

OpenTelemetry 提供了统一的可观测性框架：

```
┌─────────────────────────────────────────────────────────┐
│              OpenTelemetry Frontend                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Traces    │  │   Metrics   │  │    Logs     │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         └────────────────┼────────────────┘             │
│              ┌───────────▼───────────┐                  │
│              │     Exporter         │                  │
│              └──────────────────────┘                  │
│                        │                                │
└────────────────────────┼────────────────────────────────┘
              ┌──────────▼──────────┐
              │   Collector (OTLP)  │
              └─────────────────────┘
```

## 前端 OpenTelemetry 实现

### 初始化配置

```typescript
// telemetry/init.ts
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

export function initTelemetry() {
  const provider = new WebTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'my-web-app',
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || '1.0.0',
    }),
  });

  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_ENDPOINT || 'http://localhost:4318/v1/traces',
  });

  provider.addSpanProcessor(new BatchSpanProcessor(exporter, {
    maxQueueSize: 100,
    maxExportBatchSize: 10,
    scheduledDelayMillis: 5000,
  }));

  provider.register({
    contextManager: new ZoneContextManager(),
    propagator: new W3CTraceContextPropagator(),
  });

  return provider;
}
```

### 自动埋点

```typescript
// instrumentation/fetch.ts
import { trace, context, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('fetch-instrumentation');

const originalFetch = window.fetch;

window.fetch = async function patchedFetch(
  input: RequestInfo,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string' ? input : input.url;
  const method = init?.method || 'GET';

  return tracer.startActiveSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.url': url,
        'http.method': method,
        'http.target': new URL(url, window.location.origin).pathname,
      },
    },
    async (span) => {
      try {
        const response = await originalFetch.call(this, input, init);
        
        span.setAttribute('http.status_code', response.status);
        span.setAttribute('http.status_text', response.statusText);
        
        if (!response.ok) {
          span.setStatus({ code: 2 });
        }
        
        return response;
      } catch (error) {
        span.setStatus({ code: 2, message: (error as Error).message });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
};

const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function patchedOpen(
  method: string,
  url: string | URL,
  ...args: any[]
) {
  this.setAttribute('data-method', method);
  this.setAttribute('data-url', url.toString());
  return originalXHROpen.call(this, method, url, ...args);
};

XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
  const method = this.getAttribute('data-method');
  const url = this.getAttribute('data-url');

  const span = tracer.startSpan(`XHR ${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'http.url': url || '',
      'http.method': method || '',
    },
  });

  this.addEventListener('load', () => {
    span.setAttribute('http.status_code', this.status);
    span.end();
  });

  this.addEventListener('error', () => {
    span.setStatus({ code: 2, message: 'Network error' });
    span.end();
  });

  return originalXHRSend.call(this, body);
};
```

### React 性能追踪

```typescript
// instrumentation/react.tsx
import React, { useEffect, useRef } from 'react';
import { trace, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('react-components');

export function withTracing<P>(
  Component: React.ComponentType<P>,
  componentName: string
): React.ComponentType<P> {
  return function TracedComponent(props: P) {
    const renderStart = performance.now();

    useEffect(() => {
      const renderDuration = performance.now() - renderStart;
      
      const span = tracer.startSpan(`React Render: ${componentName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'react.component': componentName,
          'react.render.duration_ms': renderDuration,
        },
      });
      span.end();
    }, []);

    return <Component {...props} />;
  };
}

export function useRenderTracking(componentName: string) {
  const renderCount = useRef(0);
  const lastRenderTime = useRef(performance.now());

  useEffect(() => {
    const now = performance.now();
    const sinceLastRender = now - lastRenderTime.current;
    
    renderCount.current++;
    lastRenderTime.current = now;

    const span = tracer.startSpan(`React Render: ${componentName}`, {
      attributes: {
        'react.component': componentName,
        'react.render.count': renderCount.current,
        'react.render.since_last_ms': sinceLastRender,
      },
    });
    span.end();
  });
}
```

### Core Web Vitals 采集

```typescript
// instrumentation/web-vitals.ts
import { trace, metrics } from '@opentelemetry/api';

const tracer = trace.getTracer('web-vitals');
const meter = metrics.getMeter('web-vitals');

const lcpHistogram = meter.createHistogram('web.vitals.lcp', {
  description: 'Largest Contentful Paint',
  unit: 'ms',
});

const inpHistogram = meter.createHistogram('web.vitals.inp', {
  description: 'Interaction to Next Paint',
  unit: 'ms',
});

const clsHistogram = meter.createHistogram('web.vitals.cls', {
  description: 'Cumulative Layout Shift',
  unit: '1',
});

const fcpHistogram = meter.createHistogram('web.vitals.fcp', {
  description: 'First Contentful Paint',
  unit: 'ms',
});

export function observeWebVitals() {
  const lcpObserver = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1] as PerformanceEntry;
    lcpHistogram.record(lastEntry.startTime);
    
    const span = tracer.startSpan('Web Vitals: LCP', {
      attributes: { 'web.vitals.lcp': lastEntry.startTime },
    });
    span.end();
  });
  lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

  const clsObserver = new PerformanceObserver((list) => {
    let clsValue = 0;
    for (const entry of list.getEntries()) {
      if (!(entry as any).hadRecentInput) {
        clsValue += (entry as any).value;
      }
    }
    clsHistogram.record(clsValue);
  });
  clsObserver.observe({ type: 'layout-shift', buffered: true });

  const fcpObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        fcpHistogram.record(entry.startTime);
      }
    }
  });
  fcpObserver.observe({ type: 'paint', buffered: true });
}
```

## 高级功能

### 用户会话追踪

```typescript
// telemetry/session.ts
import { trace, context, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('user-session');

class UserSession {
  private sessionId: string;
  private span: any;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.startSession();
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private startSession() {
    this.span = tracer.startSpan('User Session', {
      kind: SpanKind.SESSION,
      attributes: {
        'session.id': this.sessionId,
        'user.agent': navigator.userAgent,
        'screen.width': window.screen.width,
        'screen.height': window.screen.height,
      },
    });
  }

  trackPageView(page: string) {
    const span = tracer.startSpan('Page View', {
      parent: this.span.spanContext(),
      attributes: {
        'page.url': window.location.href,
        'page.name': page,
      },
    });
    span.end();
  }

  trackInteraction(action: string, target: string) {
    const span = tracer.startSpan('User Interaction', {
      parent: this.span.spanContext(),
      attributes: {
        'interaction.action': action,
        'interaction.target': target,
      },
    });
    span.end();
  }

  endSession() {
    this.span.end();
  }
}

export const session = new UserSession();
```

### 错误边界追踪

```tsx
// components/ErrorBoundary.tsx
import React, { Component, ErrorInfo } from 'react';
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('error-boundary');

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const span = tracer.startSpan('React Error Boundary', {
      attributes: {
        'error.message': error.message,
        'error.stack': error.stack || '',
        'error.component_stack': errorInfo.componentStack || '',
      },
    });
    span.setStatus({ code: 2, message: error.message });
    span.end();

    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || <div>出错了</div>;
    }
    return this.props.children;
  }
}
```

## 总结

前端可观测性的完整方案：

1. **Traces**：追踪请求链路、组件渲染、用户交互
2. **Metrics**：采集性能指标、错误率、用户行为
3. **Logs**：记录关键事件和错误详情
4. **OpenTelemetry**：统一的可观测性标准，前后端数据打通

OpenTelemetry 在前端的落地需要：
- 自动埋点减少开发成本
- 自定义 Span 丰富上下文信息
- 与后端 Trace 关联，实现全链路追踪
- 结合 Grafana 等工具进行可视化分析

前端可观测性是提升产品质量的重要基础设施，值得投入资源建设。