---
title: "Kubernetes 入门：K8s 核心概念与基础操作"
tag: devops
description: 系统介绍 Kubernetes 的核心概念、架构设计和基础操作，帮助开发者快速上手容器编排。
date: "2024-09-18T08:00:00.000Z"
---

## 目标

本文旨在帮助开发者理解 Kubernetes 的核心概念和架构设计，掌握基础的部署、扩展和管理操作，为在生产环境使用 Kubernetes 打下基础。

## 背景

随着容器化技术的普及，如何管理和编排大量容器成为新的挑战。Kubernetes（简称 K8s）是 Google 开源的容器编排平台，已经成为云原生应用的事实标准。

### 为什么需要 Kubernetes？

1. **容器管理**：自动部署、扩展和管理容器化应用
2. **服务发现**：自动发现和负载均衡
3. **自愈能力**：自动重启失败的容器
4. **滚动更新**：零停机部署
5. **资源调度**：高效利用集群资源

### Kubernetes 的诞生

Kubernetes 源于 Google 内部的 Borg 系统。Google 使用容器技术已经超过 15 年，Kubernetes 将其最佳实践开源，让所有企业都能受益。

## 一、Kubernetes 架构

### 控制平面（Control Plane）

```
┌─────────────────────────────────────────────────────────┐
│                   Control Plane                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │    API      │  │   etcd      │  │ Scheduler   │     │
│  │   Server    │  │  (存储)     │  │  (调度器)   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐                      │
│  │ Controller  │  │  Cloud      │                      │
│  │  Manager    │  │ Controller  │                      │
│  └─────────────┘  └─────────────┘                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- **API Server**：集群的入口，所有操作都通过 API Server
- **etcd**：分布式键值存储，保存集群状态
- **Scheduler**：决定 Pod 运行在哪个节点
- **Controller Manager**：维护集群状态

### 工作节点（Worker Node）

```
┌─────────────────────────────────────────────────────────┐
│                    Worker Node                           │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   kubelet   │  │   kube-     │  │  Container  │     │
│  │             │  │   proxy     │  │   Runtime   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │                  Pods                            │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │   │
│  │  │  Pod    │  │  Pod    │  │  Pod    │          │   │
│  │  └─────────┘  └─────────┘  └─────────┘          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- **kubelet**：节点代理，管理 Pod 的生命周期
- **kube-proxy**：网络代理，实现服务发现和负载均衡
- **Container Runtime**：运行容器（Docker、containerd 等）

## 二、核心概念

### Pod

Pod 是 Kubernetes 最小的部署单元，包含一个或多个容器：

```yaml
# pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
  labels:
    app: my-app
spec:
  containers:
  - name: app
    image: nginx:1.20
    ports:
    - containerPort: 80
    resources:
      requests:
        memory: "64Mi"
        cpu: "250m"
      limits:
        memory: "128Mi"
        cpu: "500m"
```

### Deployment

Deployment 管理 Pod 的副本和更新策略：

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: app
        image: nginx:1.20
        ports:
        - containerPort: 80
```

### Service

Service 为 Pod 提供稳定的网络访问：

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app-service
spec:
  selector:
    app: my-app
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
  type: LoadBalancer
```

### Ingress

Ingress 管理外部访问集群的服务：

```yaml
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: my-app-service
            port:
              number: 80
```

## 三、kubectl 基础命令

### 集群操作

```bash
# 查看集群信息
kubectl cluster-info

# 查看节点
kubectl get nodes

# 查看所有命名空间
kubectl get namespaces
```

### Pod 操作

```bash
# 查看 Pod
kubectl get pods
kubectl get pods -o wide  # 更详细信息

# 查看 Pod 详情
kubectl describe pod <pod-name>

# 查看 Pod 日志
kubectl logs <pod-name>
kubectl logs -f <pod-name>  # 实时日志

# 进入 Pod
kubectl exec -it <pod-name> -- /bin/bash

# 删除 Pod
kubectl delete pod <pod-name>
```

### Deployment 操作

```bash
# 创建 Deployment
kubectl apply -f deployment.yaml

# 查看 Deployment
kubectl get deployments

# 扩展副本
kubectl scale deployment my-app --replicas=5

# 更新镜像
kubectl set image deployment/my-app app=nginx:1.21

# 回滚
kubectl rollout undo deployment/my-app
kubectl rollout history deployment/my-app
```

