---
title: "Go 语言入门：Goroutine 与并发编程初体验"
tag: golang
description: 带领前端开发者入门 Go 语言，重点讲解 Goroutine 和并发编程的核心概念与实践。
date: "2023-01-22T08:00:00.000Z"
---

## 目标

作为前端开发者，掌握一门后端语言能够极大地拓展技术边界。Go 语言以其简洁的语法、出色的并发性能，成为云原生时代的首选语言。本文将从前端开发者的视角出发，介绍 Go 语言的基础知识，重点讲解 Goroutine 和并发编程的核心概念。

## 背景

### 为什么前端开发者要学 Go

1. **全栈能力**：能够独立完成前后端开发
2. **性能优势**：Go 的并发模型非常适合高并发场景
3. **云原生生态**：Docker、Kubernetes、Terraform 等都是 Go 编写的
4. **简单易学**：语法简洁，学习曲线平缓
5. **高薪岗位**：Go 开发者市场需求旺盛

### 前端与 Go 的对比

```javascript
// JavaScript/TypeScript - 异步编程
async function fetchUsers() {
  const response = await fetch('/api/users')
  const users = await response.json()
  return users
}

// Go - 并发编程
func fetchUsers() ([]User, error) {
  resp, err := http.Get("/api/users")
  if err != nil {
    return nil, err
  }
  defer resp.Body.Close()
  
  var users []User
  err = json.NewDecoder(resp.Body).Decode(&users)
  return users, err
}
```

## Go 语言基础

### 第一个程序

```go
// main.go
package main

import "fmt"

func main() {
    fmt.Println("Hello, Go!")
}
```

```bash
# 运行
go run main.go

# 编译
go build -o hello main.go
./hello
```

### 变量与类型

```go
package main

import "fmt"

func main() {
    // 变量声明
    var name string = "John"
    age := 25 // 类型推断
    
    // 常量
    const Pi = 3.14159
    
    // 基本类型
    var (
        b bool = true
        i int = 42
        f float64 = 3.14
        s string = "hello"
    )
    
    // 数组和切片
    arr := [5]int{1, 2, 3, 4, 5}
    slice := []int{1, 2, 3, 4, 5}
    
    // Map
    m := map[string]int{
        "one": 1,
        "two": 2,
    }
    
    fmt.Println(name, age, Pi, b, i, f, s)
    fmt.Println(arr, slice, m)
}
```

### 函数

```go
package main

import "fmt"

// 基础函数
func add(a, b int) int {
    return a + b
}

// 多返回值
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("division by zero")
    }
    return a / b, nil
}

// 命名返回值
func swap(a, b int) (x, y int) {
    x = b
    y = a
    return
}

// 可变参数
func sum(nums ...int) int {
    total := 0
    for _, num := range nums {
        total += num
    }
    return total
}

// 函数作为参数
func apply(nums []int, fn func(int) int) []int {
    result := make([]int, len(nums))
    for i, num := range nums {
        result[i] = fn(num)
    }
    return result
}

func main() {
    fmt.Println(add(1, 2))
    
    result, err := divide(10, 3)
    if err != nil {
        fmt.Println("Error:", err)
    } else {
        fmt.Println("Result:", result)
    }
    
    x, y := swap(1, 2)
    fmt.Println(x, y)
    
    fmt.Println(sum(1, 2, 3, 4, 5))
    
    doubled := apply([]int{1, 2, 3}, func(n int) int {
        return n * 2
    })
    fmt.Println(doubled)
}
```

### 结构体与方法

```go
package main

import "fmt"

// 结构体
type User struct {
    ID    int
    Name  string
    Email string
    Age   int
}

// 方法
func (u User) String() string {
    return fmt.Sprintf("%s (%s)", u.Name, u.Email)
}

// 指针接收者（可以修改结构体）
func (u *User) SetName(name string) {
    u.Name = name
}

// 接口
type Reader interface {
    Read() string
}

type FileWriter struct {
    filename string
}

func (fw FileWriter) Read() string {
    return "Reading from " + fw.filename
}

func main() {
    // 创建结构体
    user := User{
        ID:    1,
        Name:  "John",
        Email: "john@example.com",
        Age:   25,
    }
    
    fmt.Println(user)
    
    user.SetName("Jane")
    fmt.Println(user)
    
    // 接口使用
    var r Reader = FileWriter{filename: "test.txt"}
    fmt.Println(r.Read())
}
```

## Goroutine 并发编程

### 什么是 Goroutine

Goroutine 是 Go 语言的并发执行单元，类似于线程但更加轻量：

```go
package main

import (
    "fmt"
    "time"
)

func printNumbers() {
    for i := 1; i <= 5; i++ {
        time.Sleep(100 * time.Millisecond)
        fmt.Printf("Number: %d\n", i)
    }
}

func printLetters() {
    for i := 'a'; i <= 'e'; i++ {
        time.Sleep(150 * time.Millisecond)
        fmt.Printf("Letter: %c\n", i)
    }
}

func main() {
    // 顺序执行
    // printNumbers()
    // printLetters()
    
    // 并发执行
    go printNumbers()  // 启动 Goroutine
    go printLetters()  // 启动 Goroutine
    
    // 等待 Goroutine 完成
    time.Sleep(2 * time.Second)
    
    fmt.Println("Done!")
}
```

