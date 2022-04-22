---
title: "Spring Boot + MyBatis Plus: Backend CRUD Best Practices"
tag: java
description: MyBatis Plus is an enhancement tool for MyBatis that significantly improves development efficiency. This article introduces how to use MyBatis Plus in Spring Boot projects for efficient CRUD operations.
date: "2022-04-22T08:00:00.000Z"
---

## Goal

Master the usage of MyBatis Plus in Spring Boot projects and implement efficient database operations.

## Background

### MyBatis vs MyBatis Plus

| Feature | MyBatis | MyBatis Plus |
|---------|---------|--------------|
| Basic CRUD | Requires manual XML | Auto-generated |
| Condition builders | Requires manual SQL | Chain API |
| Pagination | Requires additional configuration | Built-in support |
| Code generator | Requires third-party tools | Built-in |
| Logical delete | Requires manual implementation | Annotation configuration |

MyBatis Plus significantly simplifies development without changing MyBatis itself.

## Project Configuration

### 1. Dependency Configuration

```xml
<!-- pom.xml -->
<dependencies>
    <dependency>
        <groupId>com.baomidou</groupId>
        <artifactId>mybatis-plus-boot-starter</artifactId>
        <version>3.5.2</version>
    </dependency>
    <dependency>
        <groupId>mysql</groupId>
        <artifactId>mysql-connector-java</artifactId>
    </dependency>
    <dependency>
        <groupId>com.alibaba</groupId>
        <artifactId>druid-spring-boot-starter</artifactId>
        <version>1.2.15</version>
    </dependency>
</dependencies>
```

### 2. Configuration File

```yaml
# application.yml
spring:
  datasource:
    driver-class-name: com.mysql.cj.jdbc.Driver
    url: jdbc:mysql://localhost:3306/demo_db?useSSL=false&serverTimezone=UTC
    username: root
    password: your_password
    type: com.alibaba.druid.pool.DruidDataSource

mybatis-plus:
  configuration:
    log-impl: org.apache.ibatis.logging.stdout.StdOutImpl
    map-underscore-to-camel-case: true
  global-config:
    db-config:
      id-type: auto
      logic-delete-field: deleted
      logic-delete-value: 1
      logic-not-delete-value: 0
```

## Entity Class Definition

```java
package com.example.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("users")
public class User {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;

    private String email;

    private String nickname;

    private Integer age;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
```

### Common Annotations

| Annotation | Description |
|------------|-------------|
| @TableName | Specify table name |
| @TableId | Specify primary key |
| @TableField | Specify field |
| @TableLogic | Logical delete field |
| @Version | Optimistic lock field |

## CRUD Operations

### 1. Basic CRUD

```java
package com.example.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.entity.User;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserMapper extends BaseMapper<User> {
    // Inherit BaseMapper, automatically get CRUD methods
}
```

```java
// Usage
@Service
public class UserService {

    @Autowired
    private UserMapper userMapper;

    // Create
    public User create(User user) {
        userMapper.insert(user);
        return user;
    }

    // Get by ID
    public User getById(Long id) {
        return userMapper.selectById(id);
    }

    // Update
    public void update(User user) {
        userMapper.updateById(user);
    }

    // Delete by ID
    public void delete(Long id) {
        userMapper.deleteById(id);
    }

    // Get all
    public List<User> list() {
        return userMapper.selectList(null);
    }
}
```

### 2. Condition Builders

```java
// QueryWrapper: query conditions
QueryWrapper<User> wrapper = new QueryWrapper<>();
wrapper.eq("status", 1)
       .like("name", "Zhang")
       .orderByDesc("created_at");

List<User> users = userMapper.selectList(wrapper);

// LambdaQueryWrapper: type-safe
LambdaQueryWrapper<User> lambdaWrapper = new LambdaQueryWrapper<>();
lambdaWrapper.eq(User::getStatus, 1)
             .like(User::getName, "Zhang")
             .orderByDesc(User::getCreatedAt);

List<User> users = userMapper.selectList(lambdaWrapper);

// UpdateWrapper: update conditions
UpdateWrapper<User> updateWrapper = new UpdateWrapper<>();
updateWrapper.eq("id", 1)
             .set("status", 0);

userMapper.update(null, updateWrapper);
```

### 3. Paginated Queries

```java
// Configure pagination plugin
@Configuration
public class MybatisPlusConfig {

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.MYSQL));
        return interceptor;
    }
}
```

```java
// Paginated query
public IPage<User> getPage(int page, int size) {
    Page<User> pageParam = new Page<>(page, size);
    LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
    wrapper.orderByDesc(User::getCreatedAt);
    return userMapper.selectPage(pageParam, wrapper);
}

// Conditional paginated query
public IPage<User> search(String keyword, int page, int size) {
    Page<User> pageParam = new Page<>(page, size);
    LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
    wrapper.like(User::getUsername, keyword)
           .or()
           .like(User::getEmail, keyword);
    return userMapper.selectPage(pageParam, wrapper);
}
```

