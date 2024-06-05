---
title: "Flutter Advanced Animations: Implicit, Hero, and Custom Animations"
tag: flutter
description: An in-depth exploration of Flutter's animation system, covering implicit animation widgets, Hero shared element transitions, and custom animation implementation techniques.
date: "2024-06-05T08:00:00.000Z"
---

## Goal

This article aims to help Flutter developers develop a deep understanding of the core mechanisms behind Flutter's animation system and master the use cases and implementation techniques of three major animation paradigms. Whether you need simple interface transitions in daily development or complex custom animation effects in advanced interactions, you will find practical solutions here.

## Background

Flutter's animation system has always been one of its greatest strengths. Compared to React Native, which relies on native bridging for animations, Flutter directly renders every frame through the Skia rendering engine, achieving smooth animations close to 60fps. However, many developers only use basic widgets like `AnimatedContainer` and lack knowledge of the deeper animation mechanisms.

### The Nature of Animations

In Flutter, animations are fundamentally **interpolated property value changes over time**. A complete animation requires three core elements:

1. **AnimationController**: Controls the timeline of the animation (Duration, Curve)
2. **Tween**: Defines the start and end values of the animation
3. **Builder**: Rebuilds the UI based on the current animation value

These three components form the underlying architecture of Flutter animations. Whether using implicit animations or custom animations, they all operate within this framework.

## 1. Implicit Animations: The Simplest Way to Animate

Implicit Animations are a set of "out-of-the-box" animated widgets provided by Flutter. You only need to change property values, and Flutter automatically handles the transition animation.

### Common Implicit Animation Widgets

```dart
// AnimatedContainer - the most commonly used implicit animation widget
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

### Types of Implicit Animations

Flutter provides a rich set of implicit animation widgets, each corresponding to different property types:

| Widget | Animated Property | Typical Use Case |
|--------|-------------------|------------------|
| AnimatedContainer | Size, color, padding, etc. | Container transitions |
| AnimatedOpacity | Opacity | Fade in/out |
| AnimatedPadding | Padding | Dynamic spacing |
| AnimatedPositioned | Position (requires Stack) | Floating elements |
| AnimatedSwitcher | Child switching | Content transitions |
| AnimatedDefaultTextStyle | Text style | Text transformations |

### Advanced Usage of AnimatedSwitcher

`AnimatedSwitcher` is one of the most flexible implicit animation widgets. It can add transition effects when switching between child widgets:

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

**Key Point**: `AnimatedSwitcher` requires `Key` to distinguish between different child widgets; otherwise, it cannot detect child widget changes.

## 2. Hero Animations: Shared Element Transitions

Hero animations are the most classic transition pattern in mobile applications -- a smooth transition from an element on one page to a corresponding element on another page. Flutter natively supports this animation with simple configuration.

### Basic Implementation

```dart
// Page A
Hero(
  tag: 'avatar',  // Unique identifier, must match across pages
  child: CircleAvatar(
    radius: 30,
    backgroundImage: NetworkImage(user.avatarUrl),
  ),
)

// Page B
Hero(
  tag: 'avatar',
  child: CircleAvatar(
    radius: 100,
    backgroundImage: NetworkImage(user.avatarUrl),
  ),
)

// Navigation code
Navigator.push(
  context,
  PageRouteBuilder(
    pageBuilder: (context, animation, secondaryAnimation) => DetailPage(),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      return child;  // Hero animation handles automatically
    },
  ),
);
```

### Custom Hero Flight Animation

The default Hero animation uses linear interpolation, but in real projects we often need richer effects. Through `HeroController` and custom `PageRoute`, you can implement complex flight animation curves:

```dart
class CustomHeroDelegate extends HeroController {
  @override
  Rect getRectFromContext({
    required BuildContext context,
    required AxisDirection direction,
    required Rect navigatorRect,
  }) {
    // Custom start/end positions
    return super.getRectFromContext(
      context: context,
      direction: direction,
      navigatorRect: navigatorRect,
    );
  }
}
```

### Hero Animation Considerations

1. **Tags must be unique**: No duplicate tags within the same page
2. **Type matching**: The child widget types of both Heroes should ideally match
3. **Performance**: Complex Hero animations may affect page transition performance

## 3. Custom Animations: Full Control with AnimationController

When implicit animations cannot meet your needs, you need to use `AnimationController` for fully customized animation control.

### Basic Structure

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
      vsync: this,  // Using SingleTickerProviderStateMixin
    );

    // Define animation curve
    _scaleAnimation = Tween<double>(
      begin: 1.0,
      end: 1.5,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: Curves.elasticOut,
    ));

    // Loop playback
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

### Multiple Animation Controllers

Complex animations often require multiple properties to change simultaneously but at different paces. In this case, you can use `AnimationController` with multiple `Tween` objects:

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

Flutter provides two approaches for building animated UIs:

- **AnimatedBuilder**: More flexible, can combine multiple animations in the builder
- **AnimatedWidget**: More concise, suitable for encapsulating reusable animation components

```dart
// Using AnimatedWidget to encapsulate reusable components
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

## 4. Practical Example: Combining Animations

Let's look at a common animation requirement in real projects -- a loading indicator animation:

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

## 5. Performance Optimization Tips

1. **Use RepaintBoundary**: Isolate animation repaint regions to avoid affecting other UI elements
2. **Avoid creating animation objects in build**: Animations should be created in `initState`
3. **Dispose promptly**: Ensure animation controllers are released when the widget is destroyed
4. **Use const constructors**: Reduce unnecessary rebuilds
5. **Consider using Lottie**: Complex animations can use Lottie to import After Effects animation files for better performance

## Summary

Flutter's animation system is well-structured, from simple to complex:

- **Implicit Animations**: Suitable for simple property transitions, minimal code
- **Hero Animations**: Specifically for shared element transitions between pages, ready to use
- **Custom Animations**: Full control over every detail of the animation, suitable for complex scenarios

Mastering these three animation paradigms covers about 90% of animation needs in Flutter development. In practice, prefer implicit animations and only consider custom animation solutions when they cannot meet your requirements.
