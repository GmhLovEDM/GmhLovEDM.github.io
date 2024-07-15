---
title: "React Native Expo in Practice: Building Cross-Platform Apps Quickly"
tag: react-native
description: A comprehensive introduction to the React Native Expo development workflow, from project creation to app store submission, covering Expo SDK, EAS Build, and native module integration.
date: "2024-07-15T08:00:00.000Z"
---

## Goal

This article aims to help frontend developers quickly get started with React Native Expo and master the complete workflow of building, testing, and publishing cross-platform mobile applications using the Expo ecosystem.

## Background

React Native enables JavaScript developers to build native mobile applications, but traditional React Native development requires configuring complex native development environments like Android Studio and Xcode. Expo has dramatically lowered this barrier.

### Expo's Position

Expo is a development platform built around React Native, providing:

1. **Zero-configuration Development**: Start without Xcode/Android Studio
2. **Managed Workflow**: EAS Build cloud compilation
3. **Rich APIs**: Camera, location, notifications, and more out of the box
4. **Expo Go**: A development preview tool on your phone

As of 2024, Expo has become the recommended way to develop with React Native. Even the official React Native documentation recommends using Expo first.

## 1. Environment Setup and Project Creation

### Install Expo CLI

```bash
# Install Expo CLI globally
npm install -g expo-cli

# Or use npx to run directly
npx create-expo-app@latest my-app

# Enter the project
cd my-app
```

### Project Structure

```
my-app/
├── app/                    # App routing (Expo Router)
│   ├── (tabs)/            # Tab navigation
│   │   ├── index.tsx      # Home page
│   │   ├── explore.tsx    # Explore page
│   │   └── _layout.tsx    # Tab layout
│   ├── _layout.tsx        # Root layout
│   └── [id].tsx           # Dynamic routing
├── assets/                # Static resources
├── components/            # Reusable components
├── constants/             # Constant configurations
├── hooks/                 # Custom hooks
├── app.json              # Expo configuration
├── package.json
└── tsconfig.json
```

### Start Development Server

```bash
# Start Expo development server
npx expo start

# Scan QR code with Expo Go
# Or press a to open Android emulator
# Or press i to open iOS simulator
```

## 2. Expo Router: File-System Routing

Expo Router is the recommended routing solution for Expo, similar to Next.js's file-system routing:

### Basic Routing

```tsx
// app/index.tsx - Home route "/"
import { View, Text, StyleSheet } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Home</Text>
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

### Dynamic Routing

```tsx
// app/user/[id].tsx - Dynamic route "/user/123"
import { useLocalSearchParams } from 'expo-router';

export default function UserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  
  return (
    <View style={styles.container}>
      <Text>User ID: {id}</Text>
    </View>
  );
}
```

### Layout Routes

```tsx
// app/_layout.tsx - Root layout
import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

// app/(tabs)/_layout.tsx - Tab layout
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs>
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

## 3. Expo API in Practice

### Permission Management

```tsx
import * as Camera from 'expo-camera';
import * as Location from 'expo-location';
import { useEffect } from 'react';

export function usePermissions() {
  useEffect(() => {
    (async () => {
      // Request camera permission
      const { status: cameraStatus } = await Camera.requestCameraPermissionsAsync();
      
      // Request location permission
      const { status: locationStatus } = await Location.requestForegroundPermissionsAsync();
      
      console.log('Camera:', cameraStatus, 'Location:', locationStatus);
    })();
  }, []);
}
```

### Camera Usage

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
        <Button title="Grant Permission" onPress={requestPermission} />
      </View>
    );
  }

  const takePicture = async () => {
    // Note: New versions use CameraView
    // const photo = await cameraRef.current.takePictureAsync();
    // setPhoto(photo.uri);
  };

  return (
    <View style={styles.container}>
      {photo ? (
        <Image source={{ uri: photo }} style={styles.preview} />
      ) : (
        <CameraView style={styles.camera} facing="back">
          <Button title="Take Photo" onPress={takePicture} />
        </CameraView>
      )}
    </View>
  );
}
```

### Location Services

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
          setError('Location permission denied');
          return;
        }

        const location = await Location.getCurrentPositionAsync({});
        setLocation(location);
      } catch (err) {
        setError('Failed to get location');
      }
    })();
  }, []);

  return { location, error };
}
```

