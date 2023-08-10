---
title: "React 18 Suspense 与 Streaming SSR 实战"
tag: react
description: 深入 React 18 Suspense 机制与 Next.js Streaming SSR，实现渐进式页面加载与服务端流式渲染的完整方案。
date: "2023-08-10T08:00:00.000Z"
---

## 目标

传统 SSR 模式下，服务端必须等待所有数据获取完成后才能发送 HTML，导致首屏加载时间受限于最慢的数据请求。React 18 的 Suspense 与 Streaming SSR 允许服务端流式发送 HTML，先发送已准备好的部分，实现渐进式页面加载。本文深入解析这套机制的原理与实战应用。

## 背景

### 传统 SSR 的瓶颈

在 Next.js Pages Router 时代（或传统 SSR 框架），数据获取流程是：

```
用户请求
  ↓
服务端执行所有 getServerSideProps / 数据获取
  ↓ （等待最慢的请求，假设 3 秒）
渲染完整 HTML
  ↓
发送给客户端
  ↓
客户端水合（Hydration）
```

问题在于：如果页面有 3 个数据源，耗时分别是 200ms、500ms、3000ms，那么用户必须等待 3000ms 才能看到任何内容。

### Streaming SSR 的优势

```
用户请求
  ↓
服务端开始渲染
  ↓ （立即）
发送 Shell HTML（Suspense 边界外的内容）
  ↓
流式发送 Suspense 边界内容（按数据就绪顺序）
  ↓
客户端逐步水合
```

## Suspense 机制详解

### 基本原理

Suspense 的核心是「等待」和「降级」：

```jsx
import { Suspense, lazy } from 'react';

// 懒加载组件
const LazyComponent = lazy(() => import('./LazyComponent'));

function App() {
  return (
    <div>
      <Header /> {/* 立即渲染 */}
      <Suspense fallback={<Loading />}>
        <LazyComponent /> {/* 等待加载完成后渲染 */}
      </Suspense>
      <Footer /> {/* 立即渲染 */}
    </div>
  );
}
```

### 数据获取与 Suspense

React 18 支持在渲染时获取数据（通过 Suspense 集成）：

```jsx
// 使用支持 Suspense 的数据源（如 React Query、SWR）
import { useSuspenseQuery } from '@tanstack/react-query';

function UserProfile({ userId }) {
  const { data } = useSuspenseQuery({
    queryKey: ['user', userId],
    queryFn: () => fetchUser(userId),
  });

  return (
    <div>
      <h2>{data.name}</h2>
      <p>{data.email}</p>
    </div>
  );
}

// 父组件
function Page() {
  return (
    <div>
      <h1>用户详情</h1>
      <Suspense fallback={<Skeleton />}>
        <UserProfile userId={1} />
      </Suspense>
    </div>
  );
}
```

### 多级 Suspense

```jsx
function Dashboard() {
  return (
    <div className="dashboard">
      {/* 一级：整个页面的 loading 状态 */}
      <Suspense fallback={<PageSkeleton />}>
        <Header />

        {/* 二级：侧边栏独立加载 */}
        <Suspense fallback={<SidebarSkeleton />}>
          <Sidebar />
        </Suspense>

        {/* 三级：主内容区独立加载 */}
        <Suspense fallback={<ContentSkeleton />}>
          <MainContent />
        </Suspense>

        {/* 三级：统计图表独立加载 */}
        <Suspense fallback={<ChartSkeleton />}>
          <StatsChart />
        </Suspense>

        <Footer />
      </Suspense>
    </div>
  );
}
```

## Next.js App Router 中的 Streaming

### 基本用法

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react';

