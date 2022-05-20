---
title: "MySQL 事务隔离级别详解：脏读、幻读一网打尽"
tag: database
description: 深入理解 MySQL 事务的四种隔离级别，掌握脏读、不可重复读、幻读的原理和解决方案。
date: "2022-05-20T08:00:00.000Z"
---

## 目标

理解 MySQL 事务隔离级别的原理，掌握如何在实际项目中选择合适的隔离级别。

## 背景

### 为什么需要事务隔离？

在并发环境下，多个事务同时操作同一批数据会产生各种问题：

```
时间线：
T1: 事务 A 开始
T2: 事务 B 开始
T3: 事务 A 读取数据
T4: 事务 B 修改数据并提交
T5: 事务 A 再次读取数据

如果 T3 和 T5 读取的结果不同，就产生了"不可重复读"问题
```

### 并发问题

| 问题 | 描述 | 示例 |
|------|------|------|
| 脏读 | 读取到其他事务未提交的数据 | 事务 A 读取到事务 B 修改但未提交的数据 |
| 不可重复读 | 同一事务内两次读取结果不同 | 事务 A 两次读取之间，事务 B 修改并提交了数据 |
| 幻读 | 同一事务内两次查询结果集不同 | 事务 A 两次查询之间，事务 B 插入或删除了数据 |

## 四种隔离级别

### 1. READ UNCOMMITTED（读未提交）

```sql
SET SESSION transaction_isolation = 'READ-UNCOMMITTED';
```

**特点**：
- 最低的隔离级别
- 可以读取其他事务未提交的数据
- 会产生脏读、不可重复读、幻读

**示例**：
```sql
-- 事务 A
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;  -- 读取到 1000

-- 事务 B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;
-- 注意：没有 COMMIT

-- 事务 A（继续）
SELECT balance FROM accounts WHERE id = 1;  -- 读取到 500（脏读！）
ROLLBACK;  -- 事务 A 回滚

-- 事务 B
ROLLBACK;  -- 事务 B 也回滚

-- 结果：事务 A 读取到了事务 B 未提交的数据（500），但实际数据还是 1000
```

### 2. READ COMMITTED（读已提交）

```sql
SET SESSION transaction_isolation = 'READ-COMMITTED';
```

**特点**：
- 只能读取其他事务已提交的数据
- 解决了脏读问题
- 仍会产生不可重复读、幻读

**示例**：
```sql
-- 事务 A
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;  -- 读取到 1000

-- 事务 B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;  -- 提交

-- 事务 A（继续）
SELECT balance FROM accounts WHERE id = 1;  -- 读取到 500（不可重复读！）
ROLLBACK;

-- 结果：事务 A 两次读取结果不同（1000 → 500）
```

### 3. REPEATABLE READ（可重复读）- MySQL 默认

```sql
SET SESSION transaction_isolation = 'REPEATABLE-READ';
```

**特点**：
- 同一事务内多次读取结果一致
- 解决了脏读、不可重复读
- InnoDB 通过 MVCC 解决了大部分幻读问题

**示例**：
```sql
-- 事务 A
START TRANSACTION;
SELECT balance FROM accounts WHERE id = 1;  -- 读取到 1000

-- 事务 B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;

-- 事务 A（继续）
SELECT balance FROM accounts WHERE id = 1;  -- 仍然读取到 1000（可重复读）
ROLLBACK;

-- 结果：事务 A 两次读取结果一致（都是 1000）
```

### 4. SERIALIZABLE（串行化）

```sql
SET SESSION transaction_isolation = 'SERIALIZABLE';
```

**特点**：
- 最高的隔离级别
- 完全串行化执行
- 解决所有并发问题
- 性能最差

**示例**：
```sql
-- 事务 A
START TRANSACTION;
SELECT * FROM accounts WHERE id = 1;  -- 加共享锁

-- 事务 B
START TRANSACTION;
UPDATE accounts SET balance = 500 WHERE id = 1;  -- 阻塞！等待事务 A 完成

-- 事务 A
COMMIT;  -- 释放锁

-- 事务 B
-- 现在可以继续执行了
COMMIT;
```

## MVCC：MySQL 的多版本并发控制

### 核心原理

```
每行数据包含两个隐藏字段：
- trx_id：最近修改该行的事务 ID
- roll_pointer：指向 undo log 的指针

undo log 保存了数据的历史版本，形成一个版本链：

当前版本 (trx_id=102) → 版本1 (trx_id=100) → 版本2 (trx_id=98) → ...
```

### ReadView

