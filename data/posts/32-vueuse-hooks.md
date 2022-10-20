---
title: "A Tour of Useful VueUse Hooks: Tools That Boost Developer Productivity"
tag: vue
description: A curated collection of the most practical VueUse hooks to dramatically improve your daily Vue 3 development workflow.
date: "2022-10-20T08:00:00.000Z"
---

## Goal

VueUse is a collection of utility functions built on top of the Vue Composition API. It provides a large number of ready-to-use hooks covering DOM manipulation, state management, animations, sensors, and many other domains. This article highlights the most practical VueUse hooks and shows how they can significantly boost your day-to-day development efficiency.

## Background

### Why VueUse

1. **Type Safety**: Full TypeScript type definitions for every function.
2. **Tree-Shakable**: Import only what you need; unused functions are eliminated from the bundle.
3. **SSR Compatible**: Every function works correctly with server-side rendering.
4. **Active Community**: Continuously maintained and updated with high quality standards.
5. **Zero Extra Dependencies**: Built entirely on the Vue core library.

### Installation

```bash
# npm
npm install @vueuse/core

# yarn
yarn add @vueuse/core

# pnpm
pnpm add @vueuse/core
```

## DOM Manipulation Hooks

### useElementSize: Get Element Dimensions

```vue
<script setup>
import { ref } from 'vue'
import { useElementSize } from '@vueuse/core'

const el = ref(null)
const { width, height } = useElementSize(el)
</script>

<template>
  <div ref="el">
    Width: {{ width }}px, Height: {{ height }}px
  </div>
</template>
```

This hook uses a `ResizeObserver` under the hood to reactively track an element's dimensions. Whenever the element resizes, `width` and `height` update automatically, making it perfect for responsive layouts and dynamic content areas.

### useIntersectionObserver: Element Visibility Detection

```vue
<script setup>
import { ref } from 'vue'
import { useIntersectionObserver } from '@vueuse/core'

const el = ref(null)
const isVisible = ref(false)

const { stop } = useIntersectionObserver(
  el,
  ([{ isIntersecting }]) => {
    isVisible.value = isIntersecting
  },
  { threshold: 0.1 }
)
</script>

<template>
  <div ref="el" :class="{ visible: isVisible }">
    This element changes style based on viewport visibility
  </div>
</template>
```

This is essential for implementing lazy loading, scroll-triggered animations, and infinite scrolling. The callback fires whenever the observed element enters or leaves the viewport, and you can configure the intersection threshold for fine-grained control.

### useScroll: Track Scroll Position

```vue
<script setup>
import { ref } from 'vue'
import { useScroll } from '@vueuse/core'

const el = ref(null)
const { x, y, isScrolling, arrivedState } = useScroll(el)

// arrivedState contains { left, right, top, bottom }
</script>

<template>
  <div ref="el" style="height: 300px; overflow: auto">
    <div style="height: 1000px">
      X: {{ x }}, Y: {{ y }}
      <br>
      Is scrolling: {{ isScrolling }}
    </div>
  </div>
</template>
```

`useScroll` provides both the current scroll coordinates and convenience flags like `isScrolling` and `arrivedState`, which tell you whether the user has reached any edge of the scroll container.

### useResizeObserver: Monitor Element Size Changes

```vue
<script setup>
import { ref } from 'vue'
import { useResizeObserver } from '@vueuse/core'

const el = ref(null)
const dimensions = ref({ width: 0, height: 0 })

useResizeObserver(el, (entries) => {
  const entry = entries[0]
  dimensions.value = {
    width: entry.contentRect.width,
    height: entry.contentRect.height
  }
})
</script>

<template>
  <div ref="el">
    Width: {{ dimensions.width }}, Height: {{ dimensions.height }}
  </div>
</template>
```

## State Management Hooks

### useLocalStorage: Persistent State with localStorage

```vue
<script setup>
import { useLocalStorage } from '@vueuse/core'

// Automatically serializes/deserializes objects
const theme = useLocalStorage('theme', 'light')
const user = useLocalStorage('user', { name: '', token: '' })

// Toggle theme
function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}
</script>

<template>
  <div :class="theme">
    <button @click="toggleTheme">Toggle Theme</button>
  </div>
</template>
```

`useLocalStorage` wraps `localStorage` with automatic JSON serialization, making it trivially simple to persist user preferences, authentication tokens, or any reactive state across browser sessions.

### useSessionStorage: Session-Scoped State

```vue
<script setup>
import { useSessionStorage } from '@vueuse/core'

// Automatically cleared when the browser tab is closed
const formData = useSessionStorage('form-data', {
  name: '',
  email: '',
  message: ''
})
</script>
```

### useDebounce: Debounce Reactive Values

