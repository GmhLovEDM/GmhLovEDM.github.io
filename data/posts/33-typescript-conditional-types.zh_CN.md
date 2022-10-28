---
title: "TypeScript 高级类型体操：条件类型与 infer 实战"
tag: typescript
description: 深入解析 TypeScript 条件类型和 infer 关键字，掌握高级类型编程技巧。
date: "2022-10-28T08:00:00.000Z"
---

## 目标

TypeScript 的类型系统是图灵完备的，这意味着我们可以在类型层面实现复杂的逻辑。条件类型（Conditional Types）和 `infer` 关键字是 TypeScript 类型编程的核心工具，掌握它们能够让你写出更精确、更灵活的类型定义。本文将深入解析这些高级类型技巧，并通过实战案例展示它们的应用。

## 背景

### 为什么需要条件类型

在日常开发中，我们经常需要根据输入类型推导输出类型：

```typescript
// 没有条件类型时，需要大量重载
function process(value: string): string[]
function process(value: number): number[]
function process(value: boolean): boolean[]
function process(value: any): any[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [value]
  if (typeof value === 'boolean') return [value]
  return []
}
```

条件类型让我们能够用更简洁的方式表达这种类型关系：

```typescript
// 使用条件类型
type Process<T> = T extends string ? string[] 
  : T extends number ? number[] 
  : T extends boolean ? boolean[] 
  : never

function process<T>(value: T): Process<T> {
  // 实现...
}
```

## 条件类型基础

### 语法结构

```typescript
// 基础语法
type IsString<T> = T extends string ? true : false

// 使用
type A = IsString<'hello'>  // true
type B = IsString<42>       // false
```

### 分布式条件类型

当条件类型作用于联合类型时，会自动分发到每个成员：

```typescript
type ToArray<T> = T extends any ? T[] : never

// 分布式行为
type Result = ToArray<string | number>
// 等价于 ToArray<string> | ToArray<number>
// 即 string[] | number[]

// 非分布式行为（用方括号包裹）
type ToArrayNonDist<T> = [T] extends [any] ? T[] : never
type Result2 = ToArrayNonDist<string | number>
// 即 (string | number)[]
```

### never 类型处理

```typescript
type ExcludeNull<T> = T extends null ? never : T

type A = ExcludeNull<string | null | undefined>
// 结果: string | undefined

// 处理 never
type CleanNever<T> = [T] extends [never] ? 'never' : T
type B = CleanNever<never>  // 'never'
type C = CleanNever<string> // string
```

## infer 关键字

### 基础用法

`infer` 关键字用于在条件类型中声明待推断的类型变量：

```typescript
// 提取函数返回类型
type ReturnType<T> = T extends (...args: any[]) => infer R ? R : never

type Fn = () => string
type Result = ReturnType<Fn>  // string

// 提取 Promise 的值类型
type Awaited<T> = T extends Promise<infer U> ? U : T

type A = Awaited<Promise<string>>  // string
type B = Awaited<number>            // number
```

### 提取数组元素类型

```typescript
type ElementOf<T> = T extends (infer E)[] ? E : never

type A = ElementOf<string[]>       // string
type B = ElementOf<number[]>       // number
type C = ElementOf<[string, number]> // string | number
```

### 提取函数参数类型

```typescript
type Parameters<T> = T extends (...args: infer P) => any ? P : never

type Fn = (a: string, b: number, c: boolean) => void
type Params = Parameters<Fn>  // [string, number, boolean]
```

### 提取 Promise 参数

```typescript
type FunctionParameters<T> = T extends (...args: infer P) => any ? P : never

type AsyncFn = (id: string) => Promise<number>
type Params = FunctionParameters<AsyncFn>  // [string]
```

## 实战案例

### 案例 1：深度获取对象属性类型

```typescript
// 获取嵌套属性的类型
type GetNestedValue<T, K extends string> = K extends `${infer First}.${infer Rest}`
  ? First extends keyof T
    ? GetNestedValue<T[First], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never

// 使用示例
interface User {
  name: string
  address: {
    city: string
    zip: string
  }
  orders: Array<{
    id: number
    amount: number
  }>
}

type CityType = GetNestedValue<User, 'address.city'>  // string
type FirstOrderAmount = GetNestedValue<User, 'orders.0.amount'>  // number
```