```
ReadView 包含：
- m_ids：当前活跃的事务 ID 列表
- min_trx_id：最小活跃事务 ID
- max_trx_id：下一个要分配的事务 ID
- creator_trx_id：创建 ReadView 的事务 ID

可见性判断规则：
1. 如果 trx_id < min_trx_id → 可见
2. 如果 trx_id >= max_trx_id → 不可见
3. 如果 trx_id 在 m_ids 中 → 不可见
4. 如果 trx_id 不在 m_ids 中 → 可见
```

### RC vs RR 的区别

```
READ COMMITTED：
- 每次 SELECT 都创建新的 ReadView
- 所以能看到其他事务提交的最新数据

REPEATABLE READ：
- 只在第一次 SELECT 时创建 ReadView
- 后续读取都使用同一个 ReadView
- 所以看到的数据是一致的
```

## 实际项目中的应用

### 1. 选择隔离级别的考虑

```sql
-- 大多数场景：REPEATABLE READ（默认）
-- 适合：订单系统、库存管理

-- 特殊场景：READ COMMITTED
-- 适合：只读报表、日志分析

-- 极端场景：SERIALIZABLE
-- 适合：金融交易、库存扣减
```

### 2. 使用锁代替事务隔离

```sql
-- 场景：防止超卖
-- 方法 1：使用 SELECT ... FOR UPDATE（悲观锁）
START TRANSACTION;
SELECT stock FROM products WHERE id = 1 FOR UPDATE;
-- 这时其他事务无法修改 stock
UPDATE products SET stock = stock - 1 WHERE id = 1 AND stock > 0;
COMMIT;

-- 方法 2：使用乐观锁
-- 在表中增加 version 字段
UPDATE products SET stock = stock - 1, version = version + 1
WHERE id = 1 AND stock > 0 AND version = #{version};
-- 如果 affected rows = 0，说明有并发冲突，需要重试
```

### 3. 死锁处理

```sql
-- 查看死锁日志
SHOW ENGINE INNODB STATUS;

-- 预防死锁
-- 1. 按固定顺序访问表和行
-- 2. 保持事务尽量短
-- 3. 使用合适的索引，减少锁的范围
-- 4. 避免大事务
```

## 监控和调试

### 1. 查看当前隔离级别

```sql
-- 查看全局隔离级别
SELECT @@global.transaction_isolation;

-- 查看会话隔离级别
SELECT @@session.transaction_isolation;

-- 设置隔离级别
SET SESSION transaction_isolation = 'REPEATABLE-READ';
```

### 2. 查看锁信息

```sql
-- 查看当前锁
SELECT * FROM information_schema.INNODB_LOCKS;

-- 查看锁等待
SELECT * FROM information_schema.INNODB_LOCK_WAITS;

-- 查看正在运行的事务
SELECT * FROM information_schema.INNODB_TRX;
```

### 3. 查看 InnoDB 状态

```sql
-- 查看 InnoDB 引擎状态
SHOW ENGINE INNODB STATUS\G
```

## 最佳实践

### 1. 保持事务短小

```sql
-- 不好：长事务
START TRANSACTION;
-- ... 大量业务逻辑 ...
-- ... 调用外部 API ...
-- ... 耗时操作 ...
COMMIT;

-- 好：短事务
-- 先做耗时操作
CALL external_api();
-- 然后快速完成事务
START TRANSACTION;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
COMMIT;
```

### 2. 合理使用索引

```sql
-- 不好：全表扫描导致锁表
SELECT * FROM orders WHERE status = 'pending';  -- 锁很多行

-- 好：使用索引减少锁的范围
CREATE INDEX idx_status ON orders(status);
SELECT * FROM orders WHERE status = 'pending';  -- 只锁符合条件的行
```

### 3. 使用乐观锁处理并发

```java
// 伪代码
public boolean deductStock(Long productId, int quantity) {
    for (int i = 0; i < 3; i++) {  // 重试 3 次
        Product product = productMapper.selectById(productId);
        if (product.getStock() < quantity) {
            return false;  // 库存不足
        }

        int rows = productMapper.update(null,
            new UpdateWrapper<Product>()
                .eq("id", productId)
                .eq("version", product.getVersion())
                .set("stock", product.getStock() - quantity)
                .set("version", product.getVersion() + 1)
        );

        if (rows > 0) {
            return true;  // 成功
        }
        // 有并发冲突，重试
    }
    return false;  // 重试次数用尽
}
```

## 总结

1. **四种隔离级别从低到高**：读未提交 → 读已提交 → 可重复读 → 串行化
2. **MySQL 默认是 REPEATABLE READ**：通过 MVCC 解决大部分并发问题
3. **MVCC 是核心机制**：通过版本链和 ReadView 实现
4. **选择合适的隔离级别**：根据业务场景权衡一致性和性能
5. **锁是最后的手段**：优先考虑 MVCC，必要时使用锁

理解事务隔离级别是数据库开发的基础，能帮你避免很多并发问题。
