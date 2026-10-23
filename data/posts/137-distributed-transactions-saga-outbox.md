---
title: "Distributed Transactions in Practice: 2PC, Sagas, TCC, the Transactional Outbox, and Idempotency"
tag: architecture
description: Why a single ACID transaction stops working once data spans services, how two-phase commit and Percolator-style protocols really behave under failure, the Saga pattern (orchestration vs choreography, compensations, semantic locks), TCC, the dual-write problem and the transactional outbox with CDC, idempotent consumers and the inbox pattern, what Kafka "exactly-once" actually guarantees, and a decision guide for real systems
date: "2026-10-23T12:20:00.000Z"
---

## Goal

Inside one relational database, consistency is almost free: wrap the work in `BEGIN ... COMMIT` and the engine guarantees that either every row changes or none does. The moment an operation touches two databases, a database and a message broker, or two services owned by different teams, that guarantee disappears — and the bugs that follow are some of the most expensive in backend engineering: orders that were charged but never shipped, inventory reserved forever, events published for rows that were rolled back.

This article is a working map of the territory. It explains why the problem is hard, how the classic atomic-commit protocol (2PC) works and where it hurts, how modern distributed databases make it practical, and then spends most of its time on the patterns that service-oriented systems actually use: Sagas, TCC, the transactional outbox, and idempotent consumers. It ends with a decision guide.

## Why One Transaction Stops Being Enough

Consider a typical checkout:

1. Create an order in the Order service (its own PostgreSQL).
2. Reserve stock in the Inventory service (its own MySQL).
3. Charge the card via a payment provider (an external HTTP API).
4. Publish `OrderPlaced` to Kafka so that email, analytics and shipping react.

Each step is individually atomic. The sequence is not. Any process can crash between steps, any network call can time out *after* the remote side committed, and the payment provider will never join your database transaction. Three facts make this fundamentally hard:

- **You cannot distinguish "slow" from "dead".** A timeout tells you nothing about whether the remote operation happened. This is the practical face of the FLP impossibility result and the Two Generals problem.
- **Partial failure is the normal case.** In a single process, a crash takes everything down together; across services, one participant can fail while the others carry on.
- **Not every participant speaks transactions.** Brokers, SaaS APIs and caches generally cannot prepare, vote, or roll back on request.

There are two broad families of answers: make all participants commit atomically (**atomic commit**, e.g. 2PC), or accept that the steps commit independently and engineer the system to converge to a correct state (**Sagas, outbox, idempotency** — what Pat Helland called "life beyond distributed transactions").

## Two-Phase Commit

2PC introduces a **coordinator** and a set of **participants** (resource managers). It is the protocol behind XA, behind `PREPARE TRANSACTION` in PostgreSQL and `XA PREPARE` in MySQL, and — in a hardened form — inside most distributed SQL databases.

```
Coordinator                      Participant A        Participant B
    |---- PREPARE ------------------->|                    |
    |---- PREPARE ---------------------------------------->|
    |                      (write redo/undo, hold locks,   |
    |                       force log to disk, vote)       |
    |<--- YES ------------------------|                    |
    |<--- YES ---------------------------------------------|
 (force-write COMMIT decision to coordinator log)
    |---- COMMIT -------------------->|                    |
    |---- COMMIT ----------------------------------------->|
    |<--- ACK ------------------------|<--- ACK -----------|
```

The key property is that a participant that votes YES gives up its right to abort unilaterally. From that moment until it hears the decision it is **in doubt**: it must keep its locks, because it does not know whether the outcome is commit or abort.

### Where 2PC hurts

- **Blocking.** If the coordinator crashes after collecting votes but before (or while) sending the decision, prepared participants block — holding row locks — until the coordinator recovers. Participants cannot safely decide among themselves, because the coordinator may have already told someone "commit".
- **Latency.** At least two network round-trips plus several forced log writes (`fsync`) on the critical path, and locks are held for the whole duration.
- **Availability is the product of the parts.** Every participant must be up to commit anything; adding a participant lowers availability.
- **Operational pain.** Orphaned prepared transactions are a real-world incident type. PostgreSQL disables `PREPARE TRANSACTION` by default (`max_prepared_transactions = 0`) precisely because a forgotten prepared transaction holds locks and blocks vacuum indefinitely.

