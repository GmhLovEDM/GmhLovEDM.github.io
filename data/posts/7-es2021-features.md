---
title: "ES2021 New Features Overview: replaceAll, Promise.any and More"
tag: javascript
description: ES2021 brings practical new features like replaceAll, Promise.any, and logical assignment operators. These features are already available in all major browsers — start using them now.
date: "2021-09-05T08:00:00.000Z"
---

## Goal

Quickly master 7 new features in ES2021 that are **already production-ready**, and understand their practical application scenarios.

## Background

ES2021 (ECMAScript 2021) was officially released in June 2021, bringing several very practical features. Unlike previous years, these features were supported by all major browsers at launch and can be used immediately in production.

## Feature 1: String.prototype.replaceAll()

### Previous Pain Point

Before ES2021, to replace all matches in a string, you could only use regular expressions:

```javascript
// Previous approach
const str = 'Hello World, Hello JavaScript';

// Using regex (need to escape special characters)
const result1 = str.replace(/Hello/g, 'Hi');

// Using split + join (cumbersome)
const result2 = str.split('Hello').join('Hi');

// Using loop (even more cumbersome)
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

### New Approach

```javascript
const str = 'Hello World, Hello JavaScript';

// Directly replace all matches
const result = str.replaceAll('Hello', 'Hi');
console.log(result); // "Hi World, Hi JavaScript"

// Also supports regex
const result2 = str.replaceAll(/Hello/g, 'Hi');
console.log(result2); // "Hi World, Hi JavaScript"
```

### Practical Application Scenarios

```javascript
// 1. URL path processing
const path = '/api/users/123/posts';
const cleanPath = path.replaceAll('/', '-');
console.log(cleanPath); // "-api-users-123-posts"

// 2. SQL query building
const tableName = 'user_posts';
const query = 'SELECT * FROM {table}'.replaceAll('{table}', tableName);

// 3. Template replacement
const template = 'Hello {name}, your order {orderId} is ready';
const message = template
    .replaceAll('{name}', 'Zhang San')
    .replaceAll('{orderId}', 'ORD-12345');
```

## Feature 2: Promise.any()

### Previous Pain Point

`Promise.all` fails when any Promise fails, `Promise.race` returns the first completed result (whether success or failure). But sometimes what we want is: **any one success is enough**.

```javascript
// Previous workaround
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

### New Approach

```javascript
const promises = [
    fetch('https://api1.example.com/data'),
    fetch('https://api2.example.com/data'),
    fetch('https://api3.example.com/data'),
];

try {
    const response = await Promise.any(promises);
    const data = await response.json();
    console.log('Success:', data);
} catch (error) {
    // All Promises failed
    console.log('All requests failed:', error.errors);
}
```

### Practical Application Scenarios

```javascript
// 1. Multi-CDN failover
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
        throw new Error('All CDNs are unavailable');
    }
}

// 2. Timeout control
function withTimeout(promise, ms) {
    return Promise.any([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), ms)
        )
    ]);
}

// 3. Multiple data sources
async function getUserData(userId) {
    const response = await Promise.any([
        cache.get(`user:${userId}`),
        database.query(`SELECT * FROM users WHERE id = ${userId}`),
        fetch(`/api/users/${userId}`),
    ]);
    return response;
}
```

## Feature 3: Logical Assignment Operators

### Previous Syntax

```javascript
// || assignment
let a = 1;
a = a || 10; // If a is falsy, assign 10

// && assignment
let b = 1;
b = b && 20; // If b is truthy, assign 20

// ?? assignment
let c = null;
c = c ?? 30; // If c is null/undefined, assign 30
```

### New Syntax

```javascript
let a = 1;
a ||= 10; // Equivalent to a = a || 10

let b = 1;
b &&= 20; // Equivalent to b = b && 20

let c = null;
c ??= 30; // Equivalent to c = c ?? 30
```

### Practical Application Scenarios

```javascript
// 1. Default value setting
function initConfig(config) {
    config.host ??= 'localhost';
    config.port ??= 3000;
    config.debug ||= false;
    config.timeout &&= config.timeout * 1000;
    return config;
}

// 2. Conditional accumulation
let total = 0;
items.forEach(item => {
    if (item.included) {
        total += item.price;
    }
});

// Using &&=
items.forEach(item => {
    total += item.included && item.price;
});

// 3. Cache setting
const cache = {};
function setCache(key, value) {
    cache[key] ??= value; // Only set when key doesn't exist
}
```

