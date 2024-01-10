---
title: "Flutter 入门：Dart 语言基础与第一个 App"
tag: flutter
description: "从 Dart 语言基础到 Flutter 开发环境搭建，手把手带你创建第一个 Flutter 应用，掌握 Flutter 开发的核心概念。"
date: "2024-01-10T08:00:00.000Z"
---

## 目标

Flutter 是 Google 推出的跨平台 UI 框架，使用 Dart 语言开发，可以一套代码同时构建 iOS、Android、Web 和桌面应用。本文从 Dart 语言基础出发，讲解 Flutter 开发环境搭建和第一个应用的创建，帮助开发者快速入门 Flutter 开发。

## 背景

### 为什么选择 Flutter

Flutter 的核心优势：

- **一套代码，多端运行**：iOS、Android、Web、Windows、macOS、Linux
- **高性能**：自绘引擎，不依赖原生控件
- **快速开发**：Hot Reload 实现秒级预览
- **丰富的组件库**：Material Design 和 Cupertino 风格组件
- **Google 支持**：强大的社区和持续更新

### Dart 语言特点

Dart 是 Flutter 的开发语言，具有以下特点：

- **AOT + JIT 编译**：开发时 JIT 实现 Hot Reload，发布时 AOT 保证性能
- **强类型**：静态类型检查，减少运行时错误
- **空安全**：默认不可空，避免 NullPointerException
- **异步支持**：async/await + Isolate 并发

## Dart 语言基础

### 变量与类型

```dart
// 类型推断
var name = 'Flutter'; // String
var age = 3; // int
var height = 1.8; // double
var isStudent = true; // bool

// 显式类型
String email = 'example@flutter.com';
int count = 100;
double price = 99.99;

// 空安全
String? nullableName; // 可空类型
String nonNullName = '必须赋值'; // 非空类型

// 空值处理
print(nullableName?.length); // 条件访问
print(nullableName ?? '默认值'); // 空值合并
print(nullableName!.length); // 强制解包（危险）
```

### 函数

```dart
// 基本函数
int add(int a, int b) {
  return a + b;
}

// 箭头函数
int multiply(int a, int b) => a * b;

// 可选参数
String greet(String name, {String? title}) {
  if (title != null) {
    return '你好, $title $name';
  }
  return '你好, $name';
}

// 默认参数
void printInfo(String name, {int age = 0, String city = '北京'}) {
  print('$name, $age 岁, 来自 $city');
}

// 使用
greet('张三', title: '先生');
printInfo('李四', age: 25);
```

### 类与对象

```dart
// 定义类
class User {
  final String name;
  final int age;
  String? email;

  // 构造函数
  User({
    required this.name,
    required this.age,
    this.email,
  });

  // 命名构造函数
  User.anonymous() : name = '匿名用户', age = 0;

  // 方法
  String introduce() {
    return '我是 $name, $age 岁';
  }

  // getter
  bool get isAdult => age >= 18;
}

// 使用
var user = User(name: '张三', age: 25);
print(user.introduce());
print(user.isAdult);
```

### 集合

```dart
// List（列表）
var fruits = ['苹果', '香蕉', '橙子'];
fruits.add('葡萄');
fruits.remove('香蕉');

// Map（字典）
var scores = {
  '数学': 95,
  '英语': 88,
  '语文': 92,
};
print(scores['数学']);

// Set（集合）
var colors = {'红', '绿', '蓝'};
colors.add('黄');

// 集合操作
var numbers = [1, 2, 3, 4, 5];
var doubled = numbers.map((n) => n * 2).toList();
var evens = numbers.where((n) => n % 2 == 0).toList();
var sum = numbers.reduce((a, b) => a + b);
```

### 异步编程

```dart
// Future
Future<String> fetchData() async {
  // 模拟网络请求
  await Future.delayed(Duration(seconds: 2));
  return '数据加载完成';
}

// 使用 async/await
void loadData() async {
  print('开始加载...');
  var result = await fetchData();
  print(result);
}

// 多个异步操作并行
void loadMultiple() async {
  var results = await Future.wait([
    fetchUser(),
    fetchPosts(),
    fetchComments(),
  ]);
  print(results);
}

// Stream
Stream<int> countStream() async* {
  for (var i = 1; i <= 5; i++) {
    await Future.delayed(Duration(seconds: 1));
    yield i;
  }
}

// 使用 Stream
void listenToStream() async {
  await for (var value in countStream()) {
    print(value);
  }
}
```

## Flutter 开发环境

### 安装步骤

```bash
# 1. 下载 Flutter SDK
# 访问 https://flutter.dev/docs/get-started/install

# 2. 解压并配置环境变量
# Windows
set PATH=%PATH%;C:\flutter\bin

# macOS/Linux
export PATH="$PATH:`pwd`/flutter/bin"

# 3. 运行 Flutter 诊断
flutter doctor

# 4. 安装必要的依赖
flutter doctor --android-licenses
```

