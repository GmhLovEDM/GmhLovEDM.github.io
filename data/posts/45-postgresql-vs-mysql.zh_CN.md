---
title: "PostgreSQL vs MySQL：2023 年数据库选型指南"
tag: database
description: 深度对比 PostgreSQL 和 MySQL 两大关系型数据库，帮助开发者做出最合适的技术选型。
date: "2023-03-15T08:00:00.000Z"
---

## 目标

在选择关系型数据库时，PostgreSQL 和 MySQL 是最常见的两个选项。两者各有优势，适用于不同的场景。本文将从性能、功能、生态、适用场景等多个维度进行深度对比，帮助开发者做出最合适的技术选型。

## 背景

### 关系型数据库的重要性

尽管 NoSQL 数据库蓬勃发展，但关系型数据库仍然是：

- **事务处理**：ACID 保证
- **数据一致性**：严格的数据完整性
- **复杂查询**：强大的 SQL 支持
- **生态系统**：成熟的工具和社区

### 为什么选择这两个

- **MySQL**：互联网公司最广泛使用的数据库
- **PostgreSQL**：功能最强大的开源关系型数据库

## 核心特性对比

### 数据类型

```sql
-- MySQL 数据类型
CREATE TABLE mysql_example (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255),
  price DECIMAL(10, 2),
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  metadata JSON
);

-- PostgreSQL 数据类型
CREATE TABLE postgres_example (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  price NUMERIC(10, 2),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  metadata JSONB,
  -- PostgreSQL 特有类型
  tags TEXT[],
  ip_address INET,
  uuid UUID DEFAULT gen_random_uuid(),
  money MONEY,
  xml_data XML,
  range INT4RANGE
);
```

### JSON 支持

```sql
-- MySQL JSON
SELECT 
  JSON_EXTRACT(metadata, '$.name') AS name,
  JSON_EXTRACT(metadata, '$.age') AS age
FROM users
WHERE JSON_EXTRACT(metadata, '$.active') = true;

-- PostgreSQL JSONB（更强大）
SELECT 
  metadata->>'name' AS name,
  metadata->>'age' AS age
FROM users
WHERE metadata @> '{"active": true}';

-- PostgreSQL JSONB 索引
CREATE INDEX idx_metadata ON users USING GIN (metadata);
```

### 全文搜索

```sql
-- MySQL 全文搜索
CREATE TABLE articles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255),
  content TEXT,
  FULLTEXT INDEX idx_fulltext (title, content)
);

SELECT * FROM articles 
WHERE MATCH(title, content) AGAINST('search term' IN BOOLEAN MODE);

-- PostgreSQL 全文搜索（更强大）
CREATE TABLE articles (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  content TEXT,
  ts_vector TSVECTOR
);

-- 创建 GIN 索引
CREATE INDEX idx_search ON articles USING GIN (ts_vector);

-- 查询
SELECT * FROM articles 
WHERE ts_vector @@ plainto_tsquery('english', 'search term');
```

## 并发控制

### MySQL 锁机制

```sql
-- 行级锁
SELECT * FROM accounts WHERE id = 1 FOR UPDATE;

-- 表级锁
LOCK TABLES accounts WRITE;

-- 乐观锁
UPDATE accounts 
SET balance = balance - 100, version = version + 1
WHERE id = 1 AND version = 5;
```

### PostgreSQL MVCC

```sql
-- PostgreSQL 使用 MVCC（多版本并发控制）
-- 读操作不会阻塞写操作，写操作不会阻塞读操作

-- 快照隔离
BEGIN ISOLATION LEVEL SNAPSHOT;
SELECT * FROM accounts WHERE id = 1;
-- 即使其他事务修改了数据，这里看到的仍然是快照时的数据
COMMIT;

-- 可串行化隔离
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- 最严格的隔离级别
```

## 性能对比

### 读性能

```sql
-- MySQL InnoDB 索引
CREATE INDEX idx_user_email ON users (email);
SELECT * FROM users WHERE email = 'user@example.com';

-- PostgreSQL B-Tree 索引
CREATE INDEX idx_user_email ON users (email);
SELECT * FROM users WHERE email = 'user@example.com';

-- PostgreSQL 部分索引（更高效）
CREATE INDEX idx_active_users ON users (email) WHERE is_active = true;
```

### 写性能

```sql
-- MySQL 批量插入
INSERT INTO users (name, email) VALUES 
  ('John', 'john@example.com'),
  ('Jane', 'jane@example.com'),
  ('Bob', 'bob@example.com');

-- PostgreSQL COPY 命令（更快）
COPY users (name, email) FROM STDIN;
John	john@example.com
Jane	jane@example.com
Bob	bob@example.com
\.

-- PostgreSQL UPSERT
INSERT INTO users (name, email) VALUES ('John', 'john@example.com')
ON CONFLICT (email) 
DO UPDATE SET name = EXCLUDED.name;
```

## 高级功能

### 窗口函数

