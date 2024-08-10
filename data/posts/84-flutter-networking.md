---
title: "Flutter Networking and Data Persistence: Dio + Hive in Practice"
tag: flutter
description: An in-depth guide to Flutter network request encapsulation, interceptor mechanisms, and local data persistence, demonstrating best practices with Dio and Hive through practical projects.
date: "2024-08-10T08:00:00.000Z"
---

## Goal

This article aims to help Flutter developers master best practices for network request encapsulation and local data persistence, including advanced Dio usage, interceptor mechanisms, Hive implementation, and offline-first architecture design.

## Background

In mobile application development, network requests and data storage are the two most fundamental and important aspects. The Flutter ecosystem offers multiple networking libraries and local storage solutions, with Dio and Hive being the most popular combination.

### Why Choose Dio + Hive?

1. **Dio**: A powerful HTTP client supporting interceptors, request cancellation, and timeout control
2. **Hive**: A lightweight NoSQL database with better performance than SharedPreferences and SQLite
3. **Combined Use**: Enables offline-first mobile application architecture

## 1. Dio Basic Configuration

### Install Dependencies

```yaml
# pubspec.yaml
dependencies:
  dio: ^5.4.0
  pretty_dio_logger: ^1.4.0
  connectivity_plus: ^5.0.0
```

### Create Dio Instance

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

    // Add interceptors
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

## 2. Interceptor Mechanism

### Authentication Interceptor

```dart
InterceptorsWrapper _authInterceptor() {
  return InterceptorsWrapper(
    onRequest: (options, handler) async {
      // Get token
      final token = await TokenService.getToken();
      
      if (token != null) {
        options.headers['Authorization'] = 'Bearer $token';
      }
      
      handler.next(options);
    },
    onError: (error, handler) async {
      // Handle 401 error, try to refresh token
      if (error.response?.statusCode == 401) {
        try {
          final newToken = await _refreshToken();
          error.requestOptions.headers['Authorization'] = 'Bearer $newToken';
          
          // Retry request
          final response = await _dio.fetch(error.requestOptions);
          handler.resolve(response);
          return;
        } catch (e) {
          // Refresh token failed, navigate to login
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

### Retry Interceptor

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
        // Continue retrying or give up
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

### Cache Interceptor

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

## 3. Hive Data Persistence

### Install Dependencies

```yaml
dependencies:
  hive: ^2.2.3
  hive_flutter: ^1.1.0
  path_provider: ^2.1.0
```

### Initialize Hive

```dart
import 'package:hive_flutter/hive_flutter.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // Initialize Hive
  await Hive.initFlutter();
  
  // Register adapters
  Hive.registerAdapter(UserAdapter());
  Hive.registerAdapter(PostAdapter());
  
  // Open boxes
  await Hive.openBox('settings');
  await Hive.openBox<User>('users');
  await Hive.openBox<Post>('posts');
  
  runApp(MyApp());
}
```

### Define Data Models

```dart
import 'package:hive/hive.dart';

part 'user.g.dart'; // Run build_runner to generate adapter

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

### Data Access Layer

```dart
class UserRepository {
  final Box<User> _userBox;
  final ApiClient _apiClient;

  UserRepository(this._userBox, this._apiClient);

  // Get user (offline-first)
  Future<User?> getUser(String id) async {
    // First try local
    final localUser = _userBox.get(id);
    
    if (localUser != null) {
      // Background refresh
      _refreshUser(id);
      return localUser;
    }
    
    // No local data, fetch from network
    try {
      final response = await _apiClient.dio.get('/users/$id');
      final user = User.fromJson(response.data);
      await _userBox.put(id, user);
      return user;
    } catch (e) {
      return null;
    }
  }

  // Background refresh
  Future<void> _refreshUser(String id) async {
    try {
      final response = await _apiClient.dio.get('/users/$id');
      final user = User.fromJson(response.data);
      await _userBox.put(id, user);
    } catch (e) {
      // Network error, use local data
    }
  }

  // Save user
  Future<void> saveUser(User user) async {
    // Save locally
    await _userBox.put(user.id, user);
    
    // Sync to server
    try {
      await _apiClient.dio.post('/users', data: user.toJson());
    } catch (e) {
      // Mark for sync
      _markForSync(user.id);
    }
  }

  // Get all users
  List<User> getAllUsers() {
    return _userBox.values.toList();
  }
}
```

