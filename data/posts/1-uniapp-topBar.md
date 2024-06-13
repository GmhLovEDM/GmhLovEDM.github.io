---
title: Implementing a Highly Customizable Topbar
tag: uniapp
description: As business requirements continue to evolve, implementing a highly customizable topbar is becoming increasingly urgent. This article will start from scratch to implement a perfect topbar that supports WeChat Mini Programs.
date: "2024-06-13T13:00:00.000Z"
---


## Preface

As business needs evolve, implementing a highly customizable topbar becomes imperative. This article will start from scratch to implement a perfect topbar that fully supports WeChat Mini Programs.

## Confirm Requirements

In the standard uniapp development environment, the topbar is usually fixed and cannot be customized. This restricts our design freedom, so we need to develop a new, highly customizable topbar. In this customized topbar, we expect to achieve the following functions:

- **Display of the Main Title**: Place the main title in the middle of the topbar to ensure it is clearly visible when the page loads.
- **Display of the Subtitle**: The subtitle is located on the left side of the topbar, providing additional information or defining the return button.
- **Dynamic Interaction**: When the user scrolls the page, the main title is hidden and the subtitle is displayed.

## How to Get the Topbar Height

uniapp provides two APIs:

### Synchronous System Information Acquisition

- `getSystemInfoSync()`
  > Code example:
  >
  > ``` typescript
  > const { statusBarHeight } = uni.getSystemInfoSync();
  > ```

### Get the Layout Position Information of the Menu Button in Mini Programs

- `getMenuButtonBoundingClientRect()`
  > Code example:
  >
  > ``` typescript
  > const { width, height, top } = uni.getMenuButtonBoundingClientRect();
  > ```

### Calculating Height

#### Status Bar Height

``` typescript
// Get status bar height
const { statusBarHeight, windowHeight, screenHeight } = uni.getSystemInfoSync();
heightAttribute.statusBarHeight = statusBarHeight;
```

#### Capsule Button Height

Next, get the layout position information of the capsule button.

``` typescript
// Get capsule button information
const { width, height, top } = uni.getMenuButtonBoundingClientRect();
heightAttribute.menuButtonInfo = { width, height, top };

// Top margin of capsule button relative to navigation bar
const topDistance = heightAttribute.menuButtonInfo.top - heightAttribute.statusBarHeight;
```

#### Navigation Bar Height

With the status bar height and capsule button position information, we can calculate the height of the navigation bar. The top margin of the capsule button relative to the status bar is obtained by subtracting the status bar height `statusBarHeight` from the top position of the capsule button.

``` typescript
// Calculate navigation bar height
heightAttribute.musicheadHeight = heightAttribute.menuButtonInfo.height + topDistance * 2;
```

### Height Calculation Code Example

``` typescript
onReady(() => {
  // #ifdef  MP-WEIXIN
    // Get status bar height
    const { statusBarHeight, windowHeight, screenHeight } =
        uni.getSystemInfoSync();
    heightAttribute.statusBarHeight = statusBarHeight;

    // Get capsule button information
    const { width, height, top } = uni.getMenuButtonBoundingClientRect();
    heightAttribute.menuButtonInfo = { width, height, top };

    // Top margin of capsule button relative to navigation bar
    const topDistance = heightAttribute.menuButtonInfo.top - heightAttribute.statusBarHeight;

    // Calculate navigation bar height
    heightAttribute.musicheadHeight = heightAttribute.menuButtonInfo.height + topDistance * 2;

    // Pass navigation bar height
    emit(
        "currentHeight",
        heightAttribute.menuButtonInfo.height + topDistance * 2
    );

    // Pass remaining page height
    emit(
        "remainingHeight",
        heightAttribute.statusBarHeight + heightAttribute.musicheadHeight
    );
  // #endif
});
```

## Specific Implementation

### Create New Component

Create `index.vue` in `@/components/ccic-topbar`

### Build Container

Build `Status Bar Container` and `Navigation Bar Container`

### Write Parameters

``` js
<script lang="ts" setup>
import { reactive } from "vue";
const props = defineProps<{
  // Left side
  leftText: "return-white" | "return-black" | string | number;
  // Title
  titleText: string | number;
  // Whether to display the left side
  showLeft: boolean;
  // Whether to display the title
  showTitle: boolean;
  // Whether to display the shadow
  showBoxShadow: boolean;
}>();
const emit = defineEmits<{
  (e: "remainingHeight", height: number): void;
  (e: "currentHeight", height: number): void;
}>();

const heightAttribute = reactive({
  // Capsule button information
  menuButtonInfo: {
    width: 0,
    height: 0,
    top: 0,
  },
  // Status bar height
  statusBarHeight: 0,
  // Navigation bar height
  musicheadHeight: 0,
});

// Click return
const clickReturn = () => uni.navigateBack();
</script>
```

## Write Hook

Create `useTopBar.ts` in `@/hooks/ccic-topbar`

## Reference This Component

## Lastly

> Don't forget to set `navigationStyle` to `custom` in `pages.json`

## The Last

Thanks for reading.

* Minimum code example: See [GitHub](https://github.com/GmhLovEDM/ccic-topbar)
