---
title: "MySQL Index Principles and Optimization: Why B+ Trees Are So Fast"
tag: database
description: Deeply understand the underlying principles of MySQL indexes, from B+ tree structure to query optimization, mastering the core skills of writing high-performance SQL.
date: "2021-06-25T08:00:00.000Z"
---

## Goal

Understand the underlying data structures of MySQL indexes and master the core principles of index design and SQL optimization.

## Background

### Why Are Indexes So Important?

Assume you have a table storing 10 million user records:

```sql
-- Without index: full table scan
SELECT * FROM users WHERE phone = '13800138000';
-- Execution time: approximately 12 seconds

-- With index: B+ tree lookup
CREATE INDEX idx_phone ON users(phone);
SELECT * FROM users WHERE phone = '13800138000';
-- Execution time: approximately 0.01 seconds
```

**Indexes reduce lookup time from O(n) to O(log n).** This is why index optimization is typically the most impactful way to improve database performance.

## B+ Tree: The Foundation of MySQL Indexes

### Why Not a Binary Tree?

```
Binary search tree (worst case):
1
 \
  2
   \
    3
     \
      4
       \
        5

Degenerates into a linked list, lookup time O(n)
```

### Why Not a B Tree?

Every node in a B tree stores data, which means:
1. Each node can store a limited number of keys
2. Tree height increases, leading to more disk I/O operations

### Advantages of B+ Tree

```
B+ tree structure (assuming each node stores 3 keys):

            [10 | 20 | 30]
           /    |    |    \
    [5,7] [15,18] [25,28] [35,40]
    /  \    /  \    /  \    /  \
  [data] [data] [data] ... [data]
  (leaf nodes connected via linked list)
```

**Core advantages:**

1. **Non-leaf nodes only store indexes, not data**: Each node can hold more keys, making the tree shorter
2. **Leaf nodes connected via linked list**: Range queries only need to traverse the linked list, no backtracking needed
3. **All data is in leaf nodes**: Query path length is consistent, performance is stable

### What Does a Real B+ Tree Look Like?

B+ tree in InnoDB engine:

```
Page size: 16KB
bigint primary key: 8 bytes
Pointer: 6 bytes

Each non-leaf node can store: 16KB / (8 + 6) ≈ 1170 keys

Assuming tree height of 3:
- Level 1: 1170 keys
- Level 2: 1170 * 1170 = 1,368,900 keys
- Level 3: leaf nodes store actual data

This means a 3-level B+ tree can store approximately 20 million records!
Finding any record requires only 3 disk I/O operations.
```

## Index Types

### 1. Primary Key Index (Clustered Index)

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50),
    email VARCHAR(100)
);
```

In InnoDB, the primary key index's leaf nodes directly store the entire row data. The primary key index is the data itself.

### 2. Secondary Index (Non-clustered Index)

```sql
-- Create index for email
CREATE INDEX idx_email ON users(email);
```

The leaf nodes of secondary indexes store **primary key values**, not complete data. So when querying through a secondary index, you need to "go back to the table":

```sql
-- Query process
SELECT * FROM users WHERE email = 'test@example.com';

1. Find email = 'test@example.com' in idx_email index tree, get id = 123
2. Go back to primary key index tree, find id = 123, get complete data
```

### 3. Covering Index

If all queried fields are covered by the index, no need to go back to the table:

```sql
-- Create composite index
CREATE INDEX idx_email_name ON users(email, name);

-- Covering index query (no need to go back to table)
SELECT id, email, name FROM users WHERE email = 'test@example.com';

-- EXPLAIN shows Using index
```

### 4. Composite Index and Leftmost Prefix

```sql
-- Composite index
CREATE INDEX idx_a_b_c ON table(a, b, c);

-- Queries that can use the index
WHERE a = 1                    -- uses a
WHERE a = 1 AND b = 2          -- uses a, b
WHERE a = 1 AND b = 2 AND c = 3 -- uses a, b, c
WHERE a = 1 AND c = 3          -- only uses a (c cannot skip b)

-- Queries that cannot use the index
WHERE b = 2                    -- doesn't satisfy leftmost prefix
WHERE b = 2 AND c = 3          -- doesn't satisfy leftmost prefix
WHERE c = 3                    -- doesn't satisfy leftmost prefix
```

## Index Failure Scenarios

### 1. Using Functions or Calculations on Index Columns

```sql
-- Index fails
SELECT * FROM users WHERE YEAR(created_at) = 2021;
SELECT * FROM users WHERE id + 1 = 10;

