---
title: "Frontend Performance Monitoring: Web Vitals Collection and Analysis Practice"
tag: performance
description: From Core Web Vitals metric interpretation to production collection and analysis, helping teams build a complete frontend performance monitoring system.
date: "2024-05-22T08:00:00.000Z"
---

## Goal

Performance is a core metric for user experience. Google's Core Web Vitals (LCP, INP, CLS) have become the industry standard for measuring website performance. This article systematically explains how to collect, analyze, and optimize Web Vitals from metric interpretation to production practice.

## Background

### Core Web Vitals Evolution

```
2020: Google launched Core Web Vitals
  - LCP (Largest Contentful Paint)
  - FID (First Input Delay)
  - CLS (Cumulative Layout Shift)

2023: FID replaced by INP
  - INP (Interaction to Next Paint)

2024: INP officially becomes Core Web Vitals
```

### Three Core Metrics Explained

| Metric | What It Measures | Good Standard | Poor Standard |
|--------|------------------|---------------|---------------|
| LCP | Loading performance | <= 2.5 seconds | > 4 seconds |
| INP | Interaction responsiveness | <= 200 milliseconds | > 500 milliseconds |
| CLS | Visual stability | <= 0.1 | > 0.25 |

### Why Monitoring Is Needed

- **SEO impact**: Google uses Core Web Vitals as a ranking factor
- **User experience**: Performance directly affects user retention
- **Business value**: Performance optimization brings conversion rate improvements
- **Competitive comparison**: Continuous monitoring maintains competitiveness

## Metric Collection

### web-vitals Library

```bash
# Install
npm install web-vitals
```

```typescript
// utils/web-vitals.ts
import { onLCP, onINP, onCLS, type Metric } from 'web-vitals';

type VitalMetric = Metric & {
  rating: 'good' | 'needs-improvement' | 'poor';
};

// Send to analytics service
function sendToAnalytics(metric: VitalMetric) {
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
    // Page information
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: Date.now(),
  });

  // Use sendBeacon to not affect page unload
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/vitals', body);
  } else {
    fetch('/api/vitals', {
      method: 'POST',
      body,
      keepalive: true,
    });
  }
}

// Initialize monitoring
export function initWebVitals() {
  onLCP(sendToAnalytics);   // Largest Contentful Paint
  onINP(sendToAnalytics);   // Interaction to Next Paint
  onCLS(sendToAnalytics);   // Cumulative Layout Shift
}
```

### React Integration

```tsx
// app/layout.tsx
'use client';

import { useEffect } from 'react';
import { initWebVitals } from '@/utils/web-vitals';

export default function RootLayout({ children }) {
  useEffect(() => {
    initWebVitals();
  }, []);

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

### Custom Performance Metrics

```typescript
// utils/custom-metrics.ts
import { onLCP, onINP, onCLS } from 'web-vitals';

// Custom business metrics
export function trackBusinessMetrics() {
  // TTFB (Time to First Byte)
  const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  if (navigationEntry) {
    const ttfb = navigationEntry.responseStart - navigationEntry.requestStart;
    sendMetric('TTFB', ttfb);
  }

  // FCP (First Contentful Paint)
  const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0] as PerformanceMetric;
  if (fcpEntry) {
    sendMetric('FCP', fcpEntry.startTime);
  }

  // Custom: First screen image load time
  const images = document.querySelectorAll('img');
  let lastImageLoadTime = 0;

  images.forEach((img) => {
    if (img.complete) {
      const loadTime = performance.getEntriesByName(img.src)[0]?.startTime || 0;
      lastImageLoadTime = Math.max(lastImageLoadTime, loadTime);
    }
  });

  if (lastImageLoadTime > 0) {
    sendMetric('FIRST_IMAGE_LOAD', lastImageLoadTime);
  }
}

