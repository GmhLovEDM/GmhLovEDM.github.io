---
title: "Flutter 测试策略：单元测试、Widget 测试到集成测试"
tag: flutter
description: 系统介绍 Flutter 的三层测试策略，包括单元测试、Widget 测试和集成测试的最佳实践和实战技巧。
date: "2024-10-10T08:00:00.000Z"
---

## 目标

本文旨在帮助 Flutter 开发者建立完整的测试体系，理解三种测试类型的区别和应用场景，掌握编写高质量测试的技巧，提升代码质量和可维护性。

## 背景

软件测试是保证代码质量的关键环节。Flutter 提供了完善的测试框架，支持从单元测试到集成测试的完整测试流程。然而，很多开发者要么不写测试，要么测试写得不够好。

### 为什么需要测试？

1. **保证质量**：测试是代码质量的最后防线
2. **重构信心**：有测试保护，重构更放心
3. **文档作用**：测试是代码使用方式的活文档
4. **减少 Bug**：在生产环境前发现问题

### Flutter 测试金字塔

```
        /\
       /  \        集成测试（少量）
      /    \       端到端、跨组件
     /──────\
    /        \     Widget 测试（中量）
   /          \    组件交互、UI 逻辑
  /────────────\
 /              \  单元测试（大量）
/                \ 函数、类、逻辑
```

## 一、单元测试

### 基础配置

```yaml
# pubspec.yaml
dev_dependencies:
  test: ^1.24.0
  mockito: ^5.4.0
  build_runner: ^2.4.0
```

### 编写单元测试

```dart
// lib/models/user.dart
class User {
  final String id;
  final String name;
  final String email;

  User({required this.id, required this.name, required this.email});

  bool get isValidEmail {
    final emailRegex = RegExp(r'^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$');
    return emailRegex.hasMatch(email);
  }
}

// test/models/user_test.dart
import 'package:test/test.dart';
import 'package:my_app/models/user.dart';

void main() {
  group('User', () {
    test('should create a valid user', () {
      final user = User(
        id: '1',
        name: 'John',
        email: 'john@example.com',
      );

      expect(user.id, '1');
      expect(user.name, 'John');
      expect(user.email, 'john@example.com');
    });

    test('should validate email correctly', () {
      final validUser = User(
        id: '1',
        name: 'John',
        email: 'john@example.com',
      );

      final invalidUser = User(
        id: '2',
        name: 'Jane',
        email: 'invalid-email',
      );

      expect(validUser.isValidEmail, true);
      expect(invalidUser.isValidEmail, false);
    });

    test('should handle edge cases', () {
      final userWithSpecialChars = User(
        id: '1',
        name: 'John',
        email: 'john.doe+tag@sub.domain.com',
      );

      expect(userWithSpecialChars.isValidEmail, true);
    });
  });
}
```

### 测试异步代码

```dart
// lib/services/api_service.dart
class ApiService {
  final HttpClient client;

  ApiService(this.client);

  Future<User> getUser(String id) async {
    final response = await client.get(Uri.parse('/users/$id'));
    if (response.statusCode == 200) {
      return User.fromJson(jsonDecode(response.body));
    }
    throw Exception('Failed to load user');
  }
}

// test/services/api_service_test.dart
import 'package:test/test.dart';
import 'package:mockito/mockito.dart';
import 'package:my_app/services/api_service.dart';

class MockHttpClient extends Mock implements HttpClient {}
class MockHttpResponse extends Mock implements HttpClientResponse {}

void main() {
  group('ApiService', () {
    late ApiService apiService;
    late MockHttpClient mockClient;

    setUp(() {
      mockClient = MockHttpClient();
      apiService = ApiService(mockClient);
    });

    test('should return user on success', () async {
      final mockResponse = MockHttpResponse();
      when(mockClient.get(any)).thenAnswer((_) async => mockResponse);
      when(mockResponse.statusCode).thenReturn(200);
      when(mockResponse.body).thenReturn('{"id":"1","name":"John"}');

      final user = await apiService.getUser('1');

      expect(user.id, '1');
      expect(user.name, 'John');
    });

    test('should throw exception on failure', () async {
      final mockResponse = MockHttpResponse();
      when(mockClient.get(any)).thenAnswer((_) async => mockResponse);
      when(mockResponse.statusCode).thenReturn(404);

      expect(
        () => apiService.getUser('1'),
        throwsException,
      );
    });
  });
}
```

### 测试 BLoC/Cubit

