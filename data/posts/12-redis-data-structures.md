---
title: "Redis Data Structures in Practice: Choosing Between String, Hash, and List"
tag: database
description: Deeply understand Redis's five basic data structures, master the usage scenarios and performance characteristics of each, and avoid common usage pitfalls.
date: "2021-10-22T08:00:00.000Z"
---

## Goal

Understand the underlying implementation and usage scenarios of Redis's five basic data structures, and make the right choices in real projects.

## Background

### Why Do We Need Redis?

The bottleneck of traditional databases (MySQL) lies in disk I/O. When you need:
- High-concurrency read/write (tens of thousands per second)
- Caching hot data
- Distributed locks
- Message queues

Redis's in-memory operation speed is over 100,000 times faster than MySQL.

### Redis's Five Basic Data Structures

| Data Structure | Underlying Implementation | Typical Scenarios |
|----------------|---------------------------|-------------------|
| String | SDS (Simple Dynamic String) | Caching, counters, distributed locks |
| Hash | Ziplist/Hashtable | Object storage, shopping carts |
| List | Ziplist/Doubly linked list | Message queues, latest lists |
| Set | Hashtable/Integer set | Tags, friend relationships |
| ZSet | Skip list/Hashtable | Leaderboards, delay queues |

## String: The Universal String

### Underlying Implementation: SDS (Simple Dynamic String)

```
SDS Structure:
+--------+---------+--------+--------+
| len    | alloc   | flags |  data  |
| 4 bytes| 4 bytes | 1 byte | N bytes|
+--------+---------+--------+--------+

Advantages over C strings:
1. O(1) length retrieval (C strings require traversal)
2. Binary safe (can store binary data like images)
3. Pre-allocation and lazy deallocation reduce memory allocation frequency
```

### Usage Scenarios

```bash
# 1. Caching
SET user:1001 '{"name":"Zhang San","age":25}'
GET user:1001

# 2. Counters
INCR article:1001:views          # Article views +1
INCRBY article:1001:views 10     # Views +10
DECR article:1001:stock          # Stock -1

# 3. Distributed locks
SET lock:order:1001 "owner-id" NX EX 30  # Set lock, 30 seconds expiry

# 4. Session storage
SET session:abc123 '{"user_id":1001}' EX 3600  # 1 hour expiry

# 5. Rate limiting
INCR rate:ip:192.168.1.1
EXPIRE rate:ip:192.168.1.1 60  # 60 second window

# 6. Boolean values
SET feature:dark_mode "true"
```

### Batch Operations

```bash
# Batch set
MSET key1 value1 key2 value2 key3 value3

# Batch get
MGET key1 key2 key3

# Note: MGET is an O(N) operation, where N is the number of keys
# If too many keys are fetched at once, it may block Redis
```

## Hash: Home for Objects

### Underlying Implementation

```
Small data volume (< 512 fields): Ziplist
- Memory compact, fast traversal
- But insert/delete may trigger memory reallocation

Large data volume (>= 512 fields): Hashtable
- O(1) read/write performance
- But higher memory overhead (pointers, bucket arrays, etc.)
```

### Usage Scenarios

```bash
# 1. User information
HSET user:1001 name "Zhang San" age 25 email "zhangsan@example.com"
HGET user:1001 name
HGETALL user:1001

# 2. Shopping cart
HSET cart:user:1001 product:2001 2    # Product 2001 quantity 2
HSET cart:user:1001 product:2002 1    # Product 2002 quantity 1
HINCRBY cart:user:1001 product:2001 1 # Quantity +1
HDEL cart:user:1001 product:2002      # Delete product

# 3. Configuration information
HSET config:app theme "dark" lang "en-US" font_size 14
HGET config:app theme

# 4. Statistics
HINCRBY stats:page page:home views 1
HINCRBY stats:page page:about views 1
HGETALL stats:page
```

### Hash vs String for Object Storage

```bash
# Method 1: String (JSON)
SET user:1001 '{"name":"Zhang San","age":25,"email":"zhangsan@example.com"}'
# Pros: Simple and intuitive
# Cons: Modifying a single field requires reading the entire JSON, modifying, and writing back

# Method 2: Hash
HSET user:1001 name "Zhang San" age 25 email "zhangsan@example.com"
# Pros: Can modify a single field, better performance
# Cons: Higher memory overhead with many fields

# Selection advice:
# - Few fields (< 5) and need to read as a whole: Use String
# - Many fields and frequent single-field modifications: Use Hash
```

## List: Ordered Lists

### Underlying Implementation

```
Small data volume (< 512 elements): Ziplist
Large data volume (>= 512 elements): Doubly linked list

Doubly linked list structure:
head <-> node1 <-> node2 <-> node3 <-> tail

Supports operations at both ends, O(1) time complexity
```

### Usage Scenarios

```bash
# 1. Message queue
LPUSH queue:email '{"to":"user@example.com","subject":"Hello"}'
RPOP queue:email  # Get the earliest email

# 2. Latest list (like Weibo timeline)
LPUSH timeline:user:1001 '{"post_id":2001,"content":"Hello"}'
LRANGE timeline:user:1001 0 19  # Get latest 20 items

# 3. Stack (LIFO)
LPUSH stack:undo '{"action":"delete","data":{}}'
LPOP stack:undo  # Get the most recent operation

# 4. Fixed-length list
LPUSH recent:search "keyword"
LTRIM recent:search 0 99  # Keep only the latest 100
```