function sendMetric(name: string, value: number) {
  navigator.sendBeacon('/api/metrics', JSON.stringify({
    name,
    value,
    url: window.location.href,
    timestamp: Date.now(),
  }));
}
```

## Backend API

### Next.js API Routes

```typescript
// app/api/vitals/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function POST(request: Request) {
  const data = await request.json();

  // Store to database
  await db.vitals.create({
    data: {
      name: data.name,
      value: data.value,
      rating: data.rating,
      url: data.url,
      userAgent: data.userAgent,
      timestamp: new Date(data.timestamp),
    },
  });

  // Or send to external service
  // await sendToDataDog(data);
  // await sendToSentry(data);

  return NextResponse.json({ success: true });
}
```

### Data Aggregation

```typescript
// app/api/vitals/stats/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const days = parseInt(searchParams.get('days') || '7');

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Query performance data for specified page
  const vitals = await db.vitals.groupBy({
    by: ['name'],
    where: {
      url: url || undefined,
      timestamp: { gte: startDate },
    },
    _avg: { value: true },
    _p75: { value: true },
    _count: true,
  });

  // Calculate P75
  const stats = vitals.map((vital) => {
    const values = vital.value.map((v) => v);
    values.sort((a, b) => a - b);
    const p75Index = Math.floor(values.length * 0.75);

    return {
      name: vital.name,
      avg: vital._avg.value,
      p75: values[p75Index] || 0,
      count: vital._count,
      rating: getRating(vital.name, values[p75Index] || 0),
    };
  });

  return NextResponse.json(stats);
}

function getRating(name: string, value: number): string {
  switch (name) {
    case 'LCP':
      return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor';
    case 'INP':
      return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor';
    case 'CLS':
      return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
    default:
      return 'unknown';
  }
}
```

## Data Analysis

### Performance Dashboard

```tsx
// components/PerformanceDashboard.tsx
'use client';

import { useEffect, useState } from 'react';

interface VitalStats {
  name: string;
  avg: number;
  p75: number;
  count: number;
  rating: 'good' | 'needs-improvement' | 'poor';
}

export function PerformanceDashboard({ url }: { url?: string }) {
  const [stats, setStats] = useState<VitalStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      const params = new URLSearchParams();
      if (url) params.set('url', url);
      params.set('days', '7');

      const response = await fetch(`/api/vitals/stats?${params}`);
      const data = await response.json();
      setStats(data);
      setLoading(false);
    };

    fetchStats();
  }, [url]);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="grid grid-cols-3 gap-4">
      {stats.map((stat) => (
        <div
          key={stat.name}
          className={`p-4 rounded-lg border ${
            stat.rating === 'good'
              ? 'border-green-500 bg-green-50'
              : stat.rating === 'needs-improvement'
              ? 'border-yellow-500 bg-yellow-50'
              : 'border-red-500 bg-red-50'
          }`}
        >
          <h3 className="text-lg font-bold">{stat.name}</h3>
          <p className="text-2xl font-mono">
            {stat.name === 'CLS' ? stat.p75.toFixed(3) : `${(stat.p75 / 1000).toFixed(2)}s`}
          </p>
          <p className="text-sm text-gray-600">
            P75 | Avg: {stat.name === 'CLS' ? stat.avg.toFixed(3) : `${(stat.avg / 1000).toFixed(2)}s`}
          </p>
          <p className="text-sm text-gray-500">{stat.count} samples</p>
        </div>
      ))}
    </div>
  );
}
```

### Trend Analysis

```tsx
// components/PerformanceTrend.tsx
'use client';

import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

export function PerformanceTrend({ url }: { url?: string }) {
  const [data, setData] = useState([]);

  useEffect(() => {
    const fetchTrend = async () => {
      const response = await fetch(`/api/vitals/trend?url=${url || ''}`);
      const trendData = await response.json();
      setData(trendData);
    };

    fetchTrend();
  }, [url]);

  return (
    <div className="w-full h-96">
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Line type="monotone" dataKey="lcp" stroke="#8884d8" name="LCP (ms)" />
        <Line type="monotone" dataKey="inp" stroke="#82ca9d" name="INP (ms)" />
        <Line type="monotone" dataKey="cls" stroke="#ffc658" name="CLS" />
      </LineChart>
    </div>
  );
}
```

## Optimization Strategies

### LCP Optimization

```typescript
// 1. Preload critical resources
// app/layout.tsx
export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        {/* Preload critical fonts */}
        <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* Preconnect to CDN */}
        <link rel="preconnect" href="https://cdn.example.com" />
      </head>
      <body>{children}</body>
    </html>
  );
}

// 2. Image optimization
import Image from 'next/image';

