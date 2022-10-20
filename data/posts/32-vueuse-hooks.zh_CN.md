---
title: "VueUse 实用 Hooks 盘点：提升开发效率的利器"
tag: vue
description: 精选 VueUse 中最实用的 Hooks，帮助 Vue 3 开发者大幅提升日常开发效率。
date: "2022-10-20T08:00:00.000Z"
---

## 目标

VueUse 是基于 Vue Composition API 的实用工具函数集合，提供了大量开箱即用的 Hooks，涵盖 DOM 操作、状态管理、动画、传感器等多个领域。本文将盘点 VueUse 中最实用的 Hooks，帮助开发者提升日常开发效率。

## 背景

### 为什么选择 VueUse

1. **类型安全**：完整的 TypeScript 类型定义
2. **按需导入**：支持 tree-shaking，只打包使用的函数
3. **SSR 兼容**：所有函数都支持服务端渲染
4. **社区活跃**：持续更新，质量有保障
5. **零依赖**：基于 Vue 核心库，无额外依赖

### 安装与使用

```bash
# npm
npm install @vueuse/core

# yarn
yarn add @vueuse/core

# pnpm
pnpm add @vueuse/core
```

## DOM 操作类 Hooks

### useElementSize：获取元素尺寸

```vue
<script setup>
import { ref } from 'vue'
import { useElementSize } from '@vueuse/core'

const el = ref(null)
const { width, height } = useElementSize(el)
</script>

<template>
  <div ref="el">
    宽度: {{ width }}px, 高度: {{ height }}px
  </div>
</template>
```

### useIntersectionObserver：元素可见性检测

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
    我会根据是否在视口中改变样式
  </div>
</template>
```

### useScroll：滚动位置监听

```vue
<script setup>
import { ref } from 'vue'
import { useScroll } from '@vueuse/core'

const el = ref(null)
const { x, y, isScrolling, arrivedState } = useScroll(el)

// arrivedState 包含 { left, right, top, bottom }
</script>

<template>
  <div ref="el" style="height: 300px; overflow: auto">
    <div style="height: 1000px">
      X: {{ x }}, Y: {{ y }}
      <br>
      是否正在滚动: {{ isScrolling }}
    </div>
  </div>
</template>
```

### useResizeObserver：监听元素尺寸变化

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
    宽度: {{ dimensions.width }}, 高度: {{ dimensions.height }}
  </div>
</template>
```

## 状态管理类 Hooks

### useLocalStorage：本地存储状态

```vue
<script setup>
import { useLocalStorage } from '@vueuse/core'

// 自动序列化/反序列化
const theme = useLocalStorage('theme', 'light')
const user = useLocalStorage('user', { name: '', token: '' })

// 切换主题
function toggleTheme() {
  theme.value = theme.value === 'light' ? 'dark' : 'light'
}
</script>

<template>
  <div :class="theme">
    <button @click="toggleTheme">切换主题</button>
  </div>
</template>
```

### useSessionStorage：会话存储状态

```vue
<script setup>
import { useSessionStorage } from '@vueuse/core'

// 页面关闭后自动清除
const formData = useSessionStorage('form-data', {
  name: '',
  email: '',
  message: ''
})
</script>
```

### useDebounce：防抖处理

```vue
<script setup>
import { ref } from 'vue'
import { useDebounce } from '@vueuse/core'

const input = ref('')
const debouncedInput = useDebounce(input, 500)

// debouncedInput 会在 input 停止更新 500ms 后才更新
</script>

<template>
  <input v-model="input" placeholder="输入搜索内容">
  <p>搜索: {{ debouncedInput }}</p>
</template>
```

### useThrottle：节流处理

```vue
<script setup>
import { ref } from 'vue'
import { useThrottle } from '@vueuse/core'

const scrollY = ref(0)
const throttledScrollY = useThrottle(scrollY, 200)

// 在滚动事件中使用
function handleScroll() {
  scrollY.value = window.scrollY
}
</script>
```

### useToggle：切换布尔值

```vue
<script setup>
import { useToggle } from '@vueuse/core'

const [isVisible, toggleVisible] = useToggle(false)
const [isLoading, toggleLoading] = useToggle(false)
</script>

<template>
  <button @click="toggleVisible">
    {{ isVisible ? '隐藏' : '显示' }}
  </button>
  <div v-if="isVisible">内容</div>
</template>
```

## 浏览器 API 类 Hooks

### useOnline：网络状态检测

