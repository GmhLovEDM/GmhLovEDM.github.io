---
title: "MySQL 索引原理与优化：B+ 树到底快在哪"
tag: database
description: 深入理解 MySQL 索引的底层原理，从 B+ 树结构到查询优化，掌握写出高性能 SQL 的核心技能。
date: "2021-06-25T08:00:00.000Z"
---

## 目标

理解 MySQL 索引的底层数据结构，掌握索引设计和 SQL 优化的核心原则。

## 背景

### 为什么索引这么重要？

假设你有一个存储了 1000 万条用户记录的表：

```sql
-- 没有索引：全表扫描
SELECT * FROM users WHERE phone = '13800138000';
-- 执行时间：约 12 秒

-- 有索引：B+ 树查找
CREATE INDEX idx_phone ON users(phone);
SELECT * FROM users WHERE phone = '13800138000';
-- 执行时间：约 0.01 秒
```

**索引把查找时间从 O(n) 降低到了 O(log n)。** 这就是为什么索引优化通常是数据库性能提升最显著的手段。

## B+ 树：MySQL 索引的基石

### 为什么不用二叉树？

```
二叉搜索树（最坏情况）：
1
 \
  2
   \
    3
     \
      4
       \
        5

退化成链表，查找时间 O(n)
```

### 为什么不用 B 树？

B 树的每个节点都存储数据，导致：
1. 每个节点能存储的 key 数量有限
2. 树的高度增加，磁盘 IO 次数增多

### B+ 树的优势

```
B+ 树结构（假设每个节点存 3 个 key）：

            [10 | 20 | 30]
           /    |    |    \
    [5,7] [15,18] [25,28] [35,40]
    /  \    /  \    /  \    /  \
  [数据] [数据] [数据] ... [数据]
  (叶子节点通过链表相连)
```

**核心优势：**

1. **非叶子节点只存索引，不存数据**：每个节点能容纳更多 key，树更矮
2. **叶子节点通过链表相连**：范围查询只需要遍历链表，不需要回溯
3. **所有数据都在叶子节点**：查询路径长度一致，性能稳定

### 实际的 B+ 树长什么样？

InnoDB 引擎的 B+ 树：

```
页大小：16KB
bigint 主键：8 字节
指针：6 字节

每个非叶子节点能存：16KB / (8 + 6) ≈ 1170 个 key

假设树高为 3：
- 第一层：1170 个 key
- 第二层：1170 * 1170 = 1,368,900 个 key
- 第三层：叶子节点存储实际数据

也就是说，3 层 B+ 树可以存储约 2000 万条记录！
查找任意一条记录只需要 3 次磁盘 IO。
```

## 索引类型

### 1. 主键索引（聚簇索引）

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50),
    email VARCHAR(100)
);
```

InnoDB 中，主键索引的叶子节点直接存储整行数据。主键索引就是数据本身。

### 2. 二级索引（非聚簇索引）

```sql
-- 为 email 创建索引
CREATE INDEX idx_email ON users(email);
```

二级索引的叶子节点存储的是**主键值**，不是完整数据。所以通过二级索引查询时，需要"回表"：

```sql
-- 查询过程
SELECT * FROM users WHERE email = 'test@example.com';

1. 在 idx_email 索引树中查找 email = 'test@example.com'，得到 id = 123
2. 回到主键索引树，查找 id = 123，得到完整数据
```

### 3. 覆盖索引

如果查询的字段都被索引覆盖，就不需要回表：

```sql
-- 创建联合索引
CREATE INDEX idx_email_name ON users(email, name);

-- 覆盖索引查询（不需要回表）
SELECT id, email, name FROM users WHERE email = 'test@example.com';

-- EXPLAIN 中显示 Using index
```

### 4. 联合索引与最左前缀

```sql
-- 联合索引
CREATE INDEX idx_a_b_c ON table(a, b, c);

-- 能用到索引的查询
WHERE a = 1                    -- 用到 a
WHERE a = 1 AND b = 2          -- 用到 a, b
WHERE a = 1 AND b = 2 AND c = 3 -- 用到 a, b, c
WHERE a = 1 AND c = 3          -- 只用到 a（c 无法跳过 b）

-- 无法用到索引的查询
WHERE b = 2                    -- 不满足最左前缀
WHERE b = 2 AND c = 3          -- 不满足最左前缀
WHERE c = 3                    -- 不满足最左前缀
```

## 索引失效的场景

### 1. 对索引列使用函数或计算

```sql
-- 索引失效
SELECT * FROM users WHERE YEAR(created_at) = 2021;
SELECT * FROM users WHERE id + 1 = 10;

