---
title: "React Native Expo 实战：快速构建跨平台应用"
tag: react-native
description: 全面介绍 React Native Expo 的开发流程，从项目创建到发布上架，涵盖 Expo SDK、EAS Build 和原生模块集成。
date: "2024-07-15T08:00:00.000Z"
---

## 目标

本文旨在帮助前端开发者快速上手 React Native Expo，掌握使用 Expo 生态系统构建、测试和发布跨平台移动应用的完整流程。

## 背景

React Native 让 JavaScript 开发者能够构建原生移动应用，但传统的 React Native 开发需要配置 Android Studio、Xcode 等复杂的原生开发环境。Expo 的出现极大地降低了这个门槛。

### Expo 的定位

Expo 是一个围绕 React Native 构建的开发平台，提供：

1. **零配置开发**：无需 Xcode/Android Studio 即可开始
2. **托管工作流**：EAS Build 云端构建
3. **丰富的 API**：摄像头、位置、通知等开箱即用
4. ** Expo Go**：手机上的开发预览工具

截至 2024 年，Expo 已经成为 React Native 开发的推荐方式，连 React Native 官方文档都优先推荐使用 Expo。

## 一、环境搭建与项目创建

### 安装 Expo CLI

```bash
# 全局安装 Expo CLI
npm install -g expo-cli

# 或使用 npx 直接运行
npx create-expo-app@latest my-app

# 进入项目
cd my-app
```

### 项目结构

```
my-app/
├── app/                    # 应用路由（Expo Router）
│   ├── (tabs)/            # Tab 导航
│   │   ├── index.tsx      # 首页
│   │   ├── explore.tsx    # 探索页
│   │   └── _layout.tsx    # Tab 布局
│   ├── _layout.tsx        # 根布局
│   └── [id].tsx           # 动态路由
├── assets/                # 静态资源
├── components/            # 可复用组件
├── constants/             # 常量配置
├── hooks/                 # 自定义 Hooks
├── app.json              # Expo 配置
├── package.json
└── tsconfig.json
```

### 启动开发服务器

```bash
# 启动 Expo 开发服务器
npx expo start

# 用 Expo Go 扫描二维码
# 或按 a 打开 Android 模拟器
# 或按 i 打开 iOS 模拟器
```

## 二、Expo Router：文件系统路由

Expo Router 是 Expo 推荐的路由方案，类似于 Next.js 的文件系统路由：

### 基础路由

```tsx
// app/index.tsx - 首页路由 "/"
import { View, Text, StyleSheet } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>首页</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
  },
});
```

### 动态路由

```tsx
// app/user/[id].tsx - 动态路由 "/user/123"
import { useLocalSearchParams } from 'expo-router';

export default function UserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  
  return (
    <View style={styles.container}>
      <Text>用户 ID: {id}</Text>
    </View>
  );
}
```

### 布局路由

```tsx
// app/_layout.tsx - 根布局
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

// app/(tabs)/_layout.tsx - Tab 布局
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen
        name="index"
        options={{
          title: '首页',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
```

## 三、Expo API 实战

### 权限管理

```tsx
import * as Camera from 'expo-camera';
import * as Location from 'expo-location';
import { useEffect } from 'react';

export function usePermissions() {
  useEffect(() => {
    (async () => {
      // 请求相机权限
      const { status: cameraStatus } = await Camera.requestCameraPermissionsAsync();
      
      // 请求位置权限
      const { status: locationStatus } = await Location.requestForegroundPermissionsAsync();
      
      console.log('Camera:', cameraStatus, 'Location:', locationStatus);
    })();
  }, []);
}
```

### 相机使用

```tsx
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState } from 'react';
import { View, Button, Image } from 'react-native';

export default function CameraScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<string | null>(null);

  if (!permission) {
    return <View />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Button title="授予权限" onPress={requestPermission} />
      </View>
    );
  }

  const takePicture = async () => {
    // 注意：新版本使用 CameraView
    // const photo = await cameraRef.current.takePictureAsync();
    // setPhoto(photo.uri);
  };

  return (
    <View style={styles.container}>
      {photo ? (
        <Image source={{ uri: photo }} style={styles.preview} />
      ) : (
        <CameraView style={styles.camera} facing="back">
          <Button title="拍照" onPress={takePicture} />
        </CameraView>
      )}
    </View>
  );
}
```

### 位置服务

```tsx
import * as Location from 'expo-location';
import { useState, useEffect } from 'react';

export function useCurrentLocation() {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setError('位置权限被拒绝');
          return;
        }

        const location = await Location.getCurrentPositionAsync({});
        setLocation(location);
      } catch (err) {
        setError('获取位置失败');
      }
    })();
  }, []);

  return { location, error };
}
```