```sql
-- MySQL 8.0+ 窗口函数
SELECT 
  name,
  salary,
  RANK() OVER (ORDER BY salary DESC) as rank,
  LAG(salary) OVER (ORDER BY salary) as prev_salary
FROM employees;

-- PostgreSQL 窗口函数（更强大）
SELECT 
  name,
  salary,
  department,
  RANK() OVER (PARTITION BY department ORDER BY salary DESC) as dept_rank,
  SUM(salary) OVER (PARTITION BY department) as dept_total,
  AVG(salary) OVER (ORDER BY hire_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) as moving_avg
FROM employees;
```

### 物化视图

```sql
-- PostgreSQL 物化视图
CREATE MATERIALIZED VIEW monthly_sales AS
SELECT 
  DATE_TRUNC('month', order_date) as month,
  SUM(amount) as total_sales,
  COUNT(*) as order_count
FROM orders
GROUP BY DATE_TRUNC('month', order_date);

-- 刷新物化视图
REFRESH MATERIALIZED VIEW monthly_sales;

-- 带索引的物化视图
CREATE UNIQUE INDEX idx_monthly_sales ON monthly_sales (month);
```

### 表分区

```sql
-- PostgreSQL 声明式分区
CREATE TABLE orders (
  id SERIAL,
  order_date DATE,
  amount NUMERIC(10, 2)
) PARTITION BY RANGE (order_date);

CREATE TABLE orders_2023_q1 PARTITION OF orders
  FOR VALUES FROM ('2023-01-01') TO ('2023-04-01');

CREATE TABLE orders_2023_q2 PARTITION OF orders
  FOR VALUES FROM ('2023-04-01') TO ('2023-07-01');

-- 查询自动选择分区
EXPLAIN SELECT * FROM orders WHERE order_date = '2023-03-15';
```

## 扩展性

### MySQL 复制

```sql
-- 主从复制配置
-- 主服务器
server-id = 1
log-bin = mysql-bin
binlog-do-db = mydb

-- 从服务器
server-id = 2
relay-log = relay-bin
replicate-do-db = mydb

-- GTID 复制（更现代）
gtid_mode = ON
enforce_gtid_consistency = ON
```

### PostgreSQL 复制

```sql
-- 流复制配置
-- 主服务器
wal_level = replica
max_wal_senders = 3
wal_keep_segments = 64

-- 从服务器
primary_conninfo = 'host=primary port=5432 user=replicator password=xxx'

-- 逻辑复制（更灵活）
CREATE PUBLICATION my_publication FOR TABLE users, orders;
CREATE SUBSCRIPTION my_subscription 
  CONNECTION 'host=primary dbname=mydb'
  PUBLICATION my_publication;
```

## 适用场景

### 选择 MySQL 的场景

1. **Web 应用**：LAMP/LEMP 技术栈
2. **读密集型**：大量 SELECT 查询
3. **简单查询**：不需要复杂 SQL 特性
4. **团队熟悉**：团队有 MySQL 经验
5. **云服务**：RDS、Aurora 等托管服务成熟

### 选择 PostgreSQL 的场景

1. **复杂查询**：需要窗口函数、CTE、物化视图
2. **数据完整性**：需要严格的约束和验证
3. **地理数据**：PostGIS 扩展
4. **JSON 处理**：需要强大的 JSON 操作
5. **全文搜索**：需要高级搜索功能
6. **自定义类型**：需要复合类型、数组等

## 迁移考虑

### 从 MySQL 迁移到 PostgreSQL

```sql
-- 1. 数据类型映射
-- MySQL INT → PostgreSQL INTEGER
-- MySQL VARCHAR → PostgreSQL VARCHAR
-- MySQL DATETIME → PostgreSQL TIMESTAMPTZ
-- MySQL JSON → PostgreSQL JSONB

-- 2. 语法差异
-- MySQL AUTO_INCREMENT → PostgreSQL SERIAL
-- MySQL IFNULL → PostgreSQL COALESCE
-- MySQL GROUP_CONCAT → PostgreSQL STRING_AGG

-- 3. 使用 pgLoader 迁移
-- pgloader mysql://user:pass@host/db postgresql://user:pass@host/db
```

## 总结

PostgreSQL 和 MySQL 都是优秀的关系型数据库：

| 特性 | MySQL | PostgreSQL |
|------|-------|------------|
| 性能 | 优秀 | 优秀 |
| 功能 | 基础 | 强大 |
| 易用性 | 简单 | 中等 |
| 生态 | 成熟 | 成熟 |
| 扩展性 | 良好 | 优秀 |
| 适用场景 | Web 应用 | 企业应用 |

**建议**：

- **简单 Web 应用**：MySQL
- **复杂企业应用**：PostgreSQL
- **地理数据**：PostgreSQL（PostGIS）
- **JSON 处理**：PostgreSQL（JSONB）
- **团队熟悉 MySQL**：MySQL
- **需要高级 SQL**：PostgreSQL

无论选择哪个，都要根据项目的具体需求和团队的技术栈来决定。