### WaitGroup

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func worker(id int, wg *sync.WaitGroup) {
    defer wg.Done() // 完成时通知 WaitGroup
    
    fmt.Printf("Worker %d starting\n", id)
    time.Sleep(time.Second)
    fmt.Printf("Worker %d done\n", id)
}

func main() {
    var wg sync.WaitGroup
    
    for i := 1; i <= 5; i++ {
        wg.Add(1) // 增加计数器
        go worker(i, &wg)
    }
    
    wg.Wait() // 等待所有 Worker 完成
    fmt.Println("All workers done!")
}
```

### Channel

```go
package main

import "fmt"

func main() {
    // 创建 Channel
    ch := make(chan string)
    
    // 发送数据
    go func() {
        ch <- "Hello from goroutine"
    }()
    
    // 接收数据
    message := <-ch
    fmt.Println(message)
    
    // 缓冲 Channel
    buffered := make(chan int, 3)
    buffered <- 1
    buffered <- 2
    buffered <- 3
    
    fmt.Println(<-buffered)
    fmt.Println(<-buffered)
    fmt.Println(<-buffered)
}
```

### Select 多路复用

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    ch1 := make(chan string)
    ch2 := make(chan string)
    
    go func() {
        time.Sleep(1 * time.Second)
        ch1 <- "one"
    }()
    
    go func() {
        time.Sleep(2 * time.Second)
        ch2 <- "two"
    }()
    
    // Select 等待多个 Channel
    for i := 0; i < 2; i++ {
        select {
        case msg := <-ch1:
            fmt.Println("Received from ch1:", msg)
        case msg := <-ch2:
            fmt.Println("Received from ch2:", msg)
        case <-time.After(3 * time.Second):
            fmt.Println("Timeout!")
        }
    }
}
```

### 实际案例：并发下载

```go
package main

import (
    "fmt"
    "io"
    "net/http"
    "os"
    "sync"
)

type DownloadResult struct {
    URL  string
    Size int
    Err  error
}

func download(url string, wg *sync.WaitGroup, results chan<- DownloadResult) {
    defer wg.Done()
    
    resp, err := http.Get(url)
    if err != nil {
        results <- DownloadResult{URL: url, Err: err}
        return
    }
    defer resp.Body.Close()
    
    // 写入文件
    filename := "downloads/" + url // 简化处理
    file, err := os.Create(filename)
    if err != nil {
        results <- DownloadResult{URL: url, Err: err}
        return
    }
    defer file.Close()
    
    size, err := io.Copy(file, resp.Body)
    results <- DownloadResult{URL: url, Size: int(size), Err: err}
}

func main() {
    urls := []string{
        "https://example.com/file1.zip",
        "https://example.com/file2.zip",
        "https://example.com/file3.zip",
    }
    
    results := make(chan DownloadResult, len(urls))
    var wg sync.WaitGroup
    
    // 并发下载
    for _, url := range urls {
        wg.Add(1)
        go download(url, &wg, results)
    }
    
    // 等待所有下载完成
    go func() {
        wg.Wait()
        close(results)
    }()
    
    // 处理结果
    for result := range results {
        if result.Err != nil {
            fmt.Printf("Error downloading %s: %v\n", result.URL, result.Err)
        } else {
            fmt.Printf("Downloaded %s: %d bytes\n", result.URL, result.Size)
        }
    }
}
```

## 前端开发者快速上手

### 创建 REST API

```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "sync"
)

type User struct {
    ID    int    `json:"id"`
    Name  string `json:"name"`
    Email string `json:"email"`
}

var (
    users  = []User{}
    mu     sync.RWMutex
    nextID = 1
)

func getUsers(w http.ResponseWriter, r *http.Request) {
    mu.RLock()
    defer mu.RUnlock()
    
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(users)
}

func createUser(w http.ResponseWriter, r *http.Request) {
    var user User
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    
    mu.Lock()
    user.ID = nextID
    nextID++
    users = append(users, user)
    mu.Unlock()
    
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}

func main() {
    http.HandleFunc("/api/users", func(w http.ResponseWriter, r *http.Request) {
        switch r.Method {
        case http.MethodGet:
            getUsers(w, r)
        case http.MethodPost:
            createUser(w, r)
        default:
            http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        }
    })
    
    log.Println("Server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

## 总结

Go 语言为前端开发者提供了一个强大的后端开发选择：

1. **简洁语法**：易于学习，上手快速
2. **并发模型**：Goroutine + Channel，高效处理并发
3. **性能优异**：编译型语言，运行速度快
4. **生态丰富**：强大的标准库和社区支持
5. **云原生首选**：容器化和微服务的最佳选择

掌握 Go 语言，能够让你成为真正的全栈开发者，在技术职业发展中拥有更多可能性。
