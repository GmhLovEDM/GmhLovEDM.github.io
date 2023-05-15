---
title: "Introduction to Microservice Architecture: From Monolith to Service Decomposition"
tag: architecture
description: A deep understanding of the core concepts of microservice architecture and the evolution strategy from monolithic applications to microservices.
date: "2023-05-15T08:00:00.000Z"
---

## Goal

Microservice architecture has become the dominant architectural pattern in modern backend development. However, many teams adopt microservices without fully understanding the implications, leading to systems that are more complex rather than more manageable. This article explores the core concepts of microservice architecture, its applicable scenarios, and the correct strategy for evolving from a monolithic application to microservices.

## Background

### Pain Points of Monolithic Architecture

As the business grows, monolithic architecture faces the following issues:

1. **Long build times**: Large codebases make builds and deployments time-consuming.
2. **Accumulating technical debt**: Tight coupling makes refactoring difficult.
3. **Difficult scaling**: Independent scaling of specific modules is not possible.
4. **Challenging team collaboration**: Multiple teams modify the same codebase.
5. **Fault propagation**: A problem in one module can affect the entire system.

### How Microservices Solve These Problems

Microservice architecture splits a large application into multiple small, independent services:

- **Independent deployment**: Each service can be developed, tested, and deployed independently.
- **Technology heterogeneity**: Different services can use different technology stacks.
- **Fault isolation**: A failure in one service does not affect other services.
- **Independent scaling**: Specific services can be scaled independently based on demand.

## Core Concepts

### Service Decomposition Principles

```yaml
# Dimensions for service decomposition
By business domain:
  - User Service
  - Order Service
  - Product Service
  - Payment Service
  - Inventory Service

By technical capability:
  - Authentication Service
  - Cache Service
  - Search Service
  - File Service
```

### Inter-Service Communication

```yaml
# Synchronous communication
REST API:
  Pros: Simple, standardized
  Cons: Higher coupling

gRPC:
  Pros: High performance, strongly typed
  Cons: Steeper learning curve

# Asynchronous communication
Message queues (RabbitMQ/Kafka):
  Pros: Decoupled, smooths traffic spikes
  Cons: Increased complexity, harder to debug

Event-driven:
  Pros: Loosely coupled, scalable
  Cons: Eventual consistency, complex event sourcing
```

## Microservice Architecture Patterns

### API Gateway

```yaml
# API Gateway architecture
Client -> API Gateway -> Microservice cluster

# Responsibilities
- Request routing
- Authentication and authorization
- Rate limiting and circuit breaking
- Load balancing
- Protocol conversion
- Logging and monitoring
```

```python
# API Gateway example (Python + FastAPI)
from fastapi import FastAPI, HTTPException
import httpx

app = FastAPI()

# Service registry
services = {
    "users": "http://user-service:8001",
    "orders": "http://order-service:8002",
    "products": "http://product-service:8003"
}

@app.api_route("/{service}/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy(service: str, path: str, request: Request):
    if service not in services:
        raise HTTPException(status_code=404, detail="Service not found")
    
    url = f"{services[service]}/{path}"
    
    # Forward request
    async with httpx.AsyncClient() as client:
        response = await client.request(
            method=request.method,
            url=url,
            headers=dict(request.headers),
            content=await request.body()
        )
    
    return response.json()
```

### Service Discovery

```yaml
# Service discovery patterns
Client-side discovery:
  Client -> Service Registry -> Service instance

Server-side discovery:
  Client -> Load Balancer -> Service Registry -> Service instance

# Common tools
- Consul
- Eureka
- ZooKeeper
- Kubernetes Service
```

### Circuit Breaker Pattern

```python
# Circuit breaker implementation
import time
from enum import Enum

class CircuitState(Enum):
    CLOSED = "closed"      # Normal state
    OPEN = "open"          # Circuit broken
    HALF_OPEN = "half_open"  # Half-open state

class CircuitBreaker:
    def __init__(self, failure_threshold=5, reset_timeout=30):
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self.failure_count = 0
        self.last_failure_time = None
        self.state = CircuitState.CLOSED
    
    def call(self, func, *args, **kwargs):
        if self.state == CircuitState.OPEN:
            if time.time() - self.last_failure_time > self.reset_timeout:
                self.state = CircuitState.HALF_OPEN
            else:
                raise Exception("Circuit is open")
        
        try:
            result = func(*args, **kwargs)
            
            if self.state == CircuitState.HALF_OPEN:
                self.state = CircuitState.CLOSED
                self.failure_count = 0
            
            return result
        except Exception as e:
            self.failure_count += 1
            self.last_failure_time = time.time()
            
            if self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN
            
            raise e
```

## Service Decomposition Strategy

