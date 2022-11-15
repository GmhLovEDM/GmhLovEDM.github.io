---
title: "Redis 缓存策略：缓存穿透、雪崩、击穿怎么防"
tag: database
description: 深入分析 Redis 缓存的三大经典问题，并提供生产环境可用的解决方案。
date: "2022-11-15T08:00:00.000Z"
---

## 目标

在高并发系统中，Redis 缓存是提升性能的关键组件。然而，缓存的使用也带来了缓存穿透、缓存雪崩和缓存击穿三大经典问题。本文将深入分析这三个问题的成因，并提供生产环境可用的解决方案。

## 背景

### 缓存的基本原理

缓存的核心思想是"空间换时间"：

1. **读取流程**：先读缓存 → 命中则直接返回 → 未命中则读数据库 → 写入缓存
2. **写入流程**：先更新数据库 → 再删除缓存（而非更新缓存）

### 为什么需要缓存

- **数据库保护**：减少数据库的读写压力
- **性能提升**：内存读取比磁盘读取快几个数量级
- **用户体验**：更快的响应时间
- **成本节约**：减少数据库扩容成本

## 缓存穿透

### 问题定义

缓存穿透是指查询一个**一定不存在的数据**。由于缓存不命中，每次都要去数据库查询，但数据库也没有这条数据，所以也不会写入缓存。这导致每次请求都打到数据库。

### 典型场景

1. **恶意攻击**：攻击者故意请求不存在的 ID
2. **业务漏洞**：代码 bug 导致查询无效参数
3. **数据不一致**：缓存过期后数据已被删除

### 解决方案

#### 方案 1：缓存空值

```javascript
// 缓存空值
async function getData(key) {
  // 1. 先查缓存
  let value = await redis.get(key)
  
  if (value !== null) {
    // 如果是空值标记，返回 null
    if (value === 'NULL') return null
    return JSON.parse(value)
  }
  
  // 2. 查数据库
  value = await db.query(key)
  
  if (value) {
    // 3. 数据存在，写入缓存
    await redis.set(key, JSON.stringify(value), 'EX', 3600)
  } else {
    // 4. 数据不存在，缓存空值（较短过期时间）
    await redis.set(key, 'NULL', 'EX', 300) // 5 分钟过期
  }
  
  return value
}
```

#### 方案 2：布隆过滤器

```javascript
// 使用 Redis 的布隆过滤器模块
const BloomFilter = require('redis-bloom-filter')

async function getData(key) {
  // 1. 检查布隆过滤器
  const exists = await bloomFilter.exists(key)
  
  if (!exists) {
    // 一定不存在，直接返回
    return null
  }
  
  // 2. 查缓存
  let value = await redis.get(key)
  
  if (value !== null) {
    return JSON.parse(value)
  }
  
  // 3. 查数据库
  value = await db.query(key)
  
  if (value) {
    await redis.set(key, JSON.stringify(value), 'EX', 3600)
  }
  
  return value
}
```

#### 方案 3：接口层校验

```javascript
// 接口层参数校验
async function getUser(req, res) {
  const { id } = req.query
  
  // 1. 参数格式校验
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid ID format' })
  }
  
  // 2. 业务规则校验
  if (id < 1 || id > 999999) {
    return res.status(400).json({ error: 'ID out of range' })
  }
  
  // 3. 查询数据
  const user = await getData(`user:${id}`)
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }
  
  res.json(user)
}
```

## 缓存雪崩

### 问题定义

缓存雪崩是指在**同一时间大量缓存同时失效**，导致所有请求都打到数据库。

### 典型场景

1. **缓存同时过期**：批量数据设置相同的过期时间
2. **Redis 宕机**：整个缓存服务不可用
3. **重启导致**：服务重启后缓存为空

### 解决方案

#### 方案 1：过期时间随机化

