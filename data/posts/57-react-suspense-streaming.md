---
title: "React 18 Suspense and Streaming SSR in Practice"
tag: react
description: Deep dive into React 18 Suspense mechanism and Next.js Streaming SSR, implementing a complete solution for progressive page loading and server-side streaming rendering.
date: "2023-08-10T08:00:00.000Z"
---

## Goal

In traditional SSR mode, the server must wait for all data fetching to complete before sending HTML, making the first-screen loading time dependent on the slowest data request. React 18's Suspense and Streaming SSR allow the server to stream HTML, sending ready parts first to achieve progressive page loading. This article provides a deep analysis of the principles and practical applications of this mechanism.

## Background

### Traditional SSR Bottlenecks

In the Next.js Pages Router era (or traditional SSR frameworks), the data fetching flow is:

```
User request
  ↓
Server executes all getServerSideProps / data fetching
  ↓ (waits for the slowest request, assume 3 seconds)
Renders complete HTML
  ↓
Sends to client
  ↓
Client hydration
```

The problem is: if a page has 3 data sources taking 200ms, 500ms, and 3000ms respectively, users must wait 3000ms before seeing any content.

### Streaming SSR Advantages

```
User request
  ↓
Server begins rendering
  ↓ (immediately)
Sends Shell HTML (content outside Suspense boundaries)
  ↓
Streams Suspense boundary content (in order of data readiness)
  ↓
Client progressively hydrates
```

## Suspense Mechanism Deep Dive

### Basic Principles

Suspense's core is "waiting" and "fallback":

```jsx
import { Suspense, lazy } from 'react';

// Lazy-loaded component
const LazyComponent = lazy(() => import('./LazyComponent'));

function App() {
  return (
    <div>
      <Header /> {/* Renders immediately */}
      <Suspense fallback={<Loading />}>
        <LazyComponent /> {/* Renders after loading completes */}
      </Suspense>
      <Footer /> {/* Renders immediately */}
    </div>
  );
}
```

### Data Fetching and Suspense

React 18 supports data fetching during rendering (through Suspense integration):

```jsx
// Using a Suspense-compatible data source (e.g., React Query, SWR)
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

// Parent component
function Page() {
  return (
    <div>
      <h1>User Details</h1>
      <Suspense fallback={<Skeleton />}>
        <UserProfile userId={1} />
      </Suspense>
    </div>
  );
}
```

### Multi-Level Suspense

```jsx
function Dashboard() {
  return (
    <div className="dashboard">
      {/* Level 1: Entire page loading state */}
      <Suspense fallback={<PageSkeleton />}>
        <Header />

        {/* Level 2: Sidebar loads independently */}
        <Suspense fallback={<SidebarSkeleton />}>
          <Sidebar />
        </Suspense>

        {/* Level 3: Main content area loads independently */}
        <Suspense fallback={<ContentSkeleton />}>
          <MainContent />
        </Suspense>

        {/* Level 3: Stats chart loads independently */}
        <Suspense fallback={<ChartSkeleton />}>
          <StatsChart />
        </Suspense>

        <Footer />
      </Suspense>
    </div>
  );
}
```

## Streaming in Next.js App Router

### Basic Usage

```tsx
// app/dashboard/page.tsx
import { Suspense } from 'react';

// Server Component — data fetched on the server
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

// Page component
export default function DashboardPage() {
  return (
    <div>
      <h1>Dashboard</h1>

      {/* Shell sent immediately */}
      <div className="layout">
        {/* Stream each section */}
        <aside>
          <Suspense fallback={<div>Loading sidebar...</div>}>
            <UserList />
          </Suspense>
        </aside>

        <main>
          <Suspense fallback={<div>Loading activity...</div>}>
            <RecentActivity />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
```

### loading.tsx Convention

Next.js App Router provides a convenient loading convention:

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

This is equivalent to wrapping `page.tsx` with a Suspense boundary.

## Practice: Progressive Product Listing Page

```tsx
// app/products/page.tsx
import { Suspense } from 'react';
import { ProductFilters } from './filters';
import { ProductGrid } from './grid';
import { ProductRecommendations } from './recommendations';

// Simulate slow data fetching
async function getProducts(category?: string) {
  // Replace with real API calls in production
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
      {/* Renders immediately: page title and filter skeleton */}
      <h1 className="text-3xl font-bold mb-6">Products</h1>

      {/* Filters load immediately (don't depend on slow data) */}
      <Suspense fallback={<div>Loading filters...</div>}>
        <ProductFilters />
      </Suspense>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8 mt-8">
        {/* Main content area: streaming load */}
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

        {/* Sidebar: independent streaming load */}
        <aside>
          <Suspense fallback={<div>Loading recommendations...</div>}>
            <ProductRecommendations />
          </Suspense>
        </aside>
      </div>
    </div>
  );
}
```

## Error Handling

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
      <h2 className="text-2xl font-bold text-red-600">Something went wrong</h2>
      <p className="mt-2 text-gray-600">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
      >
        Try Again
      </button>
    </div>
  );
}
```

### Component-Level Error Boundary

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

// Usage
<ErrorBoundary fallback={<div>Failed to load, <button onClick={() => window.location.reload()}>Refresh</button></div>}>
  <Suspense fallback={<Loading />}>
    <AsyncComponent />
  </Suspense>
</ErrorBoundary>
```

## Performance Optimization

### 1. Properly Define Suspense Boundaries

```tsx
// ❌ Wrong: One Suspense for the entire page
<Suspense fallback={<FullPageLoading />}>
  <Dashboard />
</Suspense>

// ✅ Correct: Split by data dependency granularity
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

### 2. Avoid Waterfalls

```tsx
// ❌ Serial fetching (waterfall)
async function Page() {
  const user = await getUser();      // 200ms
  const posts = await getPosts();    // 500ms
  const comments = await getComments(); // 300ms
  // Total: 1000ms
}

// ✅ Parallel fetching
async function Page() {
  const [user, posts, comments] = await Promise.all([
    getUser(),
    getPosts(),
    getComments(),
  ]);
  // Total: 500ms (slowest one)
}
```

### 3. Preload Data

```tsx
// Preload data needed by child components in the parent
async function ProductPage({ id }) {
  // Preload instead of waiting in child components
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

// Child component receives Promise
async function ProductDetail({ promise }) {
  const product = await promise;
  return <div>{product.name}</div>;
}
```

## Conclusion

Suspense and Streaming SSR have fundamentally changed the SSR performance model. Key takeaways:

1. **Streaming is the core**: Send the Shell first, then stream dynamic content
2. **Suspense boundaries must be reasonable**: Too coarse affects experience, too fine increases complexity
3. **Error handling must be thorough**: Every Suspense boundary should have corresponding error handling
4. **Avoid waterfalls**: Fetch data in parallel, preload child component data

This mechanism brings SSR application user experience infinitely close to client-side rendering while retaining the advantages of SEO and first-screen performance. As the React ecosystem matures, Streaming SSR will become the standard pattern for SSR applications.
