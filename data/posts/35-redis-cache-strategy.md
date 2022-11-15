---
title: "Redis Cache Strategies: Preventing Cache Penetration, Avalanche, and Breakdown"
tag: database
description: 深入分析 Redis 缓存的三大经典问题，并提供生产环境可用的解决方案。
date: "2022-11-15T08:00:00.000Z"
---

## Goal

In high-concurrency systems, Redis caching is a critical component for boosting performance. However, using a cache introduces three classic problems: cache penetration, cache avalanche, and cache breakdown. This article provides an in-depth analysis of these three issues and offers production-ready solutions that you can apply to real-world projects.

## Background

### How Caching Works

The fundamental idea behind caching is "trading space for time":

1. **Read path**: Check cache first. If there is a hit, return the cached value directly. On a miss, query the database and write the result back to the cache.
2. **Write path**: Update the database first, then delete the cache (rather than updating the cache directly).

### Why We Need Caching

- **Database protection**: Reduces read and write pressure on the database.
- **Performance boost**: In-memory reads are orders of magnitude faster than disk reads.
- **Better user experience**: Faster response times translate directly into happier users.
- **Cost savings**: Reduces the need to scale up database infrastructure.

## Cache Penetration

### Problem Definition

Cache penetration occurs when you query for data that **definitely does not exist**. Because the cache has no entry for the key, every request falls through to the database. But the database also has no matching record, so nothing gets written back to the cache. This means every single request hits the database, completely bypassing the cache layer.

### Typical Scenarios

1. **Malicious attacks**: An attacker deliberately requests IDs that do not exist.
2. **Business logic bugs**: Code defects cause queries with invalid parameters.
3. **Data inconsistency**: A cached entry expires, but the underlying data has already been deleted.

### Solutions

#### Solution 1: Cache Null Values

```javascript
async function getData(key) {
  // 1. Check cache first
  let value = await redis.get(key)

  if (value !== null) {
    // If the entry is a null marker, return null
    if (value === 'NULL') return null
    return JSON.parse(value)
  }

  // 2. Query the database
  value = await db.query(key)

  if (value) {
    // 3. Data exists - write to cache
    await redis.set(key, JSON.stringify(value), 'EX', 3600)
  } else {
    // 4. Data does not exist - cache a null marker with a shorter TTL
    await redis.set(key, 'NULL', 'EX', 300) // expires in 5 minutes
  }

  return value
}
```

The idea is simple: even when the data does not exist, store a sentinel value in the cache. Subsequent requests for the same non-existent key will hit the cache and return immediately, never touching the database again within the TTL window.

#### Solution 2: Bloom Filter

```javascript
const BloomFilter = require('redis-bloom-filter')

async function getData(key) {
  // 1. Check the Bloom filter
  const exists = await bloomFilter.exists(key)

  if (!exists) {
    // The key definitely does not exist - return immediately
    return null
  }

  // 2. Check the cache
  let value = await redis.get(key)

  if (value !== null) {
    return JSON.parse(value)
  }

  // 3. Query the database
  value = await db.query(key)

  if (value) {
    await redis.set(key, JSON.stringify(value), 'EX', 3600)
  }

  return value
}
```

A Bloom filter is a probabilistic data structure that can tell you whether an element is "definitely not in the set" or "probably in the set." By placing one in front of the cache, you can block requests for non-existent keys before they ever reach the database. The trade-off is a small probability of false positives (the filter says a key might exist when it does not), but the benefit is that all requests for keys that are truly absent are filtered out at near-zero cost.

#### Solution 3: API Layer Validation

```javascript
async function getUser(req, res) {
  const { id } = req.query

  // 1. Format validation
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid ID format' })
  }

  // 2. Business rule validation
  if (id < 1 || id > 999999) {
    return res.status(400).json({ error: 'ID out of range' })
  }

  // 3. Query data
  const user = await getData(`user:${id}`)

  if (!user) {
    return res.status(404).json({ error: 'User not found' })
  }

  res.json(user)
}
```

Sometimes the simplest defense is the most effective. By validating input parameters at the API boundary, you can reject obviously invalid requests before they ever reach the caching or database layers. This is complementary to the other solutions and should be considered a baseline requirement for any production system.

## Cache Avalanche

### Problem Definition

Cache avalanche happens when **a large number of cache entries expire simultaneously**, causing a flood of requests to hit the database all at once.

### Typical Scenarios

1. **Synchronized expiration**: A batch of data is written to the cache with the same TTL.
2. **Redis downtime**: The entire cache service becomes unavailable.
3. **Service restart**: After a restart, the cache is empty and the database faces a sudden spike.

