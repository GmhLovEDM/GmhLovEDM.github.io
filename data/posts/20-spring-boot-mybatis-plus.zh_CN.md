---
title: "Spring Boot + MyBatis Plus：后端 CRUD 最佳实践"
tag: java
description: MyBatis Plus 是 MyBatis 的增强工具，大幅提升开发效率。本文介绍如何在 Spring Boot 项目中使用 MyBatis Plus 实现高效的 CRUD 操作。
date: "2022-04-22T08:00:00.000Z"
---

## 目标

掌握 MyBatis Plus 在 Spring Boot 项目中的使用，实现高效的数据库操作。

## 背景

### MyBatis vs MyBatis Plus

| 特性 | MyBatis | MyBatis Plus |
|------|---------|--------------|
| 基础 CRUD | 需要手写 XML | 自动生成 |
| 条件构造器 | 需要手写 SQL | 链式 API |
| 分页 | 需要额外配置 | 内置支持 |
| 代码生成器 | 需要第三方工具 | 内置 |
| 逻辑删除 | 需要手动实现 | 注解配置 |

MyBatis Plus 在不改变 MyBatis 的情况下，大幅简化了开发。

## 项目配置

### 1. 依赖配置

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

### 2. 配置文件

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

## 实体类定义

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

### 常用注解

| 注解 | 说明 |
|------|------|
| @TableName | 指定表名 |
| @TableId | 指定主键 |
| @TableField | 指定字段 |
| @TableLogic | 逻辑删除字段 |
| @Version | 乐观锁字段 |

## CRUD 操作

### 1. 基础 CRUD

```java
package com.example.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.entity.User;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserMapper extends BaseMapper<User> {
    // 继承 BaseMapper，自动拥有 CRUD 方法
}
```

```java
// 使用
@Service
public class UserService {

    @Autowired
    private UserMapper userMapper;

    // 新增
    public User create(User user) {
        userMapper.insert(user);
        return user;
    }

    // 根据 ID 查询
    public User getById(Long id) {
        return userMapper.selectById(id);
    }

    // 更新
    public void update(User user) {
        userMapper.updateById(user);
    }

    // 根据 ID 删除
    public void delete(Long id) {
        userMapper.deleteById(id);
    }

    // 查询所有
    public List<User> list() {
        return userMapper.selectList(null);
    }
}
```

### 2. 条件构造器

```java
// QueryWrapper：查询条件
QueryWrapper<User> wrapper = new QueryWrapper<>();
wrapper.eq("status", 1)
       .like("name", "张")
       .orderByDesc("created_at");

List<User> users = userMapper.selectList(wrapper);

// LambdaQueryWrapper：类型安全
LambdaQueryWrapper<User> lambdaWrapper = new LambdaQueryWrapper<>();
lambdaWrapper.eq(User::getStatus, 1)
             .like(User::getName, "张")
             .orderByDesc(User::getCreatedAt);

List<User> users = userMapper.selectList(lambdaWrapper);

// UpdateWrapper：更新条件
UpdateWrapper<User> updateWrapper = new UpdateWrapper<>();
updateWrapper.eq("id", 1)
             .set("status", 0);

userMapper.update(null, updateWrapper);
```

### 3. 分页查询

```java
// 配置分页插件
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
// 分页查询
public IPage<User> getPage(int page, int size) {
    Page<User> pageParam = new Page<>(page, size);
    LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
    wrapper.orderByDesc(User::getCreatedAt);
    return userMapper.selectPage(pageParam, wrapper);
}

// 条件分页查询
public IPage<User> search(String keyword, int page, int size) {
    Page<User> pageParam = new Page<>(page, size);
    LambdaQueryWrapper<User> wrapper = new LambdaQueryWrapper<>();
    wrapper.like(User::getUsername, keyword)
           .or()
           .like(User::getEmail, keyword);
    return userMapper.selectPage(pageParam, wrapper);
}
```

### 4. 批量操作

```java
// 批量插入
public void batchInsert(List<User> users) {
    userMapper.insertBatch(users);
}

// 批量更新
public void batchUpdate(List<User> users) {
    users.forEach(user -> userMapper.updateById(user));
}

// 批量删除
public void batchDelete(List<Long> ids) {
    userMapper.deleteBatchIds(ids);
}
```

## Service 层封装

### 1. 基础 Service

```java
package com.example.service;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;

public abstract class BaseService<M extends BaseMapper<T>, T> extends ServiceImpl<M, T> {

    // 可以在这里添加通用方法
}
```

### 2. 业务 Service

```java
@Service
public class UserService extends BaseService<UserMapper, User> {

    // 自定义业务方法
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
        // 检查用户名是否已存在
        if (lambdaQuery().eq(User::getUsername, user.getUsername()).exists()) {
            throw new RuntimeException("用户名已存在");
        }
        // 检查邮箱是否已存在
        if (lambdaQuery().eq(User::getEmail, user.getEmail()).exists()) {
            throw new RuntimeException("邮箱已被使用");
        }
        // 保存用户
        save(user);
    }
}
```

## 高级功能

### 1. 逻辑删除

```java
// 实体类
@TableLogic
private Integer deleted;

// 使用
// 删除操作会自动转换为 UPDATE SET deleted = 1
userMapper.deleteById(1);
// 实际执行: UPDATE users SET deleted = 1 WHERE id = 1

// 查询会自动过滤已删除的记录
userMapper.selectList(null);
// 实际执行: SELECT * FROM users WHERE deleted = 0
```

### 2. 自动填充

```java
// 创建处理器
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

### 3. 乐观锁

```java
// 实体类
@Version
private Integer version;

// 配置
@Bean
public MybatisPlusInterceptor mybatisPlusInterceptor() {
    MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
    interceptor.addInnerInterceptor(new OptimisticLockerInnerInterceptor());
    return interceptor;
}

// 使用
User user = userMapper.selectById(1);
user.setAge(25);
int rows = userMapper.updateById(user);
// 实际执行: UPDATE users SET age = 25, version = version + 1 WHERE id = 1 AND version = #{version}
```

### 4. 代码生成器

```java
public class CodeGenerator {

    public static void main(String[] args) {
        FastAutoGenerator.create("jdbc:mysql://localhost:3306/demo_db", "root", "password")
            .globalConfig(builder -> {
                builder.author("张三")
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

## 最佳实践

### 1. 分层架构

```
Controller → Service → Mapper → Database

Controller：接收请求，参数校验
Service：业务逻辑
Mapper：数据访问
```

### 2. 统一响应

```java
@Data
@AllArgsConstructor
@NoArgsConstructor
public class Result<T> {
    private int code;
    private String message;
    private T data;

    public static <T> Result<T> success(T data) {
        return new Result<>(200, "操作成功", data);
    }

    public static <T> Result<T> error(String message) {
        return new Result<>(500, message, null);
    }
}
```

### 3. 异常处理

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(RuntimeException.class)
    public Result<?> handleRuntimeException(RuntimeException e) {
        return Result.error(e.getMessage());
    }
}
```

## 总结

1. **MyBatis Plus 大幅简化了 CRUD**：不需要手写 XML
2. **条件构造器是核心**：链式 API，类型安全
3. **分页查询很方便**：内置分页插件
4. **自动填充和逻辑删除**：减少重复代码
5. **代码生成器**：快速生成基础代码

MyBatis Plus 是 Java 后端开发的效率神器，掌握它能让你的开发速度提升数倍。
