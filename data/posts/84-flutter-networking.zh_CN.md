---
title: "Flutter 网络请求与数据持久化：Dio + Hive 实战"
tag: flutter
description: 深入讲解 Flutter 网络请求封装、拦截器机制和本地数据持久化方案，通过实战项目演示 Dio 和 Hive 的最佳实践。
date: "2024-08-10T08:00:00.000Z"
---

## 目标

本文旨在帮助 Flutter 开发者掌握网络请求封装和本地数据持久化的最佳实践，包括 Dio 的高级用法、拦截器机制、Hive 的使用方法，以及离线优先的架构设计。

## 背景

移动应用开发中，网络请求和数据存储是最基础也是最重要的两个环节。Flutter 生态中有多种网络请求库和本地存储方案，其中 Dio 和 Hive 是目前最受欢迎的组合。

### 为什么选择 Dio + Hive？

1. **Dio**：功能强大的 HTTP 客户端，支持拦截器、取消请求、超时控制
2. **Hive**：轻量级 NoSQL 数据库，性能优于 SharedPreferences 和 SQLite
3. **配合使用**：实现离线优先的移动应用架构

## 一、Dio 基础配置

### 安装依赖

```yaml
# pubspec.yaml
dependencies:
  dio: ^5.4.0
  pretty_dio_logger: ^1.4.0
  connectivity_plus: ^5.0.0
```

### 创建 Dio 实例

```dart
import 'package:dio/dio.dart';
import 'package:pretty_dio_logger/pretty_dio_logger.dart';

class ApiClient {
  static ApiClient? _instance;
  late final Dio _dio;

  ApiClient._internal() {
    _dio = Dio(
      BaseOptions(
        baseUrl: 'https://api.example.com/v1',
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 15),
        sendTimeout: const Duration(seconds: 15),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      ),
    );

    // 添加拦截器
    _dio.interceptors.addAll([
      _authInterceptor(),
      _retryInterceptor(),
      _loggingInterceptor(),
    ]);
  }

  factory ApiClient() {
    _instance ??= ApiClient._internal();
    return _instance!;
  }

  Dio get dio => _dio;
}
```

## 二、拦截器机制

### 认证拦截器

```dart
InterceptorsWrapper _authInterceptor() {
  return InterceptorsWrapper(
    onRequest: (options, handler) async {
      // 获取 token
      final token = await TokenService.getToken();
      
      if (token != null) {
        options.headers['Authorization'] = 'Bearer $token';
      }
      
      handler.next(options);
    },
    onError: (error, handler) async {
      // 处理 401 错误，尝试刷新 token
      if (error.response?.statusCode == 401) {
        try {
          final newToken = await _refreshToken();
          error.requestOptions.headers['Authorization'] = 'Bearer $newToken';
          
          // 重试请求
          final response = await _dio.fetch(error.requestOptions);
          handler.resolve(response);
          return;
        } catch (e) {
          // 刷新 token 失败，跳转登录页
          await _handleAuthError();
        }
      }
      
      handler.next(error);
    },
    onResponse: (response, handler) {
      handler.next(response);
    },
  );
}

Future<String> _refreshToken() async {
  final refreshToken = await TokenService.getRefreshToken();
  final response = await Dio().post(
    'https://api.example.com/auth/refresh',
    data: {'refresh_token': refreshToken},
  );
  final newToken = response.data['access_token'];
  await TokenService.saveToken(newToken);
  return newToken;
}
```

### 重试拦截器

```dart
class RetryInterceptor extends Interceptor {
  final int maxRetries;
  final Duration retryDelay;

  RetryInterceptor({
    this.maxRetries = 3,
    this.retryDelay = const Duration(seconds: 1),
  });

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    final retryCount = err.requestOptions.extra['retryCount'] ?? 0;
    
    if (retryCount < maxRetries && _shouldRetry(err)) {
      err.requestOptions.extra['retryCount'] = retryCount + 1;
      
      await Future.delayed(retryDelay * (retryCount + 1));
      
      try {
        final response = await Dio().fetch(err.requestOptions);
        handler.resolve(response);
        return;
      } catch (e) {
        // 继续重试或放弃
      }
    }
    
    handler.next(err);
  }

  bool _shouldRetry(DioException err) {
    return err.type == DioExceptionType.connectionTimeout ||
           err.type == DioExceptionType.sendTimeout ||
           err.type == DioExceptionType.receiveTimeout ||
           (err.response?.statusCode ?? 0) >= 500;
  }
}
```

### 缓存拦截器

```dart
class CacheInterceptor extends Interceptor {
  final CacheManager cacheManager;

  CacheInterceptor(this.cacheManager);

  @override
  void onRequest(RequestOptions options, handler) async {
    if (options.method == 'GET') {
      final cache = await cacheManager.get(options.uri.toString());
      
      if (cache != null && !cache.isExpired) {
        handler.resolve(Response(
          requestOptions: options,
          data: cache.data,
          statusCode: 200,
        ));
        return;
      }
    }
    
    handler.next(options);
  }

  @override
  void onResponse(Response response, handler) async {
    if (response.requestOptions.method == 'GET') {
      await cacheManager.put(
        response.requestOptions.uri.toString(),
        CacheEntry(
          data: response.data,
          expiry: DateTime.now().add(const Duration(minutes: 5)),
        ),
      );
    }
    
    handler.next(response);
  }
}
```

