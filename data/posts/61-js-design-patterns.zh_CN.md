---
title: "前端设计模式：观察者、策略、发布订阅在 JS 中的应用"
tag: javascript
description: 通过实际业务场景讲解前端常用设计模式：观察者、策略、发布订阅、单例等，让代码更优雅、可维护、可扩展。
date: "2023-10-12T08:00:00.000Z"
---

## 目标

设计模式是前人总结的通用解决方案，能够有效降低代码耦合度、提升可维护性。对于前端开发者来说，理解并应用设计模式，能让你的代码从「能跑就行」进化到「优雅可扩展」。本文通过实际业务场景，讲解前端最常用的几种设计模式。

## 背景

### 为什么需要设计模式

在实际项目中，我们经常遇到这样的问题：

- 表单验证逻辑散落在多个组件中，修改时需要逐个修改
- 多个组件需要响应同一个数据变化，但不想层层传递 props
- 需要确保某个类只有一个实例（如全局状态管理）
- 大量 if-else 或 switch 语句，难以维护

设计模式就是解决这些问题的通用方案。

## 观察者模式

### 核心思想

观察者模式定义了对象之间的一对多依赖关系，当一个对象状态变化时，所有依赖它的对象都会自动收到通知。

### 实现

```typescript
// 观察者模式实现
class Observer {
  private observers: Set<Function> = new Set();

  subscribe(callback: Function): () => void {
    this.observers.add(callback);
    // 返回取消订阅函数
    return () => this.observers.delete(callback);
  }

  notify(data: any) {
    this.observers.forEach(callback => callback(data));
  }
}

// 使用示例：表单验证
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

    // 通知所有订阅者
    this.notify({
      fieldName,
      error,
      errors: Object.fromEntries(this.errors),
    });
  }

  private validateEmail(email: string): string {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email) ? '' : '邮箱格式不正确';
  }

  private validatePassword(password: string): string {
    return password.length >= 6 ? '' : '密码至少 6 位';
  }
}

// 组件中使用
const validator = new FormValidator();

// 订阅错误变化
const unsubscribe = validator.subscribe(({ errors }) => {
  setErrorDisplay(errors);
});

// 验证时触发通知
validator.validate('email', 'invalid-email');
```

### 实际场景：EventBus

```typescript
// 事件总线
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

// 跨组件通信
const eventBus = EventBus.getInstance();

// 组件 A：发送消息
function handleSendMessage() {
  eventBus.emit('notification', { type: 'success', message: '操作成功' });
}

// 组件 B：接收消息
useEffect(() => {
  const handler = (data) => showToast(data.message);
  eventBus.on('notification', handler);
  return () => eventBus.off('notification', handler);
}, []);
```

## 策略模式

### 核心思想

策略模式将算法族封装成独立的策略类，使它们可以互相替换，消除了条件判断语句。

### 实现

```typescript
// 策略接口
interface ValidationStrategy {
  validate(value: any): string;
}

// 具体策略
class RequiredValidator implements ValidationStrategy {
  validate(value: any): string {
    if (!value || (typeof value === 'string' && !value.trim())) {
      return '此字段为必填项';
    }
    return '';
  }
}

class EmailValidator implements ValidationStrategy {
  validate(value: any): string {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(value) ? '' : '邮箱格式不正确';
  }
}

class MinLengthValidator implements ValidationStrategy {
  constructor(private minLength: number) {}

  validate(value: any): string {
    return value.length >= this.minLength
      ? ''
      : `长度不能少于 ${this.minLength} 个字符`;
  }
}

// 表单验证器
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

// 使用
const validator = new FormValidator();
validator.addRule('email', new RequiredValidator());
validator.addRule('email', new EmailValidator());
validator.addRule('password', new RequiredValidator());
validator.addRule('password', new MinLengthValidator(6));

const errors = validator.validate({
  email: 'invalid-email',
  password: '123',
});
// { email: '邮箱格式不正确', password: '长度不能少于 6 个字符' }
```

### 实际场景：排序策略

```typescript
// 排序策略
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

// 使用
const products = [
  { name: '商品A', price: 100 },
  { name: '商品B', price: 50 },
  { name: '商品C', price: 200 },
];

const priceSort = new AscendingSort<typeof products[0]>();
const sorted = priceSort.sort(products, (a, b) => a.price - b.price);
```

## 发布订阅模式

### 核心思想

发布订阅模式与观察者模式类似，但增加了事件调度中心（Broker），实现了发布者和订阅者的完全解耦。

### 实现

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

// 使用示例：用户状态管理
const pubsub = PubSub.getInstance();

// 用户服务
class UserService {
  static login(user: User) {
    // 登录逻辑...
    pubsub.publish('user:login', user);
  }

  static logout() {
    // 登出逻辑...
    pubsub.publish('user:logout');
  }
}

// 各组件订阅
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

  return <header>{user ? `欢迎, ${user.name}` : '请登录'}</header>;
}

function Notification() {
  useEffect(() => {
    const unsubscribe = pubsub.subscribe('user:login', (user) => {
      showToast(`欢迎回来, ${user.name}`);
    });
    return unsubscribe;
  }, []);

  return null;
}
```

## 单例模式

### 核心思想

确保一个类只有一个实例，并提供全局访问点。

### 实现

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
    // 创建数据库连接
    return { host: 'localhost', port: 3306 };
  }

  query(sql: string) {
    console.log(`Executing: ${sql}`);
  }
}

// 使用
const db1 = Database.getInstance();
const db2 = Database.getInstance();
console.log(db1 === db2); // true
```

### 实际场景：Store 管理

```typescript
// 简易状态管理
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

// 使用
const userStore = Store.getStore('user', { name: '', isLoggedIn: false });
const cartStore = Store.getStore('cart', { items: [], total: 0 });

userStore.subscribe((state) => {
  console.log('用户状态变化:', state);
});

userStore.setState({ name: '张三', isLoggedIn: true });
```

## 总结

设计模式不是银弹，而是解决特定问题的通用方案。关键要点：

1. **观察者模式**：适合一对多的通知场景，如事件系统、数据绑定
2. **策略模式**：消除条件分支，使算法可以互相替换
3. **发布订阅模式**：实现发布者和订阅者的完全解耦
4. **单例模式**：确保全局唯一实例，如状态管理、配置管理

在实际项目中，这些模式往往是组合使用的。理解模式的核心思想，比记住实现代码更重要。当你遇到类似问题时，自然能想到对应的解决方案。
