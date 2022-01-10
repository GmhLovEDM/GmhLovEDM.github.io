---
title: "Vue 3 Composition API 实战心得：告别 Options 焦虑"
tag: vue
description: 深入理解 Vue 3 Composition API 的设计哲学和实战技巧，从 Options API 到 Composition API 的思维转变。
date: "2022-01-10T08:00:00.000Z"
---

## 目标

理解 Composition API 解决的核心问题，掌握其在真实项目中的最佳实践。

## 背景

### Options API 的痛点

在 Vue 2 的 Options API 中，一个组件的逻辑被按选项类型分割：

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
        // 计算属性分散在这里
        doubleCount() { return this.count * 2 },
        sortedPosts() { /* ... */ }
    },
    methods: {
        // 方法分散在这里
        increment() { this.count++ },
        fetchUser() { /* ... */ },
        fetchPosts() { /* ... */ }
    },
    watch: {
        // 监听器分散在这里
        user(newVal) { /* ... */ },
        count(newVal) { /* ... */ }
    },
    mounted() {
        // 生命周期钩子分散在这里
        this.fetchUser()
        this.fetchPosts()
    }
}
```

**问题**：当组件变得复杂时，同一个功能的代码被分散在 data、methods、computed、watch 等不同位置，阅读和维护都很困难。

### Composition API 的解决方案

```javascript
// Vue 3 Composition API
import { ref, computed, onMounted } from 'vue'

export default {
    setup() {
        // 功能 A：计数器
        const count = ref(0)
        const doubleCount = computed(() => count.value * 2)
        const increment = () => { count.value++ }

        // 功能 B：用户信息
        const user = ref(null)
        const fetchUser = async () => {
            const res = await fetch('/api/user')
            user.value = await res.json()
        }

        // 功能 C：文章列表
        const posts = ref([])
        const sortedPosts = computed(() => posts.value.sort(/* ... */))
        const fetchPosts = async () => {
            const res = await fetch('/api/posts')
            posts.value = await res.json()
        }

        // 生命周期
        onMounted(() => {
            fetchUser()
            fetchPosts()
        })

        return { count, doubleCount, increment, user, sortedPosts }
    }
}
```

**核心思想**：按功能组织代码，而不是按选项类型。

## 核心 API 详解

### 1. ref vs reactive

```javascript
import { ref, reactive } from 'vue'

// ref：基本类型和对象都可以
const count = ref(0)
console.log(count.value) // 0
count.value++ // 需要 .value

// reactive：只支持对象
const state = reactive({
    count: 0,
    user: { name: '张三' }
})
console.log(state.count) // 0
state.count++ // 不需要 .value
```

**选择建议**：
- 基本类型：必须用 ref
- 简单对象：都可以
- 复杂对象（嵌套深）：用 reactive
- 需要整体替换：用 ref（reactive 不能直接替换）

### 2. computed

```javascript
import { ref, computed } from 'vue'

const firstName = ref('张')
const lastName = ref('三')

// 只读 computed
const fullName = computed(() => `${firstName.value}${lastName.value}`)

// 可读写的 computed
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

// watch：明确指定监听源
watch(keyword, (newVal, oldVal) => {
    console.log(`搜索词从 ${oldVal} 变为 ${newVal}`)
    page.value = 1 // 搜索词变化时重置页码
})

// watchEffect：自动追踪依赖
watchEffect(() => {
    console.log(`当前页码: ${page.value}`)
    // 自动监听 page 的变化
    fetchPosts(keyword.value, page.value)
})

// 监听多个源
watch([keyword, page], ([newKeyword, newPage], [oldKeyword, oldPage]) => {
    console.log(`搜索词: ${newKeyword}, 页码: ${newPage}`)
})

// 深度监听
watch(
    () => state.user,
    (newUser) => {
        console.log('用户信息变化', newUser)
    },
    { deep: true }
)
```

## 实战：可复用的组合式函数

### 1. 数据请求

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

    // 如果 url 是 ref，自动监听变化
    if (typeof url === 'object' && url.value !== undefined) {
        watchEffect(fetchData)
    } else {
        fetchData()
    }

    return { data, error, loading, refetch: fetchData }
}

// 使用
const { data: users, loading, error } = useFetch('/api/users')
```

### 2. 分页

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

// 使用
const { data: posts, page, totalPages, nextPage, prevPage } = usePagination(
    async (page, pageSize) => {
        const res = await fetch(`/api/posts?page=${page}&size=${pageSize}`)
        return res.json()
    }
)
```

### 3. 表单验证

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
            message = `${field} 是必填项`
        } else if (rule.minLength && value.length < rule.minLength) {
            isValid = false
            message = `${field} 长度不能少于 ${rule.minLength}`
        } else if (rule.pattern && !rule.pattern.test(value)) {
            isValid = false
            message = `${field} 格式不正确`
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

// 使用
const { values, errors, validate, validateAll } = useForm(
    { username: '', email: '' },
    {
        username: { required: true, minLength: 3 },
        email: { required: true, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }
    }
)
```

## 与 Options API 的对比

| 特性 | Options API | Composition API |
|------|-------------|-----------------|
| 代码组织 | 按选项类型 | 按功能 |
| 逻辑复用 | Mixins（命名冲突） | 组合式函数（显式导入） |
| 类型推导 | 一般 | 优秀 |
| 学习曲线 | 简单 | 需要理解响应式 |
| 适用场景 | 简单组件 | 复杂组件 |

## 迁移策略

```javascript
// 步骤 1：在 setup 中使用 Options API（兼容模式）
export default {
    setup() {
        // 传统写法仍然可用
    },
    data() { /* ... */ },
    methods: { /* ... */ }
}

// 步骤 2：逐步迁移到 Composition API
export default {
    setup() {
        // 新逻辑用 Composition API
        const count = ref(0)
        return { count }
    },
    // 旧逻辑暂时保留
    methods: { /* ... */ }
}

// 步骤 3：完全迁移
export default {
    setup() {
        // 所有逻辑都在这里
    }
}
```

## 总结

1. **Composition API 解决了代码组织问题**：按功能而不是按选项类型
2. **组合式函数是复用逻辑的最佳方式**：比 Mixins 更清晰、更安全
3. **ref vs reactive 不是二选一**：根据场景选择，ref 更通用
4. **watchEffect 适合副作用**：自动追踪依赖，代码更简洁
5. **迁移是渐进的**：不需要一次性全部改完

Composition API 不是 Options API 的替代，而是一种新的组织方式。选择适合你项目和团队的方式。
