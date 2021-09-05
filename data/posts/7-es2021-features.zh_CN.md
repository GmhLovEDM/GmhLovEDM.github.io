---
title: "ES2021 新特性速览：replaceAll、Promise.any 用起来"
tag: javascript
description: ES2021 带来了 replaceAll、Promise.any、逻辑赋值运算符等实用新特性，这些特性已经在所有主流浏览器中可用，快来用起来吧。
date: "2021-09-05T08:00:00.000Z"
---

## 目标

快速掌握 ES2021 中**已经在生产环境中可用**的 7 个新特性，并了解它们的实际应用场景。

## 背景

ES2021（ECMAScript 2021）于 2021 年 6 月正式发布，带来了几个非常实用的特性。与往年不同的是，这些特性在发布时就已经被所有主流浏览器支持，可以立即在生产环境中使用。

## 特性 1：String.prototype.replaceAll()

### 之前的痛点

在 ES2021 之前，要替换字符串中所有的匹配项，你只能用正则表达式：

```javascript
// 之前的方式
const str = 'Hello World, Hello JavaScript';

// 使用正则（需要转义特殊字符）
const result1 = str.replace(/Hello/g, 'Hi');

// 使用 split + join（繁琐）
const result2 = str.split('Hello').join('Hi');

// 使用循环（更繁琐）
let result3 = '';
let lastIndex = 0;
while (true) {
    const index = str.indexOf('Hello', lastIndex);
    if (index === -1) {
        result3 += str.slice(lastIndex);
        break;
    }
    result3 += str.slice(lastIndex, index) + 'Hi';
    lastIndex = index + 5;
}
```

### 新的方式

```javascript
const str = 'Hello World, Hello JavaScript';

// 直接替换所有匹配项
const result = str.replaceAll('Hello', 'Hi');
console.log(result); // "Hi World, Hi JavaScript"

// 使用正则也支持
const result2 = str.replaceAll(/Hello/g, 'Hi');
console.log(result2); // "Hi World, Hi JavaScript"
```

### 实际应用场景

```javascript
// 1. URL 路径处理
const path = '/api/users/123/posts';
const cleanPath = path.replaceAll('/', '-');
console.log(cleanPath); // "-api-users-123-posts"

// 2. SQL 查询构建
const tableName = 'user_posts';
const query = 'SELECT * FROM {table}'.replaceAll('{table}', tableName);

// 3. 模板替换
const template = 'Hello {name}, your order {orderId} is ready';
const message = template
    .replaceAll('{name}', '张三')
    .replaceAll('{orderId}', 'ORD-12345');
```

## 特性 2：Promise.any()

### 之前的痛点

`Promise.all` 在任意一个 Promise 失败时就失败，`Promise.race` 返回第一个完成的结果（无论成功或失败）。但有时候我们想要的是：**任意一个成功就行**。

```javascript
// 之前的 workaround
function promiseAny(promises) {
    return new Promise((resolve, reject) => {
        const errors = [];
        let remaining = promises.length;

        promises.forEach((promise, index) => {
            Promise.resolve(promise).then(resolve, error => {
                errors[index] = error;
                remaining--;
                if (remaining === 0) {
                    reject(new AggregateError(errors, 'All promises were rejected'));
                }
            });
        });
    });
}
```

### 新的方式

```javascript
const promises = [
    fetch('https://api1.example.com/data'),
    fetch('https://api2.example.com/data'),
    fetch('https://api3.example.com/data'),
];

try {
    const response = await Promise.any(promises);
    const data = await response.json();
    console.log('成功:', data);
} catch (error) {
    // 所有 Promise 都失败了
    console.log('所有请求都失败:', error.errors);
}
```

### 实际应用场景

```javascript
// 1. 多 CDN 容错
async function fetchFromCDN(url) {
    const cdns = [
        `https://cdn1.example.com${url}`,
        `https://cdn2.example.com${url}`,
        `https://cdn3.example.com${url}`,
    ];

    try {
        const response = await Promise.any(
            cdns.map(cdn => fetch(cdn))
        );
        return await response.json();
    } catch (error) {
        throw new Error('所有 CDN 都不可用');
    }
}

// 2. 超时控制
function withTimeout(promise, ms) {
    return Promise.any([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), ms)
        )
    ]);
}

// 3. 多数据源
async function getUserData(userId) {
    const response = await Promise.any([
        cache.get(`user:${userId}`),
        database.query(`SELECT * FROM users WHERE id = ${userId}`),
        fetch(`/api/users/${userId}`),
    ]);
    return response;
}
```

## 特性 3：逻辑赋值运算符

### 之前的写法

```javascript
// || 赋值
let a = 1;
a = a || 10; // 如果 a 是 falsy，赋值为 10

// && 赋值
let b = 1;
b = b && 20; // 如果 b 是 truthy，赋值为 20

// ?? 赋值
let c = null;
c = c ?? 30; // 如果 c 是 null/undefined，赋值为 30
```

### 新的写法

```javascript
let a = 1;
a ||= 10; // 等同于 a = a || 10

let b = 1;
b &&= 20; // 等同于 b = b && 20

let c = null;
c ??= 30; // 等同于 c = c ?? 30
```

### 实际应用场景

```javascript
// 1. 默认值设置
function initConfig(config) {
    config.host ??= 'localhost';
    config.port ??= 3000;
    config.debug ||= false;
    config.timeout &&= config.timeout * 1000;
    return config;
}

// 2. 条件累加
let total = 0;
items.forEach(item => {
    if (item.included) {
        total += item.price;
    }
});

