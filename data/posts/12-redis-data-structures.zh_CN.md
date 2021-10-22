---
title: "Redis 数据结构实战：String、Hash、List 怎么选"
tag: database
description: 深入理解 Redis 的五种基础数据结构，掌握每种结构的使用场景和性能特点，避免常见的使用误区。
date: "2021-10-22T08:00:00.000Z"
---

## 目标

理解 Redis 五种基础数据结构的底层实现和使用场景，在实际项目中做出正确的选择。

## 背景

### 为什么需要 Redis？

传统数据库（MySQL）的瓶颈在于磁盘 IO。当你需要：
- 高并发读写（每秒几万次）
- 缓存热点数据
- 分布式锁
- 消息队列

Redis 的内存操作速度是 MySQL 的 10 万倍以上。

### Redis 的五种基础数据结构

| 数据结构 | 底层实现 | 典型场景 |
|----------|----------|----------|
| String | SDS（简单动态字符串） | 缓存、计数器、分布式锁 |
| Hash | 压缩列表/哈希表 | 对象存储、购物车 |
| List | 压缩列表/双向链表 | 消息队列、最新列表 |
| Set | 哈希表/整数集合 | 标签、好友关系 |
| ZSet | 跳表/哈希表 | 排行榜、延迟队列 |

## String：万能的 String

### 底层实现：SDS（Simple Dynamic String）

```
SDS 结构：
+--------+---------+--------+--------+
| len    | alloc   | flags |  data  |
| 4字节  | 4字节   | 1字节  | N字节  |
+--------+---------+--------+--------+

相比 C 字符串的优势：
1. O(1) 获取长度（C 字符串需要遍历）
2. 二进制安全（可以存储图片等二进制数据）
3. 预分配和惰性释放，减少内存分配次数
```

### 使用场景

```bash
# 1. 缓存
SET user:1001 '{"name":"张三","age":25}'
GET user:1001

# 2. 计数器
INCR article:1001:views          # 文章阅读数 +1
INCRBY article:1001:views 10     # 阅读数 +10
DECR article:1001:stock          # 库存 -1

# 3. 分布式锁
SET lock:order:1001 "owner-id" NX EX 30  # 设置锁，30 秒过期

# 4. 会话存储
SET session:abc123 '{"user_id":1001}' EX 3600  # 1 小时过期

# 5. 限流
INCR rate:ip:192.168.1.1
EXPIRE rate:ip:192.168.1.1 60  # 60 秒窗口

# 6. 布尔值
SET feature:dark_mode "true"
```

### 批量操作

```bash
# 批量设置
MSET key1 value1 key2 value2 key3 value3

# 批量获取
MGET key1 key2 key3

# 注意：MGET 是 O(N) 操作，N 是 key 的数量
# 如果一次获取太多 key，可能阻塞 Redis
```

## Hash：对象的家

### 底层实现

```
小数据量（< 512 个字段）：压缩列表（ziplist）
- 内存紧凑，遍历快
- 但插入/删除可能触发内存重分配

大数据量（>= 512 个字段）：哈希表（hashtable）
- O(1) 的读写性能
- 但内存开销较大（指针、桶数组等）
```

### 使用场景

```bash
# 1. 用户信息
HSET user:1001 name "张三" age 25 email "zhangsan@example.com"
HGET user:1001 name
HGETALL user:1001

# 2. 购物车
HSET cart:user:1001 product:2001 2    # 商品 2001 数量 2
HSET cart:user:1001 product:2002 1    # 商品 2002 数量 1
HINCRBY cart:user:1001 product:2001 1 # 数量 +1
HDEL cart:user:1001 product:2002      # 删除商品

# 3. 配置信息
HSET config:app theme "dark" lang "zh-CN" font_size 14
HGET config:app theme

# 4. 统计信息
HINCRBY stats:page page:home views 1
HINCRBY stats:page page:about views 1
HGETALL stats:page
```

### Hash vs String 存储对象

```bash
# 方式 1：String（JSON）
SET user:1001 '{"name":"张三","age":25,"email":"zhangsan@example.com"}'
# 优点：简单直观
# 缺点：修改单个字段需要读取整个 JSON，修改后再写回

# 方式 2：Hash
HSET user:1001 name "张三" age 25 email "zhangsan@example.com"
# 优点：可以只修改单个字段，性能更好
# 缺点：字段多时内存开销大

# 选择建议：
# - 字段少（< 5 个）且需要整体读取：用 String
# - 字段多且需要频繁修改单个字段：用 Hash
```

## List：有序的列表

### 底层实现

```
小数据量（< 512 个元素）：压缩列表
大数据量（>= 512 个元素）：双向链表

双向链表结构：
head <-> node1 <-> node2 <-> node3 <-> tail

支持两端操作，时间复杂度 O(1)
```

### 使用场景

```bash
# 1. 消息队列
LPUSH queue:email '{"to":"user@example.com","subject":"Hello"}'
RPOP queue:email  # 取出最早的邮件

# 2. 最新列表（如微博 timeline）
LPUSH timeline:user:1001 '{"post_id":2001,"content":"Hello"}'
LRANGE timeline:user:1001 0 19  # 获取最新 20 条

# 3. 栈（后进先出）
LPUSH stack:undo '{"action":"delete","data":{}}'
LPOP stack:undo  # 取出最近的操作

# 4. 固定长度列表
LPUSH recent:search "keyword"
LTRIM recent:search 0 99  # 只保留最近 100 条
```