```dart
// lib/blocs/counter/counter_cubit.dart
class CounterCubit extends Cubit<int> {
  CounterCubit() : super(0);

  void increment() => emit(state + 1);
  void decrement() => emit(state - 1);
  void reset() => emit(0);
}

// test/blocs/counter_cubit_test.dart
import 'package:bloc_test/bloc_test.dart';
import 'package:test/test.dart';
import 'package:my_app/blocs/counter/counter_cubit.dart';

void main() {
  group('CounterCubit', () {
    blocTest<CounterCubit, int>(
      'emits [1] when increment is called',
      build: () => CounterCubit(),
      act: (cubit) => cubit.increment(),
      expect: () => [1],
    );

    blocTest<CounterCubit, int>(
      'emits [-1] when decrement is called',
      build: () => CounterCubit(),
      act: (cubit) => cubit.decrement(),
      expect: () => [-1],
    );

    blocTest<CounterCubit, int>(
      'emits [0] when reset is called',
      build: () => CounterCubit(),
      seed: () => 5,
      act: (cubit) => cubit.reset(),
      expect: () => [0],
    );
  });
}
```

## 二、Widget 测试

### 基础 Widget 测试

```dart
// lib/widgets/user_card.dart
class UserCard extends StatelessWidget {
  final User user;
  final VoidCallback? onTap;

  const UserCard({required this.user, this.onTap, Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(user.name, style: Theme.of(context).textTheme.headline6),
              Text(user.email),
            ],
          ),
        ),
      ),
    );
  }
}

// test/widgets/user_card_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/widgets/user_card.dart';

void main() {
  testWidgets('UserCard displays user information', (tester) async {
    final user = User(
      id: '1',
      name: 'John',
      email: 'john@example.com',
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: UserCard(user: user),
        ),
      ),
    );

    // 验证显示用户信息
    expect(find.text('John'), findsOneWidget);
    expect(find.text('john@example.com'), findsOneWidget);
  });

  testWidgets('UserCard calls onTap when tapped', (tester) async {
    bool tapped = false;
    final user = User(
      id: '1',
      name: 'John',
      email: 'john@example.com',
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: UserCard(
            user: user,
            onTap: () => tapped = true,
          ),
        ),
      ),
    );

    await tester.tap(find.byType(UserCard));
    expect(tapped, true);
  });
}
```

### 测试带状态的 Widget

```dart
// test/widgets/counter_widget_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:my_app/widgets/counter_widget.dart';

void main() {
  testWidgets('CounterWidget increments counter', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CounterWidget(),
        ),
      ),
    );

    // 初始值
    expect(find.text('0'), findsOneWidget);

    // 点击增加按钮
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump();

    expect(find.text('1'), findsOneWidget);
  });

  testWidgets('CounterWidget decrements counter', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CounterWidget(),
        ),
      ),
    );

    // 点击减少按钮
    await tester.tap(find.byIcon(Icons.remove));
    await tester.pump();

    expect(find.text('-1'), findsOneWidget);
  });
}
```

### 测试表单验证

```dart
// test/widgets/login_form_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/widgets/login_form.dart';

void main() {
  testWidgets('LoginForm validates email', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LoginForm(
            onSubmit: (_, __) {},
          ),
        ),
      ),
    );

    // 点击提交按钮
    await tester.tap(find.byType(ElevatedButton));
    await tester.pump();

    // 应该显示验证错误
    expect(find.text('请输入邮箱'), findsOneWidget);
  });

  testWidgets('LoginForm submits with valid data', (tester) async {
    String? submittedEmail;
    String? submittedPassword;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LoginForm(
            onSubmit: (email, password) {
              submittedEmail = email;
              submittedPassword = password;
            },
          ),
        ),
      ),
    );

    // 输入有效数据
    await tester.enterText(
      find.byKey(Key('email_field')),
      'john@example.com',
    );
    await tester.enterText(
      find.byKey(Key('password_field')),
      'password123',
    );

    // 点击提交
    await tester.tap(find.byType(ElevatedButton));
    await tester.pump();

    expect(submittedEmail, 'john@example.com');
    expect(submittedPassword, 'password123');
  });
}
```

## 三、集成测试

### 配置

```yaml
# pubspec.yaml
dev_dependencies:
  integration_test:
    sdk: flutter

# integration_test/app_test.dart
```

### 编写集成测试