// 服务端组件 —— 数据在服务端获取
async function UserList() {
  const users = await fetch('https://api.example.com/users').then(r => r.json());

  return (
    <ul>
      {users.map(user => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}

async function RecentActivity() {
  const activities = await fetch('https://api.example.com/activities').then(r => r.json());

  return (
    <div>
      {activities.map(activity => (
        <div key={activity.id}>{activity.description}</div>
      ))}
    </div>
  );
}

// 页面组件
export default function DashboardPage() {
  return (
    <div>
      <h1>仪表盘</h1>

      {/* 立即发送的 Shell */}
      <div className="layout">
        {/* 流式发送各个部分 */}
        <aside>
          <Suspense fallback={<div>加载侧边栏中...</div>}>
            <UserList />
          </Suspense>
        </aside>

        <main>
          <Suspense fallback={<div>加载活动中...</div>}>
            <RecentActivity />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
```

### loading.tsx 约定

Next.js App Router 提供了便捷的 loading 约定：

```tsx
// app/dashboard/loading.tsx
export default function DashboardLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 bg-gray-200 rounded w-1/4 mb-4" />
      <div className="grid grid-cols-3 gap-4">
        <div className="h-32 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-200 rounded" />
      </div>
    </div>
  );
}
```

这等价于在 `page.tsx` 外层包一个 Suspense。

## 实战：渐进式商品列表页

```tsx
// app/products/page.tsx
import { Suspense } from 'react';
import { ProductFilters } from './filters';
import { ProductGrid } from './grid';
import { ProductRecommendations } from './recommendations';

// 模拟慢速数据获取
async function getProducts(category?: string) {
  // 实际项目中替换为真实 API 调用
  const res = await fetch(`https://api.example.com/products?category=${category}`);
  return res.json();
}

async function getRecommendations() {
  const res = await fetch('https://api.example.com/recommendations');
  return res.json();
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { category?: string };
}) {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* 立即渲染：页面标题和筛选器骨架 */}
      <h1 className="text-3xl font-bold mb-6">商品列表</h1>

      {/* 筛选器立即加载（不依赖慢速数据） */}
      <Suspense fallback={<div>加载筛选器...</div>}>
        <ProductFilters />
      </Suspense>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 mt-8">
        {/* 主内容区：流式加载 */}
        <div className="lg:col-span-3">
          <Suspense
            fallback={
              <div className="grid grid-cols-3 gap-4">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="h-64 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            }
          >
            <ProductGrid category={searchParams.category} />
          </Suspense>
        </div>

        {/* 侧边栏：独立流式加载 */}
        <aside>
          <Suspense fallback={<div>加载推荐...</div>}>
            <ProductRecommendations />
          </Suspense>
        </aside>
      </div>
    </div>
  );
}
```

## 错误处理

### error.tsx

```tsx
// app/dashboard/error.tsx
'use client';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="text-center py-12">
      <h2 className="text-2xl font-bold text-red-600">出错了</h2>
      <p className="mt-2 text-gray-600">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
      >
        重试
      </button>
    </div>
  );
}
```

### 组件级错误边界

```tsx
// components/ErrorBoundary.tsx
'use client';

import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: ReactNode;
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

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.state.children;
  }
}

// 使用
<ErrorBoundary fallback={<div>加载失败，<button onClick={() => window.location.reload()}>刷新</button></div>}>
  <Suspense fallback={<Loading />}>
    <AsyncComponent />
  </Suspense>
</ErrorBoundary>
```

## 性能优化

### 1. 合理划分 Suspense 边界

```tsx
// ❌ 错误：整个页面一个 Suspense
<Suspense fallback={<FullPageLoading />}>
  <Dashboard />
</Suspense>

// ✅ 正确：按数据依赖粒度划分
<Suspense fallback={<HeaderSkeleton />}>
  <Header />
</Suspense>
<Suspense fallback={<SidebarSkeleton />}>
  <Sidebar />
</Suspense>
<Suspense fallback={<ContentSkeleton />}>
  <Content />
</Suspense>
```

### 2. 避免 waterfall

```tsx
// ❌ 串行获取（waterfall）
async function Page() {
  const user = await getUser();      // 200ms
  const posts = await getPosts();    // 500ms
  const comments = await getComments(); // 300ms
  // 总计: 1000ms
}

// ✅ 并行获取
async function Page() {
  const [user, posts, comments] = await Promise.all([
    getUser(),
    getPosts(),
    getComments(),
  ]);
  // 总计: 500ms（取最慢的）
}
```

### 3. 预加载数据

```tsx
// 在父组件中预加载子组件需要的数据
async function ProductPage({ id }) {
  // 预加载，而不是在子组件中等待
  const productPromise = getProduct(id);
  const reviewsPromise = getReviews(id);

  return (
    <div>
      <Suspense fallback={<ProductSkeleton />}>
        <ProductDetail promise={productPromise} />
      </Suspense>
      <Suspense fallback={<ReviewsSkeleton />}>
        <ProductReviews promise={reviewsPromise} />
      </Suspense>
    </div>
  );
}

// 子组件接收 Promise
async function ProductDetail({ promise }) {
  const product = await promise;
  return <div>{product.name}</div>;
}
```

## 总结

Suspense 与 Streaming SSR 彻底改变了 SSR 的性能模型。关键要点：

1. **Streaming 是核心**：先发送 Shell，再流式发送动态内容
2. **Suspense 边界要合理**：太粗影响体验，太细增加复杂度
3. **错误处理要完善**：每个 Suspense 边界都应该有对应的 error 处理
4. **避免 waterfall**：并行获取数据，预加载子组件数据

这套机制让 SSR 应用的用户体验无限接近客户端渲染，同时保留了 SEO 和首屏性能的优势。随着 React 生态的成熟，Streaming SSR 将成为 SSR 应用的标准模式。
