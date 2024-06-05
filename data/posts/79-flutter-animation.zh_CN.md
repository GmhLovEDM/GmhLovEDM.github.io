---
title: "Flutter 动画进阶：隐式动画、Hero 动画与自定义动画"
tag: flutter
description: 深入解析 Flutter 动画体系，涵盖隐式动画组件、Hero 共享元素过渡动画和自定义动画的实现方式。
date: "2024-06-05T08:00:00.000Z"
---

## 目标

这篇文章旨在帮助 Flutter 开发者深入理解动画系统的核心机制，掌握三种主要动画范式的使用场景和实现技巧。无论是日常开发中的界面过渡，还是复杂交互中的自定义动画效果，都能在这里找到对应的解决方案。

## 背景

Flutter 的动画系统一直是其最大的优势之一。相比 React Native 依赖原生桥接实现动画，Flutter 直接通过 Skia 渲染引擎绘制每一帧，能够实现接近 60fps 的流畅动画效果。然而，很多开发者只停留在使用 `AnimatedContainer` 这类基础组件的阶段，对更深层的动画机制缺乏了解。

### 动画的本质

在 Flutter 中，动画的本质是**属性值随时间的插值变化**。一个完整的动画需要三个核心要素：

1. **AnimationController**：控制动画的时间线（Duration、Curve）
2. **Tween**：定义动画的起始值和结束值
3. **Builder**：根据当前动画值重建 UI

这三者构成了 Flutter 动画的底层架构，无论是隐式动画还是自定义动画，本质上都在这个框架内运行。

## 一、隐式动画：最简单的动画方式

隐式动画（Implicit Animations）是 Flutter 提供的一组"开箱即用"的动画组件，你只需要改变属性值，Flutter 会自动处理中间的过渡动画。

### 常用的隐式动画组件

```dart
// AnimatedContainer - 最常用的隐式动画组件
AnimatedContainer(
  duration: Duration(milliseconds: 300),
  curve: Curves.easeInOut,
  width: _isExpanded ? 200.0 : 100.0,
  height: _isExpanded ? 200.0 : 100.0,
  decoration: BoxDecoration(
    color: _isExpanded ? Colors.blue : Colors.red,
    borderRadius: BorderRadius.circular(_isExpanded ? 20.0 : 8.0),
  ),
  child: Center(
    child: Text('Tap me'),
  ),
)
```

### 隐式动画的种类

Flutter 提供了丰富的隐式动画组件，每种组件对应不同的属性类型：

| 组件 | 动画属性 | 典型场景 |
|------|----------|----------|
| AnimatedContainer | 大小、颜色、边距等 | 容器变换 |
| AnimatedOpacity | 透明度 | 淡入淡出 |
| AnimatedPadding | 内边距 | 动态间距 |
| AnimatedPositioned | 位置（需在Stack中） | 浮动元素 |
| AnimatedSwitcher | 子组件切换 | 内容过渡 |
| AnimatedDefaultTextStyle | 文字样式 | 文字变换 |

### AnimatedSwitcher 的高级用法

`AnimatedSwitcher` 是最灵活的隐式动画组件之一，它可以为子组件的切换添加过渡效果：

```dart
AnimatedSwitcher(
  duration: Duration(milliseconds: 500),
  transitionBuilder: (Widget child, Animation<double> animation) {
    return ScaleTransition(scale: animation, child: child);
  },
  child: _showIcon
    ? Icon(Icons.star, key: ValueKey(1), size: 100)
    : Icon(Icons.star_border, key: ValueKey(2), size: 100),
)
```

**关键点**：`AnimatedSwitcher` 需要通过 `Key` 来区分不同的子组件，否则它无法检测到子组件的变化。

## 二、Hero 动画：共享元素过渡

Hero 动画是移动应用中最经典的过渡模式——从一个页面的某个元素平滑过渡到另一个页面的对应元素。Flutter 原生支持这种动画，只需要简单的配置。

### 基本实现

```dart
// 页面 A
Hero(
  tag: 'avatar',  // 唯一标识，两个页面必须一致
  child: CircleAvatar(
    radius: 30,
    backgroundImage: NetworkImage(user.avatarUrl),
  ),
)

// 页面 B
Hero(
  tag: 'avatar',
  child: CircleAvatar(
    radius: 100,
    backgroundImage: NetworkImage(user.avatarUrl),
  ),
)

// 导航代码
Navigator.push(
  context,
  PageRouteBuilder(
    pageBuilder: (context, animation, secondaryAnimation) => DetailPage(),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      return child;  // Hero 动画会自动处理
    },
  ),
);
```

### 自定义 Hero 飞行动画

默认的 Hero 动画是线性插值，但实际项目中我们经常需要更丰富的效果。通过 `HeroController` 和自定义 `PageRoute`，可以实现复杂的飞行动画曲线：

```dart
class CustomHeroDelegate extends HeroController {
  @override
  Rect getRectFromContext({
    required BuildContext context,
    required AxisDirection direction,
    required Rect navigatorRect,
  }) {
    // 自定义起始/结束位置
    return super.getRectFromContext(
      context: context,
      direction: direction,
      navigatorRect: navigatorRect,
    );
  }
}
```

### Hero 动画的注意事项

