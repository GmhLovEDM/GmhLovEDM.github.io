---
title: "TypeScript 类型体操进阶：模板字面量类型与递归"
tag: typescript
description: 深入探索 TypeScript 模板字面量类型和递归类型，掌握高级类型编程技巧。
date: "2023-05-05T08:00:00.000Z"
---

## 目标

TypeScript 4.1 引入了模板字面量类型（Template Literal Types），这为类型系统带来了字符串操作的能力。结合递归类型，我们可以实现更加强大的类型推断和验证。本文将深入探索这些高级类型技巧，并通过实战案例展示其应用。

## 背景

### 为什么需要模板字面量类型

在实际开发中，我们经常需要处理字符串相关的类型：

- CSS 类名验证
- 事件名称匹配
- API 路径类型
- 对象键路径访问

模板字面量类型让我们能够在类型层面处理这些字符串操作。

## 模板字面量类型基础

### 基础语法

```typescript
// 基础模板字面量类型
type Hello = `Hello, ${string}`

// 字面量联合类型
type Color = 'red' | 'green' | 'blue'
type ColorClass = `color-${Color}`
// 结果: 'color-red' | 'color-green' | 'color-blue'

// 字符串操作
type Prefix = 'prefix'
type Suffix = 'suffix'
type Combined = `${Prefix}-${Suffix}`
// 结果: 'prefix-suffix'
```

### 字符串联合类型组合

```typescript
// 多个联合类型的组合
type Direction = 'top' | 'bottom' | 'left' | 'right'
type Distance = '1' | '2' | '3' | '4' | '5'

type Margin = `margin-${Direction}`
// 结果: 'margin-top' | 'margin-bottom' | 'margin-left' | 'margin-right'

type Padding = `padding-${Direction}-${Distance}`
// 结果: 'padding-top-1' | 'padding-top-2' | ... | 'padding-right-5'

// 条件类型中的模板字面量
type ExtractRouteParams<T extends string> = 
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractRouteParams<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? Param
      : never

type Params = ExtractRouteParams<'/users/:id/posts/:postId'>
// 结果: 'id' | 'postId'
```

## 实战案例

### 案例 1：CSS 类名验证

```typescript
// 验证 Tailwind CSS 类名
type TailwindPrefix = 'bg' | 'text' | 'border' | 'p' | 'm' | 'w' | 'h'
type TailwindColor = 'red' | 'blue' | 'green' | 'gray' | 'black' | 'white'
type TailwindShade = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900'
type TailwindSize = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '8' | '10' | '12' | '16' | '20' | '24'

type ValidTailwindClass = 
  | `${TailwindPrefix}-${TailwindColor}-${TailwindShade}`
  | `${TailwindPrefix}-${TailwindSize}`

function addClass<T extends string>(className: T extends ValidTailwindClass ? T : never) {
  // 添加类名
}

addClass('bg-red-500') // 正确
addClass('text-blue-400') // 正确
addClass('p-4') // 正确
// addClass('invalid-class') // 错误
```

### 案例 2：事件系统类型安全

```typescript
// 事件名称类型
type Entity = 'user' | 'order' | 'product'
type Action = 'create' | 'update' | 'delete' | 'view'

type EventName = `${Entity}:${Action}`
// 结果: 'user:create' | 'user:update' | ... | 'product:view'

// 事件数据类型
interface EventData {
  'user:create': { name: string; email: string }
  'user:update': { id: string; name?: string }
  'user:delete': { id: string }
  'user:view': { id: string }
  'order:create': { userId: string; items: string[] }
  'order:update': { id: string; status: string }
  'order:delete': { id: string }
  'order:view': { id: string }
  'product:create': { name: string; price: number }
  'product:update': { id: string; price?: number }
  'product:delete': { id: string }
  'product:view': { id: string }
}

// 类型安全的事件系统
class TypedEventEmitter {
  private handlers = new Map<string, Function[]>()
  
  on<T extends EventName>(
    event: T,
    handler: (data: EventData[T]) => void
  ) {
    const handlers = this.handlers.get(event) || []
    handlers.push(handler)
    this.handlers.set(event, handlers)
  }
  
  emit<T extends EventName>(
    event: T,
    data: EventData[T]
  ) {
    const handlers = this.handlers.get(event) || []
    handlers.forEach(handler => handler(data))
  }
}

// 使用
const emitter = new TypedEventEmitter()

emitter.on('user:create', (data) => {
  // data 自动推断为 { name: string; email: string }
  console.log(data.name, data.email)
})

emitter.emit('user:create', {
  name: 'John',
  email: 'john@example.com'
})

// 类型错误：缺少 email
// emitter.emit('user:create', { name: 'John' })
```

### 案例 3：API 路由类型

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

// 提取路由参数
type ExtractParams<T extends string> = 
  T extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof ExtractParams<`/${Rest}`>]: string }
    : T extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {}

type UserParams = ExtractParams<'/users/:id'>
// 结果: { id: string }

