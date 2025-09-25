---
title: "Frontend Observability: Implementing OpenTelemetry in the Frontend"
tag: engineering
description: Exploring the complete frontend observability solution, covering OpenTelemetry integration, performance monitoring, error tracking, and user behavior analysis
date: "2025-09-25T10:00:00.000Z"
---

## Goal

Frontend monitoring has long been stuck at the "error reporting" level, lacking a systematic observability approach. OpenTelemetry, the CNCF observability standard, is extending from the backend to the frontend. This article introduces how to implement OpenTelemetry in the frontend to build a complete observability system.

## Background

### Limitations of Traditional Frontend Monitoring

| Tool | Capability | Limitation |
|------|-----------|------------|
| Sentry | Error tracking | Only focuses on errors, lacks performance data |
| Google Analytics | User behavior | Cannot correlate with technical metrics |
| Lighthouse | Performance score | Static testing, doesn't reflect real users |

### OpenTelemetry's Advantages

OpenTelemetry provides a unified observability framework:

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
└────────────────────────┼────────────────────────────────┘
              ┌──────────▼──────────┐
              │   Collector (OTLP)  │
              └─────────────────────┘
```

## Frontend OpenTelemetry Implementation

### Initialization

```typescript
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

### Auto-Instrumentation

```typescript
import { trace, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('fetch-instrumentation');

const originalFetch = window.fetch;

window.fetch = async function patchedFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.url;
  const method = init?.method || 'GET';

  return tracer.startActiveSpan(
    `HTTP ${method}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { 'http.url': url, 'http.method': method, 'http.target': new URL(url, window.location.origin).pathname },
    },
    async (span) => {
      try {
        const response = await originalFetch.call(this, input, init);
        span.setAttribute('http.status_code', response.status);
        span.setAttribute('http.status_text', response.statusText);
        if (!response.ok) span.setStatus({ code: 2 });
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
```

### React Performance Tracing

```typescript
import React, { useEffect, useRef } from 'react';
import { trace, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('react-components');

export function withTracing<P>(Component: React.ComponentType<P>, componentName: string): React.ComponentType<P> {
  return function TracedComponent(props: P) {
    const renderStart = performance.now();

    useEffect(() => {
      const renderDuration = performance.now() - renderStart;
      const span = tracer.startSpan(`React Render: ${componentName}`, {
        kind: SpanKind.INTERNAL,
        attributes: { 'react.component': componentName, 'react.render.duration_ms': renderDuration },
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
      attributes: { 'react.component': componentName, 'react.render.count': renderCount.current, 'react.render.since_last_ms': sinceLastRender },
    });
    span.end();
  });
}
```

### Core Web Vitals Collection

```typescript
import { trace, metrics } from '@opentelemetry/api';

const tracer = trace.getTracer('web-vitals');
const meter = metrics.getMeter('web-vitals');

const lcpHistogram = meter.createHistogram('web.vitals.lcp', { description: 'Largest Contentful Paint', unit: 'ms' });
const inpHistogram = meter.createHistogram('web.vitals.inp', { description: 'Interaction to Next Paint', unit: 'ms' });
const clsHistogram = meter.createHistogram('web.vitals.cls', { description: 'Cumulative Layout Shift', unit: '1' });
const fcpHistogram = meter.createHistogram('web.vitals.fcp', { description: 'First Contentful Paint', unit: 'ms' });

export function observeWebVitals() {
  const lcpObserver = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const lastEntry = entries[entries.length - 1] as PerformanceEntry;
    lcpHistogram.record(lastEntry.startTime);
    const span = tracer.startSpan('Web Vitals: LCP', { attributes: { 'web.vitals.lcp': lastEntry.startTime } });
    span.end();
  });
  lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });

  const clsObserver = new PerformanceObserver((list) => {
    let clsValue = 0;
    for (const entry of list.getEntries()) {
      if (!(entry as any).hadRecentInput) clsValue += (entry as any).value;
    }
    clsHistogram.record(clsValue);
  });
  clsObserver.observe({ type: 'layout-shift', buffered: true });

  const fcpObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') fcpHistogram.record(entry.startTime);
    }
  });
  fcpObserver.observe({ type: 'paint', buffered: true });
}
```

## Advanced Features

### User Session Tracking

```typescript
import { trace, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('user-session');

class UserSession {
  private sessionId: string;
  private span: any;

  constructor() {
    this.sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.span = tracer.startSpan('User Session', {
      kind: SpanKind.SESSION,
      attributes: { 'session.id': this.sessionId, 'user.agent': navigator.userAgent, 'screen.width': window.screen.width, 'screen.height': window.screen.height },
    });
  }

  trackPageView(page: string) {
    const span = tracer.startSpan('Page View', { parent: this.span.spanContext(), attributes: { 'page.url': window.location.href, 'page.name': page } });
    span.end();
  }

  trackInteraction(action: string, target: string) {
    const span = tracer.startSpan('User Interaction', { parent: this.span.spanContext(), attributes: { 'interaction.action': action, 'interaction.target': target } });
    span.end();
  }

  endSession() { this.span.end(); }
}

export const session = new UserSession();
```

### Error Boundary Tracking

```tsx
import React, { Component, ErrorInfo } from 'react';
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('error-boundary');

export class ErrorBoundary extends Component<{ children: React.ReactNode; fallback?: React.ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: React.ReactNode; fallback?: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const span = tracer.startSpan('React Error Boundary', {
      attributes: { 'error.message': error.message, 'error.stack': error.stack || '', 'error.component_stack': errorInfo.componentStack || '' },
    });
    span.setStatus({ code: 2, message: error.message });
    span.end();
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) return this.props.fallback || <div>Error</div>;
    return this.props.children;
  }
}
```

## Summary

The complete frontend observability solution:

1. **Traces**: Track request chains, component renders, and user interactions.
2. **Metrics**: Collect performance metrics, error rates, and user behavior.
3. **Logs**: Record key events and error details.
4. **OpenTelemetry**: Unified observability standard connecting frontend and backend data.

Implementing OpenTelemetry in the frontend requires:
- Auto-instrumentation to reduce development cost.
- Custom Spans to enrich context information.
- Correlation with backend Traces for end-to-end tracing.
- Integration with tools like Grafana for visual analysis.

Frontend observability is critical infrastructure for improving product quality and is worth investing in.