## 三、Hive 数据持久化

### 安装依赖

```yaml
dependencies:
  hive: ^2.2.3
  hive_flutter: ^1.1.0
  path_provider: ^2.1.0
```

### 初始化 Hive

```dart
import 'package:hive_flutter/hive_flutter.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // 初始化 Hive
  await Hive.initFlutter();
  
  // 注册适配器
  Hive.registerAdapter(UserAdapter());
  Hive.registerAdapter(PostAdapter());
  
  // 打开 Box
  await Hive.openBox('settings');
  await Hive.openBox<User>('users');
  await Hive.openBox<Post>('posts');
  
  runApp(MyApp());
}
```

### 定义数据模型

```dart
import 'package:hive/hive.dart';

part 'user.g.dart'; // 需要运行 build_runner 生成适配器

@HiveType(typeId: 0)
class User extends HiveObject {
  @HiveField(0)
  final String id;

  @HiveField(1)
  final String name;

  @HiveField(2)
  final String email;

  @HiveField(3)
  final DateTime createdAt;

  User({
    required this.id,
    required this.name,
    required this.email,
    required this.createdAt,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
      createdAt: DateTime.parse(json['created_at']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'email': email,
      'created_at': createdAt.toIso8601String(),
    };
  }
}
```

### 数据访问层

```dart
class UserRepository {
  final Box<User> _userBox;
  final ApiClient _apiClient;

  UserRepository(this._userBox, this._apiClient);

  // 获取用户（离线优先）
  Future<User?> getUser(String id) async {
    // 先从本地获取
    final localUser = _userBox.get(id);
    
    if (localUser != null) {
      // 后台更新
      _refreshUser(id);
      return localUser;
    }
    
    // 本地没有，从网络获取
    try {
      final response = await _apiClient.dio.get('/users/$id');
      final user = User.fromJson(response.data);
      await _userBox.put(id, user);
      return user;
    } catch (e) {
      return null;
    }
  }

  // 后台刷新
  Future<void> _refreshUser(String id) async {
    try {
      final response = await _apiClient.dio.get('/users/$id');
      final user = User.fromJson(response.data);
      await _userBox.put(id, user);
    } catch (e) {
      // 网络错误，使用本地数据
    }
  }

  // 保存用户
  Future<void> saveUser(User user) async {
    // 保存到本地
    await _userBox.put(user.id, user);
    
    // 同步到服务器
    try {
      await _apiClient.dio.post('/users', data: user.toJson());
    } catch (e) {
      // 标记为待同步
      _markForSync(user.id);
    }
  }

  // 获取所有用户
  List<User> getAllUsers() {
    return _userBox.values.toList();
  }
}
```

## 四、网络状态管理

### 连接状态监听

```dart
import 'package:connectivity_plus/connectivity_plus.dart';

class ConnectivityService {
  final Connectivity _connectivity = Connectivity();
  final StreamController<bool> _connectionController = 
      StreamController<bool>.broadcast();

  Stream<bool> get connectionStream => _connectionController.stream;

  ConnectivityService() {
    _init();
  }

  void _init() {
    _connectivity.onConnectivityChanged.listen((result) {
      final isConnected = result != ConnectivityResult.none;
      _connectionController.add(isConnected);
    });
  }

  Future<bool> checkConnection() async {
    final result = await _connectivity.checkConnectivity();
    return result != ConnectivityResult.none;
  }

  void dispose() {
    _connectionController.close();
  }
}
```

### 离线队列

```dart
class OfflineQueue {
  final Box<Map> _queueBox;
  final ApiClient _apiClient;

  OfflineQueue(this._queueBox, this._apiClient);

  // 添加到离线队列
  Future<void> enqueue({
    required String method,
    required String path,
    Map<String, dynamic>? data,
  }) async {
    await _queueBox.add({
      'method': method,
      'path': path,
      'data': data,
      'timestamp': DateTime.now().toIso8601String(),
    });
  }

  // 处理离线队列
  Future<void> processQueue() async {
    final items = _queueBox.values.toList();
    
    for (final item in items) {
      try {
        await _apiClient.dio.request(
          item['path'],
          data: item['data'],
          options: Options(method: item['method']),
        );
        // 成功后删除
        await _queueBox.deleteAt(items.indexOf(item));
      } catch (e) {
        // 失败，保留等待下次重试
        break;
      }
    }
  }
}
```

