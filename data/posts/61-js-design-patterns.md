---
title: "Frontend Design Patterns: Observer, Strategy, and Pub-Sub in JS"
tag: javascript
description: "Explaining common frontend design patterns through real business scenarios: Observer, Strategy, Pub-Sub, Singleton, and more, to make your code more elegant, maintainable, and extensible."
date: "2023-10-12T08:00:00.000Z"
---

## Goal

Design patterns are general solutions summarized by predecessors that can effectively reduce code coupling and improve maintainability. For frontend developers, understanding and applying design patterns can evolve your code from "just works" to "elegant and extensible." This article explains the most commonly used frontend design patterns through real business scenarios.

## Background

### Why Design Patterns

In real projects, we often encounter such problems:

- Form validation logic scattered across multiple components, requiring changes one by one when modifications are needed
- Multiple components need to respond to the same data change, but prop drilling is undesirable
- Need to ensure a class has only one instance (e.g., global state management)
- Lots of if-else or switch statements that are difficult to maintain

Design patterns are the general solutions to these problems.

## Observer Pattern

### Core Idea

The Observer pattern defines a one-to-many dependency relationship between objects. When one object's state changes, all dependent objects are automatically notified.

### Implementation

```typescript
// Observer pattern implementation
class Observer {
  private observers: Set<Function> = new Set();

  subscribe(callback: Function): () => void {
    this.observers.add(callback);
    // Return unsubscribe function
    return () => this.observers.delete(callback);
  }

  notify(data: any) {
    this.observers.forEach(callback => callback(data));
  }
}

// Usage example: Form validation
class FormValidator extends Observer {
  private errors: Map<string, string> = new Map();

  validate(fieldName: string, value: any) {
    let error = '';

    if (fieldName === 'email') {
      error = this.validateEmail(value);
    } else if (fieldName === 'password') {
      error = this.validatePassword(value);
    }

    if (error) {
      this.errors.set(fieldName, error);
    } else {
      this.errors.delete(fieldName);
    }

    // Notify all subscribers
    this.notify({
      fieldName,
      error,
      errors: Object.fromEntries(this.errors),
    });
  }

  private validateEmail(email: string): string {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email) ? '' : 'Invalid email format';
  }

  private validatePassword(password: string): string {
    return password.length >= 6 ? '' : 'Password must be at least 6 characters';
  }
}

// Use in components
const validator = new FormValidator();

// Subscribe to error changes
const unsubscribe = validator.subscribe(({ errors }) => {
  setErrorDisplay(errors);
});

// Trigger notification on validation
validator.validate('email', 'invalid-email');
```

### Real-World Scenario: EventBus

```typescript
// Event bus
class EventBus {
  private static instance: EventBus;
  private events: Map<string, Set<Function>> = new Map();

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  on(event: string, callback: Function) {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event)!.add(callback);
  }

  off(event: string, callback: Function) {
    this.events.get(event)?.delete(callback);
  }

  emit(event: string, ...args: any[]) {
    this.events.get(event)?.forEach(callback => callback(...args));
  }
}

// Cross-component communication
const eventBus = EventBus.getInstance();

// Component A: Send message
function handleSendMessage() {
  eventBus.emit('notification', { type: 'success', message: 'Operation successful' });
}

// Component B: Receive message
useEffect(() => {
  const handler = (data) => showToast(data.message);
  eventBus.on('notification', handler);
  return () => eventBus.off('notification', handler);
}, []);
```

## Strategy Pattern

### Core Idea

The Strategy pattern encapsulates algorithm families into independent strategy classes, allowing them to be interchangeable and eliminating conditional statements.

### Implementation

```typescript
// Strategy interface
interface ValidationStrategy {
  validate(value: any): string;
}

// Concrete strategies
class RequiredValidator implements ValidationStrategy {
  validate(value: any): string {
    if (!value || (typeof value === 'string' && !value.trim())) {
      return 'This field is required';
    }
    return '';
  }
}

class EmailValidator implements ValidationStrategy {
  validate(value: any): string {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(value) ? '' : 'Invalid email format';
  }
}

class MinLengthValidator implements ValidationStrategy {
  constructor(private minLength: number) {}

  validate(value: any): string {
    return value.length >= this.minLength
      ? ''
      : `Must be at least ${this.minLength} characters`;
  }
}

// Form validator
class FormValidator {
  private rules: Map<string, ValidationStrategy[]> = new Map();

  addRule(fieldName: string, strategy: ValidationStrategy) {
    if (!this.rules.has(fieldName)) {
      this.rules.set(fieldName, []);
    }
    this.rules.get(fieldName)!.push(strategy);
  }

  validate(data: Record<string, any>): Record<string, string> {
    const errors: Record<string, string> = {};

    this.rules.forEach((strategies, fieldName) => {
      for (const strategy of strategies) {
        const error = strategy.validate(data[fieldName]);
        if (error) {
          errors[fieldName] = error;
          break;
        }
      }
    });

    return errors;
  }
}

// Usage
const validator = new FormValidator();
validator.addRule('email', new RequiredValidator());
validator.addRule('email', new EmailValidator());
validator.addRule('password', new RequiredValidator());
validator.addRule('password', new MinLengthValidator(6));

const errors = validator.validate({
  email: 'invalid-email',
  password: '123',
});
// { email: 'Invalid email format', password: 'Must be at least 6 characters' }
```

