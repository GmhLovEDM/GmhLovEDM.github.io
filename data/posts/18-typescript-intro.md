---
title: "TypeScript Introduction: Frontend Engineer's First Lesson in Type Gymnastics"
tag: typescript
description: TypeScript doesn't just add types to JavaScript — it changes the way you think about code. From basics to practice, master TypeScript's core concepts.
date: "2022-03-28T08:00:00.000Z"
---

## Goal

Understand TypeScript's core value and master the basic type system and practical type gymnastics techniques.

## Background

### Why Learn TypeScript?

```javascript
// JavaScript's problem
function add(a, b) {
    return a + b
}

add(1, 2)      // 3 ✓
add(1, '2')    // '12' ← Is this what you want?
add({}, [])    // '[object Object]' ← Error discovered at runtime

// TypeScript's solution
function add(a: number, b: number): number {
    return a + b
}

add(1, 2)      // 3 ✓
add(1, '2')    // Compile error! Type mismatch
add({}, [])    // Compile error! Type mismatch
```

TypeScript can catch errors at **compile time** instead of waiting until runtime.

## Basic Types

### 1. Primitive Types

```typescript
// Primitive types
let name: string = 'Zhang San'
let age: number = 25
let isActive: boolean = true
let nothing: null = null
let notDefined: undefined = undefined

// Arrays
let numbers: number[] = [1, 2, 3]
let strings: Array<string> = ['a', 'b', 'c']

// Tuple
let tuple: [string, number] = ['Zhang San', 25]

// Enum
enum Status {
    Pending = 'pending',
    Active = 'active',
    Deleted = 'deleted'
}
let userStatus: Status = Status.Active

// Any type (avoid if possible)
let anything: any = 'hello'
anything = 123  // No error, but loses type protection
```

### 2. Interfaces and Type Aliases

```typescript
// Interface: defines the shape of an object
interface User {
    id: number
    name: string
    email: string
    age?: number  // Optional property
    readonly createdAt: string  // Read-only property
}

// Type alias: can define any type
type ID = number | string
type Point = { x: number; y: number }

// Interface can extend
interface Admin extends User {
    role: 'admin'
    permissions: string[]
}

// Type can intersect
type AdminUser = User & {
    role: 'admin'
    permissions: string[]
}
```

### 3. Function Types

```typescript
// Function declaration
function greet(name: string): string {
    return `Hello, ${name}`
}

// Function expression
const greet2 = (name: string): string => `Hello, ${name}`

// Optional parameters and defaults
function createUser(name: string, age?: number, role: string = 'user') {
    return { name, age, role }
}

// Rest parameters
function sum(...numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0)
}

// Function overloads
function format(input: string): string
function format(input: number): string
function format(input: string | number): string {
    if (typeof input === 'string') {
        return input.toUpperCase()
    }
    return input.toFixed(2)
}
```

## Advanced Types

### 1. Union and Intersection Types

```typescript
// Union type: or
type StringOrNumber = string | number
let value: StringOrNumber = 'hello'
value = 123

// Intersection type: and
type Person = { name: string }
type Worker = { company: string }
type Employee = Person & Worker
// Employee = { name: string; company: string }

// Literal type
type Direction = 'up' | 'down' | 'left' | 'right'
let dir: Direction = 'up'
```

### 2. Type Guards

```typescript
// typeof guard
function process(value: string | number) {
    if (typeof value === 'string') {
        return value.toUpperCase()
    }
    return value.toFixed(2)
}

// in guard
interface Fish { swim: () => void }
interface Bird { fly: () => void }

function move(animal: Fish | Bird) {
    if ('swim' in animal) {
        animal.swim()
    } else {
        animal.fly()
    }
}

// Custom type guard
function isFish(animal: Fish | Bird): animal is Fish {
    return 'swim' in animal
}

if (isFish(animal)) {
    animal.swim() // TypeScript knows this is Fish
}
```

### 3. Conditional Types

```typescript
// Basic conditional type
type IsString<T> = T extends string ? true : false

type A = IsString<string>  // true
type B = IsString<number>  // false

// Practical conditional type
type NonNullable<T> = T extends null | undefined ? never : T
type A2 = NonNullable<string | null>  // string
```

### 4. Mapped Types

```typescript
// Make all properties optional
type Partial<T> = {
    [P in keyof T]?: T[P]
}

// Make all properties readonly
type Readonly<T> = {
    readonly [P in keyof T]: T[P]
}

// Usage
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

### 5. Utility Types

```typescript
// Pick: select partial properties
type UserBasic = Pick<User, 'id' | 'name'>
// { id: number; name: string }

// Omit: exclude partial properties
type UserWithoutEmail = Omit<User, 'email'>
// { id: number; name: string }

// Record: construct key-value pair type
type UserMap = Record<string, User>
// { [key: string]: User }

// Extract: extract from union type
type T = Extract<'a' | 'b' | 'c', 'a' | 'b'>
// 'a' | 'b'

// Exclude: exclude from union type
type T2 = Exclude<'a' | 'b' | 'c', 'a'>
// 'b' | 'c'

// ReturnType: get function return type
function getUser() { return { id: 1, name: 'Zhang San' } }
type User = ReturnType<typeof getUser>
// { id: number; name: string }

// Parameters: get function parameter types
function createUser(name: string, age: number) { /* ... */ }
type Params = Parameters<typeof createUser>
// [string, number]
```

## Practice: Type-safe API Requests

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

// Usage
const users = await getUsers(1)
// users.list type is automatically inferred as User[]
// users.total type is automatically inferred as number
```

## Practice: Type-safe Event System

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

// Usage
const emitter = new TypedEventEmitter<EventMap>()

emitter.on('user:login', (data) => {
    // data type is automatically inferred as { userId: number; timestamp: number }
    console.log(`User ${data.userId} logged in`)
})

emitter.emit('user:login', { userId: 1, timestamp: Date.now() })
emitter.emit('user:login', { userId: '1' })  // Compile error! userId should be number
```

## Common Pitfalls

### 1. Abusing any

```typescript
// Bad: loses type safety
function process(data: any) {
    return data.foo.bar
}

// Good: use unknown or generics
function process<T extends { foo: { bar: string } }>(data: T) {
    return data.foo.bar
}
```

### 2. Careful Use of Type Assertions

```typescript
// Bad: forced assertion, may error at runtime
const input = document.getElementById('myInput') as HTMLInputElement
input.value = 'hello'

// Good: type guard
const input = document.getElementById('myInput')
if (input instanceof HTMLInputElement) {
    input.value = 'hello'
}
```

### 3. Ignoring undefined

```typescript
// Bad: may error at runtime
function getLength(str: string | undefined) {
    return str.length  // str may be undefined
}

// Good: handle undefined
function getLength(str: string | undefined) {
    return str?.length ?? 0
}
```

## Summary

1. **TypeScript is a superset of JavaScript**: All valid JS is valid TS
2. **Types are tools, not burdens**: Help you find errors, provide better IDE support
3. **Start with basic types**: string, number, boolean, array
4. **Interfaces and type aliases**: Define object shapes and complex types
5. **Advanced types are powerful**: Conditional types, mapped types, utility types

TypeScript's learning curve is steep, but the payoff is enormous. Once you get used to type safety, you'll never go back.