```dart
// integration_test/app_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:my_app/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Full app login flow', (tester) async {
    app.main();
    await tester.pumpAndSettle();

    // 验证首页
    expect(find.text('Welcome'), findsOneWidget);

    // 点击登录按钮
    await tester.tap(find.byType(ElevatedButton));
    await tester.pumpAndSettle();

    // 应该导航到登录页
    expect(find.byType(TextFormField), findsNWidgets(2));

    // 输入登录信息
    await tester.enterText(
      find.byKey(Key('email_field')),
      'john@example.com',
    );
    await tester.enterText(
      find.byKey(Key('password_field')),
      'password123',
    );

    // 点击登录
    await tester.tap(find.byType(ElevatedButton));
    await tester.pumpAndSettle();

    // 应该显示主页
    expect(find.text('Home'), findsOneWidget);
  });

  testWidgets('Complete user journey', (tester) async {
    app.main();
    await tester.pumpAndSettle();

    // 1. 登录
    await tester.tap(find.byType(ElevatedButton));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(Key('email_field')), 'john@example.com');
    await tester.enterText(find.byKey(Key('password_field')), 'password123');
    await tester.tap(find.byType(ElevatedButton));
    await tester.pumpAndSettle();

    // 2. 浏览内容
    await tester.scrollUntilVisible(
      find.text('Product 10'),
      500.0,
    );
    await tester.tap(find.text('Product 10'));
    await tester.pumpAndSettle();

    // 3. 添加到购物车
    await tester.tap(find.byIcon(Icons.add_shopping_cart));
    await tester.pumpAndSettle();

    // 4. 查看购物车
    await tester.tap(find.byIcon(Icons.shopping_cart));
    await tester.pumpAndSettle();

    expect(find.text('Product 10'), findsOneWidget);
  });
}
```

## 四、测试最佳实践

### 测试命名规范

```dart
// 好的测试命名
test('should return empty list when no users exist', () {});
test('should throw exception when API call fails', () {});
test('should update state when button is tapped', () {});

// 不好的测试命名
test('test1', () {});
test('works', () {});
test('user', () {});
```

### 测试结构（AAA 模式）

```dart
test('should calculate total price correctly', () {
  // Arrange（准备）
  final cart = Cart();
  cart.addItem(Product(name: 'A', price: 10));
  cart.addItem(Product(name: 'B', price: 20));

  // Act（执行）
  final total = cart.totalPrice;

  // Assert（断言）
  expect(total, 30);
});
```

### Mock 最佳实践

```dart
// 只 Mock 你拥有的接口
class MockUserService extends Mock implements UserService {}

// 避免过度 Mock
// 不好的做法：Mock 所有东西
// 好的做法：Mock 边界（网络、数据库等）
```

### 测试覆盖率

```bash
# 运行测试并生成覆盖率报告
flutter test --coverage

# 查看覆盖率
genhtml coverage/lcov.info -o coverage/html

# 常用覆盖率指标
# - 行覆盖率：目标 80%+
# - 分支覆盖率：目标 70%+
# - 函数覆盖率：目标 90%+
```

## 五、CI/CD 集成

### GitHub Actions 配置

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - uses: subosito/flutter-action@v2
      with:
        flutter-version: '3.16.0'
        channel: 'stable'
    
    - name: Install dependencies
      run: flutter pub get
    
    - name: Analyze code
      run: flutter analyze
    
    - name: Run unit tests
      run: flutter test
    
    - name: Run widget tests
      run: flutter test test/widget_test.dart
    
    - name: Run integration tests
      run: flutter test integration_test/
    
    - name: Upload coverage
      uses: codecov/codecov-action@v3
      with:
        file: coverage/lcov.info
```

## 六、测试工具推荐

| 工具 | 用途 | 推荐度 |
|------|------|--------|
| test | 核心测试框架 | 必需 |
| mockito | Mock 框架 | 推荐 |
| bloc_test | BLoC 测试 | BLoC 项目必需 |
| golden_toolkit | 截图测试 | UI 项目推荐 |
| patrol | 集成测试增强 | 推荐 |

## 总结

| 测试类型 | 速度 | 成本 | 覆盖范围 | 数量 |
|----------|------|------|----------|------|
| 单元测试 | 快 | 低 | 函数/类 | 大量 |
| Widget 测试 | 中 | 中 | 组件 | 中量 |
| 集成测试 | 慢 | 高 | 整个应用 | 少量 |

**姐姐的建议**：

1. **先写测试**：TDD（测试驱动开发）是好习惯
2. **测试金字塔**：单元测试为主，集成测试为辅
3. **持续集成**：每次提交都运行测试
4. **不要追求 100%**：关注关键业务逻辑
5. **测试是投资**：短期增加成本，长期减少维护成本

测试是专业开发者的必备技能。希望这篇指南能帮助宝宝们建立完善的测试体系，写出更可靠的 Flutter 应用。