-- Rewrite to
SELECT * FROM users WHERE created_at >= '2021-01-01' AND created_at < '2022-01-01';
SELECT * FROM users WHERE id = 9;
```

### 2. Implicit Type Conversion

```sql
-- phone field is VARCHAR type
-- Index fails
SELECT * FROM users WHERE phone = 13800138000;

-- Rewrite to
SELECT * FROM users WHERE phone = '13800138000';
```

### 3. LIKE Starting with Wildcard

```sql
-- Index fails
SELECT * FROM users WHERE name LIKE '%zhang%';

-- Can use index
SELECT * FROM users WHERE name LIKE 'zhang%';
```

### 4. OR Conditions

```sql
-- Index fails (unless both fields have indexes)
SELECT * FROM users WHERE name = 'zhang' OR age = 25;

-- Rewrite to UNION
SELECT * FROM users WHERE name = 'zhang'
UNION
SELECT * FROM users WHERE age = 25;
```

### 5. NOT IN, NOT EXISTS

```sql
-- May cause index failure
SELECT * FROM users WHERE id NOT IN (1, 2, 3);
SELECT * FROM users WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id);
```

## EXPLAIN: Viewing Query Execution Plans

```sql
EXPLAIN SELECT * FROM users WHERE email = 'test@example.com';
```

Key fields:

| Field | Description | Optimization Goal |
|-------|-------------|-------------------|
| type | Access type | At least reach ref level |
| key | Actual index used | Must not be empty (NULL means full table scan) |
| rows | Estimated rows scanned | Smaller is better |
| Extra | Additional information | Avoid Using filesort, Using temporary |

### Type Levels (from best to worst)

```
system > const > eq_ref > ref > range > index > ALL
```

- **const**: Primary key or unique index equality query
- **ref**: Non-unique index equality query
- **range**: Index range query
- **index**: Full index scan
- **ALL**: Full table scan (needs optimization)

## Practical Optimization Cases

### Case 1: Slow Query Optimization

```sql
-- Before optimization: 12 seconds
SELECT * FROM orders 
WHERE user_id = 123 
  AND status = 'paid' 
  AND created_at > '2021-01-01'
ORDER BY created_at DESC 
LIMIT 10;

-- Analysis
-- 1. user_id, status, created_at are all query conditions
-- 2. Needs sorting
-- 3. Needs pagination

-- Optimization: Create composite index
CREATE INDEX idx_user_status_created ON orders(user_id, status, created_at);

-- After optimization: 0.01 seconds
```

### Case 2: Pagination Optimization

```sql
-- Before optimization: larger offset is slower
SELECT * FROM articles ORDER BY id DESC LIMIT 100000, 10;

-- Optimization method 1: Covering index + subquery
SELECT * FROM articles 
WHERE id >= (SELECT id FROM articles ORDER BY id DESC LIMIT 100000, 1)
ORDER BY id DESC 
LIMIT 10;

-- Optimization method 2: Remember last record of previous page
SELECT * FROM articles 
WHERE id < last_id_of_previous_page
ORDER BY id DESC 
LIMIT 10;
```

### Case 3: COUNT Optimization

```sql
-- Slow query
SELECT COUNT(*) FROM orders WHERE status = 'paid';

-- Optimization methods
-- 1. If exact value not needed, use approximate value
-- 2. Maintain a counter table
CREATE TABLE order_counts (
    status VARCHAR(20) PRIMARY KEY,
    count BIGINT DEFAULT 0
);

-- 3. Use caching
```

## Index Design Principles

1. **Prioritize fields with high selectivity**: Fields with high distinguishability (like email) are better candidates for indexes than fields with low distinguishability (like gender)
2. **Leftmost prefix principle**: Consider the order of query conditions when designing composite indexes
3. **Covering index**: Try to have query fields covered by indexes to avoid going back to the table
4. **Avoid over-indexing**: Every index has maintenance costs (slower write operations)
5. **Small data types**: Use BIGINT instead of VARCHAR for storing IDs

## Summary

1. **B+ tree is the core of MySQL indexes**: The short and wide tree structure reduces disk I/O
2. **Clustered index vs Secondary index**: Understand the back-to-table mechanism
3. **Composite indexes follow leftmost prefix**: Consider query patterns when designing indexes
4. **Avoid index failure**: Functions, type conversions, wildcards, etc. can all cause index failure
5. **EXPLAIN is your friend**: Use it to verify whether indexes are being used

Index optimization is not a one-time task; it requires continuous adjustment and verification based on actual business scenarios.
