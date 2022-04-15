---
title: "手写一个迷你版响应式系统，深入理解 Vue 3 的 reactive"
tag: vue
description: 通过手写一个简化版的 Vue 3 响应式系统，深入理解 Proxy、依赖收集和触发更新的完整流程。
date: "2022-04-15T08:00:00.000Z"
---

## 目标

通过手写一个迷你版响应式系统，深入理解 Vue 3 响应式的核心原理。

## 背景

### Vue 3 响应式的核心思想

Vue 3 的响应式系统基于三个核心概念：

1. **依赖收集（Track）**：当响应式数据被读取时，记录谁在使用它
2. **触发更新（Trigger）**：当响应式数据被修改时，通知所有依赖者
3. **Proxy 代理**：拦截对象的读写操作

### Vue 2 vs Vue 3 的响应式

```
Vue 2：Object.defineProperty
- 只能拦截属性的读写
- 无法检测属性的添加/删除
- 数组的某些操作无法检测

Vue 3：Proxy
- 可以拦截所有操作
- 完整的属性增删检测
- 数组操作完全支持
```

## 迷你响应式系统实现

### 第一步：effect 函数

`effect` 是响应式系统的核心，它包装了需要响应式追踪的函数：

```javascript
// 全局变量：当前正在执行的 effect
let activeEffect = null

// effect 栈：处理嵌套的 effect
const effectStack = []

function effect(fn) {
    const effectFn = () => {
        // 清理旧的依赖
        cleanup(effectFn)

        // 入栈
        effectStack.push(effectFn)
        activeEffect = effectFn

        // 执行传入的函数（触发依赖收集）
        fn()

        // 出栈
        effectStack.pop()
        activeEffect = effectStack[effectStack.length - 1]
    }

    // 存储依赖关系
    effectFn.deps = []
    effectFn()

    return effectFn
}

function cleanup(effectFn) {
    const deps = effectFn.deps
    deps.forEach(dep => dep.delete(effectFn))
    deps.length = 0
}
```

### 第二步：依赖收集数据结构

```javascript
// targetMap：WeakMap<object, Map<string, Set<effect>>>
// 存储结构：target -> key -> effects
const targetMap = new WeakMap()

// 收集依赖
function track(target, key) {
    if (!activeEffect) return

    // 获取或创建 target 对应的 Map
    let depsMap = targetMap.get(target)
    if (!depsMap) {
        depsMap = new Map()
        targetMap.set(target, depsMap)
    }

    // 获取或创建 key 对应的 Set
    let deps = depsMap.get(key)
    if (!deps) {
        deps = new Set()
        depsMap.set(key, deps)
    }

    // 将当前 effect 添加到依赖集合
    if (!deps.has(activeEffect)) {
        deps.add(activeEffect)
        activeEffect.deps.push(deps)
    }
}

// 触发更新
function trigger(target, key) {
    const depsMap = targetMap.get(target)
    if (!depsMap) return

    const deps = depsMap.get(key)
    if (!deps) return

    // 执行所有依赖的 effect
    deps.forEach(effectFn => {
        // 避免无限递归
        if (effectFn !== activeEffect) {
            effectFn()
        }
    })
}
```

### 第三步：reactive 函数

```javascript
function reactive(obj) {
    return new Proxy(obj, {
        get(target, key, receiver) {
            // 收集依赖
            track(target, key)

            // 递归代理嵌套对象
            const result = Reflect.get(target, key, receiver)
            if (typeof result === 'object' && result !== null) {
                return reactive(result)
            }

            return result
        },

        set(target, key, value, receiver) {
            const oldValue = target[key]
            const result = Reflect.set(target, key, value, receiver)

            // 只有值变化时才触发更新
            if (oldValue !== value) {
                trigger(target, key)
            }

            return result
        },

        deleteProperty(target, key) {
            const result = Reflect.deleteProperty(target, key)
            trigger(target, key)
            return result
        }
    })
}
```

### 第四步：ref 函数

```javascript
function ref(value) {
    const refObject = {
        __isRef: true,
        get value() {
            track(refObject, 'value')
            return value
        },
        set value(newValue) {
            if (newValue !== value) {
                value = newValue
                trigger(refObject, 'value')
            }
        }
    }

    return refObject
}
```

## 完整实现

