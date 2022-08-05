---
title: "Vue Router 4 Deep Dive: Route Guards and Dynamic Routes Done Right"
tag: vue
description: 深入解析 Vue Router 4 的路由守卫机制和动态路由配置，掌握前端路由控制的最佳实践。
date: "2022-08-05T08:00:00.000Z"
---

## Goal

In real-world Vue 3 project development, route management is one of the most fundamental yet critical pieces of infrastructure. Many developers using Vue Router 4 struggle with the execution order of route guards, the timing of dynamic route additions, and the correct approach to implementing access control. This article takes a deep dive into Vue Router 4's route guard mechanism and dynamic routing patterns, helping developers build more robust front-end routing systems.

## Background

Vue Router 4 shipped alongside Vue 3 and introduced several important changes:

- **Composition API support**: You can now use `useRouter()` and `useRoute()` inside `setup()`
- **Route guard behavior changes**: You can no longer return `false` to abort navigation (use `return undefined` instead)
- **Dynamic route API overhaul**: The usage patterns for `addRoute()` and `removeRoute()` have been adjusted
- **Enhanced type system**: Improved TypeScript support throughout

However, many developers still follow habits from Vue Router 3, which leads to various issues in routing control logic.

## Route Guard Mechanism Deep Dive

### Global Guard Execution Order

In Vue Router 4, the execution order of global guards is:

1. `router.beforeEach` -- global before-each guard
2. `router.beforeResolve` -- global before-resolve guard
3. `router.afterEach` -- global after-each hook

```javascript
// main.js
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [...]
})

// 1. Global before-each guard
router.beforeEach((to, from) => {
  console.log('beforeEach executed')
  // Return undefined to allow navigation, return false to abort
  // Vue Router 4 no longer supports returning a string for redirect
})

// 2. Global before-resolve guard
router.beforeResolve((to, from) => {
  console.log('beforeResolve executed')
})

// 3. Global after-each hook
router.afterEach((to, from) => {
  console.log('afterEach executed')
})
```

### In-Component Guards

With the Composition API, you use `onBeforeRouteLeave` and `onBeforeRouteUpdate`:

```vue
<script setup>
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

// Route update guard (when route params change for the same component)
onBeforeRouteUpdate((to, from) => {
  // Example: fetch new id parameter
  if (to.params.id !== from.params.id) {
    fetchData(to.params.id)
  }
})

// Route leave guard
onBeforeRouteLeave((to, from) => {
  if (hasUnsavedChanges.value) {
    return window.confirm('You have unsaved changes. Are you sure you want to leave?')
  }
})
</script>
```

### Complete Guard Execution Flow

Understanding the complete guard execution flow is critical:

```
Navigation triggered
  ↓
beforeRouteLeave in deactivated component
  ↓
Global beforeEach
  ↓
Resolve async route components
  ↓
beforeRouteUpdate in activated component
  ↓
beforeEnter in route config
  ↓
beforeRouteEnter in resolved route component
  ↓
Global beforeResolve
  ↓
Navigation confirmed
  ↓
Global afterEach
  ↓
DOM update
  ↓
Callbacks passed to next() in beforeRouteEnter guard
```

## Dynamic Routes Done Right

### When to Use addRoute()

`addRoute()` is the core method for adding dynamic routes in Vue Router 4. The correct timing is to add them dynamically inside route guards based on user permissions:

```javascript
// Track added routes to avoid duplicates
const addedRoutes = new Set()

router.beforeEach(async (to, from) => {
  const userStore = useUserStore()

  if (userStore.isLoggedIn && userStore.routesLoaded === false) {
    try {
      // Fetch routes corresponding to user permissions
      const dynamicRoutes = await userStore.fetchRoutes()

      // Dynamically add routes
      dynamicRoutes.forEach(route => {
        if (!addedRoutes.has(route.path)) {
          router.addRoute(route)
          addedRoutes.add(route.path)
        }
      })

      // Mark routes as loaded
      userStore.routesLoaded = true

      // Important: must return to.path, otherwise infinite loop occurs
      return { ...to, replace: true }
    } catch (error) {
      console.error('Failed to load routes:', error)
      return '/login'
    }
  }
})
```

