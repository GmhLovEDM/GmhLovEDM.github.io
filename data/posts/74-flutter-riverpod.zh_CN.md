---
title: "Flutter 状态管理：Riverpod 从入门到精通"
tag: flutter
description: 系统讲解 Flutter 状态管理方案 Riverpod，从基础概念到高级用法，掌握响应式状态管理的最佳实践。
date: "2024-04-05T08:00:00.000Z"
---

## 目标

Flutter 的状态管理是应用开发的核心挑战之一。Riverpod 是目前 Flutter 社区最受推荐的状态管理方案，它解决了 Provider 的诸多限制。本文从基础概念出发，系统讲解 Riverpod 的核心用法和高级特性。

## 背景

### Flutter 状态管理的演进

```
setState (基础)
  ↓
InheritedWidget (跨组件共享)
  ↓
Provider (依赖注入)
  ↓
Riverpod (Provider 的重写)
  ↓
Bloc (业务逻辑组件)
```

### 为什么选择 Riverpod

Riverpod 相比其他方案的优势：

- **编译时安全**：类型检查在编译时完成
- **无上下文依赖**：不需要 BuildContext
- **支持所有 Provider**：Future、Stream、State 等
- **可测试性**：易于 mock 和测试
- **自动销毁**：Provider 不再使用时自动释放资源

## 核心概念

### Provider 类型

```dart
// 1. Provider：只读数据
final nameProvider = Provider<String>((ref) {
  return '张三';
});

// 2. StateProvider：简单可变状态
final counterProvider = StateProvider<int>((ref) {
  return 0;
});

// 3. StateNotifierProvider：复杂状态管理
final todosProvider = StateNotifierProvider<TodoList, List<Todo>>((ref) {
  return TodoList();
});

// 4. FutureProvider：异步数据
final userProvider = FutureProvider<User>((ref) async {
  final response = await http.get(Uri.parse('https://api.example.com/user'));
  return User.fromJson(jsonDecode(response.body));
});

// 5. StreamProvider：流数据
final messagesProvider = StreamProvider<Message>((ref) {
  return messageStream();
});
```

### 基本用法

```dart
// 定义 Provider
final counterProvider = StateProvider<int>((ref) => 0);

// 在 Widget 中使用
class CounterWidget extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final count = ref.watch(counterProvider);

    return Row(
      children: [
        IconButton(
          icon: Icon(Icons.remove),
          onPressed: () => ref.read(counterProvider.notifier).state--,
        ),
        Text('$count'),
        IconButton(
          icon: Icon(Icons.add),
          onPressed: () => ref.read(counterProvider.notifier).state++,
        ),
      ],
    );
  }
}
```

## 实战：Todo 应用

### 数据模型

```dart
// models/todo.dart
class Todo {
  final String id;
  final String title;
  final bool completed;
  final DateTime createdAt;

  Todo({
    required this.id,
    required this.title,
    this.completed = false,
    required this.createdAt,
  });

  Todo copyWith({
    String? id,
    String? title,
    bool? completed,
    DateTime? createdAt,
  }) {
    return Todo(
      id: id ?? this.id,
      title: title ?? this.title,
      completed: completed ?? this.completed,
      createdAt: createdAt ?? this.createdAt,
    );
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'title': title,
    'completed': completed,
    'createdAt': createdAt.toIso8601String(),
  };

  factory Todo.fromJson(Map<String, dynamic> json) => Todo(
    id: json['id'],
    title: json['title'],
    completed: json['completed'],
    createdAt: DateTime.parse(json['createdAt']),
  );
}
```

### 状态管理

