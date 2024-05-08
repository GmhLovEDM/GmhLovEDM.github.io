---
title: "React Native 导航方案对比：React Navigation vs Expo Router"
tag: react-native
description: 深入对比 React Navigation 和 Expo Router 两大 React Native 导航方案，从 API 设计到性能优化，帮助开发者做出合理选择。
date: "2024-05-08T08:00:00.000Z"
---

## 目标

导航是移动应用的核心基础设施。React Navigation 是 React Native 生态中最成熟的导航库，而 Expo Router 是基于文件系统的新型导航方案。本文深入对比两者的架构差异、API 设计和适用场景。

## 背景

### 导航方案的演进

```
React Navigation 1.x (2017)：基于 JavaScript 状态
React Navigation 2.x (2018)：引入 Stack 导航
React Navigation 3.x (2019)：Hook API
React Navigation 4.x (2019)：性能优化
React Navigation 5.x (2020)：完全重写
React Navigation 6.x (2022)：稳定成熟
Expo Router 1.0 (2023)：基于文件系统的导航
Expo Router 2.0 (2024)：完全稳定
```

### 两种方案的定位

- **React Navigation**：通用的 React Native 导航库，适用于所有项目
- **Expo Router**：基于文件系统的导航，适用于 Expo 项目

## React Navigation

### 基本配置

```bash
# 安装依赖
npx expo install @react-navigation/native
npx expo install react-native-screens react-native-safe-area-context
```

### Stack 导航

```tsx
// App.tsx
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from './screens/HomeScreen';
import { DetailScreen } from './screens/DetailScreen';
import { ProfileScreen } from './screens/ProfileScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: {
            backgroundColor: '#f4511e',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
        }}
      >
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ title: '首页' }}
        />
        <Stack.Screen
          name="Detail"
          component={DetailScreen}
          options={({ route }) => ({
            title: route.params?.title || '详情',
          })}
        />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ title: '个人中心' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

### Tab 导航

```tsx
// screens/HomeScreen.tsx
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

const Tab = createBottomTabNavigator();

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'Feed') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Search') {
            iconName = focused ? 'search' : 'search-outline';
          } else if (route.name === 'Profile') {
            iconName = focused ? 'person' : 'person-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#f4511e',
        tabBarInactiveTintColor: 'gray',
      })}
    >
      <Tab.Screen name="Feed" component={FeedScreen} />
      <Tab.Screen name="Search" component={SearchScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}
```

### Drawer 导航

```tsx
// screens/HomeScreen.tsx
import { createDrawerNavigator } from '@react-navigation/drawer';

const Drawer = createDrawerNavigator();

function HomeWithDrawer() {
  return (
    <Drawer.Navigator
      screenOptions={{
        drawerPosition: 'right',
        drawerType: 'front',
      }}
    >
      <Drawer.Screen name="Home" component={HomeTabs} />
      <Drawer.Screen name="Settings" component={SettingsScreen} />
      <Drawer.Screen name="About" component={AboutScreen} />
    </Drawer.Navigator>
  );
}
```

### 导航传参

```tsx
// 类型定义
type RootStackParamList = {
  Home: undefined;
  Detail: { id: string; title: string };
  Profile: { userId: string };
};

// 跳转
type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function HomeScreen({ navigation }: Props) {
  return (
    <Button
      title="查看详情"
      onPress={() => navigation.navigate('Detail', {
        id: '123',
        title: '详情页',
      })}
    />
  );
}

// 接收参数
type DetailProps = NativeStackScreenProps<RootStackParamList, 'Detail'>;

function DetailScreen({ route }: DetailProps) {
  const { id, title } = route.params;

  return (
    <View>
      <Text>ID: {id}</Text>
      <Text>标题: {title}</Text>
    </View>
  );
}
```

### 深度链接

```tsx
// App.tsx
const linking = {
  prefixes: ['myapp://', 'https://myapp.com'],
  config: {
    screens: {
      Home: '',
      Detail: 'detail/:id',
      Profile: 'profile/:userId',
    },
  },
};

export default function App() {
  return (
    <NavigationContainer linking={linking}>
      <Stack.Navigator>...</Stack.Navigator>
    </NavigationContainer>
  );
}
```

## Expo Router

### 基本概念

Expo Router 基于文件系统，文件结构即路由结构：

```
app/
├── _layout.tsx          # 根布局
├── index.tsx            # /
├── about.tsx            # /about
├── users/
│   ├── _layout.tsx      # users 布局
│   ├── index.tsx        # /users
│   └── [id].tsx         # /users/:id
└── (tabs)/
    ├── _layout.tsx      # Tab 布局
    ├── index.tsx        # Tab 1
    ├── search.tsx       # Tab 2
    └── profile.tsx      # Tab 3
