---
title: "React Native 性能优化：Hermes、Reanimated 与列表优化"
tag: react-native
description: 全面介绍 React Native 性能优化策略，包括 Hermes 引擎、Reanimated 动画、列表渲染优化和内存管理。
date: "2024-09-05T08:00:00.000Z"
---

## 目标

本文旨在帮助 React Native 开发者掌握性能优化的核心技巧，包括 JavaScript 引擎选择、动画性能优化、列表渲染优化和内存管理，让应用达到原生级别的流畅度。

## 背景

React Native 应用的性能问题一直是开发者关注的焦点。虽然 React Native 通过桥接机制实现了跨平台开发，但 JavaScript 线程和原生线程之间的通信开销、JavaScript 引擎的性能限制等因素都会影响用户体验。

### 性能瓶颈分析

1. **JavaScript 线程**：JS 代码执行、状态更新、事件处理
2. **原生线程**：UI 渲染、手势处理、动画
3. **桥接通信**：JS 和原生之间的数据传递
4. **内存管理**：JavaScript 堆内存、图片缓存

## 一、Hermes 引擎

### 什么是 Hermes？

Hermes 是 Facebook 开发的 JavaScript 引擎，专门为 React Native 优化。它通过预编译（AOT）技术大幅提升了启动性能。

### Hermes vs JSC (JavaScriptCore)

| 特性 | Hermes | JSC |
|------|--------|-----|
| 编译策略 | AOT（预编译） | JIT（即时编译） |
| 启动速度 | 快 50-100% | 基准 |
| 内存占用 | 低 30-50% | 基准 |
| 包大小 | 更小 | 更大 |
| 运行时性能 | 接近或更好 | 基准 |

### 启用 Hermes

```javascript
// android/app/build.gradle
android {
    defaultConfig {
        // 启用 Hermes
        project.ext.react = [
            enableHermes: true,  // 使用 Hermes
        ]
    }
}

// ios/Podfile
:hermes_enabled => true
```

### Hermes 的优势

1. **启动优化**：预编译字节码，无需 JIT 编译
2. **内存优化**：更高效的垃圾回收
3. **包大小优化**：字节码比源代码更小
4. **调试支持**：支持 Chrome DevTools 调试

### 测量启动性能

```bash
# Android
adb logcat -s ReactNativeJS

# 查看启动时间
# Hermes 通常能将冷启动时间缩短 50% 以上
```

## 二、Reanimated 2/3 动画

### 为什么需要 Reanimated？

React Native 的 Animated API 在主线程和 JS 线程之间频繁通信，导致动画卡顿。Reanimated 将动画逻辑移到原生线程执行，实现了 60fps 的流畅动画。

### 基础使用

```tsx
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring,
  withTiming,
  runOnJS 
} from 'react-native-reanimated';

function AnimatedBox() {
  const offset = useSharedValue(0);
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offset.value },
      { scale: scale.value },
    ],
  }));

  const handlePress = () => {
    offset.value = withSpring(offset.value === 0 ? 100 : 0);
    scale.value = withTiming(scale.value === 1 ? 1.2 : 1, {
      duration: 300,
    });
  };

  return (
    <Animated.View style={[styles.box, animatedStyle]}>
      <Button title="Animate" onPress={handlePress} />
    </Animated.View>
  );
}
```

### 手势动画

```tsx
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

function GestureAnimatedBox() {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);

  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
    })
    .onEnd(() => {
      translateX.value = withSpring(0);
      translateY.value = withSpring(0);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <Animated.View style={[styles.box, animatedStyle]} />
    </GestureDetector>
  );
}
```

### Layout Animation

```tsx
import { 
  Layout, 
  FadeIn, 
  FadeOut, 
  SlideInRight,
  SlideOutLeft 
} from 'react-native-reanimated';

function AnimatedList({ items }) {
  return (
    <View>
      {items.map((item, index) => (
        <Animated.View
          key={item.id}
          entering={SlideInRight.delay(index * 100)}
          exiting={SlideOutLeft}
          layout={Layout.springify()}
          style={styles.item}
        >
          <Text>{item.name}</Text>
        </Animated.View>
      ))}
    </View>
  );
}
```

### 性能对比

