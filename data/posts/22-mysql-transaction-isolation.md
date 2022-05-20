---
title: "MySQL Transaction Isolation Levels Explained: Dirty Reads, Phantom Reads and More"
tag: database
description: Deeply understand MySQL's four transaction isolation levels, mastering the principles and solutions for dirty reads, non-repeatable reads, and phantom reads.
date: "2022-05-20T08:00:00.000Z"
---

## Goal

Understand the principles of MySQL transaction isolation levels and master how to choose appropriate isolation levels in real projects.

## Background

### Why Do We Need Transaction Isolation?

In a concurrent environment, multiple transactions operating on the same data simultaneously can cause various problems:

```
Timeline:
T1: Transaction A starts
T2: Transaction B starts
T3: Transaction A reads data
T4: Transaction B modifies data and commits
T5: Transaction A reads data again

If T3 and T5 return different results, a "non-repeatable read" problem occurs
```

### Concurrency Problems

| Problem | Description | Example |
|---------|-------------|---------|
| Dirty read | Reading data modified by other uncommitted transactions | Transaction A reads data modified but not committed by Transaction B |
| Non-repeatable read | Different results when reading the same data twice within one transaction | Between Transaction A's two reads, Transaction B modified and committed the data |
| Phantom read | Different result sets when querying twice within one transaction | Between Transaction A's two queries, Transaction B inserted or deleted data |

## Four Isolation Levels

### 1. READ UNCOMMITTED

```sql
SET SESSION transaction_isolation = 'READ-UNCOMMITTED';
```

**Characteristics**:
- Lowest isolation level
- Can read uncommitted data from other transactions
- Produces dirty reads, non-repeatable reads, and phantom reads

**Example**:
```sql
-- Transaction A
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;  -- Reads 1000

-- Transaction B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;
-- Note: No COMMIT

-- Transaction A (continues)
SELECT balance FROM accounts WHERE id = 1;  -- Reads 500 (dirty read!)
ROLLBACK;  -- Transaction A rolls back

-- Transaction B
ROLLBACK;  -- Transaction B also rolls back

-- Result: Transaction A read uncommitted data from Transaction B (500), but actual data is still 1000
```

### 2. READ COMMITTED

```sql
SET SESSION transaction_isolation = 'READ-COMMITTED';
```

**Characteristics**:
- Can only read committed data from other transactions
- Solves dirty read problem
- Still produces non-repeatable reads and phantom reads

**Example**:
```sql
-- Transaction A
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;  -- Reads 1000

-- Transaction B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;  -- Commits

-- Transaction A (continues)
SELECT balance FROM accounts WHERE id = 1;  -- Reads 500 (non-repeatable read!)
ROLLBACK;

-- Result: Transaction A's two reads return different results (1000 → 500)
```

### 3. REPEATABLE READ - MySQL Default

```sql
SET SESSION transaction_isolation = 'REPEATABLE-READ';
```

**Characteristics**:
- Multiple reads within the same transaction return consistent results
- Solves dirty reads and non-repeatable reads
- InnoDB solves most phantom read problems through MVCC

**Example**:
```sql
-- Transaction A
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;  -- Reads 1000

-- Transaction B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;

-- Transaction A (continues)
SELECT balance FROM accounts WHERE id = 1;  -- Still reads 1000 (repeatable read)
ROLLBACK;

-- Result: Transaction A's two reads return consistent results (both 1000)
```

### 4. SERIALIZABLE

```sql
SET SESSION transaction_isolation = 'SERIALIZABLE';
```

**Characteristics**:
- Highest isolation level
- Completely serialized execution
- Solves all concurrency problems
- Worst performance

**Example**:
```sql
-- Transaction A
START TRANSACTION;
SELECT * FROM accounts WHERE id = 1;  -- Acquires shared lock

-- Transaction B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;  -- Blocked! Waits for Transaction A to finish

-- Transaction A
COMMIT;  -- Releases lock

-- Transaction B
-- Now can continue executing
COMMIT;
```

## MVCC: MySQL's Multi-Version Concurrency Control

### Core Principle

```
Each row contains two hidden fields:
- trx_id: Transaction ID that last modified this row
- roll_pointer: Pointer to undo log

undo log preserves historical versions of data, forming a version chain:

Current version (trx_id=102) → Version 1 (trx_id=100) → Version 2 (trx_id=98) → ...
```

### ReadView

