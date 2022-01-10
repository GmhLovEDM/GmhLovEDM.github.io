---
title: "Vue 3 Composition API in Practice: Say Goodbye to Options Anxiety"
tag: vue
description: Deeply understand the design philosophy and practical techniques of Vue 3 Composition API, transitioning from Options API to Composition API thinking.
date: "2022-01-10T08:00:00.000Z"
---

## Goal

Understand the core problems that Composition API solves and master its best practices in real projects.

## Background

### Options API Pain Points

In Vue 2's Options API, a component's logic is divided by option type:

```javascript
// Vue 2 Options API
export default {
    data() {
        return {
            count: 0,
            user: null,
            posts: [],
            loading: false
        }
    },
    computed: {
        // Computed properties scattered here
        doubleCount() { return this.count * 2 },
        sortedPosts() { /* ... */ }
    },
    methods: {
        // Methods scattered here
        increment() { this.count++ },
        fetchUser() { /* ... */ },
        fetchPosts() { /* ... */ }
    },
    watch: {
        // Watchers scattered here
        user(newVal) { /* ... */ },
        count(newVal) { /* ... */ }
    },
    mounted() {
        // Lifecycle hooks scattered here
        this.fetchUser()
        this.fetchPosts()
    }
}
```

**Problem**: When components become complex, code for the same feature is scattered across data, methods, computed, watch, and other locations, making it difficult to read and maintain.

### Composition API Solution

```javascript
// Vue 3 Composition API
import { ref, computed, onMounted } from 'vue'

export default {
    setup() {
        // Feature A: Counter
        const count = ref(0)
        const doubleCount = computed(() => count.value * 2)
        const increment = () => { count.value++ }

        // Feature B: User information
        const user = ref(null)
        const fetchUser = async () => {
            const res = await fetch('/api/user')
            user.value = await res.json()
        }

        // Feature C: Article list
        const posts = ref([])
        const sortedPosts = computed(() => posts.value.sort(/* ... */))
        const fetchPosts = async () => {
            const res = await fetch('/api/posts')
            posts.value = await res.json()
        }

        // Lifecycle
        onMounted(() => {
            fetchUser()
            fetchPosts()
        })

        return { count, doubleCount, increment, user, sortedPosts }
    }
}
```

**Core idea**: Organize code by feature, not by option type.

## Core API Deep Dive

### 1. ref vs reactive

```javascript
import { ref, reactive } from 'vue'

// ref: works with both primitives and objects
const count = ref(0)
console.log(count.value) // 0
count.value++ // Needs .value

// reactive: only supports objects
const state = reactive({
    count: 0,
    user: { name: 'Zhang San' }
})
console.log(state.count) // 0
state.count++ // No .value needed
```

**Selection advice**:
- Primitives: must use ref
- Simple objects: either works
- Complex objects (deep nesting): use reactive
- Need to replace entirely: use ref (reactive cannot be directly replaced)

### 2. computed

```javascript
import { ref, computed } from 'vue'

const firstName = ref('Zhang')
const lastName = ref('San')

// Read-only computed
const fullName = computed(() => `${firstName.value}${lastName.value}`)

// Read-write computed
const fullNameRW = computed({
    get: () => `${firstName.value}${lastName.value}`,
    set: (newValue) => {
        firstName.value = newValue[0]
        lastName.value = newValue.slice(1)
    }
})
```

### 3. watch vs watchEffect

```javascript
import { ref, watch, watchEffect } from 'vue'

const keyword = ref('')
const page = ref(1)

// watch: explicitly specify watch source
watch(keyword, (newVal, oldVal) => {
    console.log(`Search term changed from ${oldVal} to ${newVal}`)
    page.value = 1 // Reset page when search term changes
})

// watchEffect: automatically track dependencies
watchEffect(() => {
    console.log(`Current page: ${page.value}`)
    // Automatically monitors page changes
    fetchPosts(keyword.value, page.value)
})

// Watch multiple sources
watch([keyword, page], ([newKeyword, newPage], [oldKeyword, oldPage]) => {
    console.log(`Search term: ${newKeyword}, Page: ${newPage}`)
})

// Deep watching
watch(
    () => state.user,
    (newUser) => {
        console.log('User info changed', newUser)
    },
    { deep: true }
)
```

## Practice: Reusable Composables

### 1. Data Fetching