```javascript
// 随机化过期时间
async function setCacheWithRandomExpire(key, value, baseExpire = 3600) {
  // 在基础过期时间上增加随机值（±10%）
  const randomExpire = baseExpire + Math.floor(Math.random() * baseExpire * 0.2) - baseExpire * 0.1
  
  await redis.set(key, JSON.stringify(value), 'EX', Math.max(randomExpire, 60))
}

// 批量设置时使用随机过期
async function batchSetCache(dataList) {
  for (const item of dataList) {
    await setCacheWithRandomExpire(`product:${item.id}`, item, 3600)
  }
}
```

#### 方案 2：多级缓存

```javascript
// 本地缓存 + Redis 缓存
class MultiLevelCache {
  constructor() {
    this.localCache = new Map()
    this.redisClient = redis
  }
  
  async get(key) {
    // 1. 先查本地缓存
    if (this.localCache.has(key)) {
      const item = this.localCache.get(key)
      if (item.expire > Date.now()) {
        return item.value
      }
      this.localCache.delete(key)
    }
    
    // 2. 查 Redis 缓存
    let value = await this.redisClient.get(key)
    
    if (value) {
      value = JSON.parse(value)
      
      // 写入本地缓存（较短过期时间）
      this.localCache.set(key, {
        value,
        expire: Date.now() + 60000 // 1 分钟
      })
      
      return value
    }
    
    return null
  }
  
  async set(key, value, expire = 3600) {
    // 写入 Redis
    await this.redisClient.set(key, JSON.stringify(value), 'EX', expire)
    
    // 写入本地缓存
    this.localCache.set(key, {
      value,
      expire: Date.now() + 60000
    })
  }
}
```

#### 方案 3：熔断降级

```javascript
// 熔断器模式
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000
    this.state = 'CLOSED'
    this.failureCount = 0
    this.lastFailureTime = null
  }
  
  async execute(fn, fallback) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN'
      } else {
        return fallback()
      }
    }
    
    try {
      const result = await fn()
      
      if (this.state === 'HALF_OPEN') {
        this.state = 'CLOSED'
        this.failureCount = 0
      }
      
      return result
    } catch (error) {
      this.failureCount++
      this.lastFailureTime = Date.now()
      
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN'
      }
      
      return fallback()
    }
  }
}

// 使用
const breaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000
})

async function getDataWithFallback(key) {
  return breaker.execute(
    () => getDataFromCache(key),
    () => getDefaultData(key)
  )
}
```

#### 方案 4：限流降级

```javascript
// 令牌桶限流
class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity
    this.tokens = capacity
    this.refillRate = refillRate
    this.lastRefillTime = Date.now()
  }
  
  refill() {
    const now = Date.now()
    const elapsed = now - this.lastRefillTime
    const tokensToAdd = elapsed * this.refillRate / 1000
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd)
    this.lastRefillTime = now
  }
  
  consume() {
    this.refill()
    
    if (this.tokens >= 1) {
      this.tokens--
      return true
    }
    
    return false
  }
}

// 使用
const bucket = new TokenBucket(100, 10) // 100 个令牌，每秒补充 10 个

async function getDataWithRateLimit(key) {
  if (!bucket.consume()) {
    // 限流，返回降级数据
    return getDefaultValue(key)
  }
  
  return getDataFromCache(key)
}
```

## 缓存击穿

### 问题定义

缓存击穿是指某个**热点 key 在过期的瞬间**，大量并发请求同时打到数据库。

### 典型场景

1. **热点数据**：明星微博、秒杀商品等
2. **缓存刚好过期**：大量请求同时到达
3. **重建缓存耗时**：数据库查询慢

### 解决方案

#### 方案 1：互斥锁