1. **Tag 必须唯一**：同一页面内不能有重复的 tag
2. **类型匹配**：两个 Hero 的子组件类型最好一致
3. **性能考量**：复杂的 Hero 动画可能影响页面切换性能

## 三、自定义动画：AnimationController 完全掌控

当隐式动画无法满足需求时，我们需要使用 `AnimationController` 进行完全自定义的动画控制。

### 基础结构

```dart
class PulseAnimation extends StatefulWidget {
  @override
  _PulseAnimationState createState() => _PulseAnimationState();
}

class _PulseAnimationState extends State<PulseAnimation>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: Duration(seconds: 2),
      vsync: this,  // 使用 SingleTickerProviderStateMixin
    );

    // 定义动画曲线
    _scaleAnimation = Tween<double>(
      begin: 1.0,
      end: 1.5,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.elasticOut,
    ));

    // 循环播放
    _controller.repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _scaleAnimation,
      builder: (context, child) {
        return Transform.scale(
          scale: _scaleAnimation.value,
          child: child,
        );
      },
      child: Container(
        width: 100,
        height: 100,
        decoration: BoxDecoration(
          color: Colors.blue,
          shape: BoxShape.circle,
        ),
      ),
    );
  }
}
```

### 多动画控制器

复杂动画往往需要多个属性同时变化，但变化节奏不同。这时可以使用 `AnimationController` 配合多个 `Tween`：

```dart
class ComplexAnimation extends StatefulWidget {
  @override
  _ComplexAnimationState createState() => _ComplexAnimationState();
}

class _ComplexAnimationState extends State<ComplexAnimation>
    with TickerProviderStateMixin {
  late AnimationController _rotationController;
  late AnimationController _scaleController;
  late Animation<double> _rotation;
  late Animation<double> _scale;

  @override
  void initState() {
    super.initState();

    _rotationController = AnimationController(
      duration: Duration(seconds: 3),
      vsync: this,
    );

    _scaleController = AnimationController(
      duration: Duration(milliseconds: 500),
      vsync: this,
    );

    _rotation = Tween<double>(
      begin: 0,
      end: 2 * 3.14159,
    ).animate(CurvedAnimation(
      parent: _rotationController,
      curve: Curves.linear,
    ));

    _scale = Tween<double>(
      begin: 1.0,
      end: 0.5,
    ).animate(CurvedAnimation(
      parent: _scaleController,
      curve: Curves.bounceOut,
    ));

    _rotationController.repeat();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([_rotation, _scale]),
      builder: (context, child) {
        return Transform.rotate(
          angle: _rotation.value,
          child: Transform.scale(
            scale: _scale.value,
            child: child,
          ),
        );
      },
      child: Icon(Icons.refresh, size: 100),
    );
  }
}
```

### AnimatedBuilder vs AnimatedWidget

Flutter 提供了两种构建动画 UI 的方式：

- **AnimatedBuilder**：更灵活，可以在 builder 中组合多个动画
- **AnimatedWidget**：更简洁，适合封装可复用的动画组件

```dart
// 使用 AnimatedWidget 封装可复用组件
class RotationTransition extends AnimatedWidget {
  const RotationTransition({
    required Animation<double> animation,
    required this.child,
  }) : super(listenable: animation);

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final animation = listenable as Animation<double>;
    return Transform.rotate(
      angle: animation.value,
      child: child,
    );
  }
}
```

## 四、实战：组合动画案例

让我们来看一个实际项目中常见的动画需求——加载指示器的动画效果：

```dart
class LoadingIndicator extends StatefulWidget {
  @override
  _LoadingIndicatorState createState() => _LoadingIndicatorState();
}

class _LoadingIndicatorState extends State<LoadingIndicator>
    with TickerProviderStateMixin {
  late AnimationController _rotateController;
  late AnimationController _pulseController;

  @override
  void initState() {
    super.initState();
    _rotateController = AnimationController(
      duration: Duration(seconds: 2),
      vsync: this,
    )..repeat();

    _pulseController = AnimationController(
      duration: Duration(milliseconds: 800),
      vsync: this,
    )..repeat(reverse: true);
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([_rotateController, _pulseController]),
      builder: (context, child) {
        return Transform.rotate(
          angle: _rotateController.value * 2 * 3.14159,
          child: Transform.scale(
            scale: 0.8 + _pulseController.value * 0.4,
            child: Container(
              width: 60,
              height: 60,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: SweepGradient(
                  colors: [Colors.blue, Colors.transparent],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
```

## 五、性能优化建议

1. **使用 RepaintBoundary**：隔离动画的重绘区域，避免影响其他 UI 元素
2. **避免在 build 中创建动画对象**：动画应该在 `initState` 中创建
3. **及时 dispose**：确保在组件销毁时释放动画控制器
4. **使用 const 构造函数**：减少不必要的重建
5. **考虑使用 Lottie**：复杂动画可以用 Lottie 导入 AE 动画文件，性能更好

## 总结

Flutter 的动画系统层次分明，从简单到复杂：

- **隐式动画**：适合简单的属性过渡，代码量最少
- **Hero 动画**：专门用于页面间共享元素过渡，开箱即用
- **自定义动画**：完全掌控动画的每一个细节，适合复杂场景

掌握这三种动画范式，基本可以覆盖 Flutter 开发中 90% 的动画需求。在实际项目中，建议优先使用隐式动画，只有在无法满足需求时才考虑自定义动画方案。
