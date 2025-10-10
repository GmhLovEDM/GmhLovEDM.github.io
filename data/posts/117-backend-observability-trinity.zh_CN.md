---
title: "后端可观测性：日志、链路追踪与指标监控三件套"
tag: architecture
description: 系统介绍后端可观测性的三大支柱：日志、链路追踪与指标监控，以及如何构建统一的可观测性平台
date: "2025-10-10T10:00:00.000Z"
---

## 目标

后端系统的复杂度不断增加，微服务架构下一次请求可能经过十几个服务。当系统出现问题时，如何快速定位？可观测性（Observability）是答案——它包含三大支柱：日志（Logs）、链路追踪（Traces）和指标（Metrics）。本文将系统介绍这三者及其最佳实践。

## 背景

### 可观测性 vs 监控

| 维度 | 监控（Monitoring） | 可观测性（Observability） |
|------|-------------------|--------------------------|
| 关注点 | 预定义的指标 | 系统内部状态的推断 |
| 问题类型 | 已知问题 | 未知问题 |
| 数据来源 | 固定的检查点 | 任意维度的查询 |
| 工具 | Nagios, Zabbix | Prometheus, Jaeger, ELK |

### 三大支柱的关系

```
┌─────────────────────────────────────────────────────────┐
│                   可观测性平台                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │    Logs     │  │   Traces    │  │   Metrics   │     │
│  │   日志      │  │   链路追踪   │  │   指标      │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         └────────────────┼────────────────┘             │
│              ┌───────────▼───────────┐                  │
│              │     Correlation      │                  │
│              │     (关联分析)        │                  │
│              └───────────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

## 日志（Logging）

### 结构化日志

```go
package logger

import (
    "os"
    "time"
    
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func NewLogger(serviceName string) *zap.Logger {
    config := zap.Config{
        Level:       zap.NewAtomicLevelAt(zap.InfoLevel),
        Development: false,
        Encoding:    "json",
        EncoderConfig: zapcore.EncoderConfig{
            TimeKey:        "timestamp",
            LevelKey:       "level",
            NameKey:        "logger",
            CallerKey:      "caller",
            MessageKey:     "message",
            StacktraceKey:  "stacktrace",
            LineEnding:     zapcore.DefaultLineEnding,
            EncodeLevel:    zapcore.LowercaseLevelEncoder,
            EncodeTime:     zapcore.ISO8601TimeEncoder,
            EncodeDuration: zapcore.MillisDurationEncoder,
            EncodeCaller:   zapcore.ShortCallerEncoder,
        },
        OutputPaths:      []string{"stdout"},
        ErrorOutputPaths: []string{"stderr"},
    }

    logger, _ := config.Build()
    return logger.With(zap.String("service", serviceName))
}

func main() {
    logger := NewLogger("user-service")
    
    logger.Info("User created",
        zap.String("user_id", "123"),
        zap.String("email", "user@example.com"),
        zap.Duration("duration", 150*time.Millisecond),
    )
    
    logger.Error("Failed to create user",
        zap.String("email", "user@example.com"),
        zap.Error(err),
        zap.String("trace_id", traceID),
    )
}
```

### 日志聚合（ELK Stack）

```yaml
# docker-compose.yml
version: '3.8'

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
    volumes:
      - esdata:/usr/share/elasticsearch/data

  logstash:
    image: docker.elastic.co/logstash/logstash:8.11.0
    volumes:
      - ./logstash.conf:/usr/share/logstash/pipeline/logstash.conf
    environment:
      - LS_JAVA_OPTS=-Xmx256m -Xms256m
    depends_on:
      - elasticsearch

  kibana:
    image: docker.elastic.co/kibana/kibana:8.11.0
    ports:
      - "5601:5601"
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
    depends_on:
      - elasticsearch

volumes:
  esdata:
```

```ruby
# logstash.conf
input {
  beats {
    port => 5044
  }
}

filter {
  json {
    source => "message"
    target => "parsed"
  }
  
  mutate {
    add_field => { "service" => "%{[parsed][service]}" }
    add_field => { "level" => "%{[parsed][level]}" }
  }
  
  date {
    match => [ "timestamp", "ISO8601" ]
    target => "@timestamp"
  }
}

output {
  elasticsearch {
    hosts => ["elasticsearch:9200"]
    index => "logs-%{+YYYY.MM.dd}"
  }
}
```

## 链路追踪（Tracing）

### OpenTelemetry 实现

```go
package tracing

import (
    "context"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/jaeger"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

func InitTracer(serviceName, jaegerEndpoint string) (func(), error) {
    exporter, err := jaeger.New(jaeger.WithCollectorEndpoint(
        jaeger.WithEndpoint(jaegerEndpoint),
    ))
    if err != nil {
        return nil, err
    }

    res, err := resource.New(context.Background(),
        resource.WithAttributes(
            semconv.ServiceNameKey.String(serviceName),
            semconv.ServiceVersionKey.String("1.0.0"),
        ),
    )
    if err != nil {
        return nil, err
    }

    tp := trace.NewTracerProvider(
        trace.WithBatcher(exporter),
        trace.WithResource(res),
        trace.WithSampler(trace.ParentBased(trace.TraceIDRatioBased(0.1))),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return func() { tp.Shutdown(context.Background()) }, nil
}

func CreateSpan(ctx context.Context, name string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
    tracer := otel.Tracer("my-service")
    return tracer.Start(ctx, name, trace.WithAttributes(attrs...))
}
```

### gRPC 拦截器

```go
package interceptor

import (
    "context"
    
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/codes"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

func TracingInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    md, _ := metadata.FromIncomingContext(ctx)
    carrier := metadataCarrier(md)
    
    ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)
    
    ctx, span := otel.Tracer("grpc-server").Start(
        ctx,
        info.FullMethod,
        trace.WithSpanKind(trace.SpanKindServer),
        trace.WithAttributes(
            attribute.String("rpc.system", "grpc"),
            attribute.String("rpc.method", info.FullMethod),
        ),
    )
    defer span.End()

    resp, err := handler(ctx, req)
    
    if err != nil {
        span.SetStatus(codes.Error, err.Error())
        span.RecordException(err)
    } else {
        span.SetStatus(codes.Ok, "")
    }

    return resp, err
}

type metadataCarrier metadata.MD

func (c metadataCarrier) Get(key string) string {
    values := metadata.MD(c).Get(key)
    if len(values) > 0 {
        return values[0]
    }
    return ""
}

func (c metadataCarrier) Set(key, value string) {
    metadata.MD(c).Set(key, value)
}

func (c metadataCarrier) Keys() []string {
    keys := make([]string, 0, len(c))
    for k := range c {
        keys = append(keys, k)
    }
    return keys
}
```

## 指标监控（Metrics）

### Prometheus 指标定义

```go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    httpRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    httpRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "Duration of HTTP requests",
            Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1, 5},
        },
        []string{"method", "path"},
    )

    ordersCreated = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "orders_created_total",
            Help: "Total number of orders created",
        },
        []string{"status"},
    )

    activeUsers = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "active_users",
            Help: "Number of active users",
        },
    )

    dbQueryDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "db_query_duration_seconds",
            Help:    "Duration of database queries",
            Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5},
        },
        []string{"operation", "table"},
    )
)

func MetricsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        
        wrapped := &statusRecorder{ResponseWriter: w, status: 200}
        
        next.ServeHTTP(wrapped, r)
        
        duration := time.Since(start).Seconds()
        
        httpRequestsTotal.WithLabelValues(
            r.Method,
            r.URL.Path,
            strconv.Itoa(wrapped.status),
        ).Inc()
        
        httpRequestDuration.WithLabelValues(
            r.Method,
            r.URL.Path,
        ).Observe(duration)
    })
}

type statusRecorder struct {
    http.ResponseWriter
    status int
}

func (r *statusRecorder) WriteHeader(code int) {
    r.status = code
    r.ResponseWriter.WriteHeader(code)
}
```

### Prometheus + Grafana

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'my-service'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: '/metrics'
  
  - job_name: 'nginx'
    static_configs:
      - targets: ['localhost:9113']
```

## 关联分析

### Trace 与 Log 关联

```go
func LogWithTrace(ctx context.Context, logger *zap.Logger, msg string, fields ...zap.Field) {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        fields = append(fields,
            zap.String("trace_id", span.SpanContext().TraceID().String()),
            zap.String("span_id", span.SpanContext().SpanID().String()),
        )
    }
    logger.Info(msg, fields...)
}
```

### Trace 与 Metrics 关联

```go
func RecordMetricWithTrace(ctx context.Context, metric prometheus.Observer, duration float64) {
    span := trace.SpanFromContext(ctx)
    if span.SpanContext().IsValid() {
        metric.(prometheus.ExemplarObserver).ObserveWithExemplar(
            duration,
            prometheus.Labels{
                "trace_id": span.SpanContext().TraceID().String(),
            },
        )
    }
}
```

## 总结

构建完整的后端可观测性体系：

1. **日志**：结构化日志 + ELK 集中管理，支持全文检索
2. **链路追踪**：OpenTelemetry + Jaeger，实现分布式追踪
3. **指标监控**：Prometheus + Grafana，实时监控系统健康
4. **关联分析**：将三者关联，实现端到端的问题定位

可观测性是现代后端系统的基础设施，它让你能够：
- 快速定位问题根因
- 了解系统运行状态
- 做出数据驱动的决策
- 持续优化系统性能