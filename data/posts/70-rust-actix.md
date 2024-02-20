---
title: "Introduction to Rust Backend Development: Actix Web Framework"
tag: rust
description: From Rust language basics to Actix Web framework practice, explaining how to use Rust to build high-performance, secure Web API services.
date: "2024-02-20T08:00:00.000Z"
---

## Goal

Rust is renowned for its extreme performance, memory safety, and zero-cost abstractions, making it a new choice for systems programming and high-performance backend development. Actix Web is one of the most popular Web frameworks in the Rust ecosystem. This article starts from Rust basics and explains how to use Actix Web to build production-grade API services.

## Background

### Why Choose Rust

Rust's advantages compared to Go, Node.js, and other languages:

- **Memory safety**: Compile-time guarantees of no data races, no null pointers
- **Zero-cost abstractions**: Advanced syntax doesn't affect runtime performance
- **High performance**: Performance close to C/C++
- **Concurrency safety**: Ownership system ensures concurrency safety

### Actix Web Features

- **Actor model**: Actor-based concurrent processing
- **High performance**: Top rankings in TechEmpower benchmarks
- **Type safety**: Leverages Rust's type system for safety
- **Middleware ecosystem**: Rich middleware support

## Rust Basics

### Ownership System

```rust
fn main() {
    // Ownership: each value has only one owner
    let s1 = String::from("hello");
    let s2 = s1; // s1's ownership moves to s2
    // println!("{}", s1); // Error: s1 is no longer valid

    // Borrowing: temporarily gain ownership
    let s3 = String::from("world");
    let len = calculate_length(&s3); // Borrow s3
    println!("{}'s length is {}", s3, len); // s3 is still valid

    // Mutable borrowing: temporarily gain mutable ownership
    let mut s4 = String::from("hello");
    change(&mut s4);
    println!("{}", s4); // Output: hello, world
}

fn calculate_length(s: &String) -> usize {
    s.len()
}

fn change(s: &mut String) {
    s.push_str(", world");
}
```

### Error Handling

```rust
use std::fs::File;
use std::io::{self, Read};

// Use Result to handle errors
fn read_file(path: &str) -> Result<String, io::Error> {
    let mut file = File::open(path)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(contents)
}

// Use match to handle errors
match read_file("config.txt") {
    Ok(contents) => println!("File contents: {}", contents),
    Err(e) => println!("Failed to read file: {}", e),
}

// Use ? operator to propagate errors
fn process_config() -> Result<(), Box<dyn std::error::Error>> {
    let contents = read_file("config.txt")?;
    let config: Config = serde_json::from_str(&contents)?;
    println!("{:?}", config);
    Ok(())
}
```

### Asynchronous Programming

```rust
use tokio;
use reqwest;

// Async function
async fn fetch_data(url: &str) -> Result<String, reqwest::Error> {
    let response = reqwest::get(url).await?;
    let body = response.text().await?;
    Ok(body)
}

// Concurrent execution
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
        Ok(_) => println!("Success"),
        Err(e) => println!("Error: {}", e),
    }
}
```

## Actix Web Basics

### Project Initialization

```bash
# Create project
cargo new my-api
cd my-api

# Add dependencies
cargo add actix-web
cargo add serde
cargo add serde_json
cargo add tokio
```

### Basic Server

```rust
use actix_web::{web, App, HttpServer, HttpResponse, Responder};
use serde::{Deserialize, Serialize};

// Response struct
#[derive(Serialize)]
struct HealthResponse {
    status: String,
    timestamp: String,
}

// Handler function
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
    println!("Server starting on http://localhost:8080");

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

## RESTful API Implementation

### Data Models

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{DateTime, Utc};

// User model
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub created_at: DateTime<Utc>,
}

// Create user request
#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub name: String,
    pub email: String,
}

// Update user request
#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub name: Option<String>,
    pub email: Option<String>,
}

// API response
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

### Service Layer

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use actix_web::web;

// In-memory database
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

// User service
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
            .ok_or_else(|| "User not found".to_string())
    }

    pub async fn create_user(
        data: &web::Data<AppState>,
        request: CreateUserRequest,
    ) -> Result<User, String> {
        let mut users = data.users.lock().unwrap();

        // Check if email already exists
        if users.values().any(|u| u.email == request.email) {
            return Err("Email already registered".to_string());
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
            Err("User not found".to_string())
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
            Err("User not found".to_string())
        }
    }
}
```

### Route Handling

```rust
use actix_web::{web, HttpResponse};

// Get all users
async fn list_users(data: web::Data<AppState>) -> HttpResponse {
    let users = UserService::get_all_users(&data).await;
    HttpResponse::Ok().json(ApiResponse::success(users))
}

// Get single user
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

// Create user
async fn create_user(
    data: web::Data<AppState>,
    body: web::Json<CreateUserRequest>,
) -> HttpResponse {
    match UserService::create_user(&data, body.into_inner()).await {
        Ok(user) => HttpResponse::Created().json(ApiResponse::success(user)),
        Err(e) => HttpResponse::BadRequest().json(ApiResponse::<User>::error(&e)),
    }
}

// Update user
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

// Delete user
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

// Route configuration
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

### Main Function

```rust
use actix_web::{App, HttpServer, middleware};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let data = web::Data::new(AppState::new());

    println!("Server starting on http://localhost:8080");

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

## Middleware

### Authentication Middleware

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
        // Check Authorization header
        let token = req
            .headers()
            .get("Authorization")
            .and_then(|value| value.to_str().ok());

        match token {
            Some(token) if token.starts_with("Bearer ") => {
                let token = &token[7..];
                // Validate token
                if validate_token(token) {
                    Either::Left(self.service.call(req))
                } else {
                    Either::Right(ok(req.into_response(
                        HttpResponse::Unauthorized()
                            .body("Invalid token")
                            .map_into_boxed_body(),
                    )))
                }
            }
            _ => Either::Right(ok(req.into_response(
                HttpResponse::Unauthorized()
                    .body("Missing authentication information")
                    .map_into_boxed_body(),
            ))),
        }
    }
}

fn validate_token(token: &str) -> bool {
    // In production, validate JWT, etc.
    !token.is_empty()
}
```

## Conclusion

Actix Web is an excellent framework for building high-performance Rust backends. Key takeaways:

1. **Ownership system**: Rust's core feature, ensuring memory safety
2. **Error handling**: Result type and ? operator for elegant error handling
3. **Asynchronous programming**: tokio runtime for high-performance async I/O
4. **Actor model**: Actix's core for efficient concurrent processing
5. **Type safety**: Leverages Rust's type system for compile-time error detection

Rust has a steep learning curve, but once mastered, you can build extremely reliable and high-performance backend services. For performance-sensitive scenarios (such as financial trading, game servers), Rust is worth considering.