## 4. Network State Management

### Connection Status Monitoring

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

### Offline Queue

```dart
class OfflineQueue {
  final Box<Map> _queueBox;
  final ApiClient _apiClient;

  OfflineQueue(this._queueBox, this._apiClient);

  // Add to offline queue
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

  // Process offline queue
  Future<void> processQueue() async {
    final items = _queueBox.values.toList();
    
    for (final item in items) {
      try {
        await _apiClient.dio.request(
          item['path'],
          data: item['data'],
          options: Options(method: item['method']),
        );
        // Delete on success
        await _queueBox.deleteAt(items.indexOf(item));
      } catch (e) {
        // Failed, keep for next retry
        break;
      }
    }
  }
}
```

## 5. Practical Example: Complete Data Layer Architecture

### Architecture Diagram

```
+-----------------------------------------------------------+
|                      UI Layer                              |
|  +----------------+  +----------------+  +----------------+  |
|  |     Screen     |  |     Screen     |  |     Screen     |  |
|  +--------+-------+  +--------+-------+  +--------+-------+  |
+-----------|------------------|------------------|-----------+
|           |       State Management       |                    |
|           |    +-------------------+     |                    |
|           |    | Provider/BLoC/Riverpod  |                    |
|           |    +-------------------+     |                    |
+-----------|------------------|------------------|-----------+
|           |         Data Layer         |                    |
|    +------+--------+  +------+--------+  +------+--------+  |
|    |     User     |  |      Post      |  |     Auth     |  |
|    |  Repository  |  |   Repository   |  |    Service   |  |
|    +------+--------+  +------+--------+  +------+--------+  |
+-----------|------------------|------------------|-----------+
|           |        Storage Layer        |                    |
|    +------+--------+  +------+--------+  +------+--------+  |
|    |     Hive     |  |      Hive      |  |    Secure    |  |
|    |   (Cache)    |  |    (Store)     |  |   Storage    |  |
|    +--------------+  +----------------+  +--------------+  |
+-----------------------------------------------------------+
```

### Complete Example

```dart
// Define data source abstraction
abstract class UserDataSource {
  Future<User?> getUser(String id);
  Future<List<User>> getUsers();
  Future<void> saveUser(User user);
  Future<void> deleteUser(String id);
}

// Local data source
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

// Remote data source
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

// Repository (offline-first strategy)
class UserRepositoryImpl implements UserRepository {
  final LocalUserDataSource _local;
  final RemoteUserDataSource _remote;
  final ConnectivityService _connectivity;

  UserRepositoryImpl(this._local, this._remote, this._connectivity);

  @override
  Future<User?> getUser(String id) async {
    // First get from local
    final localUser = await _local.getUser(id);
    
    // Check network connection
    if (await _connectivity.checkConnection()) {
      // Background refresh
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
      // Ignore sync errors
    }
  }
}
```

## 6. Performance Optimization

### Request Cancellation

```dart
class ApiClient {
  CancelToken? _cancelToken;

  void cancelRequests() {
    _cancelToken?.cancel('Request cancelled');
  }

  Future<Response> getRequest(String path) {
    _cancelToken = CancelToken();
    return _dio.get(path, cancelToken: _cancelToken);
  }
}
```

### Data Pagination

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

## Summary

| Component | Responsibility | Advantage |
|-----------|---------------|-----------|
| Dio | Network requests | Interceptors, cancellation, timeout |
| Hive | Local storage | Fast, lightweight, type-safe |
| Interceptors | Request/response handling | Reusable, composable |
| Repository Pattern | Data coordination | Offline-first, separation of concerns |

**Recommendations**:

1. **Encapsulate Dio**: Do not use raw Dio directly in business code
2. **Leverage Interceptors**: Authentication, caching, and logging should all be handled through interceptors
3. **Offline-first**: Mobile applications must handle unstable network conditions
4. **Data Synchronization**: Implement offline queues to ensure eventual data consistency
5. **Performance Monitoring**: Record request duration, success rates, and other metrics

This solution has been thoroughly validated in production environments and will help you build more robust Flutter applications.
