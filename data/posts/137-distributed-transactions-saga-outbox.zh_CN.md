---
title: "分布式事务实战：2PC、Saga、TCC、事务性发件箱与幂等"
tag: architecture
description: 为什么数据一旦跨服务，单个 ACID 事务就不再够用；两阶段提交与 Percolator 类协议在故障下的真实表现；Saga 模式（编排与协同、补偿、语义锁）、TCC；双写问题与基于 CDC 的事务性发件箱（Outbox）；幂等消费者与收件箱（Inbox）模式；Kafka 的"精确一次"到底保证了什么；以及面向真实系统的选型指南
date: "2026-10-23T12:20:00.000Z"
---

## 目标

在单个关系型数据库里，一致性几乎是免费的：把操作包进 `BEGIN ... COMMIT`，引擎保证要么所有行都改了，要么一行都没改。可一旦一次操作同时涉及两个数据库、一个数据库加一个消息中间件，或者两个由不同团队维护的服务，这个保证就消失了——随之而来的 Bug 是后端工程中代价最高的一类：扣了款却没发货、库存被永久占住、为已经回滚的数据发出了事件。

本文是这片领域的一张实用地图：先讲清楚问题为什么难，再讲经典原子提交协议（2PC）怎么工作、痛点在哪、现代分布式数据库如何让它变得可用；然后把大部分篇幅留给面向服务的系统中真正常用的模式——Saga、TCC、事务性发件箱和幂等消费者；最后给出选型指南。

## 为什么一个事务不再够用

看一个典型的下单流程：

1. 在订单服务里创建订单（它自己的 PostgreSQL）。
2. 在库存服务里预占库存（它自己的 MySQL）。
3. 通过支付服务商扣款（外部 HTTP API）。
4. 向 Kafka 发布 `OrderPlaced`，让邮件、分析、物流等下游响应。

每一步单独看都是原子的，但整个序列不是。任何进程都可能在两步之间崩溃，任何网络调用都可能在对端**已经提交之后**超时，而支付服务商永远不会加入你的数据库事务。三个事实决定了这件事本质上很难：

- **你无法区分"慢"和"死"。** 超时并不能告诉你远端操作到底有没有执行。这是 FLP 不可能性结果和"两军问题"在工程上的直接体现。
- **部分失败是常态。** 单进程里崩溃会让所有东西一起倒下；跨服务时，一个参与者失败，其他参与者还在继续。
- **并非所有参与者都支持事务。** 消息中间件、SaaS API、缓存通常无法按要求执行 prepare、投票或回滚。

解法大致分两类：要么让所有参与者原子地提交（**原子提交**，如 2PC）；要么接受各步骤独立提交，再通过工程手段让系统收敛到正确状态（**Saga、发件箱、幂等**——也就是 Pat Helland 所说的"分布式事务之外的生活"）。

## 两阶段提交（2PC）

2PC 引入一个**协调者**和若干**参与者**（资源管理器）。XA、PostgreSQL 的 `PREPARE TRANSACTION`、MySQL 的 `XA PREPARE` 背后都是它，大多数分布式 SQL 数据库内部也在用它的加固版本。

```
协调者                           参与者 A             参与者 B
    |---- PREPARE ------------------->|                    |
    |---- PREPARE ---------------------------------------->|
    |                     （写 redo/undo、持有锁、         |
    |                       日志强制刷盘、投票）           |
    |<--- YES ------------------------|                    |
    |<--- YES ---------------------------------------------|
 （把 COMMIT 决议强制写入协调者日志）
    |---- COMMIT -------------------->|                    |
    |---- COMMIT ----------------------------------------->|
    |<--- ACK ------------------------|<--- ACK -----------|
```

关键性质：参与者一旦投了 YES，就放弃了单方面中止的权利。从这一刻到收到决议之前，它处于**不确定（in doubt）**状态：必须继续持有锁，因为它不知道结果是提交还是中止。

### 2PC 的痛点

