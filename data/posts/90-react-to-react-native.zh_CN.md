---
title: "从 React 到 React Native：前端工程师的跨平台之路"
tag: react-native
description: 帮助 React 开发者平滑过渡到 React Native，理解核心差异和最佳实践，快速构建移动应用。
date: "2024-10-25T08:00:00.000Z"
---

## 目标

本文旨在帮助有 React 经验的前端开发者快速上手 React Native，理解两者的核心差异，掌握移动端特有的开发技巧和最佳实践。

## 背景

React Native 让 Web 开发者能够使用熟悉的 React 语法构建原生移动应用。对于已经掌握 React 的开发者来说，学习 React Native 的曲线相对平缓，但仍有一些关键差异需要注意。

### React vs React Native

| 特性 | React (Web) | React Native |
|------|-------------|--------------|
| 渲染目标 | DOM | 原生组件 |
| 样式系统 | CSS | StyleSheet (Flexbox) |
| 导航 | React Router | React Navigation |
| 状态管理 | Redux/Zustand | 相同 |
| 网络请求 | fetch/axios | 相同 |
| 平台 | 浏览器 | iOS/Android |

## 一、核心概念差异

### 渲染层差异

```tsx
// React (Web)
function App() {
  return (
    <div className="container">
      <h1>Hello</h1>
      <p>World</p>
    </div>
  );
}

// React Native
function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hello</Text>
      <Text>World</Text>
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

### 样式系统差异

```tsx
// React (Web) - CSS
.container {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 20px;
}

.title {
  font-size: 24px;
  font-weight: bold;
  color: #333;
}

// React Native - StyleSheet
const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
});
```

### 常用组件映射

```tsx
// Web → React Native
<div> → <View>
<span> → <Text>
<p> → <Text>
<button> → <TouchableOpacity> 或 <Pressable>
<input> → <TextInput>
<img> → <Image>
<ul> → <FlatList> 或 <ScrollView>
```

## 二、布局系统

### Flexbox 差异

```tsx
// React Native 默认 flexDirection 是 column
// Web 默认 flexDirection 是 row

// React (Web)
.container {
  display: flex;
  flex-direction: row;  // 默认值
}

// React Native
const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'column',  // 默认值，需要显式声明
  },
});
```

### 响应式布局

```tsx
import { Dimensions, PixelRatio } from 'react-native';

const { width, height } = Dimensions.get('window');

// 基于设计稿的适配方案
const guidelineBaseWidth = 375;
const guidelineBaseHeight = 812;

export const scale = (size: number) => 
  (width / guidelineBaseWidth) * size;

export const verticalScale = (size: number) => 
  (height / guidelineBaseHeight) * size;

export const moderateScale = (size: number, factor = 0.5) => 
  size + (scale(size) - size) * factor;

// 使用
const styles = StyleSheet.create({
  title: {
    fontSize: moderateScale(18),
    padding: scale(10),
  },
});
```

### 安全区域

```tsx
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';

function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <Text>内容会自动避开刘海和底部指示条</Text>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
```

## 三、导航系统

### React Navigation 基础

```tsx
// 安装
// npm install @react-navigation/native @react-navigation/native-stack
// npm install react-native-screens react-native-safe-area-context

import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

type RootStackParamList = {
  Home: undefined;
  Profile: { userId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Home">
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ title: '个人资料' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// 页面导航
function HomeScreen({ navigation }) {
  return (
    <Button
      title="查看资料"
      onPress={() => navigation.navigate('Profile', { userId: '123' })}
    />
  );
}

// 接收参数
function ProfileScreen({ route }) {
  const { userId } = route.params;
  return <Text>User ID: {userId}</Text>;
}
```

### Tab 导航

```tsx
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

const Tab = createBottomTabNavigator();

function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
```

## 四、状态管理

### 相同的 Redux/Zustand

```tsx
// 状态管理库在 React Native 中完全相同
import { create } from 'zustand';

interface AppState {
  user: User | null;
  setUser: (user: User | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));

// 使用
function ProfileScreen() {
  const { user, setUser } = useAppStore();
  
  return (
    <View>
      {user ? <Text>{user.name}</Text> : <Text>未登录</Text>}
    </View>
  );
}
```

### 本地存储

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';

// 保存数据
await AsyncStorage.setItem('user', JSON.stringify(userData));

// 读取数据
const userData = await AsyncStorage.getItem('user');

// 删除数据
await AsyncStorage.removeItem('user');

// 使用 Zustand + persist 中间件
import { persist, createJSONStorage } from 'zustand/middleware';

const useStore = create(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
    }),
    {
      name: 'app-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
```

## 五、API 调用

### 网络请求

```tsx
// React 和 React Native 使用相同的 fetch API
async function fetchUsers() {
  try {
    const response = await fetch('https://api.example.com/users');
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}

// 使用 Axios（与 React 相同）
import axios from 'axios';

const api = axios.create({
  baseURL: 'https://api.example.com',
  timeout: 10000,
});

api.interceptors.request.use((config) => {
  // 添加 token
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

### 离线处理

```tsx
import NetInfo from '@react-native-community/netinfo';

function useNetworkStatus() {
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsConnected(state.isConnected ?? false);
    });

    return () => unsubscribe();
  }, []);

  return isConnected;
}

