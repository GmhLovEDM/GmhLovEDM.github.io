---
title: "Advanced TypeScript Type Gymnastics: Template Literal Types and Recursion"
tag: typescript
description: A deep exploration of TypeScript template literal types and recursive types, covering advanced type programming techniques.
date: "2023-05-05T08:00:00.000Z"
---

## Goal

TypeScript 4.1 introduced Template Literal Types, bringing string manipulation capabilities to the type system. Combined with recursive types, we can achieve even more powerful type inference and validation. This article explores these advanced type techniques in depth and demonstrates their practical applications through real-world examples.

## Background

### Why Template Literal Types Matter

In real-world development, we frequently need to handle string-related types:

- CSS class name validation
- Event name matching
- API route path typing
- Object key path access

Template literal types allow us to perform these string operations at the type level.

## Template Literal Type Basics

### Basic Syntax

```typescript
// Basic template literal type
type Hello = `Hello, ${string}`

// Literal union types
type Color = 'red' | 'green' | 'blue'
type ColorClass = `color-${Color}`
// Result: 'color-red' | 'color-green' | 'color-blue'

// String composition
type Prefix = 'prefix'
type Suffix = 'suffix'
type Combined = `${Prefix}-${Suffix}`
// Result: 'prefix-suffix'
```

### Combining String Union Types

```typescript
// Combining multiple union types
type Direction = 'top' | 'bottom' | 'left' | 'right'
type Distance = '1' | '2' | '3' | '4' | '5'

type Margin = `margin-${Direction}`
// Result: 'margin-top' | 'margin-bottom' | 'margin-left' | 'margin-right'

type Padding = `padding-${Direction}-${Distance}`
// Result: 'padding-top-1' | 'padding-top-2' | ... | 'padding-right-5'

// Template literals in conditional types
type ExtractRouteParams<T extends string> = 
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractRouteParams<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? Param
      : never

type Params = ExtractRouteParams<'/users/:id/posts/:postId'>
// Result: 'id' | 'postId'
```

## Practical Examples

### Example 1: CSS Class Name Validation

```typescript
// Validating Tailwind CSS class names
type TailwindPrefix = 'bg' | 'text' | 'border' | 'p' | 'm' | 'w' | 'h'
type TailwindColor = 'red' | 'blue' | 'green' | 'gray' | 'black' | 'white'
type TailwindShade = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900'
type TailwindSize = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '8' | '10' | '12' | '16' | '20' | '24'

type ValidTailwindClass = 
  | `${TailwindPrefix}-${TailwindColor}-${TailwindShade}`
  | `${TailwindPrefix}-${TailwindSize}`

function addClass<T extends string>(className: T extends ValidTailwindClass ? T : never) {
  // Add class name
}

addClass('bg-red-500') // Valid
addClass('text-blue-400') // Valid
addClass('p-4') // Valid
// addClass('invalid-class') // Error
```

### Example 2: Type-Safe Event System

```typescript
// Event name types
type Entity = 'user' | 'order' | 'product'
type Action = 'create' | 'update' | 'delete' | 'view'

type EventName = `${Entity}:${Action}`
// Result: 'user:create' | 'user:update' | ... | 'product:view'

// Event data types
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

// Type-safe event emitter
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

// Usage
const emitter = new TypedEventEmitter()

emitter.on('user:create', (data) => {
  // data is automatically inferred as { name: string; email: string }
  console.log(data.name, data.email)
})

emitter.emit('user:create', {
  name: 'John',
  email: 'john@example.com'
})

// Type error: missing email
// emitter.emit('user:create', { name: 'John' })
```

### Example 3: API Route Types

```typescript
// API route definitions
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

// Extract route parameters
type ExtractParams<T extends string> = 
  T extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof ExtractParams<`/${Rest}`>]: string }
    : T extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : {}

type UserParams = ExtractParams<'/users/:id'>
// Result: { id: string }

type PostParams = ExtractParams<'/users/:userId/posts/:postId'>
// Result: { userId: string; postId: string }

// Type-safe API client
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
  
  // Handle path parameters
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

// Usage
const users = await apiFetch('GET /users', {
  params: { page: 1, limit: 10 }
})
// users is automatically inferred as Array<{ id: string; name: string }>

const newUser = await apiFetch('POST /users', {
  body: { name: 'John', email: 'john@example.com' }
})
// newUser is automatically inferred as { id: string; name: string; email: string }
```

## Recursive Types

### Basic Recursive Types

```typescript
// Recursively compute string length
type StringLength<T extends string, N extends number[] = []> = 
  T extends `${string}${infer Rest}`
    ? StringLength<Rest, [...N, 0]>
    : N['length']

type Len1 = StringLength<'hello'> // 5
type Len2 = StringLength<'hello world'> // 11

// Recursively reverse a string
type ReverseString<T extends string> = 
  T extends `${infer First}${infer Rest}`
    ? `${ReverseString<Rest>}${First}`
    : ''

type Reversed1 = ReverseString<'hello'> // 'olleh'
type Reversed2 = ReverseString<'world'> // 'dlrow'
```

### Object Key Paths

```typescript
// Get all key paths of an object
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
// Result: 'name' | 'age' | 'address' | 'address.street' | 'address.city' | 'address.zip' | 'orders'

// Get the value type corresponding to a path
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

### Deep Partial Type

```typescript
// Recursive Partial type
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object
    ? T[P] extends Function
      ? T[P]
      : DeepPartial<T[P]>
    : T[P]
}

// Usage
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

// Only a subset of config needs to be provided
const config: PartialConfig = {
  database: {
    host: 'localhost'
    // All other properties are optional
  }
}
```

### Deep Readonly Type

```typescript
// Recursive Readonly type
type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object
    ? T[P] extends Function
      ? T[P]
      : DeepReadonly<T[P]>
    : T[P]
}

// Usage
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

// config.database.host = 'other' // Error: readonly
```

## Advanced Techniques

### Recursion in Conditional Types

```typescript
// Recursive type validation
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

### Type-Safe Builder Pattern

```typescript
// Builder pattern types
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

// Usage
const config = createBuilder()
  .set('host', 'localhost')
  .set('port', 3000)
  .set('debug', true)
  .build()
// config is automatically inferred as { host: string; port: number; debug: boolean }
```

## Summary

Template literal types and recursive types are powerful extensions to the TypeScript type system:

1. **Template literal types**: Perform string operations at the type level.
2. **Recursive types**: Handle nested structures and complex type inference.
3. **Practical applications**: CSS class name validation, event systems, API route typing.
4. **Advanced techniques**: Builder pattern, type-safe path access.

Mastering these advanced type techniques enables you to write more precise and flexible type definitions, improving code maintainability and the overall development experience.