### Real-World Scenario: Sorting Strategy

```typescript
// Sorting strategy
interface SortStrategy<T> {
  sort(data: T[], compareFn?: (a: T, b: T) => number): T[];
}

class AscendingSort<T> implements SortStrategy<T> {
  sort(data: T[], compareFn?: (a: T, b: T) => number): T[] {
    return [...data].sort((a, b) => {
      if (compareFn) return compareFn(a, b);
      return a > b ? 1 : -1;
    });
  }
}

class DescendingSort<T> implements SortStrategy<T> {
  sort(data: T[], compareFn?: (a: T, b: T) => number): T[] {
    return [...data].sort((a, b) => {
      if (compareFn) return compareFn(b, a);
      return a < b ? 1 : -1;
    });
  }
}

class CustomSort<T> implements SortStrategy<T> {
  constructor(private compareFn: (a: T, b: T) => number) {}

  sort(data: T[]): T[] {
    return [...data].sort(this.compareFn);
  }
}

// Usage
const products = [
  { name: 'Product A', price: 100 },
  { name: 'Product B', price: 50 },
  { name: 'Product C', price: 200 },
];

const priceSort = new AscendingSort<typeof products[0]>();
const sorted = priceSort.sort(products, (a, b) => a.price - b.price);
```

## Pub-Sub Pattern

### Core Idea

The Pub-Sub pattern is similar to the Observer pattern but adds an event dispatch center (Broker), achieving complete decoupling between publishers and subscribers.

### Implementation

```typescript
class PubSub {
  private static instance: PubSub;
  private subscribers: Map<string, Function[]> = new Map();

  static getInstance(): PubSub {
    if (!PubSub.instance) {
      PubSub.instance = new PubSub();
    }
    return PubSub.instance;
  }

  subscribe(topic: string, callback: Function): () => void {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, []);
    }
    this.subscribers.get(topic)!.push(callback);

    return () => {
      const callbacks = this.subscribers.get(topic);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
      }
    };
  }

  publish(topic: string, data?: any) {
    const callbacks = this.subscribers.get(topic);
    if (callbacks) {
      callbacks.forEach(callback => callback(data));
    }
  }
}

// Usage example: User state management
const pubsub = PubSub.getInstance();

// User service
class UserService {
  static login(user: User) {
    // Login logic...
    pubsub.publish('user:login', user);
  }

  static logout() {
    // Logout logic...
    pubsub.publish('user:logout');
  }
}

// Components subscribe
function Header() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const unsubLogin = pubsub.subscribe('user:login', setUser);
    const unsubLogout = pubsub.subscribe('user:logout', () => setUser(null));

    return () => {
      unsubLogin();
      unsubLogout();
    };
  }, []);

  return <header>{user ? `Welcome, ${user.name}` : 'Please login'}</header>;
}

function Notification() {
  useEffect(() => {
    const unsubscribe = pubsub.subscribe('user:login', (user) => {
      showToast(`Welcome back, ${user.name}`);
    });
    return unsubscribe;
  }, []);

  return null;
}
```

## Singleton Pattern

### Core Idea

Ensure a class has only one instance and provide a global access point.

### Implementation

```typescript
class Database {
  private static instance: Database;
  private connection: any;

  private constructor() {
    this.connection = this.createConnection();
  }

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  private createConnection() {
    // Create database connection
    return { host: 'localhost', port: 3306 };
  }

  query(sql: string) {
    console.log(`Executing: ${sql}`);
  }
}

// Usage
const db1 = Database.getInstance();
const db2 = Database.getInstance();
console.log(db1 === db2); // true
```

### Real-World Scenario: Store Management

```typescript
// Simple state management
class Store<T> {
  private static stores: Map<string, Store<any>> = new Map();
  private state: T;
  private listeners: Set<Function> = new Set();

  private constructor(initialState: T) {
    this.state = initialState;
  }

  static getStore<T>(name: string, initialState: T): Store<T> {
    if (!Store.stores.has(name)) {
      Store.stores.set(name, new Store(initialState));
    }
    return Store.stores.get(name) as Store<T>;
  }

  getState(): T {
    return this.state;
  }

  setState(newState: Partial<T>) {
    this.state = { ...this.state, ...newState };
    this.notify();
  }

  subscribe(listener: Function) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(listener => listener(this.state));
  }
}

// Usage
const userStore = Store.getStore('user', { name: '', isLoggedIn: false });
const cartStore = Store.getStore('cart', { items: [], total: 0 });

userStore.subscribe((state) => {
  console.log('User state changed:', state);
});

userStore.setState({ name: 'John', isLoggedIn: true });
```

## Conclusion

Design patterns are not silver bullets but general solutions to specific problems. Key takeaways:

1. **Observer Pattern**: Suitable for one-to-many notification scenarios, such as event systems and data binding
2. **Strategy Pattern**: Eliminates conditional branches, making algorithms interchangeable
3. **Pub-Sub Pattern**: Achieves complete decoupling between publishers and subscribers
4. **Singleton Pattern**: Ensures a single global instance, such as state management and configuration management

In real projects, these patterns are often used in combination. Understanding the core idea of patterns is more important than memorizing implementation code. When you encounter similar problems, you will naturally think of the corresponding solutions.