### Solutions

#### Solution 1: Randomize Expiration Times

```javascript
async function setCacheWithRandomExpire(key, value, baseExpire = 3600) {
  // Add a random jitter of +/-10% to the base expiration time
  const randomExpire = baseExpire + Math.floor(Math.random() * baseExpire * 0.2) - baseExpire * 0.1

  await redis.set(key, JSON.stringify(value), 'EX', Math.max(randomExpire, 60))
}

async function batchSetCache(dataList) {
  for (const item of dataList) {
    await setCacheWithRandomExpire(`product:${item.id}`, item, 3600)
  }
}
```

Instead of setting every key to expire at exactly the same time, add a random jitter. This spreads expiration events across a time window, ensuring that only a fraction of keys expire in any given second. It is a simple change with a significant impact.

#### Solution 2: Multi-Level Caching

```javascript
class MultiLevelCache {
  constructor() {
    this.localCache = new Map()
    this.redisClient = redis
  }

  async get(key) {
    // 1. Check local (in-memory) cache first
    if (this.localCache.has(key)) {
      const item = this.localCache.get(key)
      if (item.expire > Date.now()) {
        return item.value
      }
      this.localCache.delete(key)
    }

    // 2. Check Redis cache
    let value = await this.redisClient.get(key)

    if (value) {
      value = JSON.parse(value)

      // Write to local cache with a shorter TTL
      this.localCache.set(key, {
        value,
        expire: Date.now() + 60000 // 1 minute
      })

      return value
    }

    return null
  }

  async set(key, value, expire = 3600) {
    await this.redisClient.set(key, JSON.stringify(value), 'EX', expire)

    this.localCache.set(key, {
      value,
      expire: Date.now() + 60000
    })
  }
}
```

By layering an in-process memory cache (such as a `Map`) in front of Redis, you add a buffer that can absorb spikes even when Redis itself is temporarily unavailable or experiencing elevated latency. The local cache has a shorter TTL so it stays relatively fresh, while Redis provides the durable shared layer across multiple application instances.

#### Solution 3: Circuit Breaker

```javascript
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

When the cache layer or database is failing, continuing to send requests through makes the situation worse. A circuit breaker stops the flow of requests after a configurable number of failures, serves a fallback response, and periodically retries to see if the downstream service has recovered. This prevents cascading failures and gives the system room to heal.

#### Solution 4: Rate Limiting with Degradation

```javascript
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

const bucket = new TokenBucket(100, 10) // 100 tokens, refilling at 10 per second

