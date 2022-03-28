---
title: "TypeScript 入门指南：前端工程师的类型体操第一课"
tag: typescript
description: TypeScript 不只是给 JavaScript 加了类型，它改变了你思考代码的方式。从基础到实战，掌握 TypeScript 的核心概念。
date: "2022-03-28T08:00:00.000Z"
---

## 目标

理解 TypeScript 的核心价值，掌握基础类型系统和实用的类型体操技巧。

## 背景

### 为什么要学 TypeScript？

```javascript
// JavaScript 的问题
function add(a, b) {
    return a + b
}

add(1, 2)      // 3 ✓
add(1, '2')    // '12' ← 你想要这个吗？
add({}, [])    // '[object Object]' ← 运行时才发现错误

// TypeScript 的解决方案
function add(a: number, b: number): number {
    return a + b
}

add(1, 2)      // 3 ✓
add(1, '2')    // 编译错误！类型不匹配
add({}, [])    // 编译错误！类型不匹配
```

TypeScript 在**编译时**就能发现错误，而不是等到运行时。

## 基础类型

### 1. 基本类型

```typescript
// 基本类型
let name: string = '张三'
let age: number = 25
let isActive: boolean = true
let nothing: null = null
let notDefined: undefined = undefined

// 数组
let numbers: number[] = [1, 2, 3]
let strings: Array<string> = ['a', 'b', 'c']

// 元组
let tuple: [string, number] = ['张三', 25]

// 枚举
enum Status {
    Pending = 'pending',
    Active = 'active',
    Deleted = 'deleted'
}
let userStatus: Status = Status.Active

// 任意类型（尽量避免）
let anything: any = 'hello'
anything = 123  // 不报错，但失去了类型保护
```

### 2. 接口和类型别名

```typescript
// 接口：定义对象的形状
interface User {
    id: number
    name: string
    email: string
    age?: number  // 可选属性
    readonly createdAt: string  // 只读属性
}

// 类型别名：可以定义任何类型
type ID = number | string
type Point = { x: number; y: number }

// 接口可以继承
interface Admin extends User {
    role: 'admin'
    permissions: string[]
}

// 类型可以交叉
type AdminUser = User & {
    role: 'admin'
    permissions: string[]
}
```

### 3. 函数类型

```typescript
// 函数声明
function greet(name: string): string {
    return `Hello, ${name}`
}

// 函数表达式
const greet2 = (name: string): string => `Hello, ${name}`

// 可选参数和默认值
function createUser(name: string, age?: number, role: string = 'user') {
    return { name, age, role }
}

// 剩余参数
function sum(...numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0)
}

// 函数重载
function format(input: string): string
function format(input: number): string
function format(input: string | number): string {
    if (typeof input === 'string') {
        return input.toUpperCase()
    }
    return input.toFixed(2)
}
```

## 高级类型

### 1. 联合类型和交叉类型

```typescript
// 联合类型：或
type StringOrNumber = string | number
let value: StringOrNumber = 'hello'
value = 123

// 交叉类型：和
type Person = { name: string }
type Worker = { company: string }
type Employee = Person & Worker
// Employee = { name: string; company: string }

// 字面量类型
type Direction = 'up' | 'down' | 'left' | 'right'
let dir: Direction = 'up'
```

### 2. 类型守卫

```typescript
// typeof 守卫
function process(value: string | number) {
    if (typeof value === 'string') {
        return value.toUpperCase()
    }
    return value.toFixed(2)
}

// in 守卫
interface Fish { swim: () => void }
interface Bird { fly: () => void }

function move(animal: Fish | Bird) {
    if ('swim' in animal) {
        animal.swim()
    } else {
        animal.fly()
    }
}

// 自定义类型守卫
function isFish(animal: Fish | Bird): animal is Fish {
    return 'swim' in animal
}

if (isFish(animal)) {
    animal.swim() // TypeScript 知道这里是 Fish
}
```

### 3. 条件类型

```typescript
// 基础条件类型
type IsString<T> = T extends string ? true : false

type A = IsString<string>  // true
type B = IsString<number>  // false

// 实用条件类型
type NonNullable<T> = T extends null | undefined ? never : T
type A2 = NonNullable<string | null>  // string
```

### 4. 映射类型

```typescript
// 将所有属性变为可选
type Partial<T> = {
    [P in keyof T]?: T[P]
}

// 将所有属性变为只读
type Readonly<T> = {
    readonly [P in keyof T]: T[P]
}

// 使用
interface User {
    id: number
    name: string
    email: string
}

type PartialUser = Partial<User>
// { id?: number; name?: string; email?: string }

type ReadonlyUser = Readonly<User>
// { readonly id: number; readonly name: string; readonly email: string }
```