// 在请求中使用
async function fetchData() {
  const isConnected = await NetInfo.fetch();
  
  if (!isConnected) {
    // 使用缓存数据
    return await getCachedData();
  }
  
  try {
    const data = await api.get('/data');
    await cacheData(data);
    return data;
  } catch (error) {
    return await getCachedData();
  }
}
```

## 六、原生功能访问

### 设备信息

```tsx
import { Platform } from 'react-native';

// 获取平台信息
const os = Platform.OS;  // 'ios' 或 'android'
const version = Platform.Version;

// 平台特定代码
const styles = StyleSheet.create({
  container: {
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
      },
      android: {
        elevation: 4,
      },
    }),
  },
});
```

### 相机和相册

```tsx
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

// 请求权限
const { status } = await Camera.requestCameraPermissionsAsync();

// 拍照
const takePicture = async (cameraRef) => {
  const photo = await cameraRef.current.takePictureAsync();
  console.log(photo.uri);
};

// 选择图片
const pickImage = async () => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });

  if (!result.canceled) {
    console.log(result.assets[0].uri);
  }
};
```

### 推送通知

```tsx
import * as Notifications from 'expo-notifications';

// 请求权限
const { status } = await Notifications.requestPermissionsAsync();

// 监听通知
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// 订阅推送
const subscribeToPush = async () => {
  const token = await Notifications.getExpoPushTokenAsync();
  // 将 token 发送到服务器
  await sendTokenToServer(token.data);
};
```

## 七、性能优化

### 列表优化

```tsx
import { FlatList } from 'react-native';
import { FlashList } from '@shopify/flash-list';

// 使用 FlashList 替代 FlatList
function UserList({ users }) {
  return (
    <FlashList
      data={users}
      renderItem={({ item }) => <UserCard user={item} />}
      estimatedItemSize={80}
      keyExtractor={(item) => item.id}
    />
  );
}
```

### 图片优化

```tsx
import FastImage from 'react-native-fast-image';

function OptimizedImage({ uri }) {
  return (
    <FastImage
      style={styles.image}
      source={{
        uri,
        priority: FastImage.priority.normal,
        cache: FastImage.cacheControl.immutable,
      }}
      resizeMode={FastImage.resizeMode.cover}
    />
  );
}
```

### 动画优化

```tsx
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated';

function AnimatedBox() {
  const offset = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  return (
    <Animated.View style={[styles.box, animatedStyle]} />
  );
}
```

## 八、调试工具

### React Native Debugger

```bash
# 安装
brew install --cask react-native-debugger

# 使用
# 在模拟器中摇一摇 → Debug → Debug with Chrome
```

### Flipper

```bash
# 安装
brew install --cask flipper

# 集成到项目
# 在 android/app/build.gradle 中添加
debugImplementation 'com.facebook.flipper:flipper:+'
```

## 九、实战迁移清单

```markdown
## React → React Native 迁移清单

### 基础设施
- [ ] 安装 React Native CLI 或 Expo
- [ ] 配置 TypeScript
- [ ] 设置 ESLint 和 Prettier
- [ ] 配置 Git hooks

### 核心组件
- [ ] 替换 HTML 标签为 RN 组件
- [ ] 迁移 CSS 到 StyleSheet
- [ ] 实现响应式布局

### 状态管理
- [ ] 迁移 Redux/Zustand（通常无需修改）
- [ ] 实现本地存储

### 导航
- [ ] 实现 React Navigation
- [ ] 迁移路由逻辑

### API 调用
- [ ] 迁移网络请求（通常无需修改）
- [ ] 实现离线处理

### 原生功能
- [ ] 集成相机/相册
- [ ] 集成推送通知
- [ ] 实现设备信息获取

### 测试
- [ ] 编写单元测试
- [ ] 编写组件测试
- [ ] 编写集成测试
```

## 总结

| 维度 | React | React Native | 迁移成本 |
|------|-------|--------------|----------|
| 组件语法 | 相同 | 相同 | 低 |
| 状态管理 | 相同 | 相同 | 低 |
| API 调用 | 相同 | 相同 | 低 |
| 样式 | CSS | StyleSheet | 中 |
| 导航 | React Router | React Navigation | 高 |
| 原生功能 | 浏览器 API | 原生 API | 中 |

**姐姐的建议**：

1. **先学 React**：确保 React 基础扎实
2. **从 Expo 开始**：Expo 降低了入门门槛
3. **理解差异**：重点关注样式和导航的差异
4. **多实践**：移动端开发需要实际动手
5. **关注社区**：React Native 社区非常活跃

React 到 React Native 的迁移比想象中容易，关键在于理解移动端的特性。希望这篇指南能帮助前端工程师顺利开启跨平台开发之旅。