### Notifications

```tsx
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';

// Configure notification handling
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function useNotifications() {
  useEffect(() => {
    // Request permissions
    const requestPermissions = async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== 'granted') {
        alert('Notification permission denied');
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
      trigger: null, // Send immediately
    });
  };

  return { sendNotification };
}
```

## 4. State Management

### Using Zustand

Zustand is a lightweight state management library that performs excellently in React Native:

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

// Usage
function ProfileScreen() {
  const { user, setUser, logout } = useUserStore();
  
  return (
    <View>
      {user ? (
        <>
          <Text>{user.name}</Text>
          <Button title="Logout" onPress={logout} />
        </>
      ) : (
        <Button title="Login" onPress={() => setUser({ id: '1', name: 'John', email: 'john@example.com' })} />
      )}
    </View>
  );
}
```

## 5. Build and Publish

### Development Phase

```bash
# Development mode
npx expo start

# Clear cache
npx expo start --clear

# Use specific platform
npx expo start --ios
npx expo start --android
```

### Using EAS Build

EAS (Expo Application Services) is Expo's cloud build service:

```bash
# Install EAS CLI
npm install -g eas-cli

# Login to Expo account
eas login

# Initialize EAS configuration
eas build:configure

# Build development version
eas build --profile development --platform ios

# Build production version
eas build --profile production --platform android
```

### eas.json Configuration

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

### Submit to App Stores

```bash
# iOS App Store
eas submit --platform ios

# Google Play Store
eas submit --platform android

# Auto version management
eas build --auto-version
```

## 6. Performance Optimization

### Image Optimization

```tsx
import { Image } from 'expo-image';

// Use expo-image instead of React Native Image
<Image
  source={{ uri: 'https://example.com/image.jpg' }}
  style={styles.image}
  contentFit="cover"
  transition={1000} // Fade-in effect
  cachePolicy="memory-disk" // Cache strategy
/>
```

### List Optimization

```tsx
import { FlashList } from '@shopify/flash-list';

// Use FlashList instead of FlatList
<FlashList
  data={items}
  renderItem={({ item }) => <ItemCard item={item} />}
  estimatedItemSize={100}
  keyExtractor={(item) => item.id}
/>
```

### Animation Optimization

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
      <Button title="Animate" onPress={handlePress} />
    </Animated.View>
  );
}
```

## 7. Debugging Tools

### React Native Debugger

```bash
# Install
brew install --cask react-native-debugger

# Or use Flipper
npx flipper-server
```

### Expo DevTools

```bash
# Open DevTools
npx expo start --dev-client

# Remote debugging
# Shake device -> Debug -> Remote JS Debug
```

### Performance Monitoring

```tsx
import { Performance } from 'expo-performance';

// Mark performance points
Performance.mark('start_fetch');

// Fetch data
await fetchData();

Performance.mark('end_fetch');
Performance.measure('fetch_data', 'start_fetch', 'end_fetch');
```

## Summary

Expo has dramatically lowered the barrier to React Native development:

| Stage | Traditional React Native | Expo |
|-------|--------------------------|------|
| Environment Setup | Requires Xcode + Android Studio | Only Node.js needed |
| Development Preview | Requires emulator | Expo Go QR scan |
| Native Build | Local compilation | EAS cloud build |
| App Store Submission | Manual configuration | EAS Submit |

**Recommendations**:

1. **New Projects Use Expo**: Unless there are clear native requirements, prefer Expo
2. **Use Expo Router**: File-system routing is more intuitive
3. **Leverage EAS**: Cloud builds save local resources
4. **Watch Expo SDK Updates**: Expo updates frequently; keep up with new features

Expo has grown from a "toy" to a production-grade development platform. Choosing Expo in 2024 is definitely the right decision.
