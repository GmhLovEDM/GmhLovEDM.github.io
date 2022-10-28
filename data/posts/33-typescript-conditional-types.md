---
title: "Advanced TypeScript Type Gymnastics: Conditional Types and infer in Practice"
tag: typescript
description: An in-depth exploration of TypeScript conditional types and the infer keyword, with hands-on examples for advanced type-level programming.
date: "2022-10-28T08:00:00.000Z"
---

## Goal

TypeScript's type system is Turing-complete, which means we can express complex logic entirely at the type level. Conditional types and the `infer` keyword are the core tools for advanced type programming. Mastering them allows you to write more precise, flexible, and expressive type definitions. This article takes a deep dive into these advanced type techniques and demonstrates their practical applications through real-world examples.

## Background

### Why Conditional Types Are Needed

In everyday development, we frequently need to derive output types based on input types:

```typescript
// Without conditional types, we need many overloads
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

Conditional types let us express these type relationships more concisely:

```typescript
// Using conditional types
type Process<T> = T extends string ? string[] 
  : T extends number ? number[] 
  : T extends boolean ? boolean[] 
  : never

function process<T>(value: T): Process<T> {
  // implementation...
}
```

This eliminates the need for function overloads entirely. The return type is automatically inferred from the input type, making the API both safer and easier to use.

## Conditional Type Fundamentals

### Syntax

```typescript
// Basic syntax
type IsString<T> = T extends string ? true : false

// Usage
type A = IsString<'hello'>  // true
type B = IsString<42>       // false
```

The syntax mirrors a ternary expression: `T extends U ? X : Y`. If `T` is assignable to `U`, the result is `X`; otherwise, it is `Y`.

### Distributive Conditional Types

When a conditional type is applied to a union type, it automatically distributes over each union member:

```typescript
type ToArray<T> = T extends any ? T[] : never

// Distributed behavior
type Result = ToArray<string | number>
// Equivalent to ToArray<string> | ToArray<number>
// Which is string[] | number[]

// Non-distributed behavior (wrap in a tuple)
type ToArrayNonDist<T> = [T] extends [any] ? T[] : never
type Result2 = ToArrayNonDist<string | number>
// Which is (string | number)[]
```

This distributive behavior is one of the most powerful features of conditional types. It allows you to transform each member of a union independently. If you need to prevent distribution -- treating the union as a whole -- wrap the type parameter in a tuple like `[T]`.

### Handling the never Type

```typescript
type ExcludeNull<T> = T extends null ? never : T

type A = ExcludeNull<string | null | undefined>
// Result: string | undefined

// Detecting never
type CleanNever<T> = [T] extends [never] ? 'never' : T
type B = CleanNever<never>  // 'never'
type C = CleanNever<string> // string
```

The `never` type plays a special role in conditional types. When a type evaluates to `never`, it is simply removed from the union. This is the mechanism behind utility types like `Exclude` and `Omit`.

## The infer Keyword

### Basic Usage

The `infer` keyword declares a type variable that TypeScript will attempt to infer from the type being matched:

```typescript
// Extract a function's return type
type ReturnType<T> = T extends (...args: any[]) => infer R ? R : never

type Fn = () => string
type Result = ReturnType<Fn>  // string

// Extract the value type from a Promise
type Awaited<T> = T extends Promise<infer U> ? U : T

type A = Awaited<Promise<string>>  // string
type B = Awaited<number>            // number
```

Think of `infer` as a placeholder: "I don't know this type yet, but figure it out from context." TypeScript will bind the inferred type variable to whatever matches that position in the type structure.

### Extracting Array Element Types

```typescript
type ElementOf<T> = T extends (infer E)[] ? E : never

type A = ElementOf<string[]>       // string
type B = ElementOf<number[]>       // number
type C = ElementOf<[string, number]> // string | number
```

### Extracting Function Parameter Types

```typescript
type Parameters<T> = T extends (...args: infer P) => any ? P : never

type Fn = (a: string, b: number, c: boolean) => void
type Params = Parameters<Fn>  // [string, number, boolean]
```

### Extracting Async Function Parameters

```typescript
type FunctionParameters<T> = T extends (...args: infer P) => any ? P : never

type AsyncFn = (id: string) => Promise<number>
type Params = FunctionParameters<AsyncFn>  // [string]
```

## Practical Examples

### Case 1: Deep Nested Object Property Access

```typescript
// Get the type of a deeply nested property via a dot-separated path
type GetNestedValue<T, K extends string> = K extends `${infer First}.${infer Rest}`
  ? First extends keyof T
    ? GetNestedValue<T[First], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never

// Usage example
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

This example uses template literal types together with `infer` and recursion to walk through a dot-separated path string and resolve the type at the end of it. It is the same principle behind libraries like `lodash.get` but entirely at the type level.

### Case 2: Type-Safe Event System

```typescript
// Event map defining payload types for each event
interface EventMap {
  'user:login': { userId: string; timestamp: number }
  'user:logout': { userId: string }
  'order:create': { orderId: string; amount: number }
  'order:pay': { orderId: string; paidAt: number }
}

// Extract all event names
type EventName = keyof EventMap

// Extract the payload type for a given event
type EventData<T extends EventName> = T extends keyof EventMap ? EventMap[T] : never

// Type-safe event handler signature
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

// Usage
const emitter = new TypedEventEmitter()

emitter.on('user:login', (data) => {
  // data is automatically inferred as { userId: string; timestamp: number }
  console.log(data.userId, data.timestamp)
})

emitter.emit('user:login', {
  userId: '123',
  timestamp: Date.now()
})

// Type error: missing timestamp property
// emitter.emit('user:login', { userId: '123' })
```