async function getDataWithRateLimit(key) {
  if (!bucket.consume()) {
    // Rate limit exceeded - return degraded data
    return getDefaultValue(key)
  }

  return getDataFromCache(key)
}
```

A token bucket limiter controls the rate at which requests are allowed through. When the bucket is empty, incoming requests are rejected or served with a degraded (default) response. This prevents the database from being overwhelmed during a cache avalanche, even if many keys are expiring at the same time.

## Cache Breakdown

### Problem Definition

Cache breakdown is the scenario where a **single hot key expires**, and a burst of concurrent requests for that key all hit the database simultaneously.

### Typical Scenarios

1. **Hot data**: Celebrity social media posts, flash-sale products, trending items.
2. **Synchronized expiration**: A popular key's TTL runs out and many requests arrive at the same instant.
3. **Slow cache rebuild**: The database query to repopulate the cache is slow, keeping the window of vulnerability open.

### Solutions

#### Solution 1: Distributed Mutex Lock

```javascript
async function getDataWithMutex(key) {
  // 1. Check cache first
  let value = await redis.get(key)

  if (value) {
    return JSON.parse(value)
  }

  // 2. Acquire a distributed lock
  const lockKey = `lock:${key}`
  const lockValue = `${Date.now()}-${Math.random()}`
  const lockAcquired = await redis.set(lockKey, lockValue, 'NX', 'EX', 10)

  if (!lockAcquired) {
    // Another process holds the lock - wait and retry
    await sleep(100)
    return getDataWithMutex(key)
  }

  try {
    // 3. Double-check the cache (another process may have updated it)
    value = await redis.get(key)

    if (value) {
      return JSON.parse(value)
    }

    // 4. Query the database
    value = await db.query(key)

    // 5. Write to cache
    if (value) {
      await redis.set(key, JSON.stringify(value), 'EX', 3600)
    } else {
      // Also prevent penetration
      await redis.set(key, 'NULL', 'EX', 300)
    }

    return value
  } finally {
    // 6. Release the lock
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

When a hot key expires, only one process should be allowed to query the database and rebuild the cache. All other processes wait and then read from the newly populated cache. The lock value is a unique identifier that ensures a process only releases the lock it acquired, preventing accidental release by a different process.

#### Solution 2: Logical Expiration

```javascript
async function getDataWithLogicalExpire(key, expireTime = 3600) {
  // 1. Check cache
  let cached = await redis.get(key)

  if (cached) {
    cached = JSON.parse(cached)

    // Check if the logical expiration time has passed
    if (cached.expireTime > Date.now()) {
      // Not expired yet - return the value
      return cached.value
    }

    // Expired - trigger an async rebuild
    if (!cached.updating) {
      cached.updating = true
      await redis.set(key, JSON.stringify(cached), 'EX', 3600)

      // Rebuild cache asynchronously
      rebuildCache(key, expireTime)
    }

    // Return the stale data while the rebuild is in progress
    return cached.value
  }

  // 2. Cache does not exist - synchronous query
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

Instead of relying on Redis TTL to expire entries, you can embed the expiration time inside the cached value itself. When the logical expiration is reached, the system returns the slightly stale data while asynchronously triggering a cache rebuild in the background. This eliminates the thundering-herd problem entirely because the cache entry is never actually removed.

#### Solution 3: Hot Data Preloading

```javascript
class HotDataPreloader {
  constructor() {
    this.hotKeys = new Set()
    this.preloadInterval = null
  }

  addHotKey(key, expireTime = 3600) {
    this.hotKeys.add({ key, expireTime })
  }

  startPreload(interval = 300000) { // Every 5 minutes
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
    // Check remaining TTL
    const ttl = await redis.ttl(key)

    if (ttl > expireTime * 0.3) {
      // Plenty of time remaining - no need to reload
      return
    }

    // Rebuild the cache
    const value = await db.query(key)

    if (value) {
      await redis.set(key, JSON.stringify(value), 'EX', expireTime)
    }
  }
}

const preloader = new HotDataPreloader()
preloader.addHotKey('product:hot:1', 3600)
preloader.addHotKey('config:app', 1800)
preloader.startPreload()
```

For keys that are known to be hot, you can proactively refresh them before they expire. The preloader periodically checks the TTL of each registered hot key, and if the remaining time drops below 30% of the configured expiration, it refreshes the entry from the database. This is the most defensive approach and completely eliminates the possibility of a breakdown for your most critical keys.

## Comprehensive Solution

### A Complete Cache Strategy

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
      // 1. Local cache
      if (useLocalCache) {
        const localValue = this.getFromLocal(key)
        if (localValue !== undefined) {
          return localValue
        }
      }

      // 2. Redis cache
      let value = await this.redis.get(key)

      if (value) {
        value = JSON.parse(value)

        if (useLocalCache) {
          this.setToLocal(key, value, 60000) // 1 minute local TTL
        }

        return value
      }

      // 3. Database query (with optional mutex)
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

    const acquired = await this.redis.set(lockKey, '1', 'NX', 'EX', 10)

    if (!acquired) {
      await sleep(100)
      return this.get(key, { expireTime, useMutex: false })
    }

    try {
      // Double-check
      let value = await this.redis.get(key)

      if (value) {
        return JSON.parse(value)
      }

      value = await db.query(key)

      if (value) {
        await this.redis.set(key, JSON.stringify(value), 'EX', expireTime)
      } else {
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

In practice, you will likely need to combine multiple strategies. A robust caching layer might use local caching for the fastest path, Redis as the shared cache, null-value caching to prevent penetration, and a mutex lock to prevent breakdown on hot keys.

## Monitoring and Alerting

### Cache Metrics

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

No caching strategy is complete without observability. Track your cache hit rate, monitor miss rates over time, and set up alerts when the miss rate spikes above a threshold. A sudden drop in hit rate is often the first indicator of a cache avalanche or penetration attack.

## Summary

Cache penetration, avalanche, and breakdown are the three classic pitfalls of Redis usage, and each has its own set of solutions:

1. **Cache penetration**: Cache null values, use Bloom filters, and validate inputs at the API layer.
2. **Cache avalanche**: Randomize expiration times, implement multi-level caching, and apply circuit breakers with rate limiting.
3. **Cache breakdown**: Use distributed mutex locks, implement logical expiration, and preload hot data.

In real-world projects, you will typically need to combine multiple approaches, along with a robust monitoring and alerting system, to build a cache layer that is both reliable and resilient under pressure.