```dart
// providers/todo_provider.dart
import 'package:uuid/uuid.dart';

// Todo 列表状态
class TodoList extends StateNotifier<List<Todo>> {
  TodoList() : super([]);

  final _uuid = Uuid();

  void add(String title) {
    state = [
      ...state,
      Todo(
        id: _uuid.v4(),
        title: title,
        createdAt: DateTime.now(),
      ),
    ];
  }

  void toggle(String id) {
    state = [
      for (final todo in state)
        if (todo.id == id)
          todo.copyWith(completed: !todo.completed)
        else
          todo,
    ];
  }

  void remove(String id) {
    state = state.where((todo) => todo.id != id).toList();
  }

  void edit(String id, String newTitle) {
    state = [
      for (final todo in state)
        if (todo.id == id)
          todo.copyWith(title: newTitle)
        else
          todo,
    ];
  }
}

final todoListProvider = StateNotifierProvider<TodoList, List<Todo>>((ref) {
  return TodoList();
});

// 筛选状态
enum TodoFilter { all, active, completed }

final todoFilterProvider = StateProvider<TodoFilter>((ref) {
  return TodoFilter.all;
});

// 筛选后的 Todo 列表
final filteredTodosProvider = Provider<List<Todo>>((ref) {
  final todos = ref.watch(todoListProvider);
  final filter = ref.watch(todoFilterProvider);

  switch (filter) {
    case TodoFilter.all:
      return todos;
    case TodoFilter.active:
      return todos.where((todo) => !todo.completed).toList();
    case TodoFilter.completed:
      return todos.where((todo) => todo.completed).toList();
  }
});

// 统计信息
final todoStatsProvider = Provider<Map<String, int>>((ref) {
  final todos = ref.watch(todoListProvider);
  return {
    'total': todos.length,
    'active': todos.where((t) => !t.completed).length,
    'completed': todos.where((t) => t.completed).length,
  };
});
```

### UI 组件

```dart
// pages/todo_page.dart
class TodoPage extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final todos = ref.watch(filteredTodosProvider);
    final stats = ref.watch(todoStatsProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text('待办事项'),
        actions: [
          // 筛选按钮
          PopupMenuButton<TodoFilter>(
            onSelected: (filter) {
              ref.read(todoFilterProvider.notifier).state = filter;
            },
            itemBuilder: (context) => [
              PopupMenuItem(
                value: TodoFilter.all,
                child: Text('全部 (${stats['total']})'),
              ),
              PopupMenuItem(
                value: TodoFilter.active,
                child: Text('进行中 (${stats['active']})'),
              ),
              PopupMenuItem(
                value: TodoFilter.completed,
                child: Text('已完成 (${stats['completed']})'),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          // 添加待办
          TodoInput(),
          // 待办列表
          Expanded(
            child: ListView.builder(
              itemCount: todos.length,
              itemBuilder: (context, index) {
                return TodoItem(todo: todos[index]);
              },
            ),
          ),
        ],
      ),
    );
  }
}

// 输入框组件
class TodoInput extends ConsumerStatefulWidget {
  @override
  ConsumerState<TodoInput> createState() => _TodoInputState();
}

class _TodoInputState extends ConsumerState<TodoInput> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.all(16),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _controller,
              decoration: InputDecoration(
                hintText: '添加新待办...',
                border: OutlineInputBorder(),
              ),
              onSubmitted: (value) {
                if (value.trim().isNotEmpty) {
                  ref.read(todoListProvider.notifier).add(value.trim());
                  _controller.clear();
                }
              },
            ),
          ),
          SizedBox(width: 8),
          ElevatedButton(
            onPressed: () {
              if (_controller.text.trim().isNotEmpty) {
                ref.read(todoListProvider.notifier).add(_controller.text.trim());
                _controller.clear();
              }
            },
            child: Text('添加'),
          ),
        ],
      ),
    );
  }
}

// 待办项组件
class TodoItem extends ConsumerWidget {
  final Todo todo;

  const TodoItem({required this.todo});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListTile(
      leading: Checkbox(
        value: todo.completed,
        onChanged: (_) {
          ref.read(todoListProvider.notifier).toggle(todo.id);
        },
      ),
      title: Text(
        todo.title,
        style: TextStyle(
          decoration: todo.completed ? TextDecoration.lineThrough : null,
          color: todo.completed ? Colors.grey : null,
        ),
      ),
      trailing: IconButton(
        icon: Icon(Icons.delete, color: Colors.red),
        onPressed: () {
          ref.read(todoListProvider.notifier).remove(todo.id);
        },
      ),
    );
  }
}
```

## 高级特性

### 异步 Provider