- **阻塞。** 如果协调者在收齐投票之后、发出决议之前（或发送过程中）崩溃，已 prepare 的参与者会带着行锁一直阻塞，直到协调者恢复。参与者之间不能自行决定，因为协调者可能已经对某个参与者说过"提交"了。
- **延迟。** 关键路径上至少两次网络往返，外加多次强制日志写（`fsync`），整个期间都持有锁。
- **可用性是各部分可用性的乘积。** 任何一个参与者不可用，就什么都提交不了；参与者越多，可用性越低。
- **运维痛苦。** 遗留的 prepared 事务是真实存在的一类故障。PostgreSQL 默认禁用 `PREPARE TRANSACTION`（`max_prepared_transactions = 0`），正是因为一个被遗忘的 prepared 事务会无限期持有锁并阻塞 vacuum。

三阶段提交（3PC）增加一轮 pre-commit 来避免阻塞，但只在有界延迟的同步网络模型下成立；在网络分区下并不安全，因此实践中很少使用。

### 让协调者具备容错能力

真正解决阻塞的办法，是不再依赖一个脆弱的单点协调者。Gray 与 Lamport 的论文 *Consensus on Transaction Commit*（2006）表明：如果提交决议本身用共识协议存储（Paxos Commit），协调者故障就不再阻塞进度。生产级分布式数据库在思路上都是这么做的：

- **Google Spanner** 在多个 Paxos 组之间运行 2PC；每个参与者和协调者都是复制状态机，所谓"崩溃"只是一次 Leader 切换，而不是丢失决议。
- **Percolator**（Peng 与 Dabek，OSDI 2010）及其在 **TiDB/TiKV** 中的继承者干脆不要独立的协调者进程。事务中选一行作为**主锁（primary lock）**。提交过程是：先对所有行做 prewrite，锁指向主锁；再提交主锁（这就是原子提交点）；然后惰性地提交次级锁。任何读者遇到残留的次级锁时，去查主锁的状态来决定前滚还是回滚。决议存放在数据本身里，由 Raft 复制。
- **CockroachDB** 用类似的**事务记录（transaction record）**加写意图（write intent）机制，并通过 *parallel commits* 把提交延迟压缩到约一轮共识。

结论：2PC 适合用在**一个系统内部**——它控制所有参与者、复制决议、跑在高速网络上；而不适合跨越独立部署的服务、不同团队和第三方 API。这正是下面这些模式的用武之地。

## Saga

Saga 模式出自 Garcia-Molina 与 Salem 1987 年的论文 *Sagas*，原本针对的是长事务。一个 Saga 是一串本地事务 T1、T2……Tn，每个都配有一个在语义上撤销它的**补偿事务** C1……Cn-1。要么整个序列完成，要么对已完成的步骤逆序执行补偿：T1、T2、T3 失败 → C2、C1。

几个重要推论：

- **没有隔离性。** 中间状态对外可见，其他请求可能看到"订单已创建、库存已预占、尚未付款"。这是放弃全局锁的代价。
- **补偿是语义上的，不是物理上的。** 你无法"撤回"一封邮件或"取消"一次扣款，只能发更正邮件或退款。补偿要针对每个业务动作单独设计。
- **补偿不能永久失败。** 它们必须可重试、幂等；如果补偿持续失败，Saga 需要人工介入或进入死信路径。

### 编排（Orchestration）与协同（Choreography）

**协同**：每个服务监听事件并发出自己的事件。`OrderCreated` → 库存服务预占库存并发出 `StockReserved` → 支付服务扣款并发出 `PaymentSucceeded` 或 `PaymentFailed` → 库存服务监听到 `PaymentFailed` 后释放库存。

**编排**：由一个 Saga 编排器（状态机）告诉每个参与者该做什么，并根据回复推进。