```vue
<script setup>
import { ref } from 'vue'
import { useDebounce } from '@vueuse/core'

const input = ref('')
const debouncedInput = useDebounce(input, 500)

// debouncedInput updates only 500ms after input stops changing
</script>

<template>
  <input v-model="input" placeholder="Type to search...">
  <p>Search query: {{ debouncedInput }}</p>
</template>
```

This is extremely useful for search inputs, auto-save features, and any scenario where you want to limit how often an expensive operation runs in response to rapid user input.

### useThrottle: Throttle Reactive Values

```vue
<script setup>
import { ref } from 'vue'
import { useThrottle } from '@vueuse/core'

const scrollY = ref(0)
const throttledScrollY = useThrottle(scrollY, 200)

// Use with scroll events
function handleScroll() {
  scrollY.value = window.scrollY
}
</script>
```

### useToggle: Boolean State Toggle

```vue
<script setup>
import { useToggle } from '@vueuse/core'

const [isVisible, toggleVisible] = useToggle(false)
const [isLoading, toggleLoading] = useToggle(false)
</script>

<template>
  <button @click="toggleVisible">
    {{ isVisible ? 'Hide' : 'Show' }}
  </button>
  <div v-if="isVisible">Content</div>
</template>
```

## Browser API Hooks

### useOnline: Network Status Detection

```vue
<script setup>
import { useOnline } from '@vueuse/core'

const isOnline = useOnline()
</script>

<template>
  <div v-if="!isOnline" class="offline-banner">
    You are currently offline
  </div>
</template>
```

### useClipboard: Clipboard Operations

```vue
<script setup>
import { ref } from 'vue'
import { useClipboard } from '@vueuse/core'

const text = ref('Hello, VueUse!')
const { copy, copied, isSupported } = useClipboard()

async function handleCopy() {
  if (isSupported) {
    await copy(text.value)
  }
}
</script>

<template>
  <div>
    <input v-model="text">
    <button @click="handleCopy" :disabled="!isSupported">
      {{ copied ? 'Copied!' : 'Copy' }}
    </button>
  </div>
</template>
```

### useGeolocation: Geolocation Access

```vue
<script setup>
import { useGeolocation } from '@vueuse/core'

const { coords, locatedAt, error } = useGeolocation()

// coords includes latitude, longitude, accuracy, etc.
</script>

<template>
  <div v-if="!error">
    Latitude: {{ coords?.latitude }}
    <br>
    Longitude: {{ coords?.longitude }}
    <br>
    Obtained at: {{ locatedAt }}
  </div>
  <div v-else>
    Failed to get location: {{ error.message }}
  </div>
</template>
```

### usePermission: Query Browser Permissions

```vue
<script setup>
import { usePermission } from '@vueuse/core'

const cameraPermission = usePermission('camera')
const microphonePermission = usePermission('microphone')
const notificationPermission = usePermission('notifications')
</script>

<template>
  <div>
    <p>Camera permission: {{ cameraPermission }}</p>
    <p>Microphone permission: {{ microphonePermission }}</p>
    <p>Notification permission: {{ notificationPermission }}</p>
  </div>
</template>
```

## Animation and Transition Hooks

### useTransition: Animated Numeric Transitions

```vue
<script setup>
import { ref } from 'vue'
import { useTransition } from '@vueuse/core'

const source = ref(0)
const output = useTransition(source, {
  duration: 1000,
  transition: [0.68, -0.55, 0.265, 1.55] // Bezier curve
})

function increment() {
  source.value += 100
}
</script>

<template>
  <div>
    <p>Current value: {{ Math.round(output) }}</p>
    <button @click="increment">Add 100</button>
  </div>
</template>
```

`useTransition` smoothly animates a number from its current value to a new target value using configurable easing functions. It is ideal for animated counters, progress bars, and any UI that benefits from smooth numeric interpolation.

### useElementVisibility: Simple Visibility Check

```vue
<script setup>
import { ref } from 'vue'
import { useElementVisibility } from '@vueuse/core'

const el = ref(null)
const isVisible = useElementVisibility(el)
</script>

<template>
  <div ref="el" style="height: 200px; overflow: auto">
    <div style="height: 1000px">
      <p>Is element visible: {{ isVisible }}</p>
    </div>
  </div>
</template>
```

## Timer and Polling Hooks

### useInterval: Recurring Timer

```vue
<script setup>
import { ref } from 'vue'
import { useInterval } from '@vueuse/core'

const count = ref(0)
const { pause, resume, isActive } = useInterval(1000, () => {
  count.value++
})
</script>

<template>
  <div>
    <p>Count: {{ count }}</p>
    <button @click="pause" :disabled="!isActive">Pause</button>
    <button @click="resume" :disabled="isActive">Resume</button>
  </div>
</template>
```