### Flutter Doctor 输出

```
Doctor summary (to see all details, run flutter doctor -v):
[✓] Flutter (Channel stable, 3.x.x)
[✓] Android toolchain
[✓] Chrome - develop for the web
[✓] Android Studio
[✓] VS Code
[✓] Connected device
```

## 创建第一个 Flutter 应用

### 项目初始化

```bash
# 创建新项目
flutter create my_first_app

# 进入项目目录
cd my_first_app

# 启动应用
flutter run
```

### 项目结构

```
my_first_app/
├── android/          # Android 平台代码
├── ios/              # iOS 平台代码
├── lib/              # Dart 代码（主要开发目录）
│   └── main.dart     # 应用入口
├── test/             # 测试代码
├── web/              # Web 平台代码
├── pubspec.yaml      # 项目配置文件
└── README.md
```

### 项目配置

```yaml
# pubspec.yaml
name: my_first_app
description: "My first Flutter application"
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.2
  http: ^1.1.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0

flutter:
  uses-material-design: true
```

## 实战：计数器应用

### 完整代码

```dart
// lib/main.dart
import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Demo',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
        useMaterial3: true,
      ),
      home: const MyHomePage(title: 'Flutter Demo Home Page'),
    );
  }
}

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});

  final String title;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  int _counter = 0;

  void _incrementCounter() {
    setState(() {
      _counter++;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: Text(widget.title),
      ),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Text(
              'You have pushed the button this many times:',
            ),
            Text(
              '$_counter',
              style: Theme.of(context).textTheme.headlineMedium,
            ),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _incrementCounter,
        tooltip: 'Increment',
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

### 代码解析

**1. Widget 树结构**

```
MaterialApp
  └── MyHomePage (StatefulWidget)
        └── Scaffold
              ├── AppBar
              │     └── Text
              ├── Body: Center
              │     └── Column
              │           ├── Text
              │           └── Text
              └── FloatingActionButton
```

**2. StatefulWidget vs StatelessWidget**

```dart
// StatelessWidget：不可变，没有状态
class MyWidget extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Text('Hello');
  }
}

// StatefulWidget：可变，有状态
class MyStatefulWidget extends StatefulWidget {
  @override
  State<MyStatefulWidget> createState() => _MyStatefulWidgetState();
}

class _MyStatefulWidgetState extends State<MyStatefulWidget> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    return Text('$count');
  }
}
```

**3. setState 更新状态**

```dart
void _incrementCounter() {
  setState(() {
    _counter++;
  });
  // setState 会触发 rebuild，更新 UI
}
```

## 常用 Widget

### 布局 Widget

```dart
// Row：水平排列
Row(
  children: [
    Icon(Icons.star),
    Icon(Icons.star),
    Icon(Icons.star),
  ],
)

// Column：垂直排列
Column(
  children: [
    Text('标题'),
    Text('内容'),
  ],
)

// Stack：堆叠
Stack(
  children: [
    Image.network('url'),
    Positioned(
      bottom: 10,
      left: 10,
      child: Text('图片标题'),
    ),
  ],
)

// Container：容器
Container(
  width: 100,
  height: 100,
  decoration: BoxDecoration(
    color: Colors.blue,
    borderRadius: BorderRadius.circular(8),
  ),
  child: Center(child: Text('Hello')),
)
```

### 交互 Widget

```dart
// 按钮
ElevatedButton(
  onPressed: () {
    print('点击了按钮');
  },
  child: Text('点我'),
)

// 输入框
TextField(
  decoration: InputDecoration(
    labelText: '用户名',
    hintText: '请输入用户名',
  ),
  onChanged: (value) {
    print('输入: $value');
  },
)

// 列表
ListView.builder(
  itemCount: items.length,
  itemBuilder: (context, index) {
    return ListTile(
      title: Text(items[index]),
      onTap: () {
        print('点击了 ${items[index]}');
      },
    );
  },
)
```

## 总结

Flutter 是一个强大的跨平台开发框架，关键要点：

1. **Dart 语言**：掌握基础语法、异步编程、空安全
2. **Widget 体系**：一切皆 Widget，理解 Widget 树的构建
3. **状态管理**：setState 是基础，复杂场景需要 Provider/Riverpod
4. **开发流程**：Hot Reload 大幅提升开发效率

Flutter 的学习曲线相对平缓，特别是对于有 React/Vue 经验的前端开发者。掌握了 Widget 体系和状态管理，就能快速构建出精美的跨平台应用。

接下来可以深入学习 Flutter 的状态管理、路由、网络请求等高级主题。
