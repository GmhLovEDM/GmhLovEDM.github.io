---
title: "Rust 后端开发初探：Actix Web 框架入门"
tag: rust
description: 从 Rust 语言基础到 Actix Web 框架实战，讲解如何使用 Rust 构建高性能、安全的 Web API 服务。
date: "2024-02-20T08:00:00.000Z"
---

## 目标

Rust 以其极致的性能、内存安全和零成本抽象著称，是系统编程和高性能后端开发的新选择。Actix Web 是 Rust 生态中最流行的 Web 框架之一，本文从 Rust 基础出发，讲解如何使用 Actix Web 构建生产级 API 服务。

## 背景

### 为什么选择 Rust

Rust 相比 Go、Node.js 等语言的优势：

- **内存安全**：编译时保证无数据竞争、无空指针
- **零成本抽象**：高级语法不影响运行时性能
- **高性能**：接近 C/C++ 的性能
- **并发安全**：所有权系统保证并发安全

### Actix Web 特点

- **Actor 模型**：基于 Actor 的并发处理
- **高性能**：在 TechEmpower 基准测试中名列前茅
- **类型安全**：利用 Rust 的类型系统保证安全
- **中间件生态**：丰富的中间件支持

## Rust 基础

### 所有权系统

```rust
fn main() {
    // 所有权：每个值只有一个所有者
    let s1 = String::from("hello");
    let s2 = s1; // s1 的所有权移动到 s2
    // println!("{}", s1); // 错误：s1 已经无效

    // 借用：临时获取所有权
    let s3 = String::from("world");
    let len = calculate_length(&s3); // 借用 s3
    println!("{} 的长度是 {}", s3, len); // s3 仍然有效

    // 可变借用：临时获取可变所有权
    let mut s4 = String::from("hello");
    change(&mut s4);
    println!("{}", s4); // 输出: hello, world
}

fn calculate_length(s: &String) -> usize {
    s.len()
}

fn change(s: &mut String) {
    s.push_str(", world");
}
```

### 错误处理

```rust
use std::fs::File;
use std::io::{self, Read};

// 使用 Result 处理错误
fn read_file(path: &str) -> Result<String, io::Error> {
    let mut file = File::open(path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

// 使用 match 处理错误
match read_file("config.txt") {
    Ok(contents) => println!("文件内容: {}", contents),
    Err(e) => println!("读取文件失败: {}", e),
}

// 使用 ? 运算符传播错误
fn process_config() -> Result<(), Box<dyn std::error::Error>> {
    let contents = read_file("config.txt")?;
    let config: Config = serde_json::from_str(&contents)?;
    println!("{:?}", config);
    Ok(())
}
```

### 异步编程

```rust
use tokio;
use reqwest;

// 异步函数
async fn fetch_data(url: &str) -> Result<String, reqwest::Error> {
    let response = reqwest::get(url).await?;
    let body = response.text().await?;
    Ok(body)
}

// 并发执行
async fn fetch_multiple() -> Result<(), reqwest::Error> {
    let (result1, result2) = tokio::join!(
        fetch_data("https://api.example.com/data1"),
        fetch_data("https://api.example.com/data2"),
    );
    println!("Result 1: {:?}", result1);
    println!("Result 2: {:?}", result2);
    Ok(())
}

#[tokio::main]
async fn main() {
    match fetch_multiple().await {
        Ok(_) => println!("成功"),
        Err(e) => println!("错误: {}", e),
    }
}
```

## Actix Web 基础

### 项目初始化

```bash
# 创建项目
cargo new my-api
cd my-api

# 添加依赖
cargo add actix-web
cargo add serde
cargo add serde_json
cargo add tokio
```

### 基本服务器