### Service 操作

```bash
# 创建 Service
kubectl apply -f service.yaml

# 查看 Service
kubectl get services

# 查看 Endpoints
kubectl get endpoints
```

## 四、配置管理

### ConfigMap

```yaml
# configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-app-config
data:
  DATABASE_URL: "mongodb://mongo:27017/mydb"
  API_KEY: "my-api-key"
  config.json: |
    {
      "debug": true,
      "logLevel": "info"
    }
```

```bash
# 创建 ConfigMap
kubectl create configmap my-app-config \
  --from-literal=DATABASE_URL=mongodb://mongo:27017/mydb \
  --from-file=config.json

# 使用 ConfigMap
kubectl apply -f configmap.yaml
```

### Secret

```yaml
# secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-app-secret
type: Opaque
data:
  username: YWRtaW4=  # base64 编码
  password: cGFzc3dvcmQ=
```

```bash
# 创建 Secret
kubectl create secret generic my-app-secret \
  --from-literal=username=admin \
  --from-literal=password=password

# 查看 Secret
kubectl get secret my-app-secret -o yaml
```

## 五、存储管理

### PersistentVolume (PV)

```yaml
# pv.yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: my-pv
spec:
  capacity:
    storage: 10Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: standard
  hostPath:
    path: /mnt/data
```

### PersistentVolumeClaim (PVC)

```yaml
# pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  storageClassName: standard
```

### 在 Pod 中使用

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  containers:
  - name: app
    image: nginx
    volumeMounts:
    - mountPath: /usr/share/nginx/html
      name: my-storage
  volumes:
  - name: my-storage
    persistentVolumeClaim:
      claimName: my-pvc
```

## 六、实战：部署 Node.js 应用

### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

### Kubernetes 配置

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-app
  labels:
    app: node-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: node-app
  template:
    metadata:
      labels:
        app: node-app
    spec:
      containers:
      - name: node-app
        image: your-registry/node-app:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: DATABASE_URL
          valueFrom:
            configMapKeyRef:
              name: app-config
              key: DATABASE_URL
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: JWT_SECRET
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "250m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: node-app-service
spec:
  selector:
    app: node-app
  ports:
  - port: 80
    targetPort: 3000
  type: LoadBalancer
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: node-app-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: node-app-service
            port:
              number: 80
```

### 部署命令

```bash
# 构建镜像
docker build -t your-registry/node-app:latest .

# 推送镜像
docker push your-registry/node-app:latest

# 部署到 Kubernetes
kubectl apply -f k8s/

# 查看状态
kubectl get pods
kubectl get services
kubectl get ingress
```

## 七、监控和调试

### 查看资源使用

```bash
# 安装 Metrics Server
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 查看资源使用
kubectl top nodes
kubectl top pods
```

### 日志和调试

```bash
# 查看所有 Pod 日志
kubectl logs -l app=my-app --all-containers

# 查看事件
kubectl get events --sort-by='.lastTimestamp'

# 调试 Pod
kubectl run debug --image=busybox --rm -it --restart=Never -- sh
```

## 总结

| 概念 | 作用 | 类比 |
|------|------|------|
| Pod | 最小部署单元 | 一个或多个容器的组合 |
| Deployment | 管理 Pod 副本 | 自动扩缩容的管理者 |
| Service | 网络访问入口 | 负载均衡器 |
| Ingress | 外部路由 | 反向代理 |
| ConfigMap/Secret | 配置管理 | 环境变量 |
| PV/PVC | 存储管理 | 网络硬盘 |

**姐姐的建议**：

1. **从单节点开始**：可以使用 Minikube 或 Docker Desktop 的 Kubernetes
2. **理解核心概念**：Pod、Deployment、Service 是最重要的三个概念
3. **使用 Helm**：Helm 是 Kubernetes 的包管理器，简化配置管理
4. **监控先行**：部署前先配置好监控和日志
5. **渐进式迁移**：不要一次性迁移所有服务

Kubernetes 学习曲线较陡，但一旦掌握，将极大提升你的运维能力。希望这篇入门指南能帮助宝宝们迈出第一步。