```

### 基本配置

```bash
# 创建 Expo Router 项目
npx create-expo-app@latest my-app --template tabs

# 安装依赖
npx expo install expo-router expo-linking expo-constants expo-status-bar
```

### 根布局

```tsx
// app/_layout.tsx
import { Stack } from 'expo-router';
import { useTheme } from '@react-navigation/native';

export default function RootLayout() {
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.primary,
        },
        headerTintColor: '#fff',
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="detail/[id]" options={{ title: '详情' }} />
    </Stack>
  );
}
```

### Tab 布局

```tsx
// app/(tabs)/_layout.tsx
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#f4511e',
        headerShown: false,
      }}
    >
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
        name="search"
        options={{
          title: '搜索',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="search" size={size} color={color} />
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

### 页面组件

```tsx
// app/index.tsx
import { Link, router } from 'expo-router';
import { View, Text, Button } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 24, marginBottom: 20 }}>首页</Text>

      {/* 使用 Link 组件 */}
      <Link href="/about" style={{ marginBottom: 10 }}>
        <Text>关于页面</Text>
      </Link>

      {/* 使用 router.push */}
      <Button
        title="查看详情"
        onPress={() => router.push('/detail/123')}
      />

      {/* 传递参数 */}
      <Button
        title="查看用户"
        onPress={() => router.push({
          pathname: '/users/[id]',
          params: { id: '456', name: '张三' },
        })}
      />
    </View>
  );
}
```

### 动态路由

```tsx
// app/users/[id].tsx
import { useLocalSearchParams } from 'expo-router';

export default function UserDetailScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 24, marginBottom: 20 }}>用户详情</Text>
      <Text>ID: {id}</Text>
      <Text>姓名: {name}</Text>
    </View>
  );
}
```

### 布局系统

```tsx
// app/(tabs)/_layout.tsx - 群组布局
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: '首页' }} />
      <Tabs.Screen name="search" options={{ title: '搜索' }} />
      {/* 隐藏某个 Tab */}
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          href: null, // 不显示在 Tab 栏
        }}
      />
    </Tabs>
  );
}
```

## 核心差异

### 架构对比

| 维度 | React Navigation | Expo Router |
|------|------------------|-------------|
| 路由定义 | 手动配置 | 文件系统 |
| 类型安全 | 需要手动定义 | 自动生成 |
| 深度链接 | 手动配置 | 自动支持 |
| 布局系统 | 手动嵌套 | 基于文件结构 |
| 学习曲线 | 中等 | 低（熟悉 Next.js） |
| 灵活性 | 高 | 中等 |

### 性能对比

```
React Navigation (Native Stack):
  启动时间: 50-100ms
  导航过渡: 原生动画
  内存占用: 较低

Expo Router (基于 React Navigation):
  启动时间: 100-200ms
  导航过渡: 原生动画
  内存占用: 稍高（额外的文件系统处理）
```

## 选型建议

### 选择 React Navigation 的场景

```
✅ 非 Expo 项目
✅ 需要完全控制导航行为
✅ 复杂的自定义过渡动画
✅ 已有 React Navigation 项目
✅ 需要支持 React Native CLI
```

### 选择 Expo Router 的场景

```
✅ Expo 项目
✅ 熟悉 Next.js 的开发者
✅ 希望快速原型开发
✅ 需要类型安全的路由
✅ 需要自动深度链接支持
```

## 迁移指南

### React Navigation → Expo Router

```tsx
// React Navigation (旧)
const Stack = createNativeStackNavigator();

function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Detail" component={DetailScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Expo Router (新)
// app/_layout.tsx
import { Stack } from 'expo-router';

export default function Layout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Home' }} />
      <Stack.Screen name="detail/[id]" options={{ title: 'Detail' }} />
    </Stack>
  );
}

// app/index.tsx
export default function HomeScreen() {
  return <View>...</View>;
}

// app/detail/[id].tsx
export default function DetailScreen() {
  return <View>...</View>;
}
```

## 总结

React Navigation 和 Expo Router 都是优秀的导航方案。关键要点：

1. **React Navigation**：成熟稳定，完全可控，适合所有 React Native 项目
2. **Expo Router**：基于文件系统，类型安全，适合 Expo 项目
3. **性能**：两者性能接近，都基于 React Navigation 核心
4. **迁移成本**：从 React Navigation 迁移到 Expo Router 相对容易

对于新 Expo 项目，推荐使用 Expo Router，它提供了更好的开发体验和类型安全。对于已有项目或非 Expo 项目，React Navigation 仍然是最佳选择。
