---
title: "Vue Router 4 深度解析：路由守卫与动态路由的正确姿势"
tag: vue
description: 深入解析 Vue Router 4 的路由守卫机制和动态路由配置，掌握前端路由控制的最佳实践。
date: "2022-08-05T08:00:00.000Z"
---

## 目标

在实际的 Vue 3 项目开发中，路由管理是最基础也最关键的基础设施之一。很多开发者在使用 Vue Router 4 时，对路由守卫的执行顺序、动态路由的添加时机、以及权限控制的实现方式存在困惑。本文旨在深入剖析 Vue Router 4 的路由守卫机制与动态路由的正确使用姿势，帮助开发者构建更健壮的前端路由系统。

## 背景

Vue Router 4 随 Vue 3 一起发布，带来了诸多重要变更：

- **Composition API 支持**：可以在 `setup()` 中使用 `useRouter()` 和 `useRoute()`
- **路由守卫行为变化**：不再能返回 `false` 来中止导航（改用 `return undefined`）
- **动态路由 API 重构**：`addRoute()` 和 `removeRoute()` 的使用方式有所调整
- **类型系统增强**：提供更好的 TypeScript 支持

然而，很多开发者仍然沿用 Vue Router 3 的习惯，导致路由控制逻辑出现各种问题。

## 路由守卫机制深度解析

### 全局守卫的执行顺序

Vue Router 4 中，全局守卫的执行顺序是：

1. `router.beforeEach` — 全局前置守卫
2. `router.beforeResolve` — 全局解析守卫
3. `router.afterEach` — 全局后置钩子

```javascript
// main.js
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [...]
})

// 1. 全局前置守卫
router.beforeEach((to, from) => {
  console.log('beforeEach 执行')
  // 返回 undefined 放行，返回 false 中止导航
  // Vue Router 4 中不再支持返回字符串重定向
})

// 2. 全局解析守卫
router.beforeResolve((to, from) => {
  console.log('beforeResolve 执行')
})

// 3. 全局后置钩子
router.afterEach((to, from) => {
  console.log('afterEach 执行')
})
```

### 组件内守卫

在 Composition API 中，使用 `onBeforeRouteLeave` 和 `onBeforeRouteUpdate`：

```vue
<script setup>
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

// 路由更新守卫（同一组件的不同路由参数变化）
onBeforeRouteUpdate((to, from) => {
  // 例如：获取新的 id 参数
  if (to.params.id !== from.params.id) {
    fetchData(to.params.id)
  }
})

// 路由离开守卫
onBeforeRouteLeave((to, from) => {
  if (hasUnsavedChanges.value) {
    return window.confirm('有未保存的修改，确定要离开吗？')
  }
})
</script>
```

### 完整守卫执行流程

理解完整的守卫执行流程至关重要：

```
触发导航
  ↓
触发在失活组件里的 beforeRouteLeave
  ↓
调用全局 beforeEach
  ↓
解析异步路由组件
  ↓
在被激活的组件里调用 beforeRouteUpdate
  ↓
调用路由配置里的 beforeEnter
  ↓
解析路由组件里调用 beforeRouteEnter
  ↓
调用全局 beforeResolve
  ↓
导航被确认
  ↓
调用全局 afterEach
  ↓
更新 DOM
  ↓
触发 beforeRouteEnter 守卫中传给 next 的回调
```

## 动态路由的正确姿势

### addRoute 的使用时机

`addRoute()` 是 Vue Router 4 中添加动态路由的核心方法。正确的使用时机是在路由守卫中根据用户权限动态添加：

```javascript
// 存储已添加的路由，避免重复添加
const addedRoutes = new Set()

router.beforeEach(async (to, from) => {
  const userStore = useUserStore()

  if (userStore.isLoggedIn && userStore.routesLoaded === false) {
    try {
      // 获取用户权限对应的路由
      const dynamicRoutes = await userStore.fetchRoutes()

      // 动态添加路由
      dynamicRoutes.forEach(route => {
        if (!addedRoutes.has(route.path)) {
          router.addRoute(route)
          addedRoutes.add(route.path)
        }
      })

      // 标记路由已加载
      userStore.routesLoaded = true

      // 重要：必须返回 to.path，否则会陷入无限循环
      return { ...to, replace: true }
    } catch (error) {
      console.error('加载路由失败:', error)
      return '/login'
    }
  }
})
```

### 嵌套动态路由的处理

对于嵌套路由，需要特别注意父路由必须先于子路由添加：

```javascript
// 错误做法：先添加子路由，再添加父路由
router.addRoute('user', { path: 'settings', component: Settings })
router.addRoute({ path: '/user', component: UserLayout, children: [...] })
// 这会导致子路由无法匹配

// 正确做法：先添加父路由，再添加子路由
const parentRoute = {
  path: '/user',
  component: UserLayout,
  children: [
    { path: 'dashboard', component: Dashboard }
  ]
}
router.addRoute(parentRoute)

// 后续可以再向父路由添加子路由
router.addRoute('user', { path: 'settings', component: Settings })
```

### 移除动态路由

Vue Router 4 提供了 `removeRoute()` 方法，这在 Vue Router 3 中是无法做到的：

```javascript
// 移除单个路由
router.removeRoute('user-settings')

// 移除父路由及其所有子路由
router.removeRoute('user')
```

## 权限控制实战方案

### 基于角色的路由权限

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

### 路由 meta 的妙用

利用 `meta` 字段存储权限信息：

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
        meta: { title: '用户管理', roles: ['admin'] }
      },
      {
        path: 'settings',
        component: SystemSettings,
        meta: { title: '系统设置', roles: ['admin', 'super'] }
      }
    ]
  }
]
```

## 常见陷阱与解决方案

### 1. 导航守卫中的异步问题

```javascript
// 问题：在 beforeEach 中使用 async/await 时的陷阱
router.beforeEach(async (to, from) => {
  const result = await checkPermission(to)
  // 如果返回 undefined，导航会被中止！
  // Vue Router 4 要求显式返回 next()
})

// 正确做法
router.beforeEach(async (to, from, next) => {
  const result = await checkPermission(to)
  if (result) {
    next()
  } else {
    next('/login')
  }
})
```

### 2. 路由参数变化但组件不重新渲染

```javascript
// 问题：同一个路由组件切换参数时，组件不会重新创建
// 解决方案 1：使用 key
<router-view :key="$route.fullPath" />

// 解决方案 2：使用 onBeforeRouteUpdate
onBeforeRouteUpdate((to, from) => {
  // 手动处理参数变化
})
```

## 总结

Vue Router 4 的路由守卫与动态路由机制为前端权限控制提供了强大的基础设施。关键要点：

1. **理解守卫执行顺序**：beforeEach → beforeResolve → afterEach 的完整流程
2. **正确使用 addRoute**：在 beforeEach 中动态添加，注意去重和嵌套顺序
3. **善用 meta 字段**：集中管理路由的权限和元信息
4. **注意 Vue Router 4 的变化**：不再返回 `false` 中止导航，改用 `undefined` 或 `next(false)`

掌握这些核心概念，能够让你的前端路由系统更加健壮、可维护，为后续的权限管理、页面缓存、路由懒加载等功能打下坚实基础。
