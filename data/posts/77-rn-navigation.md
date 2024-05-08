---
title: "React Native Navigation Comparison: React Navigation vs Expo Router"
tag: react-native
description: Deep comparison of React Navigation and Expo Router, two major React Native navigation solutions, from API design to performance optimization, helping developers make informed choices.
date: "2024-05-08T08:00:00.000Z"
---

## Goal

Navigation is core infrastructure for mobile applications. React Navigation is the most mature navigation library in the React Native ecosystem, while Expo Router is a new file-system-based navigation solution. This article deeply compares their architectural differences, API design, and applicable scenarios.

## Background

### Navigation Solution Evolution

```
React Navigation 1.x (2017): JavaScript state-based
React Navigation 2.x (2018): Introduced Stack navigation
React Navigation 3.x (2019): Hook API
React Navigation 4.x (2019): Performance optimization
React Navigation 5.x (2020): Complete rewrite
React Navigation 6.x (2022): Stable and mature
Expo Router 1.0 (2023): File-system-based navigation
Expo Router 2.0 (2024): Fully stable
```

### Positioning of Two Solutions

- **React Navigation**: Universal React Native navigation library, suitable for all projects
- **Expo Router**: File-system-based navigation, suitable for Expo projects

## React Navigation

### Basic Configuration

```bash
# Install dependencies
npx expo install @react-navigation/native
npx expo install react-native-screens react-native-safe-area-context
```

### Stack Navigation

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
          options={{ title: 'Home' }}
        />
        <Stack.Screen
          name="Detail"
          component={DetailScreen}
          options={({ route }) => ({
            title: route.params?.title || 'Detail',
          })}
        />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={{ title: 'Profile' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

### Tab Navigation

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

### Drawer Navigation

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

### Navigation Parameters

```tsx
// Type definition
type RootStackParamList = {
  Home: undefined;
  Detail: { id: string; title: string };
  Profile: { userId: string };
};

// Navigation
type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

function HomeScreen({ navigation }: Props) {
  return (
    <Button
      title="View Details"
      onPress={() => navigation.navigate('Detail', {
        id: '123',
        title: 'Detail Page',
      })}
    />
  );
}

// Receive parameters
type DetailProps = NativeStackScreenProps<RootStackParamList, 'Detail'>;

function DetailScreen({ route }: DetailProps) {
  const { id, title } = route.params;

  return (
    <View>
      <Text>ID: {id}</Text>
      <Text>Title: {title}</Text>
    </View>
  );
}
```

### Deep Linking

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

### Basic Concept

Expo Router is based on file system, file structure is route structure:

```
app/
├── _layout.tsx          # Root layout
├── index.tsx            # /
├── about.tsx            # /about
├── users/
│   ├── _layout.tsx      # users layout
│   ├── index.tsx        # /users
│   └── [id].tsx         # /users/:id
└── (tabs)/
    ├── _layout.tsx      # Tab layout
    ├── index.tsx        # Tab 1
    ├── search.tsx       # Tab 2
    └── profile.tsx      # Tab 3
```

### Basic Configuration

```bash
# Create Expo Router project
npx create-expo-app@latest my-app --template tabs

# Install dependencies
npx expo install expo-router expo-linking expo-constants expo-status-bar
```

### Root Layout

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
      <Stack.Screen name="detail/[id]" options={{ title: 'Detail' }} />
    </Stack>
  );
}
```

### Tab Layout

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
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="search" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
```

### Page Components

```tsx
// app/index.tsx
import { Link, router } from 'expo-router';
import { View, Text, Button } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 24, marginBottom: 20 }}>Home</Text>

      {/* Using Link component */}
      <Link href="/about" style={{ marginBottom: 10 }}>
        <Text>About Page</Text>
      </Link>

      {/* Using router.push */}
      <Button
        title="View Details"
        onPress={() => router.push('/detail/123')}
      />

      {/* Passing parameters */}
      <Button
        title="View User"
        onPress={() => router.push({
          pathname: '/users/[id]',
          params: { id: '456', name: 'John' },
        })}
      />
    </View>
  );
}
```

### Dynamic Routes

```tsx
// app/users/[id].tsx
import { useLocalSearchParams } from 'expo-router';

export default function UserDetailScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ fontSize: 24, marginBottom: 20 }}>User Detail</Text>
      <Text>ID: {id}</Text>
      <Text>Name: {name}</Text>
    </View>
  );
}
```

### Layout System

```tsx
// app/(tabs)/_layout.tsx - Group layout
import { Tabs } from 'expo-router';

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
      {/* Hide a Tab */}
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          href: null, // Don't show in Tab bar
        }}
      />
    </Tabs>
  );
}
```

## Core Differences

### Architecture Comparison

| Dimension | React Navigation | Expo Router |
|-----------|------------------|-------------|
| Route definition | Manual configuration | File system |
| Type safety | Need manual definition | Auto-generated |
| Deep linking | Manual configuration | Auto-supported |
| Layout system | Manual nesting | Based on file structure |
| Learning curve | Medium | Low (familiar with Next.js) |
| Flexibility | High | Medium |

### Performance Comparison

```
React Navigation (Native Stack):
  Startup time: 50-100ms
  Navigation transition: Native animation
  Memory usage: Lower

Expo Router (Based on React Navigation):
  Startup time: 100-200ms
  Navigation transition: Native animation
  Memory usage: Slightly higher (additional file system processing)
```

## Selection Guide

### When to Choose React Navigation

```
✅ Non-Expo projects
✅ Need complete control over navigation behavior
✅ Complex custom transition animations
✅ Existing React Navigation projects
✅ Need to support React Native CLI
```

### When to Choose Expo Router

```
✅ Expo projects
✅ Developers familiar with Next.js
✅ Want rapid prototyping
✅ Need type-safe routing
✅ Need automatic deep linking support
```

## Migration Guide

### React Navigation → Expo Router

```tsx
// React Navigation (old)
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

// Expo Router (new)
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

## Conclusion

React Navigation and Expo Router are both excellent navigation solutions. Key takeaways:

1. **React Navigation**: Mature, stable, fully controllable, suitable for all React Native projects
2. **Expo Router**: File-system-based, type-safe, suitable for Expo projects
3. **Performance**: Both have similar performance, both based on React Navigation core
4. **Migration cost**: Migrating from React Navigation to Expo Router is relatively easy

For new Expo projects, Expo Router is recommended as it provides better development experience and type safety. For existing projects or non-Expo projects, React Navigation remains the best choice.
