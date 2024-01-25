---
title: "React Native 新架构初探：Fabric 与 TurboModules"
tag: react-native
description: 深入 React Native 新架构的核心组件 Fabric 渲染器和 TurboModules，了解 JSI 如何桥接 JS 与原生代码，以及新架构带来的性能提升。
date: "2024-01-25T08:00:00.000Z"
---

## 目标

React Native 自 2015 年发布以来，一直是跨平台移动开发的重要选择。2024 年，React Native 新架构已经稳定，Fabric 渲染器和 TurboModules 替代了旧的 Bridge 架构。本文深入解析新架构的核心组件，了解它如何解决旧架构的性能瓶颈。

## 背景

### 旧架构的问题

React Native 旧架构（Bridge 架构）存在几个核心问题：

```
JavaScript 线程
  ↓ (异步 JSON 序列化)
Bridge (异步、批量)
  ↓ (反序列化)
原生线程
```

1. **异步通信**：JS 和原生之间通过 Bridge 异步通信，无法同步调用
2. **JSON 序列化**：每次通信都需要序列化/反序列化，性能开销大
3. **批量处理**：Bridge 会批量处理消息，导致延迟不可预测
4. **单线程瓶颈**：Bridge 是单线程的，容易成为性能瓶颈

### 新架构的核心改进

```
JavaScript 线程
  ↓ (JSI 直接调用)
Fabric 渲染器 / TurboModules
  ↓ (直接调用)
原生线程
```

新架构的核心改进：

1. **JSI（JavaScript Interface）**：替代 Bridge，实现同步调用
2. **Fabric**：新的渲染器，支持同步布局计算
3. **TurboModules**：新的原生模块系统，支持懒加载和类型安全
4. **新代码生成**：自动生成类型安全的桥接代码

## JSI：新架构的基石

### JSI 是什么

JSI 是一个轻量级的 C++ 接口，让 JavaScript 可以直接调用原生函数：

```cpp
// JSI 允许 JS 直接调用 C++ 函数
jsi::Runtime &rt = ...;
jsi::Function nativeFunction = global.getProperty(rt, "nativeFunction").getObject(rt).getFunction(rt);

// 同步调用，无需序列化
auto result = call(rt, jsi::Value(42));
```

### JSI vs Bridge

| 维度 | Bridge | JSI |
|------|--------|-----|
| 通信方式 | 异步 | 同步/异步 |
| 数据序列化 | JSON | 直接传递引用 |
| 性能 | 中等 | 高 |
| 线程 | 单线程 | 多线程 |
| 内存 | 有开销 | 几乎零开销 |

## Fabric 渲染器

### Fabric 的核心设计

Fabric 是 React Native 的新渲染器，它解决了旧架构的几个关键问题：

```cpp
// Fabric 的核心组件
// 1. Shadow Tree：不可变的布局树
// 2. C++ 层：跨平台的渲染逻辑
// 3. 主机平台：iOS/Android 的原生视图
```

### 同步布局

```javascript
// 旧架构：异步布局，无法精确获取视图尺寸
componentDidMount() {
  // 布局可能还没完成，获取的尺寸不准确
  this.refs.view.measure((x, y, width, height) => {
    console.log(width, height);
  });
}

// Fabric：同步布局，立即获取准确尺寸
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

### 并发渲染

```javascript
// Fabric 支持 React 18 的并发特性
// Suspense、Transition 等特性在移动端也能正常使用

function SearchResults() {
  const [query, setQuery] = useState('');
  const [isPending, startTransition] = useTransition();

  const handleChange = (text) => {
    // 立即更新输入框
    setQuery(text);
    // 低优先级更新搜索结果
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

### Fabric 组件示例

```javascript
// 使用 Fabric 渲染器
import { View, Text, StyleSheet } from 'react-native';

function FabricComponent() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Fabric 渲染器</Text>
      <Text style={styles.subtitle}>新架构性能更优</Text>
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

### TurboModules 的优势

TurboModules 替代了旧的 NativeModules，具有以下优势：

```javascript
// 旧架构：立即加载所有原生模块
import { NativeModules } from 'react-native';
const { CameraModule } = NativeModules; // 应用启动时加载

// 新架构：懒加载原生模块
import { TurboModuleRegistry } from 'react-native';
const CameraModule = TurboModuleRegistry.get('CameraModule'); // 需要时才加载
```

### TurboModule 定义

```typescript
// TurboModule 规范（TypeScript）
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // 同步方法
  getConstants(): {
    PI: number;
    VERSION: string;
  };

  // 异步方法
  getData(key: string): Promise<string>;

  // 带回调的方法
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('MyTurboModule');
```

### 原生实现

```java
// Android 原生实现（Kotlin）
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
        // 原生异步操作
        val value = sharedPreferences.getString(key, "")
        promise.resolve(value)
    }
}
```

```swift
// iOS 原生实现（Swift）
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

### 使用 TurboModule

```javascript
// React 组件中使用
import { useTurboModule } from './NativeMyTurboModule';

function MyComponent() {
  const module = useTurboModule();

  const handleClick = async () => {
    // 同步获取常量
    const constants = module.getConstants();
    console.log('PI:', constants.PI);

    // 异步获取数据
    const data = await module.getData('myKey');
    console.log('Data:', data);
  };

  return (
    <View>
      <Button title="获取数据" onPress={handleClick} />
    </View>
  );
}
```

## 迁移指南

### 检查兼容性

```bash
# 检查项目是否兼容新架构
npx react-native doctor

# 启用新架构
# Android: android/gradle.properties
newArchEnabled=true

# iOS: ios/Podfile
:fabric_enabled => true
```

### 逐步迁移策略

```javascript
// 1. 先升级 React Native 到最新版本
npx react-native upgrade

// 2. 检查第三方库兼容性
// 查看库是否支持新架构

// 3. 启用新架构（开发环境）
// 在 gradle.properties 和 Podfile 中启用

// 4. 测试功能
// 确保所有功能正常工作

// 5. 性能对比
// 对比新旧架构的性能指标
```

### 性能对比

```
旧架构（Bridge）：
  启动时间: 2-3 秒
  JS 帧率: 50-55 FPS
  原生模块加载: 立即（全部）

新架构（Fabric + TurboModules）：
  启动时间: 0.5-1 秒
  JS 帧率: 58-60 FPS
  原生模块加载: 懒加载（按需）
```

## 实战示例

### 自定义 TurboModule

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

// 在组件中使用
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
        title="购买"
        onPress={() => {
          analytics.trackEvent('purchase', { product_id: product.id });
        }}
      />
    </View>
  );
}
```

## 总结

React Native 新架构是 React Native 发展的里程碑：

1. **JSI**：替代 Bridge，实现同步调用和零开销通信
2. **Fabric**：新的渲染器，支持并发渲染和同步布局
3. **TurboModules**：新的原生模块系统，支持懒加载和类型安全
4. **性能提升**：启动时间缩短 50%+，帧率提升 10%+

新架构已经稳定，建议新项目直接使用，老项目逐步迁移。对于性能敏感的应用，新架构是必要的升级。

React Native 的未来是光明的，随着新架构的普及，它将与 Flutter 继续在跨平台开发领域竞争，为开发者提供更多选择。