### 通知

```tsx
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

// 配置通知处理
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function useNotifications() {
  useEffect(() => {
    // 请求权限
    const requestPermissions = async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        alert('通知权限被拒绝');
      }
    };

    requestPermissions();
  }, []);

  const sendNotification = async (title: string, body: string) => {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
      },
      trigger: null, // 立即发送
    });
  };

  return { sendNotification };
}
```

## 四、状态管理

### 使用 Zustand

Zustand 是轻量级状态管理库，在 React Native 中表现优异：

```tsx
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface UserState {
  user: { id: string; name: string; email: string } | null;
  setUser: (user: UserState['user']) => void;
  logout: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
      logout: () => set({ user: null }),
    }),
    {
      name: 'user-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

// 使用
function ProfileScreen() {
  const { user, setUser, logout } = useUserStore();
  
  return (
    <View>
      {user ? (
        <>
          <Text>{user.name}</Text>
          <Button title="退出登录" onPress={logout} />
        </>
      ) : (
        <Button title="登录" onPress={() => setUser({ id: '1', name: 'John', email: 'john@example.com' })} />
      )}
    </View>
  );
}
```

## 五、构建与发布

### 开发阶段

```bash
# 开发模式
npx expo start

# 清除缓存
npx expo start --clear

# 使用特定平台
npx expo start --ios
npx expo start --android
```

### 使用 EAS Build

EAS (Expo Application Services) 是 Expo 的云构建服务：

```bash
# 安装 EAS CLI
npm install -g eas-cli

# 登录 Expo 账号
eas login

# 初始化 EAS 配置
eas build:configure

# 构建开发版本
eas build --profile development --platform ios

# 构建生产版本
eas build --profile production --platform android
```

### eas.json 配置

```json
{
  "cli": {
    "version": ">= 5.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal"
    },
    "production": {}
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "your-apple-id",
        "ascAppId": "your-app-store-connect-app-id"
      }
    }
  }
}
```

### 提交到应用商店

```bash
# iOS App Store
eas submit --platform ios

# Google Play Store
eas submit --platform android

# 自动版本号管理
eas build --auto-version
```

## 六、性能优化

### 图片优化

```tsx
import { Image } from 'expo-image';

// 使用 expo-image 替代 React Native Image
<Image
  source={{ uri: 'https://example.com/image.jpg' }}
  style={styles.image}
  contentFit="cover"
  transition={1000} // 淡入效果
  cachePolicy="memory-disk" // 缓存策略
/>
```

### 列表优化

```tsx
import { FlashList } from '@shopify/flash-list';

// 使用 FlashList 替代 FlatList
<FlashList
  data={items}
  renderItem={({ item }) => <ItemCard item={item} />}
  estimatedItemSize={100}
  keyExtractor={(item) => item.id}
/>
```

### 动画优化

```tsx
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring 
} from 'react-native-reanimated';

function AnimatedBox() {
  const offset = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  const handlePress = () => {
    offset.value = withSpring(offset.value === 0 ? 100 : 0);
  };

  return (
    <Animated.View style={[styles.box, animatedStyle]}>
      <Button title="动画" onPress={handlePress} />
    </Animated.View>
  );
}
```

## 七、调试工具

### React Native Debugger

```bash
# 安装
brew install --cask react-native-debugger

# 或使用 Flipper
npx flipper-server
```

### Expo DevTools

```bash
# 打开 DevTools
npx expo start --dev-client

# 远程调试
# 在手机上摇一摇 → Debug → 远程 JS Debug
```

### 性能监控

```tsx
import { Performance } from 'expo-performance';

// 标记性能点
Performance.mark('start_fetch');

// 获取数据
await fetchData();

Performance.mark('end_fetch');
Performance.measure('fetch_data', 'start_fetch', 'end_fetch');
```

## 总结

Expo 大幅降低了 React Native 的开发门槛：

| 阶段 | 传统 React Native | Expo |
|------|-------------------|------|
| 环境配置 | 需要 Xcode + Android Studio | 只需 Node.js |
| 开发预览 | 需要模拟器 | Expo Go 扫码 |
| 原生构建 | 本地编译 | EAS 云构建 |
| 发布上架 | 手动配置 | EAS Submit |

**姐姐的建议**：

1. **新项目用 Expo**：除非有明确的原生需求，否则优先选择 Expo
2. **使用 Expo Router**：文件系统路由更直观
3. **善用 EAS**：云构建节省本地资源
4. **关注 Expo SDK 更新**：Expo 更新频率很高，及时跟进新特性

Expo 已经从"玩具"成长为生产级开发平台，2024 年选择 Expo 绝对是正确的决定。
