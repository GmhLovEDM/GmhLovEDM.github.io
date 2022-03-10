---
title: "Vue 3 + Vite + TS 项目最佳实践"
tag: vue
description: Vue 3 + Vite + TypeScript 是 2022 年前端开发的黄金组合，本文总结一套完整的项目最佳实践。
date: "2022-03-10T08:00:00.000Z"
---

## 目标

建立一套完整的 Vue 3 + Vite + TypeScript 项目规范，涵盖项目结构、类型定义、状态管理、路由配置等核心内容。

## 背景

### 为什么选择这个技术栈？

| 技术 | 优势 |
|------|------|
| Vue 3 | Composition API、更好的 TS 支持、性能提升 |
| Vite | 极速开发体验、原生 ESM、优秀的 TS 支持 |
| TypeScript | 类型安全、更好的 IDE 支持、减少运行时错误 |

这三者结合，能提供最佳的开发体验和代码质量。

## 项目结构

```
src/
├── api/                    # API 请求层
│   ├── index.ts           # axios 实例配置
│   ├── user.ts            # 用户相关 API
│   └── post.ts            # 文章相关 API
├── assets/                # 静态资源
│   ├── images/
│   └── styles/
├── components/            # 通用组件
│   ├── common/            # 基础组件
│   │   ├── Button.vue
│   │   └── Modal.vue
│   └── business/          # 业务组件
│       └── UserCard.vue
├── composables/           # 组合式函数
│   ├── useAuth.ts
│   ├── useFetch.ts
│   └── usePagination.ts
├── layouts/               # 布局组件
│   ├── DefaultLayout.vue
│   └── BlankLayout.vue
├── router/                # 路由配置
│   ├── index.ts
│   └── guards.ts
├── stores/                # Pinia 状态管理
│   ├── index.ts
│   ├── user.ts
│   └── app.ts
├── types/                 # TypeScript 类型定义
│   ├── api.ts
│   ├── model.ts
│   └── utils.ts
├── utils/                 # 工具函数
│   ├── request.ts
│   └── storage.ts
├── views/                 # 页面组件
│   ├── Home.vue
│   └── About.vue
├── App.vue
└── main.ts
```

## TypeScript 类型定义

### 1. 模型类型

```typescript
// types/model.ts
export interface User {
    id: number
    username: string
    email: string
    avatar?: string
    role: 'admin' | 'user'
    createdAt: string
    updatedAt: string
}

export interface Post {
    id: number
    title: string
    content: string
    author: User
    tags: string[]
    status: 'draft' | 'published'
    createdAt: string
    updatedAt: string
}

export interface ApiResponse<T> {
    code: number
    message: string
    data: T
}

export interface PaginatedResponse<T> {
    list: T[]
    total: number
    page: number
    pageSize: number
}
```

### 2. API 类型

```typescript
// types/api.ts
import type { User, Post, ApiResponse, PaginatedResponse } from './model'

// 用户相关
export interface LoginRequest {
    username: string
    password: string
}

export interface LoginResponse {
    token: string
    user: User
}

export interface GetUserResponse extends ApiResponse<User> {}
export interface GetPostsResponse extends ApiResponse<PaginatedResponse<Post>> {}

// 文章相关
export interface CreatePostRequest {
    title: string
    content: string
    tags?: string[]
}

export interface UpdatePostRequest extends Partial<CreatePostRequest> {}
```

## API 请求层

```typescript
// api/index.ts
import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'

// 创建 axios 实例
const service: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL,
    timeout: 10000,
    headers: {
        'Content-Type': 'application/json'
    }
})

// 请求拦截器
service.interceptors.request.use(
    (config) => {
        const userStore = useUserStore()
        if (userStore.token) {
            config.headers.Authorization = `Bearer ${userStore.token}`
        }
        return config
    },
    (error) => {
        return Promise.reject(error)
    }
)

// 响应拦截器
service.interceptors.response.use(
    (response: AxiosResponse) => {
        const res = response.data

        if (res.code !== 200) {
            ElMessage.error(res.message || '请求失败')

            if (res.code === 401) {
                const userStore = useUserStore()
                userStore.logout()
                window.location.href = '/login'
            }

            return Promise.reject(new Error(res.message))
        }

        return res
    },
    (error) => {
        ElMessage.error(error.message || '网络错误')
        return Promise.reject(error)
    }
)

// 封装请求方法
export function get<T>(url: string, params?: object, config?: AxiosRequestConfig) {
    return service.get<any, T>(url, { params, ...config })
}

export function post<T>(url: string, data?: object, config?: AxiosRequestConfig) {
    return service.post<any, T>(url, data, config)
}

export function put<T>(url: string, data?: object, config?: AxiosRequestConfig) {
    return service.put<any, T>(url, data, config)
}

export function del<T>(url: string, config?: AxiosRequestConfig) {
    return service.delete<any, T>(url, config)
}

export default service
```

### API 模块

```typescript
// api/user.ts
import { get, post } from './index'
import type { User, LoginRequest, LoginResponse } from '@/types'

export function getUser(id: number) {
    return get<{ data: User }>(`/api/users/${id}`)
}

export function login(data: LoginRequest) {
    return post<LoginResponse>('/api/auth/login', data)
}

export function logout() {
    return post('/api/auth/logout')
}
```