### Domain-Driven Design (DDD)

```yaml
# DDD strategic design
Bounded Context:
  - User context: User registration, login, permission management
  - Order context: Placing orders, payment, shipping
  - Product context: Product management, inventory, categories

# Context mapping
User context <-> Order context:
  User ID serves as a foreign key in the order
  
Order context <-> Product context:
  Product ID serves as a foreign key in order items
```

### Decomposition Steps

```yaml
Step 1: Identify core business domains
  - Analyze business processes
  - Identify domain boundaries
  - Define bounded contexts

Step 2: Identify subdomains
  - Core domain: Business core competencies
  - Supporting domain: Supports core business
  - Generic domain: Infrastructure services

Step 3: Decompose incrementally
  - Start with the generic domain (authentication, logging)
  - Then decompose the supporting domain (notifications, files)
  - Finally decompose the core domain (business logic)

Step 4: Establish communication mechanisms
  - Define API interfaces
  - Choose communication methods
  - Implement data consistency
```

## Data Consistency

### Eventual Consistency

```python
# Event-driven eventual consistency
class OrderService:
    def create_order(self, order_data):
        # 1. Create the order
        order = Order.create(order_data)
        
        # 2. Publish order created event
        event_bus.publish("order.created", {
            "order_id": order.id,
            "user_id": order.user_id,
            "items": order.items
        })
        
        return order

class InventoryService:
    def handle_order_created(self, event):
        # 3. Deduct inventory
        for item in event["items"]:
            inventory = Inventory.get(item["product_id"])
            inventory.quantity -= item["quantity"]
            inventory.save()
        
        # 4. Publish inventory deducted event
        event_bus.publish("inventory.deducted", {
            "order_id": event["order_id"]
        })
```

### Saga Pattern

```python
# Saga pattern for distributed transactions
class OrderSaga:
    def __init__(self):
        self.steps = []
        self.compensations = []
    
    def add_step(self, action, compensation):
        self.steps.append(action)
        self.compensations.append(compensation)
    
    def execute(self, context):
        completed_steps = []
        
        for i, step in enumerate(self.steps):
            try:
                step(context)
                completed_steps.append(i)
            except Exception as e:
                # Compensate already executed steps
                for j in reversed(completed_steps):
                    self.compensations[j](context)
                raise e
        
        return context

# Usage
saga = OrderSaga()
saga.add_step(
    action=lambda ctx: create_order(ctx),
    compensation=lambda ctx: cancel_order(ctx)
)
saga.add_step(
    action=lambda ctx: deduct_inventory(ctx),
    compensation=lambda ctx: restore_inventory(ctx)
)
saga.add_step(
    action=lambda ctx: process_payment(ctx),
    compensation=lambda ctx: refund_payment(ctx)
)

result = saga.execute(order_context)
```

## Containerized Deployment

### Docker Configuration

```dockerfile
# User service Dockerfile
FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

EXPOSE 8001

CMD ["python", "main.py"]
```

### Kubernetes Orchestration

```yaml
# User service K8s configuration
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: user-service
  template:
    metadata:
      labels:
        app: user-service
    spec:
      containers:
      - name: user-service
        image: user-service:latest
        ports:
        - containerPort: 8001
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: url
---
apiVersion: v1
kind: Service
metadata:
  name: user-service
spec:
  selector:
    app: user-service
  ports:
  - port: 8001
    targetPort: 8001
  type: ClusterIP
```

## Monitoring and Observability

```yaml
# Monitoring stack
Log collection:
  - ELK Stack (Elasticsearch + Logstash + Kibana)
  - Loki + Grafana

Metrics monitoring:
  - Prometheus + Grafana
  - Key metrics: QPS, latency, error rate, resource utilization

Distributed tracing:
  - Jaeger
  - Zipkin
  - OpenTelemetry

Alerting:
  - Alertmanager
  - PagerDuty
```

## When NOT to Use Microservices

```yaml
Scenarios where microservices are not appropriate:
  - Small team size (< 10 people)
  - Simple business logic
  - Immature technology stack
  - Lack of DevOps capabilities
  - Limited budget

Risks:
  - Increased operational complexity
  - Higher network latency
  - Data consistency challenges
  - Difficult debugging
  - Requires more infrastructure investment
```

## Summary

Microservice architecture is not a silver bullet and should be adopted carefully based on the team and business context:

1. **Do not adopt microservices for the sake of microservices.**
2. **Start with a monolith and evolve incrementally.**
3. **Prioritize solving business problems over technical ones.**
4. **Invest in infrastructure and automation.**
5. **Establish comprehensive monitoring and alerting systems.**

Only in the right scenarios can microservices truly leverage their advantages and help teams build scalable, maintainable systems.