```tsx
// 不好的做法：使用 React Native Animated
// 动画在 JS 线程执行，会导致卡顿
const opacity = new Animated.Value(0);
Animated.timing(opacity, {
  toValue: 1,
  duration: 500,
  useNativeDriver: true, // 即使开启 native driver，仍有开销
}).start();

// 好的做法：使用 Reanimated
// 动画完全在原生线程执行
const opacity = useSharedValue(0);
opacity.value = withTiming(1, { duration: 500 });
```

## 三、列表优化

### FlatList 优化

```tsx
import { FlatList, RefreshControl } from 'react-native';

function OptimizedList({ data }) {
  // 1. 使用 getItemLayout 跳过测量
  const getItemLayout = (data, index) => ({
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  });

  // 2. 使用 keyExtractor
  const keyExtractor = (item) => item.id;

  // 3. 使用 renderItem 的 React.memo
  const renderItem = React.memo(({ item }) => (
    <ListItem item={item} />
  ));

  // 4. 优化渲染参数
  return (
    <FlatList
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      getItemLayout={getItemLayout}
      // 性能参数
      removeClippedSubviews={true}
      maxToRenderPerBatch={10}
      updateCellsBatchingPeriod={50}
      windowSize={5}
      // 刷新
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    />
  );
}
```

### FlashList（推荐）

```tsx
import { FlashList } from '@shopify/flash-list';

function OptimizedFlashList({ data }) {
  return (
    <FlashList
      data={data}
      renderItem={({ item }) => <ListItem item={item} />}
      estimatedItemSize={80}
      keyExtractor={(item) => item.id}
      // FlashList 自动优化
      // - 回收不可见的列表项
      // - 预渲染可见区域外的项
      // - 更少的内存占用
    />
  );
}
```

### 列表项优化

```tsx
// 使用 React.memo 避免不必要的重渲染
const ListItem = React.memo(({ item, onPress }) => {
  return (
    <TouchableOpacity onPress={() => onPress(item.id)}>
      <View style={styles.listItem}>
        <Image source={{ uri: item.avatar }} style={styles.avatar} />
        <View style={styles.info}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.description}>{item.description}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}, (prevProps, nextProps) => {
  // 自定义比较函数
  return prevProps.item.id === nextProps.item.id;
});

// 使用 useMemo 缓存计算
function UserList({ users }) {
  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => a.name.localeCompare(b.name));
  }, [users]);

  return (
    <FlashList
      data={sortedUsers}
      renderItem={({ item }) => <ListItem item={item} />}
      estimatedItemSize={80}
    />
  );
}
```

## 四、图片优化

### 使用 FastImage

```tsx
import FastImage from 'react-native-fast-image';

function OptimizedImage({ uri }) {
  return (
    <FastImage
      style={styles.image}
      source={{
        uri: uri,
        priority: FastImage.priority.normal,
        cache: FastImage.cacheControl.immutable,
      }}
      resizeMode={FastImage.resizeMode.cover}
    />
  );
}
```

### 图片缓存策略

```typescript
import FastImage from 'react-native-fast-image';

class ImageCache {
  static async preload(urls: string[]) {
    await FastImage.preload(
      urls.map((uri) => ({
        uri,
        priority: FastImage.priority.normal,
      }))
    );
  }

  static clearCache() {
    FastImage.clearMemoryCache();
    FastImage.clearDiskCache();
  }
}

// 使用
useEffect(() => {
  ImageCache.preload(imageUrls);
}, []);
```

### 图片尺寸优化

```tsx
// 根据设备尺寸加载合适的图片
function getOptimizedImageUrl(baseUrl: string, width: number) {
  const pixelRatio = PixelRatio.get();
  const targetWidth = width * pixelRatio;
  
  // 假设 CDN 支持图片处理
  return `${baseUrl}?w=${targetWidth}&q=80`;
}

function ResponsiveImage({ uri, style }) {
  const [width, setWidth] = useState(0);
  
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <FastImage
          style={style}
          source={{ uri: getOptimizedImageUrl(uri, width) }}
          resizeMode={FastImage.resizeMode.cover}
        />
      )}
    </View>
  );
}
```

## 五、内存优化

### 避免内存泄漏