### 案例 2：类型安全的事件系统

```typescript
// 事件映射
interface EventMap {
  'user:login': { userId: string; timestamp: number }
  'user:logout': { userId: string }
  'order:create': { orderId: string; amount: number }
  'order:pay': { orderId: string; paidAt: number }
}

// 提取事件名
type EventName = keyof EventMap  // 'user:login' | 'user:logout' | 'order:create' | 'order:pay'

// 提取事件数据类型
type EventData<T extends EventName> = T extends keyof EventMap ? EventMap[T] : never

// 类型安全的事件处理器
type EventHandler<T extends EventName> = (data: EventData<T>) => void

class TypedEventEmitter {
  private handlers = new Map<string, Function[]>()
  
  on<T extends EventName>(event: T, handler: EventHandler<T>) {
    const handlers = this.handlers.get(event) || []
    handlers.push(handler)
    this.handlers.set(event, handlers)
  }
  
  emit<T extends EventName>(event: T, data: EventData<T>) {
    const handlers = this.handlers.get(event) || []
    handlers.forEach(handler => handler(data))
  }
}

// 使用
const emitter = new TypedEventEmitter()

emitter.on('user:login', (data) => {
  // data 自动推断为 { userId: string; timestamp: number }
  console.log(data.userId, data.timestamp)
})

emitter.emit('user:login', {
  userId: '123',
  timestamp: Date.now()
})

// 类型错误：缺少 timestamp
// emitter.emit('user:login', { userId: '123' })
```

### 案例 3：类型安全的 API 路由

```typescript
// API 路由定义
interface ApiRoutes {
  'GET /users': {
    params: { page: number; limit: number }
    response: Array<{ id: string; name: string }>
  }
  'POST /users': {
    body: { name: string; email: string }
    response: { id: string; name: string; email: string }
  }
  'GET /users/:id': {
    params: { id: string }
    response: { id: string; name: string; email: string }
  }
  'PUT /users/:id': {
    params: { id: string }
    body: { name?: string; email?: string }
    response: { id: string; name: string; email: string }
  }
  'DELETE /users/:id': {
    params: { id: string }
    response: { success: boolean }
  }
}

// 提取 HTTP 方法
type ExtractMethod<T extends string> = T extends `${infer Method} ${string}` ? Method : never

// 提取路由路径
type ExtractPath<T extends string> = T extends `${string} ${infer Path}` ? Path : never

// 获取路由配置
type GetRouteConfig<T extends string> = T extends keyof ApiRoutes ? ApiRoutes[T] : never

// 类型安全的 fetch 封装
async function apiFetch<T extends keyof ApiRoutes>(
  route: T,
  options?: Omit<RequestInit, 'method'> & {
    params?: GetRouteConfig<T> extends { params: infer P } ? P : never
    body?: GetRouteConfig<T> extends { body: infer B } ? B : never
  }
): Promise<GetRouteConfig<T> extends { response: infer R } ? R : never> {
  const [method, path] = (route as string).split(' ')
  
  // 处理路径参数
  let finalPath = path
  if (options?.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      finalPath = finalPath.replace(`:${key}`, String(value))
    })
  }
  
  const response = await fetch(finalPath, {
    method,
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  })
  
  return response.json()
}

// 使用
const users = await apiFetch('GET /users', {
  params: { page: 1, limit: 10 }
})
// users 自动推断为 Array<{ id: string; name: string }>

const newUser = await apiFetch('POST /users', {
  body: { name: 'John', email: 'john@example.com' }
})
// newUser 自动推断为 { id: string; name: string; email: string }
```

### 案例 4：深度 Partial 类型

