---
title: "Vue 3 + Vite + TS Project Best Practices"
tag: vue
description: Vue 3 + Vite + TypeScript is the golden combination for frontend development in 2022. This article summarizes a complete set of project best practices.
date: "2022-03-10T08:00:00.000Z"
---

## Goal

Establish a complete set of Vue 3 + Vite + TypeScript project standards, covering project structure, type definitions, state management, routing configuration, and other core content.

## Background

### Why Choose This Tech Stack?

| Technology | Advantages |
|------------|------------|
| Vue 3 | Composition API, better TS support, performance improvements |
| Vite | Ultra-fast development experience, native ESM, excellent TS support |
| TypeScript | Type safety, better IDE support, fewer runtime errors |

Combining these three provides the best development experience and code quality.

## Project Structure

```
src/
├── api/                    # API request layer
│   ├── index.ts           # axios instance configuration
│   ├── user.ts            # User-related APIs
│   └── post.ts            # Post-related APIs
├── assets/                # Static assets
│   ├── images/
│   └── styles/
├── components/            # Shared components
│   ├── common/            # Base components
│   │   ├── Button.vue
│   │   └── Modal.vue
│   └── business/          # Business components
│       └── UserCard.vue
├── composables/           # Composable functions
│   ├── useAuth.ts
│   ├── useFetch.ts
│   └── usePagination.ts
├── layouts/               # Layout components
│   ├── DefaultLayout.vue
│   └── BlankLayout.vue
├── router/                # Router configuration
│   ├── index.ts
│   └── guards.ts
├── stores/                # Pinia state management
│   ├── index.ts
│   ├── user.ts
│   └── app.ts
├── types/                 # TypeScript type definitions
│   ├── api.ts
│   ├── model.ts
│   └── utils.ts
├── utils/                 # Utility functions
│   ├── request.ts
│   └── storage.ts
├── views/                 # Page components
│   ├── Home.vue
│   └── About.vue
├── App.vue
└── main.ts
```

## TypeScript Type Definitions

### 1. Model Types

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

### 2. API Types

```typescript
// types/api.ts
import type { User, Post, ApiResponse, PaginatedResponse } from './model'

// User-related
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

// Post-related
export interface CreatePostRequest {
    title: string
    content: string
    tags?: string[]
}

export interface UpdatePostRequest extends Partial<CreatePostRequest> {}
```

## API Request Layer

```typescript
// api/index.ts
import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { useUserStore } from '@/stores/user'
import { ElMessage } from 'element-plus'

// Create axios instance
const service: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL,
    timeout: 10000,
    headers: {
        'Content-Type': 'application/json'
    }
})

// Request interceptor
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

// Response interceptor
service.interceptors.response.use(
    (response: AxiosResponse) => {
        const res = response.data

        if (res.code !== 200) {
            ElMessage.error(res.message || 'Request failed')

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
        ElMessage.error(error.message || 'Network error')
        return Promise.reject(error)
    }
)

// Encapsulated request methods
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

### API Modules

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

## Pinia State Management

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
        const res = await userApi.getUser(0) // 0 means current user
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

## Router Configuration

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
                meta: { title: 'Home' }
            },
            {
                path: 'about',
                name: 'About',
                component: () => import('@/views/About.vue'),
                meta: { title: 'About' }
            }
        ]
    },
    {
        path: '/login',
        name: 'Login',
        component: () => import('@/views/Login.vue'),
        meta: { title: 'Login', requiresAuth: false }
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

### Route Guards

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

## Component Best Practices

### 1. Component Definition

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { User } from '@/types'

// Props type definition
interface Props {
    user: User
    showAvatar?: boolean
}

const props = withDefaults(defineProps<Props>(), {
    showAvatar: true
})

// Emits type definition
interface Emits {
    (e: 'update', user: User): void
    (e: 'delete', id: number): void
}

const emit = defineEmits<Emits>()

// Reactive data
const loading = ref(false)

// Computed property
const displayName = computed(() => props.user.username || 'Unknown user')

// Methods
function handleUpdate() {
    emit('update', props.user)
}

// Lifecycle
onMounted(() => {
    // Initialization logic
})
</script>

<template>
    <div class="user-card">
        <img v-if="showAvatar" :src="user.avatar" :alt="displayName" />
        <span>{{ displayName }}</span>
        <button @click="handleUpdate">Update</button>
    </div>
</template>
```

### 2. Composable Functions

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

## Environment Configuration

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

## Summary

1. **Complete type definitions**: API responses, component props, and state should all have types
2. **Use `<script setup>` for components**: Cleaner and better type inference
3. **Composables for logic reuse**: Clearer than Mixins
4. **Unified API layer management**: Interceptors, error handling, type definitions
5. **Pinia is the preferred state management**: Cleaner than Vuex, better TS support

These practices will make your project more standardized, maintainable, and bug-free.