```rust
use actix_web::{web, App, HttpServer, HttpResponse, Responder};
use serde::{Deserialize, Serialize};

// 响应结构体
#[derive(Serialize)]
struct HealthResponse {
    status: String,
    timestamp: String,
}

// 处理函数
async fn health_check() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse {
        status: "ok".to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

async fn hello() -> impl Responder {
    HttpResponse::Ok().body("Hello, World!")
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    println!("服务器启动在 http://localhost:8080");

    HttpServer::new(|| {
        App::new()
            .route("/", web::get().to(hello))
            .route("/health", web::get().to(health_check))
    })
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
```

## RESTful API 实现

### 数据模型

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{DateTime, Utc};

// 用户模型
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: DateTime<Utc>,
}

// 创建用户请求
#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub name: String,
    pub email: String,
}

// 更新用户请求
#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub name: Option<String>,
    pub email: Option<String>,
}

// API 响应
#[derive(Debug, Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        ApiResponse {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(message: &str) -> Self {
        ApiResponse {
            success: false,
            data: None,
            error: Some(message.to_string()),
        }
    }
}
```

### 服务层

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use actix_web::web;

// 内存数据库
pub struct AppState {
    pub users: Mutex<HashMap<String, User>>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            users: Mutex::new(HashMap::new()),
        }
    }
}

// 用户服务
pub struct UserService;

impl UserService {
    pub async fn get_all_users(data: &web::Data<AppState>) -> Vec<User> {
        let users = data.users.lock().unwrap();
        users.values().cloned().collect()
    }

    pub async fn get_user_by_id(
        data: &web::Data<AppState>,
        id: &str,
    ) -> Result<User, String> {
        let users = data.users.lock().unwrap();
        users.get(id)
            .cloned()
            .ok_or_else(|| "用户不存在".to_string())
    }

    pub async fn create_user(
        data: &web::Data<AppState>,
        request: CreateUserRequest,
    ) -> Result<User, String> {
        let mut users = data.users.lock().unwrap();

        // 检查邮箱是否已存在
        if users.values().any(|u| u.email == request.email) {
            return Err("邮箱已被注册".to_string());
        }

        let user = User {
            id: Uuid::new_v4().to_string(),
            name: request.name,
            email: request.email,
            created_at: Utc::now(),
        };

        users.insert(user.id.clone(), user.clone());
        Ok(user)
    }

    pub async fn update_user(
        data: &web::Data<AppState>,
        id: &str,
        request: UpdateUserRequest,
    ) -> Result<User, String> {
        let mut users = data.users.lock().unwrap();

        if let Some(user) = users.get_mut(id) {
            if let Some(name) = request.name {
                user.name = name;
            }
            if let Some(email) = request.email {
                user.email = email;
            }
            Ok(user.clone())
        } else {
            Err("用户不存在".to_string())
        }
    }

    pub async fn delete_user(
        data: &web::Data<AppState>,
        id: &str,
    ) -> Result<(), String> {
        let mut users = data.users.lock().unwrap();
        if users.remove(id).is_some() {
            Ok(())
        } else {
            Err("用户不存在".to_string())
        }
    }
}
```

### 路由处理