```javascript
// Redis 分布式锁
async function getDataWithMutex(key) {
  // 1. 先查缓存
  let value = await redis.get(key)
  
  if (value) {
    return JSON.parse(value)
  }
  
  // 2. 获取分布式锁
  const lockKey = `lock:${key}`
  const lockValue = `${Date.now()}-${Math.random()}`
  const lockAcquired = await redis.set(lockKey, lockValue, 'NX', 'EX', 10)
  
  if (!lockAcquired) {
    // 未获取锁，等待后重试
    await sleep(100)
    return getDataWithMutex(key)
  }
  
  try {
    // 3. 再次检查缓存（可能其他线程已经更新）
    value = await redis.get(key)
    
    if (value) {
      return JSON.parse(value)
    }
    
    // 4. 查数据库
    value = await db.query(key)
    
    // 5. 写入缓存
    if (value) {
      await redis.set(key, JSON.stringify(value), 'EX', 3600)
    } else {
      // 防止穿透
      await redis.set(key, 'NULL', 'EX', 300)
    }
    
    return value
  } finally {
    // 6. 释放锁
    const currentValue = await redis.get(lockKey)
    if (currentValue === lockValue) {
      await redis.del(lockKey)
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

#### 方案 2：逻辑过期

```javascript
// 逻辑过期（不设置 Redis 过期时间）
async function getDataWithLogicalExpire(key, expireTime = 3600) {
  // 1. 查缓存
  let cached = await redis.get(key)
  
  if (cached) {
    cached = JSON.parse(cached)
    
    // 检查是否逻辑过期
    if (cached.expireTime > Date.now()) {
      // 未过期，直接返回
      return cached.value
    }
    
    // 已过期，异步更新
    if (!cached.updating) {
      // 标记正在更新
      cached.updating = true
      await redis.set(key, JSON.stringify(cached), 'EX', 3600)
      
      // 异步重建缓存
      rebuildCache(key, expireTime)
    }
    
    // 返回旧数据
    return cached.value
  }
  
  // 2. 缓存不存在，同步查询
  const value = await db.query(key)
  
  const cacheData = {
    value,
    expireTime: Date.now() + expireTime * 1000,
    updating: false
  }
  
  await redis.set(key, JSON.stringify(cacheData), 'EX', expireTime * 2)
  
  return value
}

async function rebuildCache(key, expireTime) {
  try {
    const value = await db.query(key)
    
    const cacheData = {
      value,
      expireTime: Date.now() + expireTime * 1000,
      updating: false
    }
    
    await redis.set(key, JSON.stringify(cacheData), 'EX', expireTime * 2)
  } catch (error) {
    console.error('Rebuild cache failed:', error)
  }
}
```

#### 方案 3：热点数据预加载

```javascript
// 热点数据预加载
class HotDataPreloader {
  constructor() {
    this.hotKeys = new Set()
    this.preloadInterval = null
  }
  
  addHotKey(key, expireTime = 3600) {
    this.hotKeys.add({ key, expireTime })
  }
  
  startPreload(interval = 300000) { // 5 分钟
    this.preloadInterval = setInterval(() => {
      this.preloadAll()
    }, interval)
  }
  
  async preloadAll() {
    for (const { key, expireTime } of this.hotKeys) {
      try {
        await this.preloadKey(key, expireTime)
      } catch (error) {
        console.error(`Preload ${key} failed:`, error)
      }
    }
  }
  
  async preloadKey(key, expireTime) {
    // 检查缓存剩余时间
    const ttl = await redis.ttl(key)
    
    if (ttl > expireTime * 0.3) {
      // 剩余时间充足，不需要预加载
      return
    }
    
    // 重建缓存
    const value = await db.query(key)
    
    if (value) {
      await redis.set(key, JSON.stringify(value), 'EX', expireTime)
    }
  }
}

// 使用
const preloader = new HotDataPreloader()
preloader.addHotKey('product:hot:1', 3600)
preloader.addHotKey('config:app', 1800)
preloader.startPreload()
```

## 综合解决方案

### 完整的缓存策略

```javascript
class CacheStrategy {
  constructor(options = {}) {
    this.redis = options.redis
    this.localCache = new Map()
    this.lockMap = new Map()
  }
  