### Common Commands

```bash
# Left insert
LPUSH list "a" "b" "c"  # list = ["c", "b", "a"]

# Right insert
RPUSH list "x" "y" "z"  # list = ["c", "b", "a", "x", "y", "z"]

# Range query
LRANGE list 0 -1  # Get all elements

# Blocking pop (commonly used in message queues)
BRPOP queue 30  # Block and wait for 30 seconds

# Get length
LLEN list
```

## Set: Unordered Collections

### Usage Scenarios

```bash
# 1. Tag system
SADD article:1001:tags "python" "redis" "database"
SMEMBERS article:1001:tags  # Get all tags

# 2. Friend relationships
SADD user:1001:friends 1002 1003 1004
SADD user:1002:friends 1001 1005
SINTER user:1001:friends user:1002:friends  # Mutual friends

# 3. Lottery system
SADD lottery:2021 "user1" "user2" "user3" "user4" "user5"
SRANDMEMBER lottery:2021 3  # Randomly select 3
SREM lottery:2021 "user1"  # Remove winner

# 4. Deduplication
SADD page:views:user:1001 "page1" "page2" "page1"  # Automatic dedup
SCARD page:views:user:1001  # Number of unique pages visited
```

## ZSet: Ordered Collections

### Underlying Implementation

```
Small data volume (< 128 elements): Ziplist
Large data volume (>= 128 elements): Skip List

Skip List structure:
Level 3:  1 -----------------> 9
Level 2:  1 --------> 5 -----> 9
Level 1:  1 --> 3 --> 5 --> 7 -> 9

Supports O(log N) range queries and rank queries
```

### Usage Scenarios

```bash
# 1. Leaderboard
ZADD leaderboard 100 "player1"
ZADD leaderboard 200 "player2"
ZADD leaderboard 150 "player3"

ZREVRANGE leaderboard 0 9 WITHSCORES  # Top 10
ZRANK leaderboard "player1"  # Rank

# 2. Delay queue
ZADD delay:queue 1635000000 '{"task":"send_email","data":{}}'
ZRANGEBYSCORE delay:queue 0 $(date +%s)  # Get expired tasks

# 3. Sliding window rate limiting
ZADD rate:user:1001 $(date +%s%N) "request1"
ZRANGEBYSCORE rate:user:1001 $(($(date +%s%N) - 1000000000)) $(date +%s%N)
# Get requests within 1 second

# 4. Weighted queue
ZADD task:queue 1 "Low priority task"
ZADD task:queue 5 "High priority task"
ZADD task:queue 10 "Urgent task"
ZRANGEBYSCORE task:queue -inf +inf LIMIT 0 1  # Get highest priority task
```

## Performance Comparison

```bash
# Test environment: Redis 6.0, single thread, local connection

# String read/write
100,000 SET operations: 0.05 seconds
100,000 GET operations: 0.04 seconds

# Hash read/write
100,000 HSET operations: 0.08 seconds
100,000 HGET operations: 0.06 seconds

# List read/write
100,000 LPUSH operations: 0.06 seconds
100,000 LRANGE 0 10 operations: 0.12 seconds

# Set read/write
100,000 SADD operations: 0.07 seconds
100,000 SMEMBERS operations: 0.15 seconds

# ZSet read/write
100,000 ZADD operations: 0.10 seconds
100,000 ZRANGE 0 10 operations: 0.08 seconds
```

## Selection Guide

```
What do you need to store?
│
├── Simple key-value pairs (strings, numbers)
│   └── Use String
│
├── Objects (multiple fields)
│   ├── Few fields (< 5), read as a whole
│   │   └── Use String (JSON)
│   └── Many fields, frequent single-field modifications
│       └── Use Hash
│
├── Ordered element lists
│   ├── Need operations at both ends (queue/stack)
│   │   └── Use List
│   └── Need deduplication
│       └── Use Set
│
├── Need sorting or range queries
│   └── Use ZSet
│
└── Real-time leaderboard
    └── Use ZSet
```

## Common Pitfalls

### 1. Big Key Problem

```bash
# Wrong: One Hash storing 1 million fields
HSET user:1001 field1 value1 field2 value2 ... field1000000 value1000000

# Correct: Split into multiple Hashes
HSET user:1001:basic name "Zhang San" age 25
HSET user:1001:extra city "Beijing" job "Engineer"
```

### 2. Slow Query Blocking

```bash
# Wrong: LRANGE fetching all data
LRANGE huge:list 0 -1  # May have millions of elements

# Correct: Paginated fetching
LRANGE huge:list 0 99
```

### 3. Expiration Time Setting

```bash
# Wrong: Cache without expiration
SET cache:data "..."

# Correct: Set reasonable expiration time
SETEX cache:data 3600 "..."  # 1 hour expiry
```

## Summary

1. **String is universal**: First choice for simple scenarios, but Hash is better for complex objects
2. **Hash is suitable for object storage**: Field operations are more efficient than String
3. **List is suitable for queues**: LPUSH + RPOP implements message queues
4. **Set is suitable for deduplication and set operations**: Intersection, union, difference
5. **ZSet is suitable for leaderboards**: O(log N) range queries and ranking

Choosing the right data structure can multiply your Redis usage efficiency.