type PostParams = ExtractParams<'/users/:userId/posts/:postId'>
// 结果: { userId: string; postId: string }

// 类型安全的 API 客户端
type ExtractMethod<T extends string> = T extends `${infer Method} ${string}` ? Method : never
type ExtractPath<T extends string> = T extends `${string} ${infer Path}` ? Path : never

async function apiFetch<T extends keyof ApiRoutes>(
  route: T,
  options?: {
    params?: ExtractParams<ExtractPath<T>>
    body?: ApiRoutes[T] extends { body: infer B } ? B : never
  }
): Promise<ApiRoutes[T] extends { response: infer R } ? R : never> {
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
    body: options?.body ? JSON.stringify(options.body) : undefined,
    headers: {
      'Content-Type': 'application/json'
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

## 递归类型

### 基础递归类型

```typescript
// 递归计算字符串长度
type StringLength<T extends string, N extends number[] = []> = 
  T extends `${string}${infer Rest}`
    ? StringLength<Rest, [...N, 0]>
    : N['length']

type Len1 = StringLength<'hello'> // 5
type Len2 = StringLength<'hello world'> // 11

// 递归反转字符串
type ReverseString<T extends string> = 
  T extends `${infer First}${infer Rest}`
    ? `${ReverseString<Rest>}${First}`
    : ''

type Reversed1 = ReverseString<'hello'> // 'olleh'
type Reversed2 = ReverseString<'world'> // 'dlrow'
```

### 对象键路径

```typescript
// 获取对象所有键路径
type ObjectPaths<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends object
    ? ObjectPaths<T[K], `${Prefix}${K}.`> | `${Prefix}${K}`
    : `${Prefix}${K}`
}[keyof T & string]

interface User {
  name: string
  age: number
  address: {
    street: string
    city: string
    zip: string
  }
  orders: Array<{
    id: string
    amount: number
  }>
}

type UserPaths = ObjectPaths<User>
// 结果: 'name' | 'age' | 'address' | 'address.street' | 'address.city' | 'address.zip' | 'orders'

// 获取路径对应的值类型
type GetValueByPath<T, Path extends string> = 
  Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
      ? GetValueByPath<T[Key], Rest>
      : never
    : Path extends keyof T
      ? T[Path]
      : never

type StreetType = GetValueByPath<User, 'address.street'> // string
type CityType = GetValueByPath<User, 'address.city'> // string
```

### 深度 Partial 类型

```typescript
// 递归的 Partial 类型
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object
    ? T[P] extends Function
      ? T[P]
      : DeepPartial<T[P]>
    : T[P]
}

// 使用
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

type PartialConfig = DeepPartial<Config>

// 可以只提供部分配置
const config: PartialConfig = {
  database: {
    host: 'localhost'
    // 其他属性都可选
  }
}
```

### 深度 Readonly 类型

```typescript
// 递归的 Readonly 类型
type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object
    ? T[P] extends Function
      ? T[P]
      : DeepReadonly<T[P]>
    : T[P]
}

// 使用
interface MutableConfig {
  database: {
    host: string
    port: number
  }
}

const config: DeepReadonly<MutableConfig> = {
  database: {
    host: 'localhost',
    port: 5432
  }
}

// config.database.host = 'other' // 错误：只读
```

## 高级技巧

### 条件类型中的递归

```typescript
// 递归的类型验证
type ValidateEmail<T extends string> = 
  T extends `${infer Start}@${infer Domain}.${infer TLD}`
    ? Start extends '' 
      ? false
      : Domain extends ''
        ? false
        : TLD extends ''
          ? false
          : true
    : false

type Valid1 = ValidateEmail<'john@example.com'> // true
type Valid2 = ValidateEmail<'invalid'> // false
type Valid3 = ValidateEmail<'@example.com'> // false
```

### 类型安全的 Builder 模式

```typescript
// Builder 模式类型
type Builder<T = {}> = {
  set<K extends string, V>(key: K, value: V): Builder<T & { [P in K]: V }>
  build(): T
}

function createBuilder<T = {}>(): Builder<T> {
  const state = {} as T
  
  return {
    set<K extends string, V>(key: K, value: V) {
      return createBuilder<T & { [P in K]: V }>()
    },
    build() {
      return state
    }
  }
}

// 使用
const config = createBuilder()
  .set('host', 'localhost')
  .set('port', 3000)
  .set('debug', true)
  .build()
// config 自动推断为 { host: string; port: number; debug: boolean }
```

## 总结

模板字面量类型和递归类型是 TypeScript 类型系统的强大扩展：

1. **模板字面量类型**：在类型层面进行字符串操作
2. **递归类型**：处理嵌套结构和复杂类型推断
3. **实战应用**：CSS 类名验证、事件系统、API 路由
4. **高级技巧**：Builder 模式、类型安全的路径访问

掌握这些高级类型技巧，能够让你写出更精确、更灵活的类型定义，提升代码的可维护性和开发体验。