  async get(key, options = {}) {
    const {
      expireTime = 3600,
      useLocalCache = true,
      useMutex = true,
      fallback = null
    } = options
    
    try {
      // 1. 本地缓存
      if (useLocalCache) {
        const localValue = this.getFromLocal(key)
        if (localValue !== undefined) {
          return localValue
        }
      }
      
      // 2. Redis 缓存
      let value = await this.redis.get(key)
      
      if (value) {
        value = JSON.parse(value)
        
        // 本地缓存
        if (useLocalCache) {
          this.setToLocal(key, value, 60000) // 1 分钟
        }
        
        return value
      }
      
      // 3. 数据库查询（可选加锁）
      if (useMutex) {
        return await this.getDataWithMutex(key, expireTime)
      } else {
        return await this.getDataWithoutMutex(key, expireTime)
      }
      
    } catch (error) {
      console.error(`Cache get ${key} failed:`, error)
      return fallback
    }
  }
  
  async getDataWithMutex(key, expireTime) {
    const lockKey = `lock:${key}`
    
    // 尝试获取锁
    const acquired = await this.redis.set(lockKey, '1', 'NX', 'EX', 10)
    
    if (!acquired) {
      // 等待后重试
      await sleep(100)
      return this.get(key, { expireTime, useMutex: false })
    }
    
    try {
      // 双重检查
      let value = await this.redis.get(key)
      
      if (value) {
        return JSON.parse(value)
      }
      
      // 查询数据库
      value = await db.query(key)
      
      // 写入缓存
      if (value) {
        await this.redis.set(key, JSON.stringify(value), 'EX', expireTime)
      } else {
        // 防止穿透
        await this.redis.set(key, 'NULL', 'EX', 300)
      }
      
      return value
    } finally {
      await this.redis.del(lockKey)
    }
  }
  
  getFromLocal(key) {
    if (this.localCache.has(key)) {
      const item = this.localCache.get(key)
      if (item.expire > Date.now()) {
        return item.value
      }
      this.localCache.delete(key)
    }
    return undefined
  }
  
  setToLocal(key, value, expire) {
    this.localCache.set(key, {
      value,
      expire: Date.now() + expire
    })
  }
}
```

## 监控与告警

### 缓存监控指标

```javascript
class CacheMonitor {
  constructor(redis) {
    this.redis = redis
    this.metrics = {
      hit: 0,
      miss: 0,
      total: 0
    }
  }
  
  async get(key) {
    this.metrics.total++
    
    const value = await this.redis.get(key)
    
    if (value) {
      this.metrics.hit++
      return JSON.parse(value)
    }
    
    this.metrics.miss++
    return null
  }
  
  getHitRate() {
    if (this.metrics.total === 0) return 0
    return this.metrics.hit / this.metrics.total
  }
  
  async report() {
    const hitRate = this.getHitRate()
    const redisInfo = await this.redis.info('stats')
    
    console.log('Cache Metrics:', {
      hitRate: `${(hitRate * 100).toFixed(2)}%`,
      hits: this.metrics.hit,
      misses: this.metrics.miss,
      total: this.metrics.total,
      redisHits: this.redis.parseInfo(redisInfo).keyspace_hits,
      redisMisses: this.redis.parseInfo(redisInfo).keyspace_misses
    })
  }
}
```

## 总结

缓存穿透、雪崩、击穿是 Redis 使用中的三大经典问题，解决方案各有侧重：

1. **缓存穿透**：缓存空值、布隆过滤器、接口校验
2. **缓存雪崩**：过期时间随机化、多级缓存、熔断降级
3. **缓存击穿**：互斥锁、逻辑过期、热点数据预加载

在实际项目中，通常需要组合使用多种方案，并配合完善的监控告警机制，才能构建出稳定可靠的缓存系统。