Three-phase commit (3PC) adds a pre-commit round to avoid blocking, but only under a synchronous network model with bounded delays; it is not safe under network partitions, so it is rarely used in practice.

### Making the coordinator fault-tolerant

The real fix for blocking is to stop having a single fragile coordinator. Gray and Lamport's *Consensus on Transaction Commit* (2006) shows that if the commit decision is itself stored with a consensus protocol (Paxos Commit), the coordinator's failure no longer blocks progress. This is what production distributed databases do in spirit:

- **Google Spanner** runs 2PC across Paxos groups; each participant and the coordinator are replicated state machines, so a "crash" is a leader failover, not a lost decision.
- **Percolator** (Peng and Dabek, OSDI 2010) and its descendant in **TiDB/TiKV** avoid a separate coordinator process altogether. One row in the transaction is designated the **primary lock**. Commit is: prewrite all rows with locks pointing to the primary, then commit the primary (the atomic commit point), then lazily commit secondaries. Any reader that finds a stale secondary lock checks the primary to decide whether to roll it forward or back. The decision lives in the data, replicated by Raft.
- **CockroachDB** uses a similar idea with a **transaction record** and write intents, and adds *parallel commits* to cut commit latency to roughly one round of consensus.

The lesson: 2PC is fine *inside* a system that controls every participant, replicates the decision, and runs on a fast network. It is a poor fit *across* independently deployed services, teams, and third-party APIs. That is where the next patterns come in.

## Sagas

The Saga pattern comes from Garcia-Molina and Salem's 1987 paper *Sagas*, written for long-lived database transactions. A saga is a sequence of local transactions T1, T2, …, Tn, each with a **compensating transaction** C1, …, Cn-1 that semantically undoes it. Either the whole sequence completes, or the saga runs compensations in reverse for the steps that completed: T1, T2, T3 fails → C2, C1.

Important consequences:

- **No isolation.** Intermediate states are visible. Another request can see "order created, stock reserved, not yet paid". This is the price of giving up global locks.
- **Compensation is semantic, not physical.** You cannot "un-send" an email or "un-charge" a card; you send a correction or issue a refund. Compensations must be designed per business action.
- **Compensations must not fail permanently.** They should be retryable and idempotent; if a compensation keeps failing, the saga needs a human or a dead-letter path.

### Orchestration vs choreography

**Choreography**: each service listens for events and emits its own. `OrderCreated` → Inventory reserves stock and emits `StockReserved` → Payment charges and emits `PaymentSucceeded` or `PaymentFailed` → Inventory listens for `PaymentFailed` and releases stock.

**Orchestration**: a saga orchestrator (a state machine) tells each participant what to do and reacts to replies.

| | Choreography | Orchestration |
|---|---|---|
| Coupling | Services know each other's events | Services know only the orchestrator's commands |
| Visibility of the flow | Spread across services; hard to see the whole | One place; easy to inspect and reason about |
| Adding a step | Touch several services | Change the orchestrator |
| Risk | Cyclic event dependencies, "event spaghetti" | Orchestrator becomes a god service if it absorbs business logic |
| Good fit | 2–3 steps, stable flow | Many steps, branching, timeouts, human tasks |

A minimal orchestrator in Go, persisting state after every transition so it can resume after a crash:

```go
type Step struct {
    Name       string
    Action     func(ctx context.Context, s *SagaState) error
    Compensate func(ctx context.Context, s *SagaState) error
}

type SagaState struct {
    ID        string
    OrderID   string
    Completed []string // names of steps whose Action committed
    Status    string   // RUNNING, COMPENSATING, DONE, FAILED
}

func Run(ctx context.Context, repo Repo, steps []Step, st *SagaState) error {
    for _, step := range steps[len(st.Completed):] {
        if err := retry(ctx, func() error { return step.Action(ctx, st) }); err != nil {
            if isBusinessFailure(err) { // e.g. card declined: do not retry, compensate
                return compensate(ctx, repo, steps, st)
            }
            return err // transient and out of retries: leave RUNNING, resume later
        }
        st.Completed = append(st.Completed, step.Name)
        if err := repo.Save(ctx, st); err != nil { // checkpoint
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
        // compensations retry until they succeed (with backoff + alerting)
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

Note what this sketch requires of every `Action` and `Compensate`: because the orchestrator may crash after a remote call succeeded but before the checkpoint, **every step will sometimes run twice**. Idempotency is not optional (more below). In production, rather than hand-rolling this loop, teams increasingly use durable-execution engines such as **Temporal** (or Cadence, AWS Step Functions), which persist the workflow's event history and replay it deterministically after a crash, so the "checkpoint after each step" plumbing disappears from application code.

### Ordering steps to reduce compensation pain

Chris Richardson's taxonomy (microservices.io) splits saga steps into:

- **Compensatable** steps, which can be undone (reserve stock → release stock).
- The **pivot** step, the go/no-go point after which the saga will not roll back (charge the card).
- **Retriable** steps after the pivot, which must eventually succeed (send confirmation, notify shipping).

Put cheap, easily reversible steps first, the hard-to-undo action as the pivot, and only guaranteed-to-succeed-with-retries steps after it.

### Living without isolation

Because sagas have no isolation, you get anomalies like lost updates and dirty reads at the business level. Common countermeasures:

- **Semantic lock**: mark the record with a pending state (`order.status = APPROVAL_PENDING`) so other flows know it is in flux and can refuse or wait.
- **Commutative updates**: design operations so order doesn't matter (credit/debit as appended ledger entries rather than overwriting a balance).
- **Re-read value / version check**: before the pivot, re-check that the data hasn't changed (optimistic concurrency with a version column).
- **Pessimistic view**: reorder steps so that the riskiest visible effect happens last.

## TCC: Try-Confirm-Cancel

TCC is a reservation-based variant popular in payments and e-commerce (and implemented by frameworks such as Apache Seata). Each participant exposes three operations:

- **Try**: check business rules and *reserve* resources (freeze 100 in the account, hold 1 unit of stock) without making them final.
- **Confirm**: turn the reservation into the real effect; must be idempotent and should not fail for business reasons.
- **Cancel**: release the reservation; must be idempotent.

TCC is effectively a 2PC implemented at the business layer: Try ≈ prepare, Confirm/Cancel ≈ commit/abort, but the "locks" are business-level reservations with explicit expiry rather than database row locks, so they do not block other work. It gives better isolation than a plain saga (others see "frozen" funds, not spent funds), at the cost of three APIs per operation and a reservation model in each service.

Three classic TCC pitfalls that implementations must handle:

1. **Empty cancel**: Cancel arrives for a Try that never executed (Try timed out in the network). Cancel must succeed as a no-op and record that it happened.
2. **Suspension (hanging)**: the delayed Try arrives *after* Cancel. Without a guard, it reserves resources that nobody will ever release. Fix: Try checks for a recorded cancel for the same transaction id and refuses.
3. **Idempotency**: Confirm and Cancel will be retried; each must be safe to apply twice.

All three are solved with a small per-participant table keyed by global transaction id and branch id, recording which phase has been executed.

## The Dual-Write Problem and the Transactional Outbox

Even a single service has a distributed transaction hiding in it the moment it writes to its database **and** publishes an event:

```python
# BROKEN: dual write
with db.transaction():
    db.insert("orders", order)