### 常用命令

```bash
# 左侧插入
LPUSH list "a" "b" "c"  # list = ["c", "b", "a"]

# 右侧插入
RPUSH list "x" "y" "z"  # list = ["c", "b", "a", "x", "y", "z"]

# 范围查询
LRANGE list 0 -1  # 获取所有元素

# 阻塞弹出（消息队列常用）
BRPOP queue 30  # 阻塞等待 30 秒

# 获取长度
LLEN list
```

## Set：无序的集合

### 使用场景

```bash
# 1. 标签系统
SADD article:1001:tags "python" "redis" "database"
SMEMBERS article:1001:tags  # 获取所有标签

# 2. 好友关系
SADD user:1001:friends 1002 1003 1004
SADD user:1002:friends 1001 1005
SINTER user:1001:friends user:1002:friends  # 共同好友

# 3. 抽奖系统
SADD lottery:2021 "user1" "user2" "user3" "user4" "user5"
SRANDMEMBER lottery:2021 3  # 随机抽取 3 个
SREM lottery:2021 "user1"  # 移除中奖者

# 4. 去重
SADD page:views:user:1001 "page1" "page2" "page1"  # 自动去重
SCARD page:views:user:1001  # 访问的唯一页面数
```

## ZSet：有序的集合

### 底层实现

```
小数据量（< 128 个元素）：压缩列表
大数据量（>= 128 个元素）：跳表（Skip List）

跳表结构：
Level 3:  1 -----------------> 9
Level 2:  1 --------> 5 -----> 9
Level 1:  1 --> 3 --> 5 --> 7 -> 9

支持 O(log N) 的范围查询和排名查询
```

### 使用场景

```bash
# 1. 排行榜
ZADD leaderboard 100 "player1"
ZADD leaderboard 200 "player2"
ZADD leaderboard 150 "player3"

ZREVRANGE leaderboard 0 9 WITHSCORES  # Top 10
ZRANK leaderboard "player1"  # 排名

# 2. 延迟队列
ZADD delay:queue 1635000000 '{"task":"send_email","data":{}}'
ZRANGEBYSCORE delay:queue 0 $(date +%s)  # 获取到期任务

# 3. 滑动窗口限流
ZADD rate:user:1001 $(date +%s%N) "request1"
ZRANGEBYSCORE rate:user:1001 $(($(date +%s%N) - 1000000000)) $(date +%s%N)
# 获取 1 秒内的请求数

# 4. 带权重的队列
ZADD task:queue 1 "低优先级任务"
ZADD task:queue 5 "高优先级任务"
ZADD task:queue 10 "紧急任务"
ZRANGEBYSCORE task:queue -inf +inf LIMIT 0 1  # 获取最高优先级任务
```

## 性能对比

```bash
# 测试环境：Redis 6.0，单线程，本地连接

# String 读写
100,000 次 SET: 0.05 秒
100,000 次 GET: 0.04 秒

# Hash 读写
100,000 次 HSET: 0.08 秒
100,000 次 HGET: 0.06 秒

# List 读写
100,000 次 LPUSH: 0.06 秒
100,000 次 LRANGE 0 10: 0.12 秒

# Set 读写
100,000 次 SADD: 0.07 秒
100,000 次 SMEMBERS: 0.15 秒

# ZSet 读写
100,000 次 ZADD: 0.10 秒
100,000 次 ZRANGE 0 10: 0.08 秒
```

## 选择指南

```
你需要存储什么？
│
├── 简单的键值对（字符串、数字）
│   └── 用 String
│
├── 对象（多个字段）
│   ├── 字段少（< 5），整体读取
│   │   └── 用 String（JSON）
│   └── 字段多，频繁修改单个字段
│       └── 用 Hash
│
├── 有序的元素列表
│   ├── 需要两端操作（队列/栈）
│   │   └── 用 List
│   └── 需要去重
│       └── 用 Set
│
├── 需要排序或范围查询
│   └── 用 ZSet
│
└── 实时排行榜
    └── 用 ZSet
```

## 常见误区

### 1. 大 Key 问题

```bash
# 错误：一个 Hash 存储了 100 万个字段
HSET user:1001 field1 value1 field2 value2 ... field1000000 value1000000

# 正确：拆分成多个 Hash
HSET user:1001:basic name "张三" age 25
HSET user:1001:extra city "北京" job "工程师"
```

### 2. 慢查询阻塞

```bash
# 错误：LRANGE 获取所有数据
LRANGE huge:list 0 -1  # 可能有几百万个元素

# 正确：分页获取
LRANGE huge:list 0 99
```

### 3. 过期时间设置

```bash
# 错误：不过期的缓存
SET cache:data "..."

# 正确：设置合理的过期时间
SETEX cache:data 3600 "..."  # 1 小时过期
```

## 总结

1. **String 是万能的**：简单场景首选，但复杂对象用 Hash 更好
2. **Hash 适合对象存储**：字段操作比 String 更高效
3. **List 适合队列**：LPUSH + RPOP 实现消息队列
4. **Set 适合去重和关系运算**：交集、并集、差集
5. **ZSet 适合排行榜**：O(log N) 的范围查询和排名

选择正确的数据结构，能让你的 Redis 使用效率提升数倍。