```javascript
// composables/useFetch.js
import { ref, watchEffect } from 'vue'

export function useFetch(url, options = {}) {
    const data = ref(null)
    const error = ref(null)
    const loading = ref(false)

    const fetchData = async () => {
        loading.value = true
        error.value = null

        try {
            const response = await fetch(url.value || url, options)
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`)
            }
            data.value = await response.json()
        } catch (err) {
            error.value = err.message
        } finally {
            loading.value = false
        }
    }

    // If url is a ref, automatically watch for changes
    if (typeof url === 'object' && url.value !== undefined) {
        watchEffect(fetchData)
    } else {
        fetchData()
    }

    return { data, error, loading, refetch: fetchData }
}

// Usage
const { data: users, loading, error } = useFetch('/api/users')
```

### 2. Pagination

```javascript
// composables/usePagination.js
import { ref, computed } from 'vue'

export function usePagination(fetchFn, options = {}) {
    const { pageSize = 10 } = options

    const page = ref(1)
    const total = ref(0)
    const data = ref([])
    const loading = ref(false)

    const totalPages = computed(() => Math.ceil(total.value / pageSize))

    const fetchData = async () => {
        loading.value = true
        try {
            const result = await fetchFn(page.value, pageSize)
            data.value = result.data
            total.value = result.total
        } finally {
            loading.value = false
        }
    }

    const nextPage = () => {
        if (page.value < totalPages.value) {
            page.value++
            fetchData()
        }
    }

    const prevPage = () => {
        if (page.value > 1) {
            page.value--
            fetchData()
        }
    }

    const goToPage = (p) => {
        page.value = p
        fetchData()
    }

    return {
        page,
        total,
        data,
        loading,
        totalPages,
        fetchData,
        nextPage,
        prevPage,
        goToPage
    }
}

// Usage
const { data: posts, page, totalPages, nextPage, prevPage } = usePagination(
    async (page, pageSize) => {
        const res = await fetch(`/api/posts?page=${page}&size=${pageSize}`)
        return res.json()
    }
)
```

### 3. Form Validation

```javascript
// composables/useForm.js
import { ref, reactive } from 'vue'

export function useForm(initialValues = {}, rules = {}) {
    const values = reactive({ ...initialValues })
    const errors = reactive({})
    const touched = reactive({})

    const validate = (field) => {
        if (!rules[field]) return true

        const rule = rules[field]
        const value = values[field]
        let isValid = true
        let message = ''

        if (rule.required && !value) {
            isValid = false
            message = `${field} is required`
        } else if (rule.minLength && value.length < rule.minLength) {
            isValid = false
            message = `${field} must be at least ${rule.minLength} characters`
        } else if (rule.pattern && !rule.pattern.test(value)) {
            isValid = false
            message = `${field} format is incorrect`
        }

        errors[field] = isValid ? '' : message
        return isValid
    }

    const validateAll = () => {
        let isValid = true
        for (const field in rules) {
            if (!validate(field)) {
                isValid = false
            }
        }
        return isValid
    }

    const reset = () => {
        Object.assign(values, initialValues)
        Object.keys(errors).forEach(key => errors[key] = '')
    }

    return { values, errors, touched, validate, validateAll, reset }
}

// Usage
const { values, errors, validate, validateAll } = useForm(
    { username: '', email: '' },
    {
        username: { required: true, minLength: 3 },
        email: { required: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }
    }
)
```

## Comparison with Options API

| Feature | Options API | Composition API |
|---------|-------------|-----------------|
| Code organization | By option type | By feature |
| Logic reuse | Mixins (naming conflicts) | Composables (explicit imports) |
| Type inference | Average | Excellent |
| Learning curve | Simple | Needs understanding of reactivity |
| Use cases | Simple components | Complex components |

## Migration Strategy

```javascript
// Step 1: Use Options API within setup (compatibility mode)
export default {
    setup() {
        // Traditional syntax still works
    },
    data() { /* ... */ },
    methods: { /* ... */ }
}

// Step 2: Gradually migrate to Composition API
export default {
    setup() {
        // New logic uses Composition API
        const count = ref(0)
        return { count }
    },
    // Old logic temporarily retained
    methods: { /* ... */ }
}

// Step 3: Complete migration
export default {
    setup() {
        // All logic here
    }
}
```

## Summary

1. **Composition API solves code organization**: By feature, not by option type
2. **Composables are the best way to reuse logic**: Clearer and safer than Mixins
3. **ref vs reactive is not either-or**: Choose based on scenario, ref is more universal
4. **watchEffect is ideal for side effects**: Automatically tracks dependencies, cleaner code
5. **Migration is progressive**: No need to change everything at once

Composition API is not a replacement for Options API, but a new way to organize code. Choose what works best for your project and team.
