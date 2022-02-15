---
title: "Pinia vs Vuex: Which Next-Gen State Management Is Better?"
tag: vue
description: Pinia is Vue 3's officially recommended state management library. Comparing it with Vuex to analyze its advantages and use cases, helping you make the right choice.
date: "2022-02-15T08:00:00.000Z"
---

## Goal

Understand Pinia's design philosophy and advantages, and master its usage in real projects.

## Background

### Vuex's Problems

Vuex 3/4 is Vue's official state management library, but it has many pain points in practice:

```javascript
// Vuex typical writing
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

**Pain points**:
1. **Mutations are redundant**: Most mutations are just simple assignments
2. **Poor TypeScript support**: Requires additional type declarations
3. **Complex module nesting**: Namespaces, module registration, etc.
4. **Code redundancy**: Four-layer structure of state + getters + mutations + actions

### Pinia's Solution

```javascript
// Pinia writing
import { defineStore } from 'pinia'

export const useCounterStore = defineStore('counter', {
    state: () => ({ count: 0 }),
    getters: {
        doubleCount: (state) => state.count * 2
    },
    actions: {
        async fetchCount() {
            const count = await api.getCount()
            this.count = count  // Directly modify state, no mutations needed
        }
    }
})
```

**Improvements**:
1. **Removed mutations**: Directly modify state in actions
2. **Native TypeScript support**: Automatic type inference
3. **Flat modules**: No namespaces needed
4. **Cleaner code**: Less boilerplate

## Core Comparison

### 1. Code Volume

```javascript
// Vuex: need to define state + getters + mutations + actions
// Pinia: only need state + getters + actions

// Vuex action call
store.commit('SET_COUNT', 1)
store.dispatch('fetchUser')

// Pinia action call
store.count = 1  // Direct modification
store.fetchUser()  // Direct call
```

### 2. TypeScript Support

```typescript
// Vuex: need to manually declare types
interface RootState {
    count: number
    user: User | null
}

// Pinia: automatic type inference
const store = useCounterStore()
store.count  // Automatically inferred as number
store.doubleCount  // Automatically inferred as number
store.fetchUser()  // Automatically inferred as Promise<void>
```

### 3. Modularization

```javascript
// Vuex: needs namespaces
const moduleA = {
    namespaced: true,
    state: () => ({ count: 0 }),
    mutations: { /* ... */ }
}

// Usage
store.commit('moduleA/SET_COUNT', 1)

// Pinia: flat, no namespaces needed
const useStoreA = defineStore('a', { /* ... */ })
const useStoreB = defineStore('b', { /* ... */ })

// Usage
storeA.count = 1
storeB.count = 1
```

### 4. State Modification

```javascript
// Vuex: must go through mutations
mutations: {
    SET_COUNT(state, count) {
        state.count = count
    }
}
// Usage
store.commit('SET_COUNT', 1)

// Pinia: direct modification
store.count = 1

// Or batch modification
store.$patch({
    count: 1,
    user: null
})

// Or use function for modification
store.$patch((state) => {
    state.count++
    state.user = null
})
```

## Complete Pinia API

### 1. Defining Stores

```javascript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

// Method 1: Options API style
export const useCounterStore = defineStore('counter', {
    state: () => ({
        count: 0,
        name: 'Counter'
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

// Method 2: Composition API style (recommended)
export const useCounterStore = defineStore('counter', () => {
    // state
    const count = ref(0)
    const name = ref('Counter')

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

### 2. Using in Components

```vue
<template>
    <div>
        <p>Count: {{ store.count }}</p>
        <p>Double: {{ store.doubleCount }}</p>
        <button @click="store.increment()">+1</button>
        <button @click="store.$reset()">Reset</button>
    </div>
</template>

<script setup>
import { useCounterStore } from '@/stores/counter'

const store = useCounterStore()

// Destructure (maintain reactivity)
import { storeToRefs } from 'pinia'
const { count, doubleCount } = storeToRefs(store)
const { increment } = store
</script>
```

### 3. Store Interaction

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

    // Use other stores
    async function checkout() {
        const userStore = useUserStore()
        if (!userStore.isLoggedIn) {
            throw new Error('Please login first')
        }
        await api.checkout(userStore.user.id, items.value)
    }

    return { items, total, checkout }
})
```

### 4. Persistence

```javascript
// Using pinia-plugin-persistedstate
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

// Enable persistence when defining store
export const useUserStore = defineStore('user', {
    state: () => ({ user: null, token: '' }),
    persist: true  // Automatically persist to localStorage
})

// Or configure persistence options
export const useUserStore = defineStore('user', {
    state: () => ({ user: null, token: '' }),
    persist: {
        storage: sessionStorage,
        paths: ['token']  // Only persist token
    }
})
```

## Migration Guide

### Migrating from Vuex to Pinia

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
    // mutations removed
    actions: { increment() { this.count++ } }
}
```

### Key Changes

| Vuex | Pinia |
|------|-------|
| `commit('MUTATION', data)` | Directly modify state or call action |
| `dispatch('ACTION')` | Directly call action |
| `mapState` | `storeToRefs` |
| `mapGetters` | Directly access store properties |
| `mapMutations` | Not needed |
| `mapActions` | Directly call store methods |

## Selection Advice

### When to Use Pinia

1. **New projects**: Use Pinia directly
2. **Vue 3 projects**: Pinia is officially recommended
3. **TypeScript projects**: Pinia has better type support
4. **Small to medium projects**: Pinia is cleaner

### When Vuex Might Still Be Needed

1. **Large legacy projects**: High migration cost
2. **Complex state management**: Vuex's strict mode and plugin ecosystem are more mature
3. **Team familiar with Vuex**: Learning cost consideration

## Summary

1. **Pinia is the next-generation replacement for Vuex**: Cleaner and more powerful
2. **Removed mutations**: Directly modify state, reducing boilerplate
3. **Native TypeScript support**: Automatic inference, no extra configuration needed
4. **Composition API friendly**: Can use ref, computed, etc.
5. **Low migration cost**: Similar API design, relatively easy migration

For new projects, Pinia should be your default choice. It not only simplifies code but also provides a better development experience.
