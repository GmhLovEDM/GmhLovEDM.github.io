---
title: "Pinia vs Vuex：新一代状态管理谁更香"
tag: vue
description: Pinia 是 Vue 3 官方推荐的状态管理库，对比 Vuex 分析其优势和使用场景，帮助你做出正确的选择。
date: "2022-02-15T08:00:00.000Z"
---

## 目标

理解 Pinia 的设计理念和优势，掌握它在实际项目中的使用方式。

## 背景

### Vuex 的问题

Vuex 3/4 是 Vue 官方的状态管理库，但在实际使用中有很多痛点：

```javascript
// Vuex 的典型写法
const store = new Vuex.Store({
    state: {
        count: 0,
        user: null,
        posts: []
    },
    getters: {
        doubleCount: state => state.count * 2,
        userPosts: state => state.posts.filter(p => p.userId === state.user?.id)
    },
    mutations: {
        SET_COUNT(state, count) { state.count = count },
        SET_USER(state, user) { state.user = user },
        SET_POSTS(state, posts) { state.posts = posts }
    },
    actions: {
        async fetchUser({ commit }) {
            const user = await api.getUser()
            commit('SET_USER', user)
        },
        async fetchPosts({ commit }) {
            const posts = await api.getPosts()
            commit('SET_POSTS', posts)
        }
    }
})
```

**痛点**：
1. **mutations 是多余的**：大部分 mutation 只是一个简单的赋值
2. **TypeScript 支持差**：需要额外的类型声明
3. **模块嵌套复杂**：命名空间、模块注册等概念
4. **代码冗余**：state + getters + mutations + actions 四层结构

### Pinia 的解决方案

```javascript
// Pinia 的写法
import { defineStore } from 'pinia'

export const useCounterStore = defineStore('counter', {
    state: () => ({ count: 0 }),
    getters: {
        doubleCount: (state) => state.count * 2
    },
    actions: {
        async fetchCount() {
            const count = await api.getCount()
            this.count = count  // 直接修改 state，不需要 mutations
        }
    }
})
```

**改进**：
1. **去掉了 mutations**：直接在 actions 中修改 state
2. **TypeScript 原生支持**：自动推导类型
3. **扁平化模块**：不需要命名空间
4. **代码更简洁**：更少的样板代码

## 核心对比

### 1. 代码量

```javascript
// Vuex：需要定义 state + getters + mutations + actions
// Pinia：只需要 state + getters + actions

// Vuex 的 action 调用
store.commit('SET_COUNT', 1)
store.dispatch('fetchUser')

// Pinia 的 action 调用
store.count = 1  // 直接修改
store.fetchUser()  // 直接调用
```

### 2. TypeScript 支持

```typescript
// Vuex：需要手动声明类型
interface RootState {
    count: number
    user: User | null
}

// Pinia：自动推导类型
const store = useCounterStore()
store.count  // 自动推导为 number
store.doubleCount  // 自动推导为 number
store.fetchUser()  // 自动推导为 Promise<void>
```

### 3. 模块化

```javascript
// Vuex：需要命名空间
const moduleA = {
    namespaced: true,
    state: () => ({ count: 0 }),
    mutations: { /* ... */ }
}

// 使用
store.commit('moduleA/SET_COUNT', 1)

// Pinia：扁平化，不需要命名空间
const useStoreA = defineStore('a', { /* ... */ })
const useStoreB = defineStore('b', { /* ... */ })

// 使用
storeA.count = 1
storeB.count = 1
```

### 4. 状态修改

```javascript
// Vuex：必须通过 mutations
mutations: {
    SET_COUNT(state, count) {
        state.count = count
    }
}
// 使用
store.commit('SET_COUNT', 1)

// Pinia：直接修改
store.count = 1

// 或者批量修改
store.$patch({
    count: 1,
    user: null
})

// 或者用函数修改
store.$patch((state) => {
    state.count++
    state.user = null
})
```

## Pinia 完整 API

### 1. 定义 Store

