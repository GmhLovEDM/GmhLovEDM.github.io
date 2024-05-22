---
title: "前端性能监控：Web Vitals 采集与分析实战"
tag: performance
description: 从 Core Web Vitals 指标解读到生产环境的采集与分析，帮助团队建立完整的前端性能监控体系。
date: "2024-05-22T08:00:00.000Z"
---

## 目标

性能是用户体验的核心指标。Google 提出的 Core Web Vitals（LCP、INP、CLS）已经成为衡量网站性能的行业标准。本文从指标解读到生产实践，系统讲解如何采集、分析和优化 Web Vitals。

## 背景

### Core Web Vitals 演进

```
2020 年：Google 推出 Core Web Vitals
  - LCP（Largest Contentful Paint）
  - FID（First Input Delay）
  - CLS（Cumulative Layout Shift）

2023 年：FID 被 INP 替代
  - INP（Interaction to Next Paint）

2024 年：INP 正式成为 Core Web Vitals
```

### 三大指标解读

| 指标 | 衡量什么 | 良好标准 | 差的标准 |
|------|----------|----------|----------|
| LCP | 加载性能 | <= 2.5 秒 | > 4 秒 |
| INP | 交互响应性 | <= 200 毫秒 | > 500 毫秒 |
| CLS | 视觉稳定性 | <= 0.1 | > 0.25 |

### 为什么需要监控

- **SEO 影响**：Google 使用 Core Web Vitals 作为排名因素
- **用户体验**：性能直接影响用户留存率
- **商业价值**：性能优化带来转化率提升
- **竞品对比**：持续监控保持竞争力

## 指标采集

### web-vitals 库

```bash
# 安装
npm install web-vitals
```

```typescript
// utils/web-vitals.ts
import { onLCP, onINP, onCLS, type Metric } from 'web-vitals';

type VitalMetric = Metric & {
  rating: 'good' | 'needs-improvement' | 'poor';
};

// 发送到分析服务
function sendToAnalytics(metric: VitalMetric) {
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
    // 页面信息
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: Date.now(),
  });

  // 使用 sendBeacon 不影响页面卸载
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

// 初始化监控
export function initWebVitals() {
  onLCP(sendToAnalytics);   // 最大内容绘制
  onINP(sendToAnalytics);   // 交互到下一次绘制
  onCLS(sendToAnalytics);   // 累积布局偏移
}
```

### React 集成

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
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
```

### 自定义性能指标

```typescript
// utils/custom-metrics.ts
import { onLCP, onINP, onCLS } from 'web-vitals';

// 自定义业务指标
export function trackBusinessMetrics() {
  // TTFB（Time to First Byte）
  const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  if (navigationEntry) {
    const ttfb = navigationEntry.responseStart - navigationEntry.requestStart;
    sendMetric('TTFB', ttfb);
  }

  // FCP（First Contentful Paint）
  const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0] as PerformanceMetric;
  if (fcpEntry) {
    sendMetric('FCP', fcpEntry.startTime);
  }

  // 自定义：首屏图片加载时间
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

## 后端 API

### Next.js API 路由

```typescript
// app/api/vitals/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function POST(request: Request) {
  const data = await request.json();

  // 存储到数据库
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

  // 或者发送到外部服务
  // await sendToDataDog(data);
  // await sendToSentry(data);

  return NextResponse.json({ success: true });
}
```

### 数据聚合

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

  // 查询指定页面的性能数据
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

  // 计算 P75
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

## 数据分析

### 性能仪表板

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

  if (loading) return <div>加载中...</div>;

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
            P75 | 平均: {stat.name === 'CLS' ? stat.avg.toFixed(3) : `${(stat.avg / 1000).toFixed(2)}s`}
          </p>
          <p className="text-sm text-gray-500">{stat.count} 次采样</p>
        </div>
      ))}
    </div>
  );
}
```

### 趋势分析

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

## 优化策略

### LCP 优化

```typescript
// 1. 预加载关键资源
// app/layout.tsx
export default function RootLayout({ children }) {
  return (
    <html>
      <head>
        {/* 预加载关键字体 */}
        <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* 预连接到 CDN */}
        <link rel="preconnect" href="https://cdn.example.com" />
      </head>
      <body>{children}</body>
    </html>
  );
}

// 2. 图片优化
import Image from 'next/image';

function HeroImage() {
  return (
    <Image
      src="/hero.jpg"
      alt="Hero"
      width={1200}
      height={600}
      priority // 预加载首屏图片
      placeholder="blur"
      blurDataURL="data:image/jpeg;base64,..."
    />
  );
}

// 3. 字体优化
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
});
```

### INP 优化

```typescript
// 1. 使用 startTransition 降低交互优先级
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

// 2. 使用 useDeferredValue 延迟更新
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

// 3. Web Worker 处理计算密集型任务
// worker.js
self.onmessage = (e) => {
  const result = heavyComputation(e.data);
  self.postMessage(result);
};

// 组件中使用
function DataProcessor({ data }) {
  const [result, setResult] = useState(null);

  useEffect(() => {
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.onmessage = (e) => setResult(e.data);
    worker.postMessage(data);
    return () => worker.terminate();
  }, [data]);

  return <div>{result ? JSON.stringify(result) : '处理中...'}</div>;
}
```

### CLS 优化

```tsx
// 1. 图片设置固定尺寸
function ImageComponent() {
  return (
    <img
      src="/image.jpg"
      width={800}
      height={600}
      alt="图片"
      loading="lazy"
    />
  );
}

// 2. 使用 Next.js Image 组件（自动设置尺寸）
import Image from 'next/image';

function OptimizedImage() {
  return (
    <Image
      src="/image.jpg"
      width={800}
      height={600}
      alt="图片"
    />
  );
}

// 3. 动态内容预留空间
function AdBanner({ width, height }) {
  return (
    <div style={{ width, height }}>
      {/* 广告内容 */}
    </div>
  );
}

// 4. 字体加载优化
@font-face {
  font-family: 'CustomFont';
  src: url('/fonts/custom.woff2') format('woff2');
  font-display: swap; /* 使用备用字体，加载完成后切换 */
}
```

## 监控告警

### 告警规则

```typescript
// utils/alerts.ts
interface AlertRule {
  metric: string;
  threshold: number;
  window: number; // 分钟
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
  // 发送到 Slack、邮件等
  await fetch(process.env.SLACK_WEBHOOK, {
    method: 'POST',
    body: JSON.stringify({
      text: `🚨 性能告警: ${alert.metric} P75 达到 ${alert.value}ms，超过阈值 ${alert.threshold}ms`,
    }),
  });
}
```

## 总结

前端性能监控是保证用户体验的关键。关键要点：

1. **Core Web Vitals**：LCP、INP、CLS 三大核心指标
2. **采集方案**：使用 web-vitals 库自动采集
3. **数据分析**：建立仪表板，追踪趋势
4. **优化策略**：针对每个指标的优化方案
5. **监控告警**：设置阈值，及时发现问题

性能优化是一个持续的过程，需要建立「采集 → 分析 → 优化 → 验证」的闭环。只有持续监控，才能保证用户体验的持续提升。