```javascript
// mini-reactive.js

// ---- 核心变量 ----
let activeEffect = null
const effectStack = []
const targetMap = new WeakMap()

// ---- effect ----
function effect(fn) {
    const effectFn = () => {
        cleanup(effectFn)
        effectStack.push(effectFn)
        activeEffect = effectFn
        fn()
        effectStack.pop()
        activeEffect = effectStack[effectStack.length - 1]
    }
    effectFn.deps = []
    effectFn()
    return effectFn
}

function cleanup(effectFn) {
    const deps = effectFn.deps
    deps.forEach(dep => dep.delete(effectFn))
    deps.length = 0
}

// ---- track & trigger ----
function track(target, key) {
    if (!activeEffect) return
    let depsMap = targetMap.get(target)
    if (!depsMap) {
        depsMap = new Map()
        targetMap.set(target, depsMap)
    }
    let deps = depsMap.get(key)
    if (!deps) {
        deps = new Set()
        depsMap.set(key, deps)
    }
    if (!deps.has(activeEffect)) {
        deps.add(activeEffect)
        activeEffect.deps.push(deps)
    }
}

function trigger(target, key) {
    const depsMap = targetMap.get(target)
    if (!depsMap) return
    const deps = depsMap.get(key)
    if (!deps) return
    deps.forEach(effectFn => {
        if (effectFn !== activeEffect) {
            effectFn()
        }
    })
}

// ---- reactive ----
function reactive(obj) {
    return new Proxy(obj, {
        get(target, key, receiver) {
            track(target, key)
            const result = Reflect.get(target, key, receiver)
            if (typeof result === 'object' && result !== null) {
                return reactive(result)
            }
            return result
        },
        set(target, key, value, receiver) {
            const oldValue = target[key]
            const result = Reflect.set(target, key, value, receiver)
            if (oldValue !== value) {
                trigger(target, key)
            }
            return result
        },
        deleteProperty(target, key) {
            const result = Reflect.deleteProperty(target, key)
            trigger(target, key)
            return result
        }
    })
}

// ---- ref ----
function ref(value) {
    const refObject = {
        __isRef: true,
        get value() {
            track(refObject, 'value')
            return value
        },
        set value(newValue) {
            if (newValue !== value) {
                value = newValue
                trigger(refObject, 'value')
            }
        }
    }
    return refObject
}

// ---- computed ----
function computed(getter) {
    let value
    let dirty = true

    const effectFn = effect(getter, {
        lazy: true,
        scheduler: () => {
            dirty = true
            trigger(computedObj, 'value')
        }
    })

    const computedObj = {
        get value() {
            if (dirty) {
                value = effectFn()
                dirty = false
                track(computedObj, 'value')
            }
            return value
        }
    }

    return computedObj
}

module.exports = { effect, reactive, ref, computed }
```

## 测试

```javascript
// test.js
const { effect, reactive, ref, computed } = require('./mini-reactive')

// 测试 reactive
console.log('=== 测试 reactive ===')
const state = reactive({ count: 0, name: '张三' })

effect(() => {
    console.log(`count: ${state.count}`)
})
// 输出: count: 0

state.count++
// 输出: count: 1

state.count++
// 输出: count: 2

// 测试 ref
console.log('\n=== 测试 ref ===')
const count = ref(0)

effect(() => {
    console.log(`ref count: ${count.value}`)
})
// 输出: ref count: 0

count.value++
// 输出: ref count: 1

// 测试 computed
console.log('\n=== 测试 computed ===')
const state2 = reactive({ firstName: '张', lastName: '三' })
const fullName = computed(() => `${state2.firstName}${state2.lastName}`)

effect(() => {
    console.log(`fullName: ${fullName.value}`)
})
// 输出: fullName: 张三

state2.firstName = '李'
// 输出: fullName: 李三
```

## Vue 3 源码中的关键概念

### 1. effect 的调度器（scheduler）

```javascript
// Vue 3 中的 effect 支持 scheduler
function effect(fn, options = {}) {
    const effectFn = () => {
        // ...
        if (options.scheduler) {
            options.scheduler(effectFn)
        } else {
            fn()
        }
        // ...
    }
    // ...
}
```

### 2. 避免无限递归

```javascript
// 在 trigger 中检查是否是当前正在执行的 effect
function trigger(target, key) {
    // ...
    deps.forEach(effectFn => {
        if (effectFn !== activeEffect) {
            effectFn()
        }
    })
}
```

### 3. 依赖清理

```javascript
// 每次执行 effect 前清理旧的依赖
function effect(fn) {
    const effectFn = () => {
        cleanup(effectFn)  // 清理旧依赖
        // ...
    }
}
```

## 与 Vue 3 源码的对比

| 特性 | 我们的实现 | Vue 3 源码 |
|------|-----------|-----------|
| reactive | 基础 Proxy | 深度代理、缓存、标记 |
| ref | 基础实现 | 更多优化 |
| effect | 基础实现 | 调度器、优先级 |
| computed | 简化版 | 完整的惰性求值 |
| 依赖清理 | 基础实现 | 更精细的清理 |

## 总结

1. **Proxy 是响应式的基础**：拦截对象的读写操作
2. **依赖收集用 WeakMap + Map + Set**：三层结构存储依赖关系
3. **effect 是响应式的核心**：包装需要响应式追踪的函数
4. **trigger 触发更新**：通知所有依赖的 effect 重新执行
5. **清理依赖很重要**：避免内存泄漏和无效更新

通过手写这个迷你响应式系统，你应该能理解 Vue 3 响应式的核心原理。这些知识对于调试 Vue 应用和优化性能都非常有帮助。