```javascript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// 方式 1：Options API 风格
export const useCounterStore = defineStore('counter', {
    state: () => ({
        count: 0,
        name: '计数器'
    }),
    getters: {
        doubleCount: (state) => state.count * 2
    },
    actions: {
        increment() {
            this.count++
        },
        async fetchCount() {
            const count = await api.getCount()
            this.count = count
        }
    }
})

// 方式 2：Composition API 风格（推荐）
export const useCounterStore = defineStore('counter', () => {
    // state
    const count = ref(0)
    const name = ref('计数器')

    // getters
    const doubleCount = computed(() => count.value * 2)

    // actions
    function increment() {
        count.value++
    }

    async function fetchCount() {
        const fetchedCount = await api.getCount()
        count.value = fetchedCount
    }

    return { count, name, doubleCount, increment, fetchCount }
})
```

### 2. 在组件中使用

```vue
<template>
    <div>
        <p>Count: {{ store.count }}</p>
        <p>Double: {{ store.doubleCount }}</p>
        <button @click="store.increment()">+1</button>
        <button @click="store.$reset()">重置</button>
    </div>
</template>

<script setup>
import { useCounterStore } from '@/stores/counter'

const store = useCounterStore()

// 解构（保持响应式）
import { storeToRefs } from 'pinia'
const { count, doubleCount } = storeToRefs(store)
const { increment } = store
</script>
```

### 3. Store 之间的交互

```javascript
// stores/user.js
export const useUserStore = defineStore('user', () => {
    const user = ref(null)
    const isLoggedIn = computed(() => !!user.value)

    async function login(username, password) {
        user.value = await api.login(username, password)
    }

    return { user, isLoggedIn, login }
})

// stores/cart.js
export const useCartStore = defineStore('cart', () => {
    const items = ref([])
    const total = computed(() => items.value.reduce((sum, item) => sum + item.price, 0))

    // 使用其他 store
    async function checkout() {
        const userStore = useUserStore()
        if (!userStore.isLoggedIn) {
            throw new Error('请先登录')
        }
        await api.checkout(userStore.user.id, items.value)
    }

    return { items, total, checkout }
})
```

### 4. 持久化

```javascript
// 使用 pinia-plugin-persistedstate
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// 定义 store 时启用持久化
export const useUserStore = defineStore('user', {
    state: () => ({ user: null, token: '' }),
    persist: true  // 自动持久化到 localStorage
})

// 或者配置持久化选项
export const useUserStore = defineStore('user', {
    state: () => ({ user: null, token: '' }),
    persist: {
        storage: sessionStorage,
        paths: ['token']  // 只持久化 token
    }
})
```

## 迁移指南

### 从 Vuex 迁移到 Pinia

```javascript
// Vuex
const store = {
    state: { count: 0 },
    mutations: { SET_COUNT(state, count) { state.count = count } },
    actions: { increment({ commit }) { commit('SET_COUNT', state.count + 1) } }
}

// Pinia
const store = {
    state: { count: 0 },
    // mutations 被移除
    actions: { increment() { this.count++ } }
}
```

### 关键变化

| Vuex | Pinia |
|------|-------|
| `commit('MUTATION', data)` | 直接修改 state 或调用 action |
| `dispatch('ACTION')` | 直接调用 action |
| `mapState` | `storeToRefs` |
| `mapGetters` | 直接访问 store 属性 |
| `mapMutations` | 不需要 |
| `mapActions` | 直接调用 store 方法 |

## 选择建议

### 使用 Pinia 的场景

1. **新项目**：直接用 Pinia
2. **Vue 3 项目**：Pinia 是官方推荐
3. **TypeScript 项目**：Pinia 类型支持更好
4. **中小型项目**：Pinia 更简洁

### 可能还需要 Vuex 的场景

1. **大型遗留项目**：迁移成本高
2. **复杂的状态管理**：Vuex 的严格模式和插件生态更成熟
3. **团队熟悉 Vuex**：学习成本考虑

## 总结

1. **Pinia 是 Vuex 的下一代替代**：更简洁、更强大
2. **去掉了 mutations**：直接修改 state，减少样板代码
3. **TypeScript 原生支持**：自动推导，不需要额外配置
4. **Composition API 友好**：可以使用 ref、computed 等
5. **迁移成本低**：API 设计相似，迁移相对容易

对于新项目，Pinia 应该是你的默认选择。它不仅简化了代码，还提供了更好的开发体验。