```typescript
// 递归的 Partial 类型
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object 
    ? T[P] extends Function 
      ? T[P] 
      : DeepPartial<T[P]>
    : T[P]
}

// 使用示例
interface Config {
  database: {
    host: string
    port: number
    credentials: {
      username: string
      password: string
    }
  }
  server: {
    port: number
    ssl: boolean
  }
}

// 所有属性都变为可选，包括嵌套的
type PartialConfig = DeepPartial<Config>

// 可以只提供部分配置
const config: PartialConfig = {
  database: {
    host: 'localhost'
    // 其他属性都可选
  }
}
```

### 案例 5：类型安全的表单验证

```typescript
// 验证规则类型
type ValidationRule<T> = {
  validate: (value: T) => boolean
  message: string
}

// 字段配置类型
type FieldConfig<T> = {
  [K in keyof T]: {
    rules: ValidationRule<T[K]>[]
    defaultValue?: T[K]
  }
}

// 表单类型推导
interface UserForm {
  name: string
  email: string
  age: number
}

// 验证规则配置
const userFormRules: FieldConfig<UserForm> = {
  name: {
    rules: [
      { validate: (value) => value.length > 0, message: '姓名不能为空' },
      { validate: (value) => value.length >= 2, message: '姓名至少2个字符' }
    ],
    defaultValue: ''
  },
  email: {
    rules: [
      { validate: (value) => value.length > 0, message: '邮箱不能为空' },
      { validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), message: '邮箱格式不正确' }
    ]
  },
  age: {
    rules: [
      { validate: (value) => value >= 18, message: '年龄必须大于18' },
      { validate: (value) => value <= 100, message: '年龄不能超过100' }
    ],
    defaultValue: 18
  }
}

// 类型安全的表单验证器
class TypedFormValidator<T> {
  private rules: FieldConfig<T>
  
  constructor(rules: FieldConfig<T>) {
    this.rules = rules
  }
  
  validate(data: T): { valid: boolean; errors: Record<keyof T, string[]> } {
    const errors = {} as Record<keyof T, string[]>
    let valid = true
    
    Object.keys(this.rules).forEach((field) => {
      const fieldRules = this.rules[field as keyof T].rules
      const value = data[field as keyof T]
      const fieldErrors: string[] = []
      
      fieldRules.forEach(rule => {
        if (!rule.validate(value as any)) {
          fieldErrors.push(rule.message)
          valid = false
        }
      })
      
      if (fieldErrors.length > 0) {
        errors[field as keyof T] = fieldErrors
      }
    })
    
    return { valid, errors }
  }
}

// 使用
const validator = new TypedFormValidator(userFormRules)
const result = validator.validate({
  name: '',
  email: 'invalid-email',
  age: 15
})
// result.errors 包含所有验证错误
```

## 高级技巧

### 条件类型的嵌套

```typescript
type NestedConditional<T> = 
  T extends string 
    ? 'string' 
    : T extends number 
      ? 'number' 
      : T extends boolean 
        ? 'boolean' 
        : T extends Array<any> 
          ? 'array' 
          : T extends object 
            ? 'object' 
            : 'unknown'

type A = NestedConditional<string>  // 'string'
type B = NestedConditional<number[]> // 'array'
```

### infer 在多个位置使用

```typescript
// 提取函数的所有参数类型（包括 this）
type FunctionArgs<T> = T extends (this: infer This, ...args: infer Args) => any 
  ? { this: This; args: Args }
  : { this: never; args: T extends (...args: infer Args) => any ? Args : never }

function example(this: { name: string }, a: number, b: string) {}

type Args = FunctionArgs<typeof example>
// { this: { name: string }; args: [number, string] }
```

## 总结

条件类型和 `infer` 关键字是 TypeScript 类型编程的核心工具：

1. **条件类型**：根据类型条件推导新类型，支持分布式行为
2. **infer 关键字**：在条件类型中声明待推断的类型变量
3. **实战应用**：类型安全的事件系统、API 路由、表单验证等
4. **高级技巧**：嵌套条件、多位置 infer、递归类型等

掌握这些高级类型技巧，能够让你写出更精确、更灵活的类型定义，提升代码的可维护性和开发体验。
