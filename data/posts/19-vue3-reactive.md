---
title: "Writing a Mini Reactive System: Deep Understanding of Vue 3's reactive"
tag: vue
description: By writing a simplified version of Vue 3's reactive system, deeply understand the complete process of Proxy, dependency collection, and update triggering.
date: "2022-04-15T08:00:00.000Z"
---

## Goal

Deeply understand the core principles of Vue 3's reactivity by writing a mini reactive system.

## Background

### Core Concepts of Vue 3 Reactivity

Vue 3's reactivity system is based on three core concepts:

1. **Dependency Collection (Track)**: When reactive data is read, record who is using it
2. **Update Triggering (Trigger)**: When reactive data is modified, notify all dependents
3. **Proxy Interception**: Intercept object read/write operations

### Vue 2 vs Vue 3 Reactivity

```
Vue 2: Object.defineProperty
- Can only intercept property read/write
- Cannot detect property addition/deletion
- Some array operations cannot be detected

Vue 3: Proxy
- Can intercept all operations
- Complete property addition/deletion detection
- Full array operation support
```

## Mini Reactive System Implementation

### Step 1: The effect Function

`effect` is the core of the reactivity system, wrapping functions that need reactive tracking:

```javascript
// Global variable: currently executing effect
let activeEffect = null

// Effect stack: handle nested effects
const effectStack = []

function effect(fn) {
    const effectFn = () => {
        // Clean up old dependencies
        cleanup(effectFn)

        // Push to stack
        effectStack.push(effectFn)
        activeEffect = effectFn

        // Execute the passed function (triggers dependency collection)
        fn()

        // Pop from stack
        effectStack.pop()
        activeEffect = effectStack[effectStack.length - 1]
    }

    // Store dependency relationships
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

### Step 2: Dependency Collection Data Structure

```javascript
// targetMap: WeakMap<object, Map<string, Set<effect>>>
// Storage structure: target -> key -> effects
const targetMap = new WeakMap()

// Collect dependencies
function track(target, key) {
    if (!activeEffect) return

    // Get or create Map for target
    let depsMap = targetMap.get(target)
    if (!depsMap) {
        depsMap = new Map()
        targetMap.set(target, depsMap)
    }

    // Get or create Set for key
    let deps = depsMap.get(key)
    if (!deps) {
        deps = new Set()
        depsMap.set(key, deps)
    }

    // Add current effect to dependency set
    if (!deps.has(activeEffect)) {
        deps.add(activeEffect)
        activeEffect.deps.push(deps)
    }
}

// Trigger update
function trigger(target, key) {
    const depsMap = targetMap.get(target)
    if (!depsMap) return

    const deps = depsMap.get(key)
    if (!deps) return

    // Execute all dependent effects
    deps.forEach(effectFn => {
        // Avoid infinite recursion
        if (effectFn !== activeEffect) {
            effectFn()
        }
    })
}
```

### Step 3: The reactive Function

```javascript
function reactive(obj) {
    return new Proxy(obj, {
        get(target, key, receiver) {
            // Collect dependencies
            track(target, key)

            // Recursively proxy nested objects
            const result = Reflect.get(target, key, receiver)
            if (typeof result === 'object' && result !== null) {
                return reactive(result)
            }

            return result
        },

        set(target, key, value, receiver) {
            const oldValue = target[key]
            const result = Reflect.set(target, key, value, receiver)

            // Only trigger update when value changes
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

### Step 4: The ref Function

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

## Complete Implementation

```javascript
// mini-reactive.js

// ---- Core Variables ----
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

## Testing

```javascript
// test.js
const { effect, reactive, ref, computed } = require('./mini-reactive')

// Test reactive
console.log('=== Test reactive ===')
const state = reactive({ count: 0, name: 'Zhang San' })

effect(() => {
    console.log(`count: ${state.count}`)
})
// Output: count: 0

state.count++
// Output: count: 1

state.count++
// Output: count: 2

// Test ref
console.log('\n=== Test ref ===')
const count = ref(0)

effect(() => {
    console.log(`ref count: ${count.value}`)
})
// Output: ref count: 0

count.value++
// Output: ref count: 1

// Test computed
console.log('\n=== Test computed ===')
const state2 = reactive({ firstName: 'Zhang', lastName: 'San' })
const fullName = computed(() => `${state2.firstName}${state2.lastName}`)

effect(() => {
    console.log(`fullName: ${fullName.value}`)
})
// Output: fullName: ZhangSan

state2.firstName = 'Li'
// Output: fullName: LiSan
```

## Key Concepts in Vue 3 Source Code

### 1. Effect Scheduler

```javascript
// Vue 3's effect supports scheduler
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

### 2. Avoiding Infinite Recursion

```javascript
// Check if it's the currently executing effect in trigger
function trigger(target, key) {
    // ...
    deps.forEach(effectFn => {
        if (effectFn !== activeEffect) {
            effectFn()
        }
    })
}
```

### 3. Dependency Cleanup

```javascript
// Clean up old dependencies before each effect execution
function effect(fn) {
    const effectFn = () => {
        cleanup(effectFn)  // Clean up old dependencies
        // ...
    }
}
```

## Comparison with Vue 3 Source Code

| Feature | Our Implementation | Vue 3 Source Code |
|---------|-------------------|-------------------|
| reactive | Basic Proxy | Deep proxy, caching, marking |
| ref | Basic implementation | More optimizations |
| effect | Basic implementation | Scheduler, priority |
| computed | Simplified version | Complete lazy evaluation |
| Dependency cleanup | Basic implementation | More refined cleanup |

## Summary

1. **Proxy is the foundation of reactivity**: Intercept object read/write operations
2. **Dependency collection uses WeakMap + Map + Set**: Three-layer structure for storing dependencies
3. **Effect is the core of reactivity**: Wraps functions that need reactive tracking
4. **Trigger fires updates**: Notifies all dependent effects to re-execute
5. **Dependency cleanup is important**: Prevents memory leaks and invalid updates

By writing this mini reactive system, you should understand the core principles of Vue 3's reactivity. This knowledge is very helpful for debugging Vue applications and optimizing performance.
