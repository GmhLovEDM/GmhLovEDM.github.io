---
title: "Kubernetes Introduction: K8s Core Concepts and Basic Operations"
tag: devops
description: A systematic introduction to Kubernetes core concepts, architecture design, and basic operations to help developers quickly get started with container orchestration.
date: "2024-09-18T08:00:00.000Z"
---

## Goal

This article aims to help developers understand Kubernetes core concepts and architecture design, master basic deployment, scaling, and management operations, and build a foundation for using Kubernetes in production environments.

## Background

With the popularity of containerization technology, managing and orchestrating large numbers of containers has become a new challenge. Kubernetes (K8s) is Google's open-source container orchestration platform that has become the de facto standard for cloud-native applications.

### Why Do We Need Kubernetes?

1. **Container Management**: Automatically deploy, scale, and manage containerized applications
2. **Service Discovery**: Automatic discovery and load balancing
3. **Self-healing**: Automatically restart failed containers
4. **Rolling Updates**: Zero-downtime deployment
5. **Resource Scheduling**: Efficient cluster resource utilization

### Kubernetes Origins

Kubernetes originated from Google's internal Borg system. Google has been using container technology for over 15 years, and Kubernetes open-sourced its best practices so all enterprises can benefit.

## 1. Kubernetes Architecture

### Control Plane

```
+-----------------------------------------------------------+
|                    Control Plane                            |
+-----------------------------------------------------------+
|                                                             |
|  +----------------+  +----------------+  +----------------+  |
|  |      API       |  |      etcd      |  |   Scheduler    |  |
|  |     Server     |  |    (Storage)   |  |  (Scheduling)  |  |
|  +----------------+  +----------------+  +----------------+  |
|                                                             |
|  +----------------+  +----------------+                      |
|  |   Controller   |  |     Cloud      |                      |
|  |    Manager     |  |   Controller   |                      |
|  +----------------+  +----------------+                      |
|                                                             |
+-----------------------------------------------------------+
```

- **API Server**: Cluster entry point; all operations go through the API Server
- **etcd**: Distributed key-value store that saves cluster state
- **Scheduler**: Decides which node a Pod runs on
- **Controller Manager**: Maintains cluster state

### Worker Node

```
+-----------------------------------------------------------+
|                    Worker Node                              |
+-----------------------------------------------------------+
|                                                             |
|  +----------------+  +----------------+  +----------------+  |
|  |    kubelet     |  |    kube-       |  |   Container    |  |
|  |                |  |    proxy       |  |    Runtime     |  |
|  +----------------+  +----------------+  +----------------+  |
|                                                             |
|  +-----------------------------------------------------+   |
|  |                      Pods                            |   |
|  |  +----------+  +----------+  +----------+            |   |
|  |  |   Pod    |  |   Pod    |  |   Pod    |            |   |
|  |  +----------+  +----------+  +----------+            |   |
|  +-----------------------------------------------------+   |
|                                                             |
+-----------------------------------------------------------+
```

- **kubelet**: Node agent that manages Pod lifecycle
- **kube-proxy**: Network proxy that implements service discovery and load balancing
- **Container Runtime**: Runs containers (Docker, containerd, etc.)

## 2. Core Concepts

### Pod

Pod is the smallest deployable unit in Kubernetes, containing one or more containers:

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

Deployment manages Pod replicas and update strategies:

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

Service provides stable network access for Pods:

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

Ingress manages external access to cluster services:

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

## 3. kubectl Basic Commands

### Cluster Operations

```bash
# View cluster information
kubectl cluster-info

# View nodes
kubectl get nodes

# View all namespaces
kubectl get namespaces
```

### Pod Operations

```bash
# View Pods
kubectl get pods
kubectl get pods -o wide  # More detailed information

# View Pod details
kubectl describe pod <pod-name>

# View Pod logs
kubectl logs <pod-name>
kubectl logs -f <pod-name>  # Real-time logs

# Enter Pod
kubectl exec -it <pod-name> -- /bin/bash

# Delete Pod
kubectl delete pod <pod-name>
```

### Deployment Operations

```bash
# Create Deployment
kubectl apply -f deployment.yaml

# View Deployment
kubectl get deployments

# Scale replicas
kubectl scale deployment my-app --replicas=5

# Update image
kubectl set image deployment/my-app app=nginx:1.21

# Rollback
kubectl rollout undo deployment/my-app
kubectl rollout history deployment/my-app
```

### Service Operations

```bash
# Create Service
kubectl apply -f service.yaml

# View Service
kubectl get services

# View Endpoints
kubectl get endpoints
```

## 4. Configuration Management

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
# Create ConfigMap
kubectl create configmap my-app-config \
  --from-literal=DATABASE_URL=mongodb://mongo:27017/mydb \
  --from-file=config.json

# Use ConfigMap
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
  username: YWRtaW4=  # base64 encoded
  password: cGFzc3dvcmQ=
```

```bash
# Create Secret
kubectl create secret generic my-app-secret \
  --from-literal=username=admin \
  --from-literal=password=password

# View Secret
kubectl get secret my-app-secret -o yaml
```

## 5. Storage Management

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

### Using in Pod

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

## 6. Practical Example: Deploying a Node.js Application

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

### Kubernetes Configuration

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

### Deployment Commands

```bash
# Build image
docker build -t your-registry/node-app:latest .

# Push image
docker push your-registry/node-app:latest

# Deploy to Kubernetes
kubectl apply -f k8s/

# Check status
kubectl get pods
kubectl get services
kubectl get ingress
```

## 7. Monitoring and Debugging

### View Resource Usage

```bash
# Install Metrics Server
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# View resource usage
kubectl top nodes
kubectl top pods
```

### Logs and Debugging

```bash
# View all Pod logs
kubectl logs -l app=my-app --all-containers

# View events
kubectl get events --sort-by='.lastTimestamp'

# Debug Pod
kubectl run debug --image=busybox --rm -it --restart=Never -- sh
```

## Summary

| Concept | Function | Analogy |
|---------|----------|---------|
| Pod | Smallest deployable unit | A combination of one or more containers |
| Deployment | Manages Pod replicas | Auto-scaling manager |
| Service | Network access entry point | Load balancer |
| Ingress | External routing | Reverse proxy |
| ConfigMap/Secret | Configuration management | Environment variables |
| PV/PVC | Storage management | Network hard drive |

**Recommendations**:

1. **Start with Single Node**: Use Minikube or Docker Desktop's Kubernetes
2. **Understand Core Concepts**: Pod, Deployment, and Service are the three most important concepts
3. **Use Helm**: Helm is Kubernetes' package manager that simplifies configuration management
4. **Monitoring First**: Configure monitoring and logging before deployment
5. **Gradual Migration**: Don't migrate all services at once

Kubernetes has a steep learning curve, but once mastered, it will greatly enhance your operational capabilities. This introductory guide will help you take the first step.
