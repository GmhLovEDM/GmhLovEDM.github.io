---
title: "MongoDB vs PostgreSQL：文档型 vs 关系型怎么选"
tag: database
description: 全面对比 MongoDB 和 PostgreSQL 的架构设计、查询性能、数据模型和适用场景，帮助开发者做出正确的数据库选型。
date: "2024-07-05T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者深入理解 MongoDB（文档型数据库）和 PostgreSQL（关系型数据库）的核心差异，包括数据模型、查询语言、性能特征和适用场景，为项目数据库选型提供决策依据。

## 背景

数据库选型是架构设计中最关键的决策之一。选错了数据库，后期迁移的成本极高。MongoDB 和 PostgreSQL 分别代表了 NoSQL 和关系型数据库的两个阵营，它们的设计哲学截然不同。

### 数据库的两大流派

1. **关系型数据库（RDBMS）**：以表和关系为核心，强调数据一致性和完整性
2. **文档型数据库（Document DB）**：以文档和集合为核心，强调灵活性和开发效率

这两种数据库没有绝对的优劣，关键在于你的业务场景更需要什么。

## 一、数据模型对比

### PostgreSQL 的关系模型

```sql
-- 创建用户表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建订单表
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  product_name VARCHAR(100),
  amount DECIMAL(10, 2),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 查询用户及其订单
SELECT u.username, o.product_name, o.amount
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.username = 'john';
```

### MongoDB 的文档模型

```javascript
// 用户文档
{
  _id: ObjectId("507f1f77bcf86cd799439011"),
  username: "john",
  email: "john@example.com",
  created_at: ISODate("2024-07-05"),
  // 嵌入的订单数据
  orders: [
    {
      product_name: "iPhone 15",
      amount: 999.99,
      status: "completed",
      created_at: ISODate("2024-07-01")
    },
    {
      product_name: "AirPods Pro",
      amount: 249.99,
      status: "pending",
      created_at: ISODate("2024-07-05")
    }
  ]
}

// 查询用户及其订单
db.users.findOne(
  { username: "john" },
  { username: 1, orders: 1 }
);
```

### 数据模型的核心差异

| 特性 | PostgreSQL | MongoDB |
|------|-----------|---------|
| 数据结构 | 固定 Schema | 灵活 Schema |
| 关系表达 | 外键 + JOIN | 嵌入或引用 |
| 数据完整性 | 强约束 | 应用层保证 |
| 扩展方式 | 垂直扩展为主 | 水平扩展为主 |
| 事务支持 | 完整 ACID | 4.0+ 支持多文档事务 |

## 二、查询语言对比

### PostgreSQL 的 SQL

SQL 是一门声明式语言，表达力极强：

```sql
-- 复杂聚合查询
SELECT 
  u.username,
  COUNT(o.id) as order_count,
  SUM(o.amount) as total_spent,
  AVG(o.amount) as avg_order_value
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE o.created_at >= '2024-01-01'
GROUP BY u.username
HAVING COUNT(o.id) > 5
ORDER BY total_spent DESC
LIMIT 10;

-- 窗口函数
SELECT 
  username,
  amount,
  RANK() OVER (PARTITION BY user_id ORDER BY amount DESC) as rank
FROM orders;

-- CTE (Common Table Expression)
WITH user_stats AS (
  SELECT user_id, COUNT(*) as order_count
  FROM orders
  GROUP BY user_id
)
SELECT u.username, s.order_count
FROM users u
JOIN user_stats s ON u.id = s.user_id;
```

### MongoDB 的聚合管道

MongoDB 使用聚合管道（Aggregation Pipeline）进行复杂查询：

```javascript
// 复杂聚合查询
db.orders.aggregate([
  { $match: { created_at: { $gte: ISODate("2024-01-01") } } },
  { $group: {
      _id: "$user_id",
      order_count: { $sum: 1 },
      total_spent: { $sum: "$amount" },
      avg_order_value: { $avg: "$amount" }
    }
  },
  { $lookup: {
      from: "users",
      localField: "_id",
      foreignField: "_id",
      as: "user"
    }
  },
  { $unwind: "$user" },
  { $project: {
      username: "$user.username",
      order_count: 1,
      total_spent: 1,
      avg_order_value: 1
    }
  },
  { $sort: { total_spent: -1 } },
  { $limit: 10 }
]);

// 文档更新
db.users.updateOne(
  { username: "john" },
  { 
    $push: { 
      orders: { 
        product_name: "MacBook Pro",
        amount: 1999.99,
        status: "pending",
        created_at: new Date()
      }
    }
  }
);
```

### 查询语言对比

| 操作 | SQL (PostgreSQL) | Aggregation (MongoDB) |
|------|------------------|----------------------|
| 简单查询 | `SELECT * FROM users WHERE id = 1` | `db.users.findOne({_id: 1})` |
| JOIN | `JOIN orders ON ...` | `$lookup` |
| 聚合 | `GROUP BY` + 聚合函数 | `$group` + 聚合操作符 |
| 子查询 | 支持 | `$expr` + `$function` |
| 全文搜索 | `tsvector` + `tsquery` | `$text` + `$search` |

## 三、性能特征

### 读取性能

```javascript
// MongoDB - 文档级锁定，嵌入数据一次读取
db.users.findOne({ username: "john" });
// 返回用户数据 + 所有订单，无需 JOIN

// PostgreSQL - 需要 JOIN 操作
SELECT u.*, o.*
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.username = 'john';
// 需要两次索引查找 + JOIN 操作
```