function HeroImage() {
  return (
    <Image
      src="/hero.jpg"
      alt="Hero"
      width={1200}
      height={600}
      priority // Preload first screen image
      placeholder="blur"
      blurDataURL="data:image/jpeg;base64,..."
    />
  );
}

// 3. Font optimization
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
});
```

### INP Optimization

```typescript
// 1. Use startTransition to lower interaction priority
import { useTransition } from 'react';

function SearchInput({ onSearch }) {
  const [query, setQuery] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleChange = (e) => {
    setQuery(e.target.value);
    startTransition(() => {
      onSearch(e.target.value);
    });
  };

  return (
    <div>
      <input value={query} onChange={handleChange} />
      {isPending && <Spinner />}
    </div>
  );
}

// 2. Use useDeferredValue to defer updates
import { useDeferredValue } from 'react';

function SearchResults({ query }) {
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => search(deferredQuery), [deferredQuery]);

  return (
    <ul>
      {results.map((result) => (
        <li key={result.id}>{result.title}</li>
      ))}
    </ul>
  );
}

// 3. Web Worker for compute-intensive tasks
// worker.js
self.onmessage = (e) => {
  const result = heavyComputation(e.data);
  self.postMessage(result);
};

// Use in component
function DataProcessor({ data }) {
  const [result, setResult] = useState(null);

  useEffect(() => {
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.onmessage = (e) => setResult(e.data);
    worker.postMessage(data);
    return () => worker.terminate();
  }, [data]);

  return <div>{result ? JSON.stringify(result) : 'Processing...'}</div>;
}
```

### CLS Optimization

```tsx
// 1. Set fixed dimensions for images
function ImageComponent() {
  return (
    <img
      src="/image.jpg"
      width={800}
      height={600}
      alt="Image"
      loading="lazy"
    />
  );
}

// 2. Use Next.js Image component (auto-sets dimensions)
import Image from 'next/image';

function OptimizedImage() {
  return (
    <Image
      src="/image.jpg"
      width={800}
      height={600}
      alt="Image"
    />
  );
}

// 3. Reserve space for dynamic content
function AdBanner({ width, height }) {
  return (
    <div style={{ width, height }}>
      {/* Ad content */}
    </div>
  );
}

// 4. Font loading optimization
@font-face {
  font-family: 'CustomFont';
  src: url('/fonts/custom.woff2') format('woff2');
  font-display: swap; /* Use fallback font, switch after loading */
}
```

## Monitoring Alerts

### Alert Rules

```typescript
// utils/alerts.ts
interface AlertRule {
  metric: string;
  threshold: number;
  window: number; // minutes
  severity: 'warning' | 'critical';
}

const alertRules: AlertRule[] = [
  { metric: 'LCP', threshold: 4000, window: 5, severity: 'critical' },
  { metric: 'INP', threshold: 500, window: 5, severity: 'critical' },
  { metric: 'CLS', threshold: 0.25, window: 5, severity: 'critical' },
  { metric: 'LCP', threshold: 2500, window: 30, severity: 'warning' },
];

export async function checkAlerts() {
  for (const rule of alertRules) {
    const stats = await getRecentStats(rule.metric, rule.window);
    const p75 = calculateP75(stats);

    if (p75 > rule.threshold) {
      await sendAlert({
        metric: rule.metric,
        value: p75,
        threshold: rule.threshold,
        severity: rule.severity,
      });
    }
  }
}

async function sendAlert(alert) {
  // Send to Slack, email, etc.
  await fetch(process.env.SLACK_WEBHOOK, {
    method: 'POST',
    body: JSON.stringify({
      text: `🚨 Performance Alert: ${alert.metric} P75 reached ${alert.value}ms, exceeding threshold ${alert.threshold}ms`,
    }),
  });
}
```

## Conclusion

Frontend performance monitoring is key to ensuring user experience. Key takeaways:

1. **Core Web Vitals**: LCP, INP, CLS three core metrics
2. **Collection solution**: Use web-vitals library for automatic collection
3. **Data analysis**: Build dashboards, track trends
4. **Optimization strategies**: Targeted optimization for each metric
5. **Monitoring alerts**: Set thresholds, discover issues promptly

Performance optimization is a continuous process, requiring a "collect → analyze → optimize → verify" closed loop. Only through continuous monitoring can we ensure continuous improvement in user experience.