```tsx
// 清理定时器和订阅
function DataComponent() {
  const [data, setData] = useState(null);

  useEffect(() => {
    const timer = setInterval(fetchData, 5000);
    const subscription = EventBus.addListener('update', handleUpdate);

    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  return <View>{/* ... */}</View>;
}

// 使用 AbortController 取消请求
function SearchComponent({ query }) {
  const [results, setResults] = useState([]);

  useEffect(() => {
    const controller = new AbortController();

    const search = async () => {
      try {
        const response = await fetch(`/api/search?q=${query}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        setResults(data);
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error(error);
        }
      }
    };

    search();

    return () => controller.abort();
  }, [query]);

  return <View>{/* ... */}</View>;
}
```

### 内存监控

```typescript
import { NativeModules } from 'react-native';

// 获取内存使用情况
function getMemoryUsage() {
  if (NativeModules.MemoryInfo) {
    return NativeModules.MemoryInfo.getMemoryUsage();
  }
  return null;
}

// 定期检查
useEffect(() => {
  const interval = setInterval(() => {
    const memory = getMemoryUsage();
    if (memory && memory.used > MEMORY_THRESHOLD) {
      console.warn('High memory usage:', memory);
      // 执行清理操作
    }
  }, 10000);

  return () => clearInterval(interval);
}, []);
```

## 六、性能监测

### 使用性能 API

```tsx
import { Performance } from 'react-native-performance';

// 标记性能点
function DataLoader() {
  useEffect(() => {
    Performance.mark('data_fetch_start');
    
    fetchData().then(() => {
      Performance.mark('data_fetch_end');
      Performance.measure(
        'data_fetch',
        'data_fetch_start',
        'data_fetch_end'
      );
    });
  }, []);

  return <View>{/* ... */}</View>;
}
```

### 性能优化清单

```markdown
## React Native 性能优化检查清单

### 启动优化
- [ ] 启用 Hermes 引擎
- [ ] 减少首屏组件数量
- [ ] 使用懒加载
- [ ] 优化图片加载

### 渲染优化
- [ ] 使用 React.memo
- [ ] 使用 useMemo/useCallback
- [ ] 避免内联函数
- [ ] 使用 FlashList 替代 FlatList

### 动画优化
- [ ] 使用 Reanimated
- [ ] 避免在 JS 线程执行动画
- [ ] 使用 useNativeDriver

### 内存优化
- [ ] 及时清理订阅和定时器
- [ ] 优化图片缓存
- [ ] 避免内存泄漏
- [ ] 监控内存使用
```

## 七、实战案例

### 优化聊天界面

```tsx
function ChatScreen({ messages }) {
  // 1. 使用 FlashList
  const renderItem = useCallback(({ item }) => (
    <ChatMessage message={item} />
  ), []);

  const getItemLayout = useCallback((data, index) => ({
    length: MESSAGE_HEIGHT,
    offset: MESSAGE_HEIGHT * index,
    index,
  }), []);

  return (
    <FlashList
      data={messages}
      renderItem={renderItem}
      estimatedItemSize={80}
      getItemLayout={getItemLayout}
      inverted // 聊天界面倒序
      keyExtractor={(item) => item.id}
    />
  );
}

// 2. 优化消息组件
const ChatMessage = React.memo(({ message }) => {
  const isOwn = message.senderId === currentUserId;

  return (
    <Animated.View
      entering={FadeInDown.delay(100)}
      style={[styles.message, isOwn && styles.ownMessage]}
    >
      <Text>{message.text}</Text>
      <Text style={styles.time}>{message.time}</Text>
    </Animated.View>
  );
});
```

## 总结

| 优化方向 | 关键技术 | 预期收益 |
|----------|----------|----------|
| 启动优化 | Hermes | 冷启动快 50%+ |
| 动画优化 | Reanimated | 60fps 流畅动画 |
| 列表优化 | FlashList | 减少 50% 内存 |
| 图片优化 | FastImage | 加载快 2-3 倍 |
| 内存优化 | 清理和监控 | 减少 OOM 崩溃 |

**姐姐的建议**：

1. **先测量再优化**：不要盲目优化，先找出瓶颈
2. **Hermes 必开**：这是免费的性能提升
3. **Reanimated 必用**：动画必须在原生线程执行
4. **FlashList 替代 FlatList**：这是 Shopify 验证过的优化方案
5. **持续监控**：性能优化是一场持久战

性能优化不是一次性的工作，而是需要持续关注和改进的过程。希望这些技巧能帮助宝宝们构建更流畅的 React Native 应用。