| | 协同 | 编排 |
|---|---|---|
| 耦合 | 服务需要了解彼此的事件 | 服务只需了解编排器的命令 |
| 流程可见性 | 分散在各服务中，很难看清全貌 | 集中在一处，易于查看和推理 |
| 新增步骤 | 要改多个服务 | 改编排器即可 |
| 风险 | 事件循环依赖、"事件意大利面" | 编排器吸收太多业务逻辑后变成上帝服务 |
| 适用 | 2～3 步、流程稳定 | 步骤多、有分支、超时、人工环节 |

下面是一个用 Go 写的最小编排器，每次状态迁移后都持久化，以便崩溃后恢复：

```go
type Step struct {
    Name       string
    Action     func(ctx context.Context, s *SagaState) error
    Compensate func(ctx context.Context, s *SagaState) error
}

type SagaState struct {
    ID        string
    OrderID   string
    Completed []string // 已提交 Action 的步骤名
    Status    string   // RUNNING, COMPENSATING, DONE, FAILED
}

func Run(ctx context.Context, repo Repo, steps []Step, st *SagaState) error {
    for _, step := range steps[len(st.Completed):] {
        if err := retry(ctx, func() error { return step.Action(ctx, st) }); err != nil {
            if isBusinessFailure(err) { // 例如卡被拒：不重试，直接补偿
                return compensate(ctx, repo, steps, st)
            }
            return err // 临时错误且重试耗尽：保持 RUNNING，稍后恢复
        }
        st.Completed = append(st.Completed, step.Name)
        if err := repo.Save(ctx, st); err != nil { // 检查点
            return err
        }
    }
    st.Status = "DONE"
    return repo.Save(ctx, st)
}

func compensate(ctx context.Context, repo Repo, steps []Step, st *SagaState) error {
    st.Status = "COMPENSATING"
    _ = repo.Save(ctx, st)
    for i := len(st.Completed) - 1; i >= 0; i-- {
        step := steps[i]
        if step.Compensate == nil {
            continue
        }
        // 补偿会一直重试直到成功（配合退避与告警）
        if err := retryForever(ctx, func() error { return step.Compensate(ctx, st) }); err != nil {
            st.Status = "FAILED"
            _ = repo.Save(ctx, st)
            return err
        }
        st.Completed = st.Completed[:i]
        _ = repo.Save(ctx, st)
    }
    st.Status = "COMPENSATED"
    return repo.Save(ctx, st)
}
```

注意这段代码对每个 `Action` 和 `Compensate` 的要求：编排器可能在远程调用成功之后、写检查点之前崩溃，所以**每一步都有可能被执行两次**。幂等不是可选项（后文详述）。生产环境中，越来越多团队不再手写这种循环，而是使用 **Temporal**（或 Cadence、AWS Step Functions）这类持久化执行引擎：它们持久化工作流的事件历史，崩溃后确定性地重放，于是"每步之后打检查点"的样板代码就从业务代码中消失了。

### 通过步骤顺序减轻补偿负担

Chris Richardson（microservices.io）把 Saga 步骤分为：

- **可补偿步骤**：可以撤销（预占库存 → 释放库存）。
- **关键步骤（pivot）**：决定成败的节点，过了它 Saga 就不再回滚（扣款）。
- **可重试步骤**：位于关键步骤之后，必须最终成功（发送确认、通知物流）。

把廉价、易撤销的步骤放在前面，把难以撤销的动作作为关键步骤，之后只放"重试终会成功"的步骤。

### 没有隔离性时怎么办

由于 Saga 没有隔离性，业务层面会出现丢失更新、脏读等异常。常见对策：

- **语义锁**：给记录打上进行中状态（`order.status = APPROVAL_PENDING`），让其他流程知道它正在变化，可以拒绝或等待。
- **可交换更新**：把操作设计成与顺序无关（用追加的流水记录表示记账/扣账，而不是覆盖余额）。
- **重读值 / 版本校验**：在关键步骤之前重新确认数据没被改过（用版本列做乐观并发控制）。
- **悲观视图**：调整步骤顺序，让风险最大的可见效果最后发生。

## TCC：Try-Confirm-Cancel