```rust
use actix_web::{web, HttpResponse};

// 获取所有用户
async fn list_users(data: web::Data<AppState>) -> HttpResponse {
    let users = UserService::get_all_users(&data).await;
    HttpResponse::Ok().json(ApiResponse::success(users))
}

// 获取单个用户
async fn get_user(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let id = path.into_inner();
    match UserService::get_user_by_id(&data, &id).await {
        Ok(user) => HttpResponse::Ok().json(ApiResponse::success(user)),
        Err(e) => HttpResponse::NotFound().json(ApiResponse::<User>::error(&e)),
    }
}

// 创建用户
async fn create_user(
    data: web::Data<AppState>,
    body: web::Json<CreateUserRequest>,
) -> HttpResponse {
    match UserService::create_user(&data, body.into_inner()).await {
        Ok(user) => HttpResponse::Created().json(ApiResponse::success(user)),
        Err(e) => HttpResponse::BadRequest().json(ApiResponse::<User>::error(&e)),
    }
}

// 更新用户
async fn update_user(
    data: web::Data<AppState>,
    path: web::Path<String>,
    body: web::Json<UpdateUserRequest>,
) -> HttpResponse {
    let id = path.into_inner();
    match UserService::update_user(&data, &id, body.into_inner()).await {
        Ok(user) => HttpResponse::Ok().json(ApiResponse::success(user)),
        Err(e) => HttpResponse::NotFound().json(ApiResponse::<User>::error(&e)),
    }
}

// 删除用户
async fn delete_user(
    data: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let id = path.into_inner();
    match UserService::delete_user(&data, &id).await {
        Ok(()) => HttpResponse::NoContent().finish(),
        Err(e) => HttpResponse::NotFound().json(ApiResponse::<()>::error(&e)),
    }
}

// 路由配置
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1")
            .service(
                web::resource("/users")
                    .route(web::get().to(list_users))
                    .route(web::post().to(create_user))
            )
            .service(
                web::resource("/users/{id}")
                    .route(web::get().to(get_user))
                    .route(web::put().to(update_user))
                    .route(web::delete().to(delete_user))
            )
    );
}
```

### 主函数

```rust
use actix_web::{App, HttpServer, middleware};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let data = web::Data::new(AppState::new());

    println!("服务器启动在 http://localhost:8080");

    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .configure(configure_routes)
            .wrap(middleware::Logger::default())
            .wrap(middleware::Compress::default())
    })
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
```

## 中间件

### 认证中间件

```rust
use actix_web::{
    dev::{Service, ServiceRequest, ServiceResponse, Transform},
    Error, HttpMessage,
};
use futures::future::{ok, Ready, Future, Either};

pub struct AuthMiddleware;

impl<S, B> Transform<S, ServiceRequest> for AuthMiddleware
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<Either<B, &'static str>>;
    type Error = Error;
    type InitError = ();
    type Transform = AuthMiddlewareMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ok(AuthMiddlewareMiddleware { service })
    }
}

pub struct AuthMiddlewareMiddleware<S> {
    service: S,
}

impl<S, B> Service<ServiceRequest> for AuthMiddlewareMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error>,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<Either<B, &'static str>>;
    type Error = Error;
    type Future = Either<S::Future, Ready<Result<Self::Response, Self::Error>>>;

    fn poll_ready(
        &self,
        ctx: &mut core::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.service.poll_ready(ctx)
    }

    fn call(&self, req: ServiceRequest) -> Self::Future {
        // 检查 Authorization 头
        let token = req
            .headers()
            .get("Authorization")
            .and_then(|value| value.to_str().ok());

        match token {
            Some(token) if token.starts_with("Bearer ") => {
                let token = &token[7..];
                // 验证 token
                if validate_token(token) {
                    Either::Left(self.service.call(req))
                } else {
                    Either::Right(ok(req.into_response(
                        HttpResponse::Unauthorized()
                            .body("无效的 token")
                            .map_into_boxed_body(),
                    )))
                }
            }
            _ => Either::Right(ok(req.into_response(
                HttpResponse::Unauthorized()
                    .body("缺少认证信息")
                    .map_into_boxed_body(),
            ))),
        }
    }
}

fn validate_token(token: &str) -> bool {
    // 实际项目中应该验证 JWT 等
    !token.is_empty()
}
```

## 总结

Actix Web 是构建高性能 Rust 后端的优秀框架。关键要点：

1. **所有权系统**：Rust 的核心特性，保证内存安全
2. **错误处理**：Result 类型和 ? 运算符，优雅处理错误
3. **异步编程**：tokio 运行时，高性能异步 I/O
4. **Actor 模型**：Actix 的核心，高效的并发处理
5. **类型安全**：利用 Rust 的类型系统，编译时发现错误

Rust 的学习曲线较陡峭，但一旦掌握，就能构建出极其可靠和高性能的后端服务。对于性能敏感的场景（如金融交易、游戏服务器），Rust 是值得考虑的选择。