### 4. Batch Operations

```java
// Batch insert
public void batchInsert(List<User> users) {
    userMapper.insertBatch(users);
}

// Batch update
public void batchUpdate(List<User> users) {
    users.forEach(user -> userMapper.updateById(user));
}

// Batch delete
public void batchDelete(List<Long> ids) {
    userMapper.deleteBatchIds(ids);
}
```

## Service Layer Encapsulation

### 1. Base Service

```java
package com.example.service;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;

public abstract class BaseService<M extends BaseMapper<T>, T> extends ServiceImpl<M, T> {

    // Can add common methods here
}
```

### 2. Business Service

```java
@Service
public class UserService extends BaseService<UserMapper, User> {

    // Custom business methods
    public User findByUsername(String username) {
        return lambdaQuery()
                .eq(User::getUsername, username)
                .one();
    }

    public IPage<User> search(String keyword, int page, int size) {
        return lambdaPage(
                new Page<>(page, size),
                lambdaWrapper()
                        .like(StringUtils.isNotBlank(keyword), User::getUsername, keyword)
                        .orderByDesc(User::getCreatedAt)
        );
    }

    public void register(User user) {
        // Check if username already exists
        if (lambdaQuery().eq(User::getUsername, user.getUsername()).exists()) {
            throw new RuntimeException("Username already exists");
        }
        // Check if email already exists
        if (lambdaQuery().eq(User::getEmail, user.getEmail()).exists()) {
            throw new RuntimeException("Email already in use");
        }
        // Save user
        save(user);
    }
}
```

## Advanced Features

### 1. Logical Delete

```java
// Entity class
@TableLogic
private Integer deleted;

// Usage
// Delete operation automatically converts to UPDATE SET deleted = 1
userMapper.deleteById(1);
// Actually executes: UPDATE users SET deleted = 1 WHERE id = 1

// Query automatically filters deleted records
userMapper.selectList(null);
// Actually executes: SELECT * FROM users WHERE deleted = 0
```

### 2. Auto-fill

```java
// Create handler
@Component
public class MyMetaObjectHandler implements MetaObjectHandler {

    @Override
    public void insertFill(MetaObject metaObject) {
        this.strictInsertFill(metaObject, "createdAt", LocalDateTime.class, LocalDateTime.now());
        this.strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }

    @Override
    public void updateFill(MetaObject metaObject) {
        this.strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }
}
```

### 3. Optimistic Lock

```java
// Entity class
@Version
private Integer version;

// Configuration
@Bean
public MybatisPlusInterceptor mybatisPlusInterceptor() {
    MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
    interceptor.addInnerInterceptor(new OptimisticLockerInnerInterceptor());
    return interceptor;
}

// Usage
User user = userMapper.selectById(1);
user.setAge(25);
int rows = userMapper.updateById(user);
// Actually executes: UPDATE users SET age = 25, version = version + 1 WHERE id = 1 AND version = #{version}
```

### 4. Code Generator

```java
public class CodeGenerator {

    public static void main(String[] args) {
        FastAutoGenerator.create("jdbc:mysql://localhost:3306/demo_db", "root", "password")
            .globalConfig(builder -> {
                builder.author("Zhang San")
                    .outputDir("D:\\project\\src\\main\\java")
                    .disableOpenDir();
            })
            .packageConfig(builder -> {
                builder.parent("com.example")
                    .moduleName("user")
                    .entity("entity")
                    .mapper("mapper")
                    .service("service")
                    .controller("controller");
            })
            .strategyConfig(builder -> {
                builder.addInclude("users")
                    .entityBuilder()
                    .enableLombok()
                    .logicDeleteColumnName("deleted");
            })
            .execute();
    }
}
```

## Best Practices

### 1. Layered Architecture

```
Controller → Service → Mapper → Database

Controller: receive requests, parameter validation
Service: business logic
Mapper: data access
```

### 2. Unified Response

```java
@Data
@AllArgsConstructor
@NoArgsConstructor
public class Result<T> {
    private int code;
    private String message;
    private T data;

    public static <T> Result<T> success(T data) {
        return new Result<>(200, "Operation successful", data);
    }

    public static <T> Result<T> error(String message) {
        return new Result<>(500, message, null);
    }
}
```

### 3. Exception Handling

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(RuntimeException.class)
    public Result<?> handleRuntimeException(RuntimeException e) {
        return Result.error(e.getMessage());
    }
}
```

## Summary

1. **MyBatis Plus significantly simplifies CRUD**: No need for manual XML
2. **Condition builders are core**: Chain API, type-safe
3. **Paginated queries are convenient**: Built-in pagination plugin
4. **Auto-fill and logical delete**: Reduce repetitive code
5. **Code generator**: Quickly generate base code

MyBatis Plus is a efficiency tool for Java backend development. Mastering it can multiply your development speed.
