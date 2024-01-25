---
title: "React Native New Architecture: Fabric and TurboModules"
tag: react-native
description: Deep dive into React Native new architecture's core components Fabric renderer and TurboModules, understanding how JSI bridges JS and native code, and the performance improvements brought by the new architecture.
date: "2024-01-25T08:00:00.000Z"
---

## Goal

React Native has been an important choice for cross-platform mobile development since its release in 2015. In 2024, the React Native new architecture has stabilized, with Fabric renderer and TurboModules replacing the old Bridge architecture. This article deeply analyzes the new architecture's core components and how it solves the old architecture's performance bottlenecks.

## Background

### Old Architecture Issues

React Native's old architecture (Bridge architecture) had several core issues:

```
JavaScript Thread
  ↓ (Async JSON serialization)
Bridge (Async, Batched)
  ↓ (Deserialization)
Native Thread
```

1. **Async communication**: JS and native communicate asynchronously through Bridge, cannot make synchronous calls
2. **JSON serialization**: Each communication requires serialization/deserialization, significant performance overhead
3. **Batch processing**: Bridge processes messages in batches, causing unpredictable latency
4. **Single-thread bottleneck**: Bridge is single-threaded, easily becoming a performance bottleneck

### New Architecture Core Improvements

```
JavaScript Thread
  ↓ (JSI direct call)
Fabric Renderer / TurboModules
  ↓ (Direct call)
Native Thread
```

Core improvements of the new architecture:

1. **JSI (JavaScript Interface)**: Replaces Bridge, enabling synchronous calls
2. **Fabric**: New renderer supporting synchronous layout calculation
3. **TurboModules**: New native module system supporting lazy loading and type safety
4. **New code generation**: Auto-generates type-safe bridging code

## JSI: Foundation of the New Architecture

### What is JSI

JSI is a lightweight C++ interface that allows JavaScript to directly call native functions:

```cpp
// JSI allows JS to directly call C++ functions
jsi::Runtime &rt = ...;
jsi::Function nativeFunction = global.getProperty(rt, "nativeFunction").getObject(rt).getFunction(rt);

// Synchronous call, no serialization needed
auto result = call(rt, jsi::Value(42));
```

### JSI vs Bridge

| Dimension | Bridge | JSI |
|-----------|--------|-----|
| Communication | Async | Sync/Async |
| Data serialization | JSON | Direct reference passing |
| Performance | Medium | High |
| Threading | Single-threaded | Multi-threaded |
| Memory | Has overhead | Nearly zero overhead |

## Fabric Renderer

### Fabric Core Design

Fabric is React Native's new renderer, solving several key issues of the old architecture:

```cpp
// Fabric core components
// 1. Shadow Tree: Immutable layout tree
// 2. C++ layer: Cross-platform rendering logic
// 3. Host platform: iOS/Android native views
```

### Synchronous Layout

```javascript
// Old architecture: async layout, cannot accurately get view dimensions
componentDidMount() {
  // Layout may not have completed, dimensions may be inaccurate
  this.refs.view.measure((x, y, width, height) => {
    console.log(width, height);
  });
}

// Fabric: synchronous layout, get accurate dimensions immediately
function MyComponent() {
  const [dimensions, setDimensions] = useState(null);

  const onLayout = useCallback((event) => {
    const { width, height } = event.nativeEvent.layout;
    setDimensions({ width, height });
  }, []);

  return (
    <View onLayout={onLayout}>
      {dimensions && <Text>{dimensions.width} x {dimensions.height}</Text>}
    </View>
  );
}
```

### Concurrent Rendering

```javascript
// Fabric supports React 18's concurrent features
// Suspense, Transition, and other features work on mobile

function SearchResults() {
  const [query, setQuery] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleChange = (text) => {
    // Update input immediately
    setQuery(text);
    // Low-priority update for search results
    startTransition(() => {
      setResults(search(text));
    });
  };

  return (
    <View>
      <TextInput value={query} onChangeText={handleChange} />
      {isPending ? (
        <ActivityIndicator />
      ) : (
        <ResultsList results={results} />
      )}
    </View>
  );
}
```

### Fabric Component Example

```javascript
// Using Fabric renderer
import { View, Text, StyleSheet } from 'react-native';

function FabricComponent() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Fabric Renderer</Text>
      <Text style={styles.subtitle}>New architecture with better performance</Text>
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
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
});
```

## TurboModules

### TurboModules Advantages

TurboModules replace the old NativeModules, offering the following advantages:

```javascript
// Old architecture: Load all native modules immediately
import { NativeModules } from 'react-native';
const { CameraModule } = NativeModules; // Loaded at app startup

// New architecture: Lazy load native modules
import { TurboModuleRegistry } from 'react-native';
const CameraModule = TurboModuleRegistry.get('CameraModule'); // Loaded on demand
```