## Pinia 状态管理

```typescript
// stores/user.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import * as userApi from '@/api/user'

export const useUserStore = defineStore('user', () => {
    // State
    const token = ref(localStorage.getItem('token') || '')
    const user = ref<User | null>(null)

    // Getters
    const isLoggedIn = computed(() => !!token.value)
    const username = computed(() => user.value?.username || '')

    // Actions
    async function login(username: string, password: string) {
        const res = await userApi.login({ username, password })
        token.value = res.token
        user.value = res.user
        localStorage.setItem('token', res.token)
    }

    async function fetchUser() {
        if (!token.value) return
        const res = await userApi.getUser(0) // 0 表示当前用户
        user.value = res.data
    }

    function logout() {
        token.value = ''
        user.value = null
        localStorage.removeItem('token')
    }

    return {
        token,
        user,
        isLoggedIn,
        username,
        login,
        fetchUser,
        logout
    }
})
```

## 路由配置

```typescript
// router/index.ts
import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
    {
        path: '/',
        component: () => import('@/layouts/DefaultLayout.vue'),
        children: [
            {
                path: '',
                name: 'Home',
                component: () => import('@/views/Home.vue'),
                meta: { title: '首页' }
            },
            {
                path: 'about',
                name: 'About',
                component: () => import('@/views/About.vue'),
                meta: { title: '关于' }
            }
        ]
    },
    {
        path: '/login',
        name: 'Login',
        component: () => import('@/views/Login.vue'),
        meta: { title: '登录', requiresAuth: false }
    },
    {
        path: '/:pathMatch(.*)*',
        name: 'NotFound',
        component: () => import('@/views/NotFound.vue')
    }
]

const router = createRouter({
    history: createWebHistory(),
    routes
})

export default router
```

### 路由守卫

```typescript
// router/guards.ts
import router from './index'
import { useUserStore } from '@/stores/user'

const whiteList = ['/login', '/register']

router.beforeEach(async (to, from, next) => {
    document.title = `${to.meta.title || ''} - MyApp`

    const userStore = useUserStore()

    if (userStore.isLoggedIn) {
        if (!userStore.user) {
            try {
                await userStore.fetchUser()
            } catch {
                userStore.logout()
                next(`/login?redirect=${to.path}`)
                return
            }
        }

        if (to.path === '/login') {
            next('/')
        } else {
            next()
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

## 组件最佳实践

### 1. 组件定义

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { User } from '@/types'

// Props 类型定义
interface Props {
    user: User
    showAvatar?: boolean
}

const props = withDefaults(defineProps<Props>(), {
    showAvatar: true
})

// Emits 类型定义
interface Emits {
    (e: 'update', user: User): void
    (e: 'delete', id: number): void
}

const emit = defineEmits<Emits>()

// 响应式数据
const loading = ref(false)

// 计算属性
const displayName = computed(() => props.user.username || '未知用户')

// 方法
function handleUpdate() {
    emit('update', props.user)
}

// 生命周期
onMounted(() => {
    // 初始化逻辑
})
</script>

<template>
    <div class="user-card">
        <img v-if="showAvatar" :src="user.avatar" :alt="displayName" />
        <span>{{ displayName }}</span>
        <button @click="handleUpdate">更新</button>
    </div>
</template>
```

### 2. 组合式函数

```typescript
// composables/useFetch.ts
import { ref, watchEffect, type Ref } from 'vue'

interface UseFetchOptions<T> {
    immediate?: boolean
    onSuccess?: (data: T) => void
    onError?: (error: Error) => void
}

export function useFetch<T>(
    url: Ref<string> | string,
    options: UseFetchOptions<T> = {}
) {
    const { immediate = true, onSuccess, onError } = options

    const data = ref<T | null>(null) as Ref<T | null>
    const error = ref<Error | null>(null)
    const loading = ref(false)

    async function fetchData() {
        loading.value = true
        error.value = null

        try {
            const response = await fetch(typeof url === 'string' ? url : url.value)
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }
            const result = await response.json()
            data.value = result
            onSuccess?.(result)
        } catch (err) {
            error.value = err as Error
            onError?.(err as Error)
        } finally {
            loading.value = false
        }
    }

    if (immediate) {
        if (typeof url === 'object') {
            watchEffect(fetchData)
        } else {
            fetchData()
        }
    }

    return { data, error, loading, refetch: fetchData }
}
```

## 环境配置

```typescript
// vite-env.d.ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_BASE_URL: string
    readonly VITE_APP_TITLE: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
```

```yaml
# .env.development
VITE_API_BASE_URL=http://localhost:8080
VITE_APP_TITLE=MyApp Dev

# .env.production
VITE_API_BASE_URL=https://api.example.com
VITE_APP_TITLE=MyApp
```

## 总结

1. **类型定义要完善**：API 响应、组件 Props、状态都要有类型
2. **组件使用 `<script setup>`**：更简洁、更好的类型推导
3. **组合式函数复用逻辑**：比 Mixins 更清晰
4. **API 层统一管理**：拦截器、错误处理、类型定义
5. **Pinia 是状态管理首选**：比 Vuex 更简洁，TS 支持更好

这套实践能让你的项目更规范、更易维护、更少 bug。