TCC 是一种基于预留资源的变体，在支付和电商领域很流行（Apache Seata 等框架都有实现）。每个参与者暴露三个操作：

- **Try**：校验业务规则并**预留**资源（冻结账户中的 100 元、锁定 1 件库存），但不使其最终生效。
- **Confirm**：把预留转为真实效果；必须幂等，且不应因业务原因失败。
- **Cancel**：释放预留；必须幂等。

TCC 本质上是在业务层实现的 2PC：Try 约等于 prepare，Confirm/Cancel 约等于 commit/abort；但"锁"是带显式过期时间的业务预留，而不是数据库行锁，因此不会阻塞其他工作。它比普通 Saga 的隔离性更好（别人看到的是"冻结"的资金，而不是已花掉的资金），代价是每个操作要三个接口，并且每个服务都要有预留模型。

TCC 实现必须处理三个经典问题：

1. **空回滚**：某个 Try 根本没执行（在网络中超时），却收到了 Cancel。Cancel 必须作为空操作成功返回，并记录下来。
2. **悬挂**：延迟到达的 Try 在 Cancel **之后**才到。如果不设防，它会预留一份永远没人释放的资源。解法：Try 先检查同一事务 ID 是否已有 Cancel 记录，有则拒绝执行。
3. **幂等**：Confirm 和 Cancel 都会被重试，每个都必须能安全地执行两次。

这三个问题都可以用每个参与者一张以全局事务 ID 和分支 ID 为键的小表来解决，记录各阶段是否已执行。

## 双写问题与事务性发件箱

哪怕只有一个服务，只要它既写数据库**又**发事件，里面就藏着一个分布式事务：

```python
# 错误示范：双写
with db.transaction():
    db.insert("orders", order)
kafka.send("orders", OrderPlaced(order.id))   # 在这里崩溃 → 事件丢失
```

调换顺序也没用：先发事件再回滚，就会留下一个指向不存在订单的幽灵事件。在事务内部发事件也不行：提交失败时，消息发送并不会回滚。

**事务性发件箱（Transactional Outbox）**把第二次写移出关键路径：服务在写业务数据的**同一个本地事务**里，把事件写进 `outbox` 表；再由一个独立的中继进程稍后发布。

```sql
CREATE TABLE outbox (
    id             UUID PRIMARY KEY,
    aggregate_type TEXT        NOT NULL,   -- 例如 'order'
    aggregate_id   TEXT        NOT NULL,   -- 作为消息 key → 保证单实体有序
    event_type     TEXT        NOT NULL,
    payload        JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```python
with db.transaction():
    db.insert("orders", order)
    db.insert("outbox", {
        "id": uuid4(),
        "aggregate_type": "order",
        "aggregate_id": str(order.id),
        "event_type": "OrderPlaced",
        "payload": json.dumps(order.to_event()),
    })
# 两行要么一起提交，要么都不提交
```

把发件箱里的行搬到消息中间件有两种方式：

**1. 轮询发布。** 一个工作进程反复查询未发布的行，发布后标记或删除。在 PostgreSQL 中，多个工作进程可以用互相跳过的行锁安全地分担负载：

```sql
SELECT id, aggregate_id, event_type, payload
FROM outbox
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

简单、适用于任何数据库，但会带来轮询负载和延迟；而且除非按聚合分区，否则并行的工作进程可能打乱事件顺序。

**2. 变更数据捕获（CDC，日志追踪）。** CDC 工具读取数据库的复制日志（PostgreSQL 逻辑解码 / WAL、MySQL binlog），把每条新插入的发件箱记录转换成消息。**Debezium** 提供了 *Outbox Event Router* 转换器，按 `aggregate_type` 路由到不同 Topic，并用 `aggregate_id` 作为 Kafka key。好处：没有轮询查询、按提交顺序投递、延迟极低。代价：要运维 Kafka Connect 和 Debezium，还得管理复制槽（被遗弃的 PostgreSQL 复制槽会一直保留 WAL，可能把磁盘写满）。