### useTimeout: Delayed Execution

```vue
<script setup>
import { ref } from 'vue'
import { useTimeout } from '@vueuse/core'

const isReady = ref(false)
const { ready, start, stop } = useTimeout(3000, false, {
  callback: () => {
    isReady.value = true
  }
})
</script>

<template>
  <div>
    <p>Countdown complete: {{ ready }}</p>
    <button @click="start">Start Countdown</button>
    <button @click="stop">Stop</button>
  </div>
</template>
```

### useTimestamp: Live Timestamp

```vue
<script setup>
import { useTimestamp } from '@vueuse/core'

const timestamp = useTimestamp({ interval: 1000 })

// timestamp updates once per second
</script>

<template>
  <p>Current timestamp: {{ timestamp }}</p>
  <p>Current time: {{ new Date(timestamp).toLocaleString() }}</p>
</template>
```

## Event Handling Hooks

### useEventListener: Automatic Event Listener Management

```vue
<script setup>
import { ref } from 'vue'
import { useEventListener } from '@vueuse/core'

const button = ref(null)
const clickCount = ref(0)

useEventListener(button, 'click', () => {
  clickCount.value++
})
</script>

<template>
  <button ref="button">Click count: {{ clickCount }}</button>
</template>
```

`useEventListener` automatically adds the event listener when the component mounts and removes it when the component unmounts, eliminating the common source of memory leaks from forgotten cleanup.

### useKeyStroke: Keyboard Event Handling

```vue
<script setup>
import { useKeyStroke } from '@vueuse/core'

// Listen for a single key
useKeyStroke('Enter', (e) => {
  console.log('Enter was pressed')
})

// Listen for key combinations
useKeyStroke(['Control', 's'], (e) => {
  e.preventDefault()
  console.log('Ctrl + S was pressed')
})
</script>
```

### useDropZone: Drag-and-Drop Areas

```vue
<script setup>
import { ref } from 'vue'
import { useDropZone } from '@vueuse/core'

const dropZoneRef = ref(null)
const isOverDropZone = ref(false)
const files = ref([])

function onDrop(event) {
  files.value = Array.from(event.dataTransfer.files)
}

const { isOver } = useDropZone(dropZoneRef, {
  onDrop,
  onEnter: () => { isOverDropZone.value = true },
  onLeave: () => { isOverDropZone.value = false }
})
</script>

<template>
  <div 
    ref="dropZoneRef"
    :class="{ 'drop-zone-active': isOverDropZone }"
    style="height: 200px; border: 2px dashed #ccc"
  >
    <p>Drop files here</p>
    <ul>
      <li v-for="file in files" :key="file.name">{{ file.name }}</li>
    </ul>
  </div>
</template>
```

## Practical Tips

### Composing Custom Hooks from VueUse

```vue
<script setup>
import { ref } from 'vue'
import { useLocalStorage, useDebounce, useOnline } from '@vueuse/core'

// Combine multiple hooks to build complex functionality
function useAutoSaveForm() {
  const formData = useLocalStorage('form-data', {})
  const isOnline = useOnline()
  const debouncedSave = useDebounce(save, 1000)

  async function save() {
    if (!isOnline.value) return
    
    try {
      await fetch('/api/save', {
        method: 'POST',
        body: JSON.stringify(formData.value)
      })
    } catch (error) {
      console.error('Save failed:', error)
    }
  }

  function updateField(key, value) {
    formData.value[key] = value
    debouncedSave()
  }

  return {
    formData,
    updateField,
    isOnline
  }
}

const { formData, updateField, isOnline } = useAutoSaveForm()
</script>
```

This example demonstrates the real power of VueUse: combining `useLocalStorage` for persistence, `useOnline` to avoid failed requests, and `useDebounce` to prevent excessive API calls -- all composed together in a clean, reusable custom hook.

## Summary

VueUse provides a large collection of high-quality utility hooks that can dramatically improve Vue 3 development efficiency:

1. **DOM Manipulation**: `useElementSize`, `useIntersectionObserver`, `useScroll`, `useResizeObserver`
2. **State Management**: `useLocalStorage`, `useSessionStorage`, `useDebounce`, `useThrottle`, `useToggle`
3. **Browser APIs**: `useOnline`, `useClipboard`, `useGeolocation`, `usePermission`
4. **Animations and Transitions**: `useTransition`, `useElementVisibility`
5. **Timers and Polling**: `useInterval`, `useTimeout`, `useTimestamp`
6. **Event Handling**: `useEventListener`, `useKeyStroke`, `useDropZone`

By leveraging these hooks thoughtfully, you can write code that is cleaner, more maintainable, and free from the boilerplate that comes with manually wiring up browser APIs and common patterns.