### Handling Nested Dynamic Routes

For nested routes, you must ensure parent routes are added before child routes:

```javascript
// Wrong: adding child route before parent
router.addRoute('user', { path: 'settings', component: Settings })
router.addRoute({ path: '/user', component: UserLayout, children: [...] })
// This will cause the child route to fail to match

// Correct: adding parent route first, then child routes
const parentRoute = {
  path: '/user',
  component: UserLayout,
  children: [
    { path: 'dashboard', component: Dashboard }
  ]
}
router.addRoute(parentRoute)

// Later you can add more child routes to the parent
router.addRoute('user', { path: 'settings', component: Settings })
```

### Removing Dynamic Routes

Vue Router 4 provides the `removeRoute()` method, which was not possible in Vue Router 3:

```javascript
// Remove a single route
router.removeRoute('user-settings')

// Remove a parent route and all its children
router.removeRoute('user')
```

## Access Control in Practice

### Role-Based Route Permissions

```javascript
// permission.js
const whiteList = ['/login', '/register', '/404']

router.beforeEach(async (to, from, next) => {
  const token = getToken()

  if (token) {
    if (to.path === '/login') {
      next({ path: '/' })
    } else {
      const userStore = useUserStore()
      if (userStore.roles.length === 0) {
        try {
          const { roles, accessRoutes } = await userStore.getInfo()
          const routes = generateRoutes(roles, accessRoutes)
          routes.forEach(route => router.addRoute(route))
          next({ ...to, replace: true })
        } catch (error) {
          await userStore.logout()
          next(`/login?redirect=${to.path}`)
        }
      } else {
        next()
      }
    }
  } else {
    if (whiteList.includes(to.path)) {
      next()
    } else {
      next(`/login?redirect=${to.path}`)
    }
  }
})
```

### Leveraging Route Meta

Use the `meta` field to store permission information:

```javascript
const routes = [
  {
    path: '/admin',
    component: AdminLayout,
    meta: { requiresAuth: true, roles: ['admin'] },
    children: [
      {
        path: 'users',
        component: UserManagement,
        meta: { title: 'User Management', roles: ['admin'] }
      },
      {
        path: 'settings',
        component: SystemSettings,
        meta: { title: 'System Settings', roles: ['admin', 'super'] }
      }
    ]
  }
]
```

## Common Pitfalls and Solutions

### 1. Async Issues in Navigation Guards

```javascript
// Problem: pitfalls when using async/await in beforeEach
router.beforeEach(async (to, from) => {
  const result = await checkPermission(to)
  // If you return undefined, navigation will be aborted!
  // Vue Router 4 requires explicitly calling next()
})

// Correct approach
router.beforeEach(async (to, from, next) => {
  const result = await checkPermission(to)
  if (result) {
    next()
  } else {
    next('/login')
  }
})
```

### 2. Route Params Change but Component Does Not Re-render

```javascript
// Problem: when switching params on the same route component, it won't recreate
// Solution 1: use a key
<router-view :key="$route.fullPath" />

// Solution 2: use onBeforeRouteUpdate
onBeforeRouteUpdate((to, from) => {
  // Manually handle parameter changes
})
```

## Summary

Vue Router 4's route guard and dynamic routing mechanism provides powerful infrastructure for front-end access control. Key takeaways:

1. **Understand guard execution order**: The complete flow from beforeEach to beforeResolve to afterEach
2. **Use addRoute correctly**: Add dynamically inside beforeEach, watch for duplicates and nested route ordering
3. **Leverage meta fields**: Centrally manage route permissions and metadata
4. **Be aware of Vue Router 4 changes**: No more returning `false` to abort navigation -- use `undefined` or `next(false)` instead

Mastering these core concepts will make your front-end routing system more robust and maintainable, laying a solid foundation for subsequent features like permission management, page caching, and route lazy loading.