无论哪种方式，发件箱提供的都是**至少一次**投递：中继可能在发布之后、记录进度之前崩溃，事件就会再发一次。这就引出了这个模式的另一半。

### 为什么不直接对业务表做 CDC？

可以，但那样你的内部表结构就成了对外的事件契约：改个列名就会让消费者出错。发件箱让你可以发布经过设计、带版本的领域事件，同时保持表结构私有。事件溯源（Event Sourcing）是更极端的做法：事件日志本身就是唯一事实来源，根本不存在双写。

## 幂等消费者与收件箱模式

所有值得使用的可靠消息方案都是至少一次投递，因此消费者必须能容忍重复。稳妥的做法是：在产生副作用的**同一个事务**里记录已处理的消息 ID：

```sql
CREATE TABLE processed_messages (
    consumer    TEXT NOT NULL,
    message_id  UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, message_id)
);
```

```python
def handle(msg):
    with db.transaction():
        inserted = db.execute(
            "INSERT INTO processed_messages (consumer, message_id) "
            "VALUES (%s, %s) ON CONFLICT DO NOTHING",
            ("shipping", msg.id),
        ).rowcount
        if inserted == 0:
            return  # 重复消息：已经处理过
        create_shipment(msg.payload)  # 同一个数据库事务
    consumer.commit_offset(msg)       # 在数据库提交之后
```

如果进程在数据库提交之后、提交位点之前崩溃，消息会被重新投递，插入发生冲突，处理器直接跳过。这张"收件箱"表也是实现单实体有序的地方（为每个聚合保存最后应用的版本，忽略更旧的消息）。

其他幂等手段，从最轻量到最通用：

- **天然幂等的操作**：`SET status = 'SHIPPED'` 是幂等的；`balance = balance - 100` 不是。
- **带版本的条件更新**：`UPDATE ... SET status='PAID', version=version+1 WHERE id=? AND version=?`。
- **业务键唯一约束**：每个 `order_id` 只能有一笔支付。
- **API 幂等键**：客户端为每个逻辑操作生成一个键，每次重试都带上；服务端把键和结果一起存下，遇到重复请求就回放存储的响应。Stripe 的 `Idempotency-Key` 请求头让这种做法流行开来，IETF HTTPAPI 工作组也在推进同名请求头的标准化。Stripe 关于幂等键的工程文章是服务端实现的好蓝本，包括为多步请求记录"恢复点"。

当副作用发生在你的数据库之外（外部 API）时，把你的消息 ID 作为**对方的**幂等键传过去，让去重发生在副作用真正发生的地方。

## "精确一次"到底意味着什么

Kafka 在 0.11 版本（KIP-98）引入了幂等生产者和事务，它们提供两件具体的东西：

- **幂等生产者**（`enable.idempotence=true`，新版客户端默认开启）：Broker 利用生产者 ID 和每个分区的序列号，对同一生产者会话的重试去重，网络重试不会在日志里产生重复。
- **事务**：生产者可以原子地写入多个分区**并**提交消费位点，因此 Kafka 内部的"消费—转换—生产"循环要么完整发生、要么完全不发生；使用 `isolation.level=read_committed` 的消费者看不到被中止的写入。Kafka Streams 的 `processing.guarantee=exactly_once_v2` 就建立在这之上。

它们**不能**把这种原子性延伸到你的 PostgreSQL、邮件服务商或支付 API。副作用一旦离开 Kafka，你就回到了"至少一次投递 + 幂等处理"。一个有用的心智模型：跨任意系统的**精确一次投递**是做不到的；**精确一次效果**则通过"至少一次投递 + 在副作用处去重"来实现。

## 组合起来：一个能扛住崩溃的下单流程