```dart
// 异步获取用户信息
final userProvider = FutureProvider<User>((ref) async {
  final response = await http.get(
    Uri.parse('https://api.example.com/user'),
    headers: {'Authorization': 'Bearer $token'},
  );

  if (response.statusCode == 200) {
    return User.fromJson(jsonDecode(response.body));
  } else {
    throw Exception('获取用户信息失败');
  }
});

// 在 Widget 中使用
class UserProfile extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(userProvider);

    return userAsync.when(
      loading: () => CircularProgressIndicator(),
      error: (error, stack) => Text('错误: $error'),
      data: (user) => Column(
        children: [
          CircleAvatar(
            backgroundImage: NetworkImage(user.avatar),
          ),
          Text(user.name),
          Text(user.email),
        ],
      ),
    );
  }
}
```

### Stream Provider

```dart
// 实时消息流
final messagesProvider = StreamProvider<Message>((ref) {
  return FirebaseFirestore.instance
      .collection('messages')
      .orderBy('createdAt', descending: true)
      .snapshots()
      .map((snapshot) => snapshot.docs
          .map((doc) => Message.fromJson(doc.data()))
          .toList());
});

// 在 Widget 中使用
class MessageList extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messagesAsync = ref.watch(messagesProvider);

    return messagesAsync.when(
      loading: () => CircularProgressIndicator(),
      error: (error, stack) => Text('错误: $error'),
      data: (messages) => ListView.builder(
        itemCount: messages.length,
        itemBuilder: (context, index) {
          return ListTile(
            title: Text(messages[index].content),
            subtitle: Text(messages[index].sender),
          );
        },
      ),
    );
  }
}
```

### Provider 依赖

```dart
// 带依赖的 Provider
final apiClientProvider = Provider<ApiClient>((ref) {
  final baseUrl = ref.watch(baseUrlProvider);
  return ApiClient(baseUrl);
});

final userProvider = FutureProvider<User>((ref) async {
  final apiClient = ref.watch(apiClientProvider);
  return apiClient.getUser();
});

final userPostsProvider = FutureProvider<List<Post>>((ref) async {
  final user = ref.watch(userProvider);
  final apiClient = ref.watch(apiClientProvider);
  return apiClient.getUserPosts(user.id);
});
```

### 自动销毁

```dart
// Provider 不再被监听时自动销毁
final autoDisposeProvider = FutureProvider.autoDispose<User>((ref) async {
  // 使用 autoDispose 后，当没有 Widget 监听时
  // Provider 会被自动销毁，释放资源
  final response = await http.get(Uri.parse('https://api.example.com/user'));
  return User.fromJson(jsonDecode(response.body));
});

// 手动失效
final provider = Provider<User>((ref) {
  // 使用 ref.invalidate(provider) 手动失效
  // 或 ref.refresh(provider) 刷新
  return fetchUser();
});
```

## 测试

```dart
// 单元测试
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('TodoList 添加待办', () {
    final container = ProviderContainer();

    // 初始状态
    expect(container.read(todoListProvider), isEmpty);

    // 添加待办
    container.read(todoListProvider.notifier).add('测试待办');

    // 验证状态
    expect(container.read(todoListProvider).length, 1);
    expect(container.read(todoListProvider).first.title, '测试待办');

    // 清理
    container.dispose();
  });

  test('筛选功能', () {
    final container = ProviderContainer();

    // 添加待办
    container.read(todoListProvider.notifier).add('待办 1');
    container.read(todoListProvider.notifier).add('待办 2');

    // 完成第一个
    final firstId = container.read(todoListProvider).first.id;
    container.read(todoListProvider.notifier).toggle(firstId);

    // 筛选进行中
    container.read(todoFilterProvider.notifier).state = TodoFilter.active;
    expect(container.read(filteredTodosProvider).length, 1);

    // 筛选已完成
    container.read(todoFilterProvider.notifier).state = TodoFilter.completed;
    expect(container.read(filteredTodosProvider).length, 1);

    container.dispose();
  });
}
```

## 总结

Riverpod 是 Flutter 状态管理的最佳实践之一。关键要点：

1. **类型安全**：编译时检查，减少运行时错误
2. **无上下文依赖**：可以在任何地方使用
3. **多种 Provider**：满足不同的状态管理需求
4. **响应式更新**：自动重建受影响的 Widget
5. **易于测试**：ProviderContainer 方便测试

Riverpod 的学习曲线相对平缓，但要精通需要理解其响应式模型。掌握了 Riverpod，就能构建出可维护、可测试的 Flutter 应用。