### 5. 工具类型

```typescript
// Pick：选取部分属性
type UserBasic = Pick<User, 'id' | 'name'>
// { id: number; name: string }

// Omit：排除部分属性
type UserWithoutEmail = Omit<User, 'email'>
// { id: number; name: string }

// Record：构造键值对类型
type UserMap = Record<string, User>
// { [key: string]: User }

// Extract：从联合类型中提取
type T = Extract<'a' | 'b' | 'c', 'a' | 'b'>
// 'a' | 'b'

// Exclude：从联合类型中排除
type T2 = Exclude<'a' | 'b' | 'c', 'a'>
// 'b' | 'c'

// ReturnType：获取函数返回类型
function getUser() { return { id: 1, name: '张三' } }
type User = ReturnType<typeof getUser>
// { id: number; name: string }

// Parameters：获取函数参数类型
function createUser(name: string, age: number) { /* ... */ }
type Params = Parameters<typeof createUser>
// [string, number]
```

## 实战：类型安全的 API 请求

```typescript
// types/api.ts
interface ApiResponse<T> {
    code: number
    message: string
    data: T
}

interface PaginatedData<T> {
    list: T[]
    total: number
    page: number
}

// utils/request.ts
async function request<T>(url: string): Promise<T> {
    const response = await fetch(url)
    const result: ApiResponse<T> = await response.json()

    if (result.code !== 200) {
        throw new Error(result.message)
    }

    return result.data
}

// api/user.ts
interface User {
    id: number
    name: string
    email: string
}

async function getUsers(page: number) {
    return request<PaginatedData<User>>(`/api/users?page=${page}`)
}

async function getUser(id: number) {
    return request<User>(`/api/users/${id}`)
}

// 使用
const users = await getUsers(1)
// users.list 的类型自动推导为 User[]
// users.total 的类型自动推导为 number
```

## 实战：类型安全的事件系统

```typescript
// types/events.ts
interface EventMap {
    'user:login': { userId: number; timestamp: number }
    'user:logout': { userId: number }
    'post:publish': { postId: number; title: string }
}

// utils/event-emitter.ts
class TypedEventEmitter<T extends Record<string, any>> {
    private listeners = new Map<keyof T, Set<Function>>()

    on<K extends keyof T>(event: K, listener: (data: T[K]) => void) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set())
        }
        this.listeners.get(event)!.add(listener)
    }

    emit<K extends keyof T>(event: K, data: T[K]) {
        this.listeners.get(event)?.forEach(listener => listener(data))
    }

    off<K extends keyof T>(event: K, listener: (data: T[K]) => void) {
        this.listeners.get(event)?.delete(listener)
    }
}

// 使用
const emitter = new TypedEventEmitter<EventMap>()

emitter.on('user:login', (data) => {
    // data 的类型自动推导为 { userId: number; timestamp: number }
    console.log(`用户 ${data.userId} 登录`)
})

emitter.emit('user:login', { userId: 1, timestamp: Date.now() })
emitter.emit('user:login', { userId: '1' })  // 编译错误！userId 应该是 number
```

## 常见陷阱

### 1. any 的滥用

```typescript
// 不好：失去类型安全
function process(data: any) {
    return data.foo.bar
}

// 好：使用 unknown 或泛型
function process<T extends { foo: { bar: string } }>(data: T) {
    return data.foo.bar
}
```

### 2. 类型断言的谨慎使用

```typescript
// 不好：强制断言，可能在运行时出错
const input = document.getElementById('myInput') as HTMLInputElement
input.value = 'hello'

// 好：类型守卫
const input = document.getElementById('myInput')
if (input instanceof HTMLInputElement) {
    input.value = 'hello'
}
```

### 3. 忽略 undefined

```typescript
// 不好：可能在运行时出错
function getLength(str: string | undefined) {
    return str.length  // str 可能是 undefined
}

// 好：处理 undefined
function getLength(str: string | undefined) {
    return str?.length ?? 0
}
```

## 总结

1. **TypeScript 是 JavaScript 的超集**：所有合法的 JS 都是合法的 TS
2. **类型是工具，不是负担**：帮你发现错误，提供更好的 IDE 支持
3. **从基础类型开始**：string、number、boolean、array
4. **接口和类型别名**：定义对象形状和复杂类型
5. **高级类型很强大**：条件类型、映射类型、工具类型

TypeScript 的学习曲线是陡峭的，但回报是巨大的。一旦你习惯了类型安全，就再也回不去了。