-- 改写为
SELECT * FROM users WHERE created_at >= '2021-01-01' AND created_at < '2022-01-01';
SELECT * FROM users WHERE id = 9;
```

### 2. 隐式类型转换

```sql
-- phone 字段是 VARCHAR 类型
-- 索引失效
SELECT * FROM users WHERE phone = 13800138000;

-- 改写为
SELECT * FROM users WHERE phone = '13800138000';
```

### 3. LIKE 以通配符开头

```sql
-- 索引失效
SELECT * FROM users WHERE name LIKE '%zhang%';

-- 可以使用索引
SELECT * FROM users WHERE name LIKE 'zhang%';
```

### 4. OR 条件

```sql
-- 索引失效（除非两个字段都有索引）
SELECT * FROM users WHERE name = 'zhang' OR age = 25;

-- 改写为 UNION
SELECT * FROM users WHERE name = 'zhang'
UNION
SELECT * FROM users WHERE age = 25;
```

### 5. NOT IN、NOT EXISTS

```sql
-- 可能索引失效
SELECT * FROM users WHERE id NOT IN (1, 2, 3);
SELECT * FROM users WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id);
```

## EXPLAIN：查看查询执行计划

```sql
EXPLAIN SELECT * FROM users WHERE email = 'test@example.com';
```

关键字段：

| 字段 | 说明 | 优化目标 |
|------|------|----------|
| type | 访问类型 | 至少达到 ref 级别 |
| key | 实际使用的索引 | 不能为空（NULL 表示全表扫描） |
| rows | 预估扫描行数 | 越小越好 |
| Extra | 额外信息 | 避免 Using filesort、Using temporary |

### type 的级别（从好到差）

```
system > const > eq_ref > ref > range > index > ALL
```

- **const**：主键或唯一索引等值查询
- **ref**：非唯一索引等值查询
- **range**：索引范围查询
- **index**：全索引扫描
- **ALL**：全表扫描（需要优化）

## 实战优化案例

### 案例 1：慢查询优化

```sql
-- 优化前：12 秒
SELECT * FROM orders 
WHERE user_id = 123 
  AND status = 'paid' 
  AND created_at > '2021-01-01'
ORDER BY created_at DESC 
LIMIT 10;

-- 分析
-- 1. user_id, status, created_at 都是查询条件
-- 2. 需要排序
-- 3. 需要分页

-- 优化方案：创建联合索引
CREATE INDEX idx_user_status_created ON orders(user_id, status, created_at);

-- 优化后：0.01 秒
```

### 案例 2：分页优化

```sql
-- 优化前：offset 越大越慢
SELECT * FROM articles ORDER BY id DESC LIMIT 100000, 10;

-- 优化方案 1：覆盖索引 + 子查询
SELECT * FROM articles 
WHERE id >= (SELECT id FROM articles ORDER BY id DESC LIMIT 100000, 1)
ORDER BY id DESC 
LIMIT 10;

-- 优化方案 2：记住上一页的最后一条
SELECT * FROM articles 
WHERE id < 上一页最后一条的id
ORDER BY id DESC 
LIMIT 10;
```

### 案例 3：COUNT 优化

```sql
-- 慢查询
SELECT COUNT(*) FROM orders WHERE status = 'paid';

-- 优化方案
-- 1. 如果不需要精确值，使用近似值
-- 2. 维护计数器表
CREATE TABLE order_counts (
    status VARCHAR(20) PRIMARY KEY,
    count BIGINT DEFAULT 0
);

-- 3. 使用缓存
```

## 索引设计原则

1. **选择性高的字段优先**：区分度高的字段（如 email）比区分度低的字段（如 gender）更适合建索引
2. **最左前缀原则**：联合索引要考虑查询条件的顺序
3. **覆盖索引**：尽量让查询字段被索引覆盖，避免回表
4. **避免过度索引**：每个索引都有维护成本（写操作变慢）
5. **小数据类型**：使用 BIGINT 而不是 VARCHAR 存储 ID

## 总结

1. **B+ 树是 MySQL 索引的核心**：矮胖的树结构减少了磁盘 IO
2. **聚簇索引 vs 二级索引**：理解回表机制
3. **联合索引遵循最左前缀**：设计索引时要考虑查询模式
4. **索引失效要避免**：函数、类型转换、通配符等都会导致索引失效
5. **EXPLAIN 是你的朋友**：用它来验证索引是否生效

索引优化不是一蹴而就的，需要结合实际业务场景不断调整和验证。