kafka.send("orders", OrderPlaced(order.id))   # crash here → event lost
```

Swapping the order doesn't help: publish first and a rollback leaves a ghost event for an order that does not exist. Publishing inside the transaction doesn't help either: the broker send isn't rolled back if the commit fails.

The **transactional outbox** removes the second write from the critical path. The service writes the event to an `outbox` table *in the same local transaction* as the business data; a separate relay later publishes it.

```sql
CREATE TABLE outbox (
    id             UUID PRIMARY KEY,
    aggregate_type TEXT        NOT NULL,   -- e.g. 'order'
    aggregate_id   TEXT        NOT NULL,   -- used as the message key → per-entity ordering
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
# both rows commit atomically, or neither does
```

There are two ways to move rows from the outbox to the broker:

**1. Polling publisher.** A worker repeatedly selects unpublished rows, publishes them, and marks or deletes them. With PostgreSQL, multiple workers can share the load safely using row locks that skip each other:

```sql
SELECT id, aggregate_id, event_type, payload
FROM outbox
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

Simple, works with any database, but adds polling load and latency, and parallel workers can reorder events unless you partition by aggregate.

**2. Change data capture (log tailing).** A CDC tool reads the database's replication log (PostgreSQL logical decoding / WAL, MySQL binlog) and turns each inserted outbox row into a message. **Debezium** ships an *Outbox Event Router* transformation that routes rows by `aggregate_type` to topics and uses `aggregate_id` as the Kafka key. Benefits: no polling queries, commit-order delivery, very low latency. Costs: you now operate Kafka Connect and Debezium, and you must manage replication slots (an abandoned PostgreSQL slot retains WAL and can fill the disk).

Either way, the outbox gives **at-least-once** delivery: the relay can crash after publishing but before recording progress, and the event goes out again. Which brings us to the other half of the pattern.

### Why not just use CDC on the business tables?

You can, but then your internal schema becomes your public event contract: renaming a column breaks consumers. The outbox lets you publish deliberate, versioned domain events while keeping tables private. Event sourcing is the extreme version, where the event log *is* the source of truth and there is no dual write at all.

## Idempotent Consumers and the Inbox Pattern

Every reliable messaging setup worth using is at-least-once, so consumers must tolerate duplicates. The robust approach is to record processed message ids **in the same transaction** as the side effect:

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
            return  # duplicate: already applied
        create_shipment(msg.payload)  # same DB transaction
    consumer.commit_offset(msg)       # after the DB commit
```

If the process crashes after the database commit but before the offset commit, the message is redelivered, the insert conflicts, and the handler skips it. This "inbox" table is also where you can enforce per-entity ordering (keep the last applied version per aggregate and ignore older ones).

Other idempotency techniques, from cheapest to most general:

- **Naturally idempotent operations**: `SET status = 'SHIPPED'` is idempotent; `balance = balance - 100` is not.
- **Conditional updates with versions**: `UPDATE ... SET status='PAID', version=version+1 WHERE id=? AND version=?`.
- **Unique constraints on business keys**: one payment per `order_id`.
- **Idempotency keys on APIs**: the client generates a key per logical operation and sends it on every retry; the server stores the key with the result and replays the stored response for duplicates. Stripe's API popularised this with the `Idempotency-Key` header, and the IETF HTTPAPI working group is standardising the same header. Stripe's engineering write-up on idempotency keys is a good blueprint for the server side, including recording "recovery points" for multi-step requests.

When the side effect is outside your database (an external API), pass your message id through as *their* idempotency key so the dedup happens where the effect happens.

## What "Exactly-Once" Really Means

Kafka added idempotent producers and transactions in version 0.11 (KIP-98). They provide two concrete things:

- **Idempotent producer** (`enable.idempotence=true`, default in recent clients): the broker deduplicates retries from the same producer session using a producer id and per-partition sequence numbers, so network retries don't create duplicates in the log.
- **Transactions**: a producer can atomically write to several partitions *and* commit consumer offsets, so a consume-transform-produce loop inside Kafka either fully happens or not at all; consumers with `isolation.level=read_committed` never see aborted writes. Kafka Streams' `processing.guarantee=exactly_once_v2` is built on this.

What they do **not** do is extend that atomicity to your PostgreSQL, your email provider, or a payment API. Once a side effect leaves Kafka, you are back to at-least-once delivery plus idempotent processing. A useful mental model: *exactly-once delivery* across arbitrary systems is not achievable; *exactly-once effect* is achieved by at-least-once delivery combined with deduplication at the point of effect.

## Putting It Together: A Checkout That Survives Crashes

1. **Order service** creates the order with `status = PENDING` and an `OrderCreated` outbox row in one local transaction (semantic lock + outbox).
2. **Saga orchestrator** (e.g. a Temporal workflow keyed by `order_id`) drives the steps:
   - `ReserveStock(order_id)` — compensatable, idempotent on `order_id`; compensation `ReleaseStock`.
   - `ChargeCard(order_id)` — the pivot; calls the provider with `Idempotency-Key = order_id`.
   - `ConfirmOrder`, `RequestShipment` — retriable, idempotent.
3. Each service publishes its own state changes via its outbox; downstream consumers (email, analytics) dedupe with an inbox table.
4. A declined card triggers `ReleaseStock` and `order.status = CANCELLED`; a provider timeout triggers a status query to the provider (never a blind second charge).
5. **Reconciliation**: a nightly job compares orders, reservations, and the provider's settlement report. Every real payments system has one, because some failure combination will always slip past the happy-path logic.

## Decision Guide

| Situation | Recommended approach |
|---|---|
| All data in one database | A local ACID transaction. Don't split what doesn't need splitting. |
| Need cross-shard/cross-region ACID, you control the storage | A distributed SQL database (Spanner, CockroachDB, TiDB, YugabyteDB) that runs replicated 2PC for you. |
| Two resources you own, low volume, short operations, XA supported | XA/2PC can be acceptable; monitor in-doubt transactions closely. |
| Write to DB + publish an event | Transactional outbox (polling or CDC) + idempotent consumers. Always. |
| Multi-service business process | Saga; orchestration once there are more than ~3 steps or any timeouts/branches; consider a durable-execution engine. |
| Money or scarce inventory where users must not see over-commitment | TCC-style reservations, or a saga with semantic locks and the pivot placed carefully. |
| External APIs involved | Idempotency keys end to end, status queries on timeout, reconciliation. |

## Common Mistakes

- Treating a timeout as a failure and retrying a non-idempotent call (double charges).
- Committing the consumer offset before the side effect commits (lost messages) — or relying only on offsets to avoid duplicates (they won't).
- Compensations that can themselves fail for business reasons, leaving sagas stuck half-undone.
- Using parallel outbox relays without per-aggregate partitioning, then wondering why `OrderCancelled` arrives before `OrderCreated`.
- No dead-letter queue, no alerting on stuck sagas, no reconciliation job — the system is "eventually consistent" in theory and permanently inconsistent in practice.

## Summary

Distributed transactions are less about one clever protocol and more about choosing where you pay. 2PC pays with blocking and coupling, and is excellent when a database with a replicated coordinator pays it for you. Across services, the dependable toolkit is: local transactions only, an outbox for every event, at-least-once delivery, idempotency at every point of effect, sagas (ideally orchestrated and durable) for multi-step processes, explicit compensations and semantic locks for the missing isolation, and reconciliation as the final safety net.

## References

- J. Gray, L. Lamport. *Consensus on Transaction Commit*. ACM TODS, 2006.
- H. Garcia-Molina, K. Salem. *Sagas*. ACM SIGMOD, 1987.
- D. Peng, F. Dabek. *Large-scale Incremental Processing Using Distributed Transactions and Notifications* (Percolator). OSDI 2010.
- J. C. Corbett et al. *Spanner: Google's Globally-Distributed Database*. OSDI 2012.
- P. Helland. *Life beyond Distributed Transactions: an Apostate's Opinion*. CIDR 2007.
- Chris Richardson, microservices.io: *Pattern: Saga* and *Pattern: Transactional outbox*.
- Debezium documentation: *Outbox Event Router*.
- Apache Kafka KIP-98: *Exactly Once Delivery and Transactional Messaging*.
- Stripe Engineering: *Designing robust and predictable APIs with idempotency*.
- PostgreSQL documentation: `PREPARE TRANSACTION` and `max_prepared_transactions`.