// 使用 &&=
items.forEach(item => {
    total += item.included && item.price;
});

// 3. 缓存设置
const cache = {};
function setCache(key, value) {
    cache[key] ??= value; // 只有 key 不存在时才设置
}
```

## 特性 4：数值分隔符

### 之前的痛点

```javascript
// 大数字很难读
const million = 1000000000;
const billion = 1000000000000;
const hex = 0xFF00FF00;
const binary = 0b1111111100000000;
```

### 新的方式

```javascript
// 使用下划线作为分隔符（视觉上更清晰）
const million = 1_000_000_000;
const billion = 1_000_000_000_000;
const hex = 0xFF_00_FF_00;
const binary = 0b1111_1111_0000_0000;

// 实际应用场景
const fileSize = 10_485_760; // 10MB，清晰明了
const maxAge = 31_536_000;   // 一年的秒数
const price = 99_99;          // 价格，更易读
```

## 特性 5：WeakRef

### 使用场景

```javascript
// 创建弱引用
const cache = new Map();
let obj = { data: '重要数据' };

// 创建弱引用
const weakRef = new WeakRef(obj);

// 访问引用的对象
console.log(weakRef.deref()); // { data: '重要数据' }

// 当原始对象被垃圾回收后
obj = null;
// WeakRef 不会阻止垃圾回收
// 之后 weakRef.deref() 返回 undefined
```

### 实际应用场景

```javascript
// 1. 大对象缓存
class ObjectCache {
    constructor() {
        this.cache = new Map();
    }

    set(key, obj) {
        this.cache.set(key, new WeakRef(obj));
    }

    get(key) {
        const ref = this.cache.get(key);
        if (ref) {
            const obj = ref.deref();
            if (obj) {
                return obj;
            }
            // 对象已被回收，清理引用
            this.cache.delete(key);
        }
        return null;
    }
}

// 2. DOM 元素追踪
const elementRefs = new WeakSet();
function trackElement(el) {
    elementRefs.add(el);
}
```

## 特性 6：FinalizationRegistry

```javascript
// 注册对象被垃圾回收时的回调
const registry = new FinalizationRegistry((heldValue) => {
    console.log(`对象被回收: ${heldValue}`);
});

// 使用
let obj = { data: 'test' };
registry.register(obj, 'my-object');

// 当 obj 被垃圾回收时，回调会被调用
obj = null; // 触发垃圾回收（不确定何时发生）
```

## 特性 7：String.prototype.matchAll()

虽然这是 ES2020 的特性，但 ES2021 正式成为标准：

```javascript
const str = 'Hello World, Hello JavaScript';
const regex = /Hello/g;

// 之前的 workaround
let match;
while ((match = regex.exec(str)) !== null) {
    console.log(match);
}

// 新的方式
for (const match of str.matchAll(regex)) {
    console.log(match);
    // match[0] = "Hello"
    // match.index = 0, 13
}

// 实际应用场景：提取所有 URL
const text = '访问 https://example.com 和 http://test.com';
const urls = [...text.matchAll(/https?:\/\/[^\s]+/g)]
    .map(match => match[0]);
console.log(urls); // ["https://example.com", "http://test.com"]
```

## 浏览器支持情况（2021 年 9 月）

| 特性 | Chrome | Firefox | Safari | Edge |
|------|--------|---------|--------|------|
| replaceAll | 85+ | 77+ | 13.1+ | 85+ |
| Promise.any | 85+ | 79+ | 14+ | 85+ |
| 逻辑赋值 | 85+ | 79+ | 14+ | 85+ |
| 数值分隔符 | 75+ | 70+ | 13+ | 75+ |
| WeakRef | 84+ | 79+ | 12.1+ | 84+ |
| FinalizationRegistry | 84+ | 79+ | 12.1+ | 84+ |
| matchAll | 73+ | 67+ | 13+ | 73+ |

**结论：2021 年 9 月，所有 ES2021 特性都可以在生产环境中安全使用。**

## 实际项目中的应用示例

### 示例 1：表单验证工具

```javascript
function validateForm(data) {
    const errors = [];

    // 使用 ??= 设置默认值
    data.required ??= true;

    // 使用 replaceAll 清理输入
    data.email = data.email?.replaceAll(' ', '');

    // 使用 matchAll 提取所有错误
    const patterns = {
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        phone: /^1[3-9]\d{9}$/,
    };

    for (const [field, pattern] of Object.entries(patterns)) {
        if (data[field] && !pattern.test(data[field])) {
            errors.push(`${field} 格式不正确`);
        }
    }

    return errors;
}
```

### 示例 2：并发请求管理

```javascript
async function fetchWithFallback(urls, options = {}) {
    const { timeout = 5000, retries = 2 } = options;

    // 使用 Promise.any 实现容错
    const promises = urls.map(url =>
        withTimeout(fetch(url), timeout)
            .then(res => res.json())
    );

    try {
        return await Promise.any(promises);
    } catch (error) {
        if (retries > 0) {
            return fetchWithFallback(urls, { ...options, retries: retries - 1 });
        }
        throw new Error('所有数据源都不可用');
    }
}
```

## 总结

ES2021 的这些特性虽然看起来不大，但每一个都能让代码更简洁、更可读：

1. **replaceAll**：告别 `split().join()` 和正则转义
2. **Promise.any**：真正的"任意一个成功就行"
3. **逻辑赋值**：更简洁的条件赋值
4. **数值分隔符**：大数字可读性提升
5. **WeakRef**：更精细的内存控制

这些特性已经在所有现代浏览器中可用，没有理由不在你的下一个项目中使用它们。