**分析**：
- MongoDB 在读取嵌套文档时更快（无需 JOIN）
- PostgreSQL 在读取关联数据时通过索引优化也能很快
- 对于简单查询，两者差异不大

### 写入性能

```javascript
// MongoDB - 批量写入优化
db.orders.insertMany([
  { user_id: 1, product: "A", amount: 100 },
  { user_id: 1, product: "B", amount: 200 },
  // ... 更多文档
]);

// PostgreSQL - 批量插入
INSERT INTO orders (user_id, product_name, amount)
VALUES 
  (1, 'A', 100),
  (1, 'B', 200);
```

**分析**：
- MongoDB 的批量写入性能通常更好
- PostgreSQL 的单条写入性能也不错
- 事务开销对两者都有影响

### 索引策略

```javascript
// MongoDB 索引
db.users.createIndex({ username: 1 });
db.users.createIndex({ "orders.created_at": -1 });

// 复合索引
db.orders.createIndex({ user_id: 1, created_at: -1 });
```

```sql
-- PostgreSQL 索引
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);

-- GIN 索引（用于全文搜索）
CREATE INDEX idx_products_search ON products 
  USING GIN(to_tsvector('english', name || ' ' || description));
```

## 四、适用场景

### 选择 MongoDB 的场景

1. **内容管理系统（CMS）**
   - 不同类型的内容有不同的字段
   - 文档结构经常变化
   - 需要快速迭代

```javascript
// CMS 文档 - 灵活的字段结构
// 文章
{ type: "article", title: "...", content: "...", tags: [...] }

// 视频
{ type: "video", title: "...", url: "...", duration: 120 }

// 产品
{ type: "product", name: "...", price: 99.99, specs: {...} }
```

2. **实时分析和日志**
   - 高写入吞吐量
   - 查询模式不固定
   - 需要快速聚合

3. **移动端/游戏后端**
   - 灵活的数据结构
   - 快速读写
   - 水平扩展需求

### 选择 PostgreSQL 的场景

1. **金融/电商系统**
   - 强数据一致性
   - 复杂事务
   - 数据完整性

```sql
-- 转账事务
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

2. **复杂报表和分析**
   - 窗口函数
   - 复杂 JOIN
   - 数据仓库场景

3. **地理信息系统**
   - PostGIS 扩展
   - 空间查询
   - 地图应用

### 混合使用策略

很多现代应用同时使用两种数据库：

```
┌─────────────────────────────────────────────────────────┐
│                     应用层                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐              ┌─────────────┐           │
│  │  MongoDB    │              │ PostgreSQL  │           │
│  │             │              │             │           │
│  │ - 用户内容  │              │ - 用户账户  │           │
│  │ - 日志数据  │              │ - 订单支付  │           │
│  │ - 缓存数据  │              │ - 库存管理  │           │
│  └─────────────┘              └─────────────┘           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 五、云服务对比

### MongoDB Atlas

```javascript
// 连接 Atlas
const { MongoClient } = require('mongodb');
const client = new MongoClient(uri);

async function connect() {
  await client.connect();
  const database = client.db('myapp');
  const users = database.collection('users');
}
```

**优势**：
- 全球分布
- 自动备份
- 免费层可用

### PostgreSQL 云服务

```javascript
// 使用 Prisma 连接
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getUsers() {
  const users = await prisma.user.findMany({
    include: { orders: true }
  });
}
```

**选择**：
- AWS RDS / Aurora
- Google Cloud SQL
- Azure Database
- Supabase（开源 Firebase 替代）

## 六、迁移考虑

### 从 MongoDB 迁移到 PostgreSQL

```javascript
// MongoDB 文档
{
  _id: ObjectId("..."),
  name: "John",
  address: {
    street: "123 Main St",
    city: "New York"
  },
  tags: ["admin", "user"]
}

// PostgreSQL 表结构
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100),
  street VARCHAR(100),
  city VARCHAR(50)
);

CREATE TABLE user_tags (
  user_id INTEGER REFERENCES users(id),
  tag VARCHAR(50)
);
```

### 从 PostgreSQL 迁移到 MongoDB

需要考虑：
- 数据扁平化
- 关系转嵌套
- 索引重建
- 查询重写

## 总结

| 考虑因素 | 选择 MongoDB | 选择 PostgreSQL |
|----------|-------------|-----------------|
| 数据结构 | 频繁变化 | 相对固定 |
| 一致性要求 | 最终一致即可 | 强一致性 |
| 扩展需求 | 水平扩展 | 垂直扩展 |
| 查询复杂度 | 简单查询为主 | 复杂查询多 |
| 团队技能 | NoSQL 经验 | SQL 经验 |
| 成本预算 | 计算密集型 | 存储密集型 |

**姐姐的建议**：

1. **先理解业务**：数据库选型应该从业务需求出发，而不是技术偏好
2. **考虑团队能力**：团队对哪种数据库更熟悉？
3. **预留扩展空间**：选择能支撑未来 3-5 年发展的方案
4. **混合使用**：不要害怕在同一个系统中使用多种数据库

没有银弹，只有最适合你场景的选择。如果你在两者之间犹豫，可以先从 PostgreSQL 开始——它更通用，迁移成本相对较低。当遇到明确的性能或灵活性瓶颈时，再考虑引入 MongoDB。