```vue
<script setup>
import { useOnline } from '@vueuse/core'

const isOnline = useOnline()
</script>

<template>
  <div v-if="!isOnline" class="offline-banner">
    您当前处于离线状态
  </div>
</template>
```

### useClipboard：剪贴板操作

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
      {{ copied ? '已复制!' : '复制' }}
    </button>
  </div>
</template>
```

### useGeolocation：地理位置获取

```vue
<script setup>
import { useGeolocation } from '@vueuse/core'

const { coords, locatedAt, error } = useGeolocation()

// coords 包含 latitude, longitude, accuracy 等
</script>

<template>
  <div v-if="!error">
    纬度: {{ coords?.latitude }}
    <br>
    经度: {{ coords?.longitude }}
    <br>
    获取时间: {{ locatedAt }}
  </div>
  <div v-else>
    获取位置失败: {{ error.message }}
  </div>
</template>
```

### usePermission：权限查询

```vue
<script setup>
import { usePermission } from '@vueuse/core'

const cameraPermission = usePermission('camera')
const microphonePermission = usePermission('microphone')
const notificationPermission = usePermission('notifications')
</script>

<template>
  <div>
    <p>摄像头权限: {{ cameraPermission }}</p>
    <p>麦克风权限: {{ microphonePermission }}</p>
    <p>通知权限: {{ notificationPermission }}</p>
  </div>
</template>
```

## 动画与过渡类 Hooks

### useTransition：数值过渡动画

```vue
<script setup>
import { ref } from 'vue'
import { useTransition } from '@vueuse/core'

const source = ref(0)
const output = useTransition(source, {
  duration: 1000,
  transition: [0.68, -0.55, 0.265, 1.55] // 贝塞尔曲线
})

function increment() {
  source.value += 100
}
</script>

<template>
  <div>
    <p>当前值: {{ Math.round(output) }}</p>
    <button @click="increment">增加 100</button>
  </div>
</template>
```

### useElementVisibility：元素可见性

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
      <p>元素是否可见: {{ isVisible }}</p>
    </div>
  </div>
</template>
```

## 定时器与轮询类 Hooks

### useInterval：定时器

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
    <p>计数: {{ count }}</p>
    <button @click="pause" :disabled="!isActive">暂停</button>
    <button @click="resume" :disabled="isActive">恢复</button>
  </div>
</template>
```

### useTimeout：延迟执行

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
    <p>倒计时是否完成: {{ ready }}</p>
    <button @click="start">开始倒计时</button>
    <button @click="stop">停止</button>
  </div>
</template>
```

### useTimestamp：时间戳更新

```vue
<script setup>
import { useTimestamp } from '@vueuse/core'

const timestamp = useTimestamp({ interval: 1000 })

// timestamp 每秒更新一次
</script>

<template>
  <p>当前时间戳: {{ timestamp }}</p>
  <p>当前时间: {{ new Date(timestamp).toLocaleString() }}</p>
</template>
```

## 事件处理类 Hooks

### useEventListener：事件监听

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
  <button ref="button">点击次数: {{ clickCount }}</button>
</template>
```

### useKeyStroke：键盘事件

```vue
<script setup>
import { useKeyStroke } from '@vueuse/core'

// 监听单个按键
useKeyStroke('Enter', (e) => {
  console.log('回车被按下')
})

// 监听组合键
useKeyStroke(['Control', 's'], (e) => {
  e.preventDefault()
  console.log('Ctrl + S 被按下')
})
</script>
```

### useDropZone：拖放区域

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
    <p>拖放文件到此处</p>
    <ul>
      <li v-for="file in files" :key="file.name">{{ file.name }}</li>
    </ul>
  </div>
</template>
```

## 实用技巧

### 自定义 Hook 组合

```vue
<script setup>
import { ref } from 'vue'
import { useLocalStorage, useDebounce, useOnline } from '@vueuse/core'

// 组合多个 Hooks 实现复杂功能
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
      console.error('保存失败:', error)
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

## 总结

VueUse 提供了大量高质量的实用 Hooks，能够显著提升 Vue 3 开发效率：

1. **DOM 操作**：useElementSize、useIntersectionObserver、useScroll
2. **状态管理**：useLocalStorage、useDebounce、useToggle
3. **浏览器 API**：useOnline、useClipboard、useGeolocation
4. **动画过渡**：useTransition、useElementVisibility
5. **定时器轮询**：useInterval、useTimeout、useTimestamp
6. **事件处理**：useEventListener、useKeyStroke、useDropZone

合理使用这些 Hooks，能够让你的代码更简洁、更易维护，同时避免重复造轮子。
