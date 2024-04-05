---
title: "Flutter State Management: Riverpod from Beginner to Expert"
tag: flutter
description: Systematic explanation of Flutter state management solution Riverpod, from basic concepts to advanced usage, mastering best practices for reactive state management.
date: "2024-04-05T08:00:00.000Z"
---

## Goal

Flutter state management is one of the core challenges in application development. Riverpod is currently the most recommended state management solution in the Flutter community, addressing many limitations of Provider. This article starts from basic concepts and systematically explains Riverpod's core usage and advanced features.

## Background

### Flutter State Management Evolution

```
setState (Basic)
  ↓
InheritedWidget (Cross-component sharing)
  ↓
Provider (Dependency injection)
  ↓
Riverpod (Provider rewrite)
  ↓
Bloc (Business logic component)
```

### Why Choose Riverpod

Riverpod's advantages compared to other solutions:

- **Compile-time safety**: Type checking completed at compile time
- **No context dependency**: Doesn't require BuildContext
- **Supports all Provider types**: Future, Stream, State, etc.
- **Testability**: Easy to mock and test
- **Auto-disposal**: Automatically releases resources when Provider is no longer used

## Core Concepts

### Provider Types

```dart
// 1. Provider: Read-only data
final nameProvider = Provider<String>((ref) {
  return 'John';
});

// 2. StateProvider: Simple mutable state
final counterProvider = StateProvider<int>((ref) {
  return 0;
});

// 3. StateNotifierProvider: Complex state management
final todosProvider = StateNotifierProvider<TodoList, List<Todo>>((ref) {
  return TodoList();
});

// 4. FutureProvider: Async data
final userProvider = FutureProvider<User>((ref) async {
  final response = await http.get(Uri.parse('https://api.example.com/user'));
  return User.fromJson(jsonDecode(response.body));
});

// 5. StreamProvider: Stream data
final messagesProvider = StreamProvider<Message>((ref) {
  return messageStream();
});
```

### Basic Usage

```dart
// Define Provider
final counterProvider = StateProvider<int>((ref) => 0);

// Use in Widget
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

## Practice: Todo Application

### Data Model

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

### State Management

```dart
// providers/todo_provider.dart
import 'package:uuid/uuid.dart';

// Todo list state
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

// Filter state
enum TodoFilter { all, active, completed }

final todoFilterProvider = StateProvider<TodoFilter>((ref) {
  return TodoFilter.all;
});

// Filtered todo list
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

// Statistics
final todoStatsProvider = Provider<Map<String, int>>((ref) {
  final todos = ref.watch(todoListProvider);
  return {
    'total': todos.length,
    'active': todos.where((t) => !t.completed).length,
    'completed': todos.where((t) => t.completed).length,
  };
});
```

### UI Components

```dart
// pages/todo_page.dart
class TodoPage extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final todos = ref.watch(filteredTodosProvider);
    final stats = ref.watch(todoStatsProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text('Todos'),
        actions: [
          // Filter button
          PopupMenuButton<TodoFilter>(
            onSelected: (filter) {
              ref.read(todoFilterProvider.notifier).state = filter;
            },
            itemBuilder: (context) => [
              PopupMenuItem(
                value: TodoFilter.all,
                child: Text('All (${stats['total']})'),
              ),
              PopupMenuItem(
                value: TodoFilter.active,
                child: Text('Active (${stats['active']})'),
              ),
              PopupMenuItem(
                value: TodoFilter.completed,
                child: Text('Completed (${stats['completed']})'),
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          // Add todo
          TodoInput(),
          // Todo list
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

// Input component
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
                hintText: 'Add new todo...',
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
            child: Text('Add'),
          ),
        ],
      ),
    );
  }
}

// Todo item component
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

## Advanced Features

### Async Provider

```dart
// Async fetch user info
final userProvider = FutureProvider<User>((ref) async {
  final response = await http.get(
    Uri.parse('https://api.example.com/user'),
    headers: {'Authorization': 'Bearer $token'},
  );

  if (response.statusCode == 200) {
    return User.fromJson(jsonDecode(response.body));
  } else {
    throw Exception('Failed to fetch user info');
  }
});

// Use in Widget
class UserProfile extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final userAsync = ref.watch(userProvider);

    return userAsync.when(
      loading: () => CircularProgressIndicator(),
      error: (error, stack) => Text('Error: $error'),
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
// Real-time message stream
final messagesProvider = StreamProvider<Message>((ref) {
  return FirebaseFirestore.instance
      .collection('messages')
      .orderBy('createdAt', descending: true)
      .snapshots()
      .map((snapshot) => snapshot.docs
          .map((doc) => Message.fromJson(doc.data()))
          .toList());
});

// Use in Widget
class MessageList extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messagesAsync = ref.watch(messagesProvider);

    return messagesAsync.when(
      loading: () => CircularProgressIndicator(),
      error: (error, stack) => Text('Error: $error'),
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

### Provider Dependencies

```dart
// Provider with dependencies
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

### Auto-Disposal

```dart
// Provider automatically disposed when no longer listened to
final autoDisposeProvider = FutureProvider.autoDispose<User>((ref) async {
  // With autoDispose, when no Widget is listening
  // Provider is automatically disposed, releasing resources
  final response = await http.get(Uri.parse('https://api.example.com/user'));
  return User.fromJson(jsonDecode(response.body));
});

// Manual invalidation
final provider = Provider<User>((ref) {
  // Use ref.invalidate(provider) to manually invalidate
  // Or ref.refresh(provider) to refresh
  return fetchUser();
});
```

## Testing

```dart
// Unit test
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

void main() {
  test('TodoList add todo', () {
    final container = ProviderContainer();

    // Initial state
    expect(container.read(todoListProvider), isEmpty);

    // Add todo
    container.read(todoListProvider.notifier).add('Test todo');

    // Verify state
    expect(container.read(todoListProvider).length, 1);
    expect(container.read(todoListProvider).first.title, 'Test todo');

    // Cleanup
    container.dispose();
  });

  test('Filter functionality', () {
    final container = ProviderContainer();

    // Add todos
    container.read(todoListProvider.notifier).add('Todo 1');
    container.read(todoListProvider.notifier).add('Todo 2');

    // Complete first one
    final firstId = container.read(todoListProvider).first.id;
    container.read(todoListProvider.notifier).toggle(firstId);

    // Filter active
    container.read(todoFilterProvider.notifier).state = TodoFilter.active;
    expect(container.read(filteredTodosProvider).length, 1);

    // Filter completed
    container.read(todoFilterProvider.notifier).state = TodoFilter.completed;
    expect(container.read(filteredTodosProvider).length, 1);

    container.dispose();
  });
}
```

## Conclusion

Riverpod is one of the best practices for Flutter state management. Key takeaways:

1. **Type safety**: Compile-time checks reduce runtime errors
2. **No context dependency**: Can be used anywhere
3. **Multiple Provider types**: Satisfies different state management needs
4. **Reactive updates**: Automatically rebuilds affected Widgets
5. **Easy to test**: ProviderContainer facilitates testing

Riverpod's learning curve is relatively gentle, but mastering it requires understanding its reactive model. Once you master Riverpod, you can build maintainable, testable Flutter applications.