## 五、实战：完整的数据层架构

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                      UI Layer                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Screen    │  │   Screen    │  │   Screen    │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
├─────────┼────────────────┼────────────────┼─────────────┤
│         │           State Management     │              │
│         │    ┌───────────┴───────────┐   │              │
│         │    │   Provider/BLoC/Riverpod│  │              │
│         │    └───────────┬───────────┘   │              │
├─────────┼────────────────┼────────────────┼─────────────┤
│         │              Data Layer        │              │
│    ┌────┴────┐    ┌──────┴──────┐    ┌───┴────┐        │
│    │  User   │    │    Post     │    │  Auth  │        │
│    │ Repository│   │ Repository │    │Service │        │
│    └────┬────┘    └──────┬──────┘    └───┬────┘        │
├─────────┼────────────────┼────────────────┼─────────────┤
│         │          Storage Layer         │              │
│    ┌────┴────┐    ┌──────┴──────┐    ┌───┴────┐        │
│    │  Hive   │    │    Hive     │    │ Secure │        │
│    │ (Cache) │    │   (Store)   │    │Storage │        │
│    └─────────┘    └─────────────┘    └────────┘        │
└─────────────────────────────────────────────────────────┘
```

### 完整示例

```dart
// 定义数据源抽象
abstract class UserDataSource {
  Future<User?> getUser(String id);
  Future<List<User>> getUsers();
  Future<void> saveUser(User user);
  Future<void> deleteUser(String id);
}

// 本地数据源
class LocalUserDataSource implements UserDataSource {
  final Box<User> _box;

  LocalUserDataSource(this._box);

  @override
  Future<User?> getUser(String id) async {
    return _box.get(id);
  }

  @override
  Future<List<User>> getUsers() async {
    return _box.values.toList();
  }

  @override
  Future<void> saveUser(User user) async {
    await _box.put(user.id, user);
  }

  @override
  Future<void> deleteUser(String id) async {
    await _box.delete(id);
  }
}

// 远程数据源
class RemoteUserDataSource implements UserDataSource {
  final ApiClient _apiClient;

  RemoteUserDataSource(this._apiClient);

  @override
  Future<User?> getUser(String id) async {
    try {
      final response = await _apiClient.dio.get('/users/$id');
      return User.fromJson(response.data);
    } catch (e) {
      return null;
    }
  }

  @override
  Future<List<User>> getUsers() async {
    try {
      final response = await _apiClient.dio.get('/users');
      return (response.data as List)
          .map((json) => User.fromJson(json))
          .toList();
    } catch (e) {
      return [];
    }
  }

  @override
  Future<void> saveUser(User user) async {
    await _apiClient.dio.post('/users', data: user.toJson());
  }

  @override
  Future<void> deleteUser(String id) async {
    await _apiClient.dio.delete('/users/$id');
  }
}

// 仓库（离线优先策略）
class UserRepositoryImpl implements UserRepository {
  final LocalUserDataSource _local;
  final RemoteUserDataSource _remote;
  final ConnectivityService _connectivity;

  UserRepositoryImpl(this._local, this._remote, this._connectivity);

  @override
  Future<User?> getUser(String id) async {
    // 先从本地获取
    final localUser = await _local.getUser(id);
    
    // 检查网络连接
    if (await _connectivity.checkConnection()) {
      // 后台更新
      _syncUser(id);
    }
    
    return localUser;
  }

  Future<void> _syncUser(String id) async {
    try {
      final remoteUser = await _remote.getUser(id);
      if (remoteUser != null) {
        await _local.saveUser(remoteUser);
      }
    } catch (e) {
      // 忽略同步错误
    }
  }
}
```

## 六、性能优化

### 请求取消

```dart
class ApiClient {
  CancelToken? _cancelToken;

  void cancelRequests() {
    _cancelToken?.cancel('请求已取消');
  }

  Future<Response> getRequest(String path) {
    _cancelToken = CancelToken();
    return _dio.get(path, cancelToken: _cancelToken);
  }
}
```

### 数据分页

```dart
class PaginatedRepository<T> {
  final int pageSize;
  int _currentPage = 0;
  bool _hasMore = true;

  PaginatedRepository({this.pageSize = 20});

  Future<List<T>> loadMore(Future<List<T>> Function(int page) fetcher) async {
    if (!_hasMore) return [];

    try {
      final items = await fetcher(_currentPage);
      _currentPage++;
      _hasMore = items.length == pageSize;
      return items;
    } catch (e) {
      return [];
    }
  }

  void reset() {
    _currentPage = 0;
    _hasMore = true;
  }
}
```

## 总结

| 组件 | 职责 | 优势 |
|------|------|------|
| Dio | 网络请求 | 拦截器、取消、超时 |
| Hive | 本地存储 | 快速、轻量、类型安全 |
| 拦截器 | 请求/响应处理 | 可复用、可组合 |
| 仓库模式 | 数据协调 | 离线优先、关注点分离 |

**姐姐的建议**：

1. **封装 Dio**：不要在业务代码中直接使用原生 Dio
2. **善用拦截器**：认证、缓存、日志都应该通过拦截器处理
3. **离线优先**：移动应用必须考虑网络不稳定的情况
4. **数据同步**：实现离线队列，确保数据最终一致性
5. **性能监控**：记录请求耗时、成功率等指标

这套方案在生产环境中已经得到了充分验证，希望能帮助宝宝们构建更健壮的 Flutter 应用。