This pattern ensures that event handlers always receive the correct payload type. A typo in the event name or a missing field in the payload will be caught at compile time rather than at runtime.

### Case 3: Type-Safe API Routes

```typescript
// API route definitions mapping HTTP methods and paths to their types
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

// Extract the HTTP method from a route string
type ExtractMethod<T extends string> = T extends `${infer Method} ${string}` ? Method : never

// Extract the path from a route string
type ExtractPath<T extends string> = T extends `${string} ${infer Path}` ? Path : never

// Look up the configuration for a specific route
type GetRouteConfig<T extends string> = T extends keyof ApiRoutes ? ApiRoutes[T] : never

// A type-safe fetch wrapper
async function apiFetch<T extends keyof ApiRoutes>(
  route: T,
  options?: Omit<RequestInit, 'method'> & {
    params?: GetRouteConfig<T> extends { params: infer P } ? P : never
    body?: GetRouteConfig<T> extends { body: infer B } ? B : never
  }
): Promise<GetRouteConfig<T> extends { response: infer R } ? R : never> {
  const [method, path] = (route as string).split(' ')
  
  // Substitute path parameters
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

// Usage
const users = await apiFetch('GET /users', {
  params: { page: 1, limit: 10 }
})
// users is automatically inferred as Array<{ id: string; name: string }>

const newUser = await apiFetch('POST /users', {
  body: { name: 'John', email: 'john@example.com' })
// newUser is automatically inferred as { id: string; name: string; email: string }
```

This example showcases how conditional types, `infer`, template literal types, and mapped types combine to create a fully type-safe API client. Every route has its own parameter types, body types, and response types, all verified at compile time.

### Case 4: Deep Partial Type

```typescript
// Recursive Partial type that makes all properties optional at every depth
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object 
    ? T[P] extends Function 
      ? T[P] 
      : DeepPartial<T[P]>
    : T[P]
}

// Usage example
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

// All properties become optional, including nested ones
type PartialConfig = DeepPartial<Config>

// You can provide only partial configuration
const config: PartialConfig = {
  database: {
    host: 'localhost'
    // all other properties are optional
  }
}
```

### Case 5: Type-Safe Form Validation

```typescript
// Validation rule type
type ValidationRule<T> = {
  validate: (value: T) => boolean
  message: string
}

// Field configuration type
type FieldConfig<T> = {
  [K in keyof T]: {
    rules: ValidationRule<T[K]>[]
    defaultValue?: T[K]
  }
}

// Form type definition
interface UserForm {
  name: string
  email: string
  age: number
}

// Validation rules configuration
const userFormRules: FieldConfig<UserForm> = {
  name: {
    rules: [
      { validate: (value) => value.length > 0, message: 'Name is required' },
      { validate: (value) => value.length >= 2, message: 'Name must be at least 2 characters' }
    ],
    defaultValue: ''
  },
  email: {
    rules: [
      { validate: (value) => value.length > 0, message: 'Email is required' },
      { validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), message: 'Invalid email format' }
    ]
  },
  age: {
    rules: [
      { validate: (value) => value >= 18, message: 'Age must be at least 18' },
      { validate: (value) => value <= 100, message: 'Age cannot exceed 100' }
    ],
    defaultValue: 18
  }
}

// Type-safe form validator
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

// Usage
const validator = new TypedFormValidator(userFormRules)
const result = validator.validate({
  name: '',
  email: 'invalid-email',
  age: 15
})
// result.errors contains all validation errors
```

The key insight here is that `FieldConfig<T>` uses a mapped type over `keyof T` combined with the validation rule type to ensure that each field can only have rules that match its value type. You cannot accidentally apply a string validation rule to a numeric field.

## Advanced Techniques

### Nested Conditional Types

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

This pattern of nesting conditional types is common when you need to classify types into one of several categories. Each `extends` clause acts as a branch in the logic.

### Using infer in Multiple Positions

```typescript
// Extract all parameter types of a function, including the this parameter
type FunctionArgs<T> = T extends (this: infer This, ...args: infer Args) => any 
  ? { this: This; args: Args }
  : { this: never; args: T extends (...args: infer Args) => any ? Args : never }

function example(this: { name: string }, a: number, b: string) {}

type Args = FunctionArgs<typeof example>
// { this: { name: string }; args: [number, string] }
```

You can use `infer` in multiple positions within a single conditional type, letting TypeScript independently infer different parts of the type structure.

## Summary

Conditional types and the `infer` keyword are the cornerstones of advanced TypeScript type programming:

1. **Conditional Types**: Derive new types based on type-level conditions, with automatic distribution over union members.
2. **The infer Keyword**: Declare placeholder type variables within conditional types for TypeScript to infer.
3. **Practical Applications**: Type-safe event systems, API route typing, form validation, deep property access, and more.
4. **Advanced Techniques**: Nested conditionals, multiple `infer` positions, recursive types, and template literal pattern matching.

Mastering these techniques allows you to write type definitions that are more precise, more flexible, and more expressive -- ultimately improving code maintainability and the overall developer experience.
