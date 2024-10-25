---
title: "From React to React Native: A Frontend Engineer's Cross-Platform Journey"
tag: react-native
description: Helping React developers smoothly transition to React Native, understanding core differences and best practices to quickly build mobile applications.
date: "2024-10-25T08:00:00.000Z"
---

## Goal

This article aims to help frontend developers with React experience quickly get started with React Native, understand the core differences between the two, and master mobile-specific development techniques and best practices.

## Background

React Native enables web developers to build native mobile applications using familiar React syntax. For developers who have already mastered React, the learning curve for React Native is relatively gentle, but there are some key differences to note.

### React vs React Native

| Feature | React (Web) | React Native |
|---------|-------------|--------------|
| Rendering Target | DOM | Native components |
| Styling System | CSS | StyleSheet (Flexbox) |
| Navigation | React Router | React Navigation |
| State Management | Redux/Zustand | Same |
| Network Requests | fetch/axios | Same |
| Platform | Browser | iOS/Android |

## 1. Core Concept Differences

### Rendering Layer Differences

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

### Styling System Differences

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

### Common Component Mapping

```tsx
// Web -> React Native
<div> -> <View>
<span> -> <Text>
<p> -> <Text>
<button> -> <TouchableOpacity> or <Pressable>
<input> -> <TextInput>
<img> -> <Image>
<ul> -> <FlatList> or <ScrollView>
```

## 2. Layout System

### Flexbox Differences

```tsx
// React Native default flexDirection is column
// Web default flexDirection is row

// React (Web)
.container {
  display: flex;
  flex-direction: row;  // Default value
}

// React Native
const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'column',  // Default value, needs explicit declaration
  },
});
```

### Responsive Layout

```tsx
import { Dimensions, PixelRatio } from 'react-native';

const { width, height } = Dimensions.get('window');

// Design draft-based adaptation
const guidelineBaseWidth = 375;
const guidelineBaseHeight = 812;

export const scale = (size: number) => 
  (width / guidelineBaseWidth) * size;

export const verticalScale = (size: number) => 
  (height / guidelineBaseHeight) * size;

export const moderateScale = (size: number, factor = 0.5) => 
  size + (scale(size) - size) * factor;

// Usage
const styles = StyleSheet.create({
  title: {
    fontSize: moderateScale(18),
    padding: scale(10),
  },
});
```

### Safe Area

```tsx
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';

function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container}>
        <Text>Content will automatically avoid notch and bottom indicator</Text>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
```

## 3. Navigation System

### React Navigation Basics

```tsx
// Install
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
          options={{ title: 'Profile' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Page navigation
function HomeScreen({ navigation }) {
  return (
    <Button
      title="View Profile"
      onPress={() => navigation.navigate('Profile', { userId: '123' })}
    />
  );
}

// Receive parameters
function ProfileScreen({ route }) {
  const { userId } = route.params;
  return <Text>User ID: {userId}</Text>;
}
```

### Tab Navigation

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

## 4. State Management

### Same Redux/Zustand

```tsx
// State management libraries work identically in React Native
import { create } from 'zustand';

interface AppState {
  user: User | null;
  setUser: (user: User | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));

// Usage
function ProfileScreen() {
  const { user, setUser } = useAppStore();
  
  return (
    <View>
      {user ? <Text>{user.name}</Text> : <Text>Not logged in</Text>}
    </View>
  );
}
```

### Local Storage

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';

// Save data
await AsyncStorage.setItem('user', JSON.stringify(userData));

// Read data
const userData = await AsyncStorage.getItem('user');

// Delete data
await AsyncStorage.removeItem('user');

// Using Zustand + persist middleware
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

## 5. API Calls

### Network Requests

```tsx
// React and React Native use the same fetch API
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

// Using Axios (same as React)
import axios from 'axios';

const api = axios.create({
  baseURL: 'https://api.example.com',
  timeout: 10000,
});

api.interceptors.request.use((config) => {
  // Add token
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

### Offline Handling

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

// Use in requests
async function fetchData() {
  const isConnected = await NetInfo.fetch();
  
  if (!isConnected) {
    // Use cached data
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

## 6. Native Feature Access

### Device Information

```tsx
import { Platform } from 'react-native';

// Get platform information
const os = Platform.OS;  // 'ios' or 'android'
const version = Platform.Version;

// Platform-specific code
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

### Camera and Gallery

```tsx
import { Camera } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';

// Request permission
const { status } = await Camera.requestCameraPermissionsAsync();

// Take photo
const takePicture = async (cameraRef) => {
  const photo = await cameraRef.current.takePictureAsync();
  console.log(photo.uri);
};

// Pick image
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

### Push Notifications

```tsx
import * as Notifications from 'expo-notifications';

// Request permission
const { status } = await Notifications.requestPermissionsAsync();

// Listen for notifications
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Subscribe to push
const subscribeToPush = async () => {
  const token = await Notifications.getExpoPushTokenAsync();
  // Send token to server
  await sendTokenToServer(token.data);
};
```

## 7. Performance Optimization

### List Optimization

```tsx
import { FlatList } from 'react-native';
import { FlashList } from '@shopify/flash-list';

// Use FlashList instead of FlatList
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

### Image Optimization

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

### Animation Optimization

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

## 8. Debugging Tools

### React Native Debugger

```bash
# Install
brew install --cask react-native-debugger

# Usage
# Shake device -> Debug -> Debug with Chrome
```

### Flipper

```bash
# Install
brew install --cask flipper

# Integrate into project
# Add to android/app/build.gradle
debugImplementation 'com.facebook.flipper:flipper:+'
```

## 9. Practical Migration Checklist

```markdown
## React -> React Native Migration Checklist

### Infrastructure
- [ ] Install React Native CLI or Expo
- [ ] Configure TypeScript
- [ ] Set up ESLint and Prettier
- [ ] Configure Git hooks

### Core Components
- [ ] Replace HTML tags with RN components
- [ ] Migrate CSS to StyleSheet
- [ ] Implement responsive layout

### State Management
- [ ] Migrate Redux/Zustand (usually no changes needed)
- [ ] Implement local storage

### Navigation
- [ ] Implement React Navigation
- [ ] Migrate routing logic

### API Calls
- [ ] Migrate network requests (usually no changes needed)
- [ ] Implement offline handling

### Native Features
- [ ] Integrate camera/gallery
- [ ] Integrate push notifications
- [ ] Implement device information access

### Testing
- [ ] Write unit tests
- [ ] Write component tests
- [ ] Write integration tests
```

## Summary

| Dimension | React | React Native | Migration Cost |
|-----------|-------|--------------|----------------|
| Component Syntax | Same | Same | Low |
| State Management | Same | Same | Low |
| API Calls | Same | Same | Low |
| Styling | CSS | StyleSheet | Medium |
| Navigation | React Router | React Navigation | High |
| Native Features | Browser API | Native API | Medium |

**Recommendations**:

1. **Learn React First**: Ensure solid React fundamentals
2. **Start with Expo**: Expo lowers the entry barrier
3. **Understand Differences**: Focus on styling and navigation differences
4. **Practice More**: Mobile development requires hands-on practice
5. **Follow the Community**: React Native community is very active

The transition from React to React Native is easier than you might think. The key is understanding mobile-specific characteristics. This guide will help frontend engineers smoothly start their cross-platform development journey.