### TurboModule Definition

```typescript
// TurboModule spec (TypeScript)
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Synchronous method
  getConstants(): {
    PI: number;
    VERSION: string;
  };

  // Async method
  getData(key: string): Promise<string>;

  // Method with callback
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('MyTurboModule');
```

### Native Implementation

```java
// Android native implementation (Kotlin)
@ReactModule(name = "MyTurboModule")
class MyTurboModule(reactContext: ReactApplicationContext) :
    NativeMyTurboModuleSpec(reactContext) {

    override fun getConstants(): MutableMap<String, Any> {
        return mutableMapOf(
            "PI" to 3.14159,
            "VERSION" to "1.0.0"
        )
    }

    override fun getData(key: String, promise: Promise) {
        // Native async operation
        val value = sharedPreferences.getString(key, "")
        promise.resolve(value)
    }
}
```

```swift
// iOS native implementation (Swift)
@objc(MyTurboModule)
class MyTurboModule: NSObject {
    @objc static func requiresMainQueueSetup() -> Bool {
        return false
    }

    func getConstants() -> [String: Any] {
        return [
            "PI": 3.14159,
            "VERSION": "1.0.0"
        ]
    }

    func getData(_ key: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
        let value = UserDefaults.standard.string(forKey: key) ?? ""
        resolve(value)
    }
}
```

### Using TurboModule

```javascript
// Using in React component
import { useTurboModule } from './NativeMyTurboModule';

function MyComponent() {
  const module = useTurboModule();

  const handleClick = async () => {
    // Get constants synchronously
    const constants = module.getConstants();
    console.log('PI:', constants.PI);

    // Get data asynchronously
    const data = await module.getData('myKey');
    console.log('Data:', data);
  };

  return (
    <View>
      <Button title="Get Data" onPress={handleClick} />
    </View>
  );
}
```

## Migration Guide

### Check Compatibility

```bash
# Check if project is compatible with new architecture
npx react-native doctor

# Enable new architecture
# Android: android/gradle.properties
newArchEnabled=true

# iOS: ios/Podfile
:fabric_enabled => true
```

### Gradual Migration Strategy

```javascript
// 1. First upgrade React Native to latest version
npx react-native upgrade

// 2. Check third-party library compatibility
// Check if libraries support new architecture

// 3. Enable new architecture (development environment)
// Enable in gradle.properties and Podfile

// 4. Test functionality
// Ensure all features work properly

// 5. Performance comparison
// Compare performance metrics between old and new architecture
```

### Performance Comparison

```
Old architecture (Bridge):
  Startup time: 2-3 seconds
  JS frame rate: 50-55 FPS
  Native module loading: Immediate (all)

New architecture (Fabric + TurboModules):
  Startup time: 0.5-1 second
  JS frame rate: 58-60 FPS
  Native module loading: Lazy (on demand)
```

## Practical Examples

### Custom TurboModule

```typescript
// src/modules/Analytics.ts
import { TurboModuleRegistry } from 'react-native';

interface AnalyticsModule {
  trackEvent(event: string, properties?: Record<string, any>): void;
  setUser(userId: string): void;
  flush(): Promise<void>;
}

const AnalyticsModule = TurboModuleRegistry.get<AnalyticsModule>('Analytics');

export const analytics = {
  trackEvent: (event: string, properties?: Record<string, any>) => {
    AnalyticsModule?.trackEvent(event, properties);
  },
  setUser: (userId: string) => {
    AnalyticsModule?.setUser(userId);
  },
  flush: async () => {
    await AnalyticsModule?.flush();
  },
};

// Using in component
function ProductPage({ product }) {
  useEffect(() => {
    analytics.trackEvent('page_view', {
      product_id: product.id,
      product_name: product.name,
    });
  }, [product]);

  return (
    <View>
      <Text>{product.name}</Text>
      <Button
        title="Purchase"
        onPress={() => {
          analytics.trackEvent('purchase', { product_id: product.id });
        }}
      />
    </View>
  );
}
```

## Conclusion

React Native's new architecture is a milestone in React Native's development:

1. **JSI**: Replaces Bridge, enabling synchronous calls and zero-overhead communication
2. **Fabric**: New renderer supporting concurrent rendering and synchronous layout
3. **TurboModules**: New native module system supporting lazy loading and type safety
4. **Performance improvement**: Startup time reduced by 50%+, frame rate improved by 10%+

The new architecture is stable. New projects are recommended to use it directly, while old projects should migrate gradually. For performance-sensitive applications, the new architecture is a necessary upgrade.

React Native's future is bright. As the new architecture becomes widespread, it will continue competing with Flutter in the cross-platform development space, providing developers with more choices.