1. **订单服务**在一个本地事务里创建 `status = PENDING` 的订单，并写入一条 `OrderCreated` 发件箱记录（语义锁 + 发件箱）。
2. **Saga 编排器**（例如以 `order_id` 为键的 Temporal 工作流）推进各步骤：
   - `ReserveStock(order_id)`——可补偿，按 `order_id` 幂等；补偿为 `ReleaseStock`。
   - `ChargeCard(order_id)`——关键步骤；调用支付服务商时带上 `Idempotency-Key = order_id`。
   - `ConfirmOrder`、`RequestShipment`——可重试、幂等。
3. 每个服务通过自己的发件箱发布状态变更；下游消费者（邮件、分析）用收件箱表去重。
4. 卡被拒时触发 `ReleaseStock` 并把订单置为 `CANCELLED`；支付服务商超时时，向服务商查询支付状态（绝不盲目再扣一次）。
5. **对账**：每晚的任务比对订单、库存预留和支付服务商的结算报表。所有真实的支付系统都有对账，因为总会有某种故障组合绕过正常流程的逻辑。

## 选型指南

| 场景 | 推荐方案 |
|---|---|
| 所有数据都在一个数据库里 | 本地 ACID 事务。没必要拆的就别拆。 |
| 需要跨分片/跨地域 ACID，且存储由你掌控 | 使用替你运行复制化 2PC 的分布式 SQL 数据库（Spanner、CockroachDB、TiDB、YugabyteDB）。 |
| 两个自有资源、量小、操作短、支持 XA | XA/2PC 可以接受；密切监控不确定状态的事务。 |
| 写数据库 + 发事件 | 事务性发件箱（轮询或 CDC）+ 幂等消费者。永远如此。 |
| 跨多个服务的业务流程 | Saga；超过约 3 步或存在超时、分支时用编排；考虑持久化执行引擎。 |
| 资金或稀缺库存，用户不能看到超卖 | TCC 式预留，或带语义锁、仔细安排关键步骤的 Saga。 |
| 涉及外部 API | 端到端幂等键、超时后查询状态、对账。 |

## 常见错误

- 把超时当失败，并重试一个非幂等的调用（重复扣款）。
- 在副作用提交之前提交消费位点（丢消息）——或者只依赖位点来避免重复（做不到）。
- 补偿本身可能因业务原因失败，导致 Saga 卡在撤销到一半的状态。
- 发件箱中继并行运行却没有按聚合分区，然后奇怪为什么 `OrderCancelled` 比 `OrderCreated` 先到。
- 没有死信队列、没有卡住 Saga 的告警、没有对账任务——理论上"最终一致"，实际上永久不一致。

## 总结

分布式事务与其说是某个巧妙的协议，不如说是选择在哪里付出代价。2PC 用阻塞和耦合付费，当数据库用复制化的协调者替你付这笔账时，它非常好用。跨服务时，靠得住的工具箱是：只用本地事务；每个事件都走发件箱；至少一次投递；在每个副作用处保证幂等；用 Saga（最好是编排式、持久化的）处理多步流程；用显式补偿和语义锁弥补缺失的隔离性；最后用对账兜底。

## 参考资料

- J. Gray, L. Lamport. *Consensus on Transaction Commit*. ACM TODS, 2006.
- H. Garcia-Molina, K. Salem. *Sagas*. ACM SIGMOD, 1987.
- D. Peng, F. Dabek. *Large-scale Incremental Processing Using Distributed Transactions and Notifications*（Percolator）. OSDI 2010.
- J. C. Corbett 等. *Spanner: Google's Globally-Distributed Database*. OSDI 2012.
- P. Helland. *Life beyond Distributed Transactions: an Apostate's Opinion*. CIDR 2007.
- Chris Richardson, microservices.io：*Pattern: Saga* 与 *Pattern: Transactional outbox*。
- Debezium 文档：*Outbox Event Router*。
- Apache Kafka KIP-98：*Exactly Once Delivery and Transactional Messaging*。
- Stripe Engineering：*Designing robust and predictable APIs with idempotency*。
- PostgreSQL 文档：`PREPARE TRANSACTION` 与 `max_prepared_transactions`。