```
ReadView contains:
- m_ids: List of currently active transaction IDs
- min_trx_id: Minimum active transaction ID
- max_trx_id: Next transaction ID to be assigned
- creator_trx_id: Transaction ID that created the ReadView

Visibility judgment rules:
1. If trx_id < min_trx_id → visible
2. If trx_id >= max_trx_id → not visible
3. If trx_id is in m_ids → not visible
4. If trx_id is not in m_ids → visible
```

### Difference Between RC and RR

```
READ COMMITTED:
- Creates new ReadView for each SELECT
- So can see the latest data committed by other transactions

REPEATABLE READ:
- Only creates ReadView on the first SELECT
- Subsequent reads use the same ReadView
- So the data seen is consistent
```

## Application in Real Projects

### 1. Choosing Isolation Level Considerations

```sql
-- Most scenarios: REPEATABLE READ (default)
-- Suitable for: order systems, inventory management

-- Special scenarios: READ COMMITTED
-- Suitable for: read-only reports, log analysis

-- Extreme scenarios: SERIALIZABLE
-- Suitable for: financial transactions, inventory deduction
```

### 2. Using Locks Instead of Transaction Isolation

```sql
-- Scenario: Prevent overselling
-- Method 1: SELECT ... FOR UPDATE (pessimistic lock)
START TRANSACTION;
SELECT stock FROM products WHERE id = 1 FOR UPDATE;
-- Other transactions cannot modify stock now
UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0;
COMMIT;

-- Method 2: Optimistic lock
-- Add version field to table
UPDATE products SET stock = stock - 1, version = version + 1
WHERE id = 1 AND stock > 0 AND version = #{version};
-- If affected rows = 0, concurrent conflict occurred, need to retry
```

### 3. Deadlock Handling

```sql
-- View deadlock logs
SHOW ENGINE INNODB STATUS;

-- Prevent deadlocks
-- 1. Access tables and rows in fixed order
-- 2. Keep transactions as short as possible
-- 3. Use appropriate indexes to reduce lock scope
-- 4. Avoid large transactions
```

## Monitoring and Debugging

### 1. View Current Isolation Level

```sql
-- View global isolation level
SELECT @@global.transaction_isolation;

-- View session isolation level
SELECT @@session.transaction_isolation;

-- Set isolation level
SET SESSION transaction_isolation = 'REPEATABLE-READ';
```

### 2. View Lock Information

```sql
-- View current locks
SELECT * FROM information_schema.INNODB_LOCKS;

-- View lock waits
SELECT * FROM information_schema.INNODB_LOCK_WAITS;

-- View running transactions
SELECT * FROM information_schema.INNODB_TRX;
```

### 3. View InnoDB Status

```sql
-- View InnoDB engine status
SHOW ENGINE INNODB STATUS\G
```

## Best Practices

### 1. Keep Transactions Short

```sql
-- Bad: Long transaction
START TRANSACTION;
-- ... extensive business logic ...
-- ... call external APIs ...
-- ... time-consuming operations ...
COMMIT;

-- Good: Short transaction
-- Do time-consuming operations first
CALL external_api();
-- Then quickly complete transaction
START TRANSACTION;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

### 2. Use Indexes Appropriately

```sql
-- Bad: Full table scan causes table lock
SELECT * FROM orders WHERE status = 'pending';  -- Locks many rows

-- Good: Use index to reduce lock scope
CREATE INDEX idx_status ON orders(status);
SELECT * FROM orders WHERE status = 'pending';  -- Only locks matching rows
```

### 3. Use Optimistic Locks for Concurrency

```java
// Pseudocode
public boolean deductStock(Long productId, int quantity) {
    for (int i = 0; i < 3; i++) {  // Retry 3 times
        Product product = productMapper.selectById(productId);
        if (product.getStock() < quantity) {
            return false;  // Insufficient stock
        }

        int rows = productMapper.update(null,
            new UpdateWrapper<Product>()
                .eq("id", productId)
                .eq("version", product.getVersion())
                .set("stock", product.getStock() - quantity)
                .set("version", product.getVersion() + 1)
        );

        if (rows > 0) {
            return true;  // Success
        }
        // Concurrent conflict, retry
    }
    return false;  // Retries exhausted
}
```

## Summary

1. **Four isolation levels from low to high**: READ UNCOMMITTED → READ COMMITTED → REPEATABLE READ → SERIALIZABLE
2. **MySQL default is REPEATABLE READ**: Solves most concurrency problems through MVCC
3. **MVCC is the core mechanism**: Implemented through version chains and ReadView
4. **Choose appropriate isolation level**: Balance consistency and performance based on business scenarios
5. **Locks are the last resort**: Prefer MVCC, use locks when necessary

Understanding transaction isolation levels is fundamental to database development and helps you avoid many concurrency problems.