## Feature 4: Numeric Separators

### Previous Pain Point

```javascript
// Large numbers are hard to read
const million = 1000000000;
const billion = 1000000000000;
const hex = 0xFF00FF00;
const binary = 0b1111111100000000;
```

### New Approach

```javascript
// Use underscores as separators (visually clearer)
const million = 1_000_000_000;
const billion = 1_000_000_000_000;
const hex = 0xFF_00_FF_00;
const binary = 0b1111_1111_0000_0000;

// Practical application scenarios
const fileSize = 10_485_760; // 10MB, clear and readable
const maxAge = 31_536_000;   // Seconds in a year
const price = 99_99;          // Price, more readable
```

## Feature 5: WeakRef

### Usage Scenario

```javascript
// Create weak reference
const cache = new Map();
let obj = { data: 'important data' };

// Create weak reference
const weakRef = new WeakRef(obj);

// Access the referenced object
console.log(weakRef.deref()); // { data: 'important data' }

// After the original object is garbage collected
obj = null;
// WeakRef doesn't prevent garbage collection
// Later weakRef.deref() returns undefined
```

### Practical Application Scenarios

```javascript
// 1. Large object cache
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
            // Object has been collected, clean up reference
            this.cache.delete(key);
        }
        return null;
    }
}

// 2. DOM element tracking
const elementRefs = new WeakSet();
function trackElement(el) {
    elementRefs.add(el);
}
```

## Feature 6: FinalizationRegistry

```javascript
// Register callback when object is garbage collected
const registry = new FinalizationRegistry((heldValue) => {
    console.log(`Object collected: ${heldValue}`);
});

// Usage
let obj = { data: 'test' };
registry.register(obj, 'my-object');

// When obj is garbage collected, the callback will be called
obj = null; // Triggers garbage collection (timing uncertain)
```

## Feature 7: String.prototype.matchAll()

Although this was an ES2020 feature, it became an official standard in ES2021:

```javascript
const str = 'Hello World, Hello JavaScript';
const regex = /Hello/g;

// Previous workaround
let match;
while ((match = regex.exec(str)) !== null) {
    console.log(match);
}

// New approach
for (const match of str.matchAll(regex)) {
    console.log(match);
    // match[0] = "Hello"
    // match.index = 0, 13
}

// Practical application: extract all URLs
const text = 'Visit https://example.com and http://test.com';
const urls = [...text.matchAll(/https?:\/\/[^\s]+/g)]
    .map(match => match[0]);
console.log(urls); // ["https://example.com", "http://test.com"]
```

## Browser Support (September 2021)

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| replaceAll | 85+ | 77+ | 13.1+ | 85+ |
| Promise.any | 85+ | 79+ | 14+ | 85+ |
| Logical assignment | 85+ | 79+ | 14+ | 85+ |
| Numeric separators | 75+ | 70+ | 13+ | 75+ |
| WeakRef | 84+ | 79+ | 12.1+ | 84+ |
| FinalizationRegistry | 84+ | 79+ | 12.1+ | 84+ |
| matchAll | 73+ | 67+ | 13+ | 73+ |

**Conclusion: As of September 2021, all ES2021 features can be safely used in production.**

## Practical Project Examples

### Example 1: Form Validation Tool

```javascript
function validateForm(data) {
    const errors = [];

    // Use ??= to set default values
    data.required ??= true;

    // Use replaceAll to clean input
    data.email = data.email?.replaceAll(' ', '');

    // Use matchAll to extract all errors
    const patterns = {
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        phone: /^1[3-9]\d{9}$/,
    };

    for (const [field, pattern] of Object.entries(patterns)) {
        if (data[field] && !pattern.test(data[field])) {
            errors.push(`${field} format is incorrect`);
        }
    }

    return errors;
}
```

### Example 2: Concurrent Request Management

```javascript
async function fetchWithFallback(urls, options = {}) {
    const { timeout = 5000, retries = 2 } = options;

    // Use Promise.any for failover
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
        throw new Error('All data sources are unavailable');
    }
}
```

## Summary

These ES2021 features may seem small, but each one makes code more concise and readable:

1. **replaceAll**: Say goodbye to `split().join()` and regex escaping
2. **Promise.any**: True "any one success is enough"
3. **Logical assignment**: More concise conditional assignment
4. **Numeric separators**: Improved readability for large numbers
5. **WeakRef**: More fine-grained memory control

These features are already available in all modern browsers. There's no reason not to use them in your next project.
