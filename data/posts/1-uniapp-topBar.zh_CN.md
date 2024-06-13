---
title: 实现一个高度定制化的 topbar
tag: uniapp
description: 随着业务需求的不断发展，实现一个高度定制化的 topbar 迫在眉睫，下文将从零开始实现一个完美支持微信小程序的 topbar
date: "2024-06-13T13:00:00.000Z"
---


## 前言

随着业务需求的不断发展，实现一个高度定制化的 topbar 迫在眉睫，下文将从零开始实现一个完美支持微信小程序的 topbar

[//]: ##最佳案例

[//]: <p align="center">
[//]: <img src="https://github.com/GmhLovEDM/bolgImage/blob/main/topbar/weChatQrCode.png?raw=true" width="200px" height="200px"  alt=""/>
[//]: </p>

## 确认需求

在标准的 uniapp 开发环境中，topbar 通常是固定并且无法自定义的。这限制了我们在设计上的自由度，因此需要开发一个新的、可高度定制的 topbar。在这个定制化的 topbar 中，我们期望实现以下功能：

- **主标题的展示**：在 topbar 的中间位置放置主标题，确保它在页面加载时清晰可见。
- **副标题的展示**：副标题位于 topbar 的左侧，提供额外的信息或定义返回按钮。
- **动态交互**：在用户滚动页面时，主标题被隐藏，副标题显示出来

## 如何获取 topbar 高度

uniapp 提供了两个 API：

### 同步获取系统信息

- [`getSystemInfoSync()`](http://uniapp.dcloud.io/api/system/info?id=getsysteminfosync)
  > 代码示例：
  >
  > ``` typescript
  > const { statusBarHeight } = uni.getSystemInfoSync();
  > ```

### 获取小程序下该菜单按钮的布局位置信息

- [`getMenuButtonBoundingClientRect()`](http://uniapp.dcloud.io/api/ui/menuButton?id=getmenubuttonboundingclientrect)
  > 代码示例：
  >
  > ``` typescript
  > const { width, height, top } = uni.getMenuButtonBoundingClientRect();
  > ```

### 计算高度

[//]: <img src="https://github.com/GmhLovEDM/bolgImage/blob/main/topbar/index.png?raw=true" width="100%" height="100%"  alt=""/>

#### 状态栏高度

``` typescript
// 获取状态栏高度
const { statusBarHeight, windowHeight, screenHeight } = uni.getSystemInfoSync();
heightAttribute.statusBarHeight = statusBarHeight;
```

#### 胶囊按钮高度

接下来，获取胶囊按钮的布局位置信息。

``` typescript
// 获取胶囊按钮信息
const { width, height, top } = uni.getMenuButtonBoundingClientRect();
heightAttribute.menuButtonInfo = { width, height, top };

// 胶囊按钮相对于离导航栏的上边距
const topDistance = heightAttribute.menuButtonInfo.top - heightAttribute.statusBarHeight;
```

#### 导航栏高度

有了状态栏高度和胶囊按钮的位置信息后，我们可以计算导航栏的高度。胶囊按钮相对于状态栏的上边距是通过胶囊按钮的顶部位置 top 减去状态栏高度 statusBarHeight 得到的。

``` typescript
// 计算导航栏高度
heightAttribute.musicheadHeight = heightAttribute.menuButtonInfo.height + topDistance * 2;
```

### 计算高度代码示例

``` typescript
onReady(() => {
  // #ifdef  MP-WEIXIN
    // 获取状态栏高度
    const { statusBarHeight, windowHeight, screenHeight } =
        uni.getSystemInfoSync();
    heightAttribute.statusBarHeight = statusBarHeight;

    // 获取胶囊按钮信息
    const { width, height, top } = uni.getMenuButtonBoundingClientRect();
    heightAttribute.menuButtonInfo = { width, height, top };

    // 胶囊按钮相对于离导航栏的上边距
    const topDistance = heightAttribute.menuButtonInfo.top - heightAttribute.statusBarHeight;

    // 计算导航栏高度
    heightAttribute.musicheadHeight = heightAttribute.menuButtonInfo.height + topDistance * 2;

    // 传递导航栏高度
    emit(
        "currentHeight",
        heightAttribute.menuButtonInfo.height + topDistance * 2
    );

    // 传递页面剩余高度
    emit(
        "remainingHeight",
        heightAttribute.statusBarHeight + heightAttribute.musicheadHeight
    );
  // #endif
});
```

## 具体实现

### 新建组件

在 `@/components/ccic-topbar` 中创建 `index.vue`

``` vue
<template>
  <view class="page"></view>
</template>

<script lang="ts" setup></script>

<style lang="scss" scoped></style>
```

### 搭建容器

搭出 `状态栏容器` 和 `导航栏容器`

``` vue
<view class="page">
    <!-- 状态栏高度 -->
    <view class="top-status"></view>
    <!-- 导航栏容器 -->
    <view class="top-bar">
        <!-- 返回 & 副标题 -->
        <view class="top-bar-left" :class="props.showLeft ? 'showLeft' : 'hideLeft'">
            <template v-if="props.leftText === 'return-black'">
                <image @tap="clickReturn" src="../../static/return-black.png" style=""></image>
            </template>
            <template v-if="props.leftText === 'return-white'">
                <image @tap="clickReturn" src="../../static/return-white.png" style=""></image>
            </template>
            <template v-else>
                <text>{{ props.leftText }}</text>
            </template>
        </view>
        <!-- 主标题 -->
        <text class="top-bar-title" :class="props.showTitle ? 'showTitle' : 'hideTitle'">{{ props.titleText }}</text>
    </view>
</view>

<script lang="ts" setup>

</script>

<style lang="scss" scoped>
	.showLeft {
		transform: translateX(0px);
		opacity: 1;
	}

	.hideLeft {
		transform: translateX(-80px);
		opacity: 0;
	}

	.showTitle {
		transform: translateX(0px);
		opacity: 1;
	}

	.hideTitle {
		transform: translateY(-60px);
		opacity: 0;
	}

	.page {
		position: sticky;
		top: 0;
		z-index: 3001;
	}

	.top-status {
		transition: all 1s;
		background-color: #409eff;
	}

	.top-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background-color: #409eff;
		transition: all 0.6s;

		.top-bar-left {
			// width: 50rpx;
			height: 50rpx;
			position: absolute;
			left: 24rpx;
			transition: all 1s;

			image {
				width: 50rpx;
				height: 50rpx;
			}

			text {
				font-family: PingFang SC;
				font-style: normal;
				font-weight: 400;
				font-size: 36rpx;
				color: #FFFFFF;
			}
		}

		.top-bar-title {
			margin: 0 auto;
			font-family: PingFang SC;
			font-style: normal;
			font-weight: 400;
			font-size: 36rpx;
			color: #FFFFFF;
			transition: all 1s;
		}
	}
</style>
```

### 编写入参

```vue
<script lang="ts" setup>
import { reactive } from "vue";
const props = defineProps<{
  // 左侧
  leftText: "return-white" | "return-black" | string | number;
  // 标题
  titleText: string | number;
  // 是否显示左侧
  showLeft: boolean;
  // 是否显示标题
  showTitle: boolean;
  // 是否显示阴影
  showBoxShadow: boolean;
}>();
const emit = defineEmits<{
  (e: "remainingHeight", height: number): void;
  (e: "currentHeight", height: number): void;
}>();

const heightAttribute = reactive({
  // 胶囊按钮信息
  menuButtonInfo: {
    width: 0,
    height: 0,
    top: 0,
  },
  // 状态栏高度
  statusBarHeight: 0,
  // 导航栏高度
  musicheadHeight: 0,
});

// 点击返回
const clickReturn = () => uni.navigateBack();
</script>
```

## 编写Hook

在 `@/hooks/ccic-topbar` 中创建 `useTopBar.ts`

```typescript
import { ref } from 'vue';
import { onPageScroll } from '@dcloudio/uni-app';

/** 获取剩余高度 */
export const useRemainingHeight = (height: number) => {
	return `height: calc(100% - (${height * 2}rpx + env(safe-area-inset-bottom)));`;
};

/** 获取组件参数 */
export const useSlideDirection = () => {
	const showLeft = ref(true);
	const showTitle = ref(false);
	const showBoxShadow = ref(false);
	let prevScrollTop = 0;

	onPageScroll((e) => {
		// 是否显示阴影
		if (e.scrollTop == 0) {
			showBoxShadow.value = false;
		} else showBoxShadow.value = true;
		// 处理IOS回弹
		if (e.scrollTop <= 0) {
			showLeft.value = true;
			showTitle.value = false;
		} else {
			// 判断滑动
			if (e.scrollTop > prevScrollTop) {
				// 向上滑动
				showLeft.value = false;
				showTitle.value = true;
			} else if (e.scrollTop < prevScrollTop) {
				// 向下滑动
				showLeft.value = true;
				showTitle.value = false;
			} else {
				// 没有滑动
				showTitle.value = true;
			}
		}
		// 记录旧的scrollTop
		prevScrollTop = e.scrollTop;
	});

	return {
		showLeft,
		showTitle,
		showBoxShadow,
		// FIXME: 需要多返回一个onPageScroll才能使其生效
		onPageScroll
	};
};
```

## 引用此组件

```vue
<template>
	<ccicTopBar leftText="中检IT视界" titleText="首页" :showLeft="showLeft" :showTitle="showTitle" :showBoxShadow="showBoxShadow" @remainingHeight="setPageHeight"></ccicTopBar>
	<view class="list" v-for="(item, index) in 100" :key="index">{{ item }}</view>
</template>

<script lang="ts" setup>
	import { ref } from 'vue';
	import ccicTopBar from '@/components/ccic-topbar';
	import { useSlideDirection, useRemainingHeight } from '@/hooks/useTopBar';

	// 顶部topbar参数
	const { showLeft, showTitle, showBoxShadow, onPageScroll } = useSlideDirection();
	void onPageScroll;

	// 获取除顶部topbar外剩余高度
	const pageHeight = ref('');
	const setPageHeight = (height: number) => {
		pageHeight.value = useRemainingHeight(height);
	};
</script>

<style></style>
```

## 最后

> 别忘了将 `pages.json` 中的 `navigationStyle` 设置为 `custom`

```javascript
"pages": [ //pages数组中第一项表示应用启动页，参考：https://uniapp.dcloud.io/collocation/pages
    {
        "path": "pages/index/index",
        "style": {
            "navigationBarTitleText": "中检IT视界"
            // 隐藏原生topbar
            "navigationStyle": "custom"
        }
    }
],
```

## 最后的最后

感谢阅读。

* 最小代码示例：详见[GitHub](https://github.com/GmhLovEDM/ccic-topbar)