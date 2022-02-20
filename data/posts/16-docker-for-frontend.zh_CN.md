---
title: "Docker 从入门到实战：前端工程师也该会的容器化"
tag: devops
description: 面向前端工程师的 Docker 入门指南，从概念理解到实战部署，让你的应用实现一次构建、到处运行。
date: "2022-02-20T08:00:00.000Z"
---

## 目标

理解 Docker 的核心概念，掌握在前端项目中使用 Docker 的基本技能。

## 背景

### 为什么前端工程师需要学 Docker？

1. **环境一致性**：再也不用说"在我电脑上是好的"
2. **部署简单**：一条命令部署到任何服务器
3. **CI/CD 友好**：自动化构建和部署的基础
4. **微服务理解**：理解现代架构的基础

### Docker 是什么？

```
虚拟机 vs Docker：

虚拟机：
┌─────────────┐ ┌─────────────┐
│   App A     │ │   App B     │
├─────────────┤ ├─────────────┤
│   Guest OS  │ │   Guest OS  │
├─────────────┴─┴─────────────┤
│         Hypervisor          │
├─────────────────────────────┤
│         Host OS             │
└─────────────────────────────┘

Docker：
┌─────────────┐ ┌─────────────┐
│   App A     │ │   App B     │
├─────────────┤ ├─────────────┤
│   Bins/     │ │   Bins/     │
│   Libs      │ │   Libs      │
└─────────────┴─┴─────────────┘
│         Docker Engine       │
├─────────────────────────────┤
│         Host OS             │
└─────────────────────────────┘

Docker 容器共享宿主机内核，更轻量、启动更快
```

## 核心概念

### 1. 镜像（Image）

镜像是只读的模板，包含运行应用所需的一切：
- 代码
- 运行时环境
- 系统工具
- 库

### 2. 容器（Container）

容器是镜像的运行实例，可以被启动、停止、删除。

### 3. Dockerfile

Dockerfile 是构建镜像的配置文件。

### 4. 仓库（Registry）

Docker Hub 等仓库用于存储和分发镜像。

## 前端项目实战

### 1. 基础 Dockerfile

```dockerfile
# 使用 Node.js 官方镜像作为构建环境
FROM node:18-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制源代码
COPY . .

# 构建生产版本
RUN npm run build

# ---- 生产阶段 ----
# 使用 Nginx 镜像作为运行环境
FROM nginx:alpine

# 从构建阶段复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 复制 Nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 暴露端口
EXPOSE 80

# 启动 Nginx
CMD ["nginx", "-g", "daemon off;"]
```

### 2. Nginx 配置

```nginx
# nginx.conf
server {
    listen 80;
    server_name localhost;

    root /usr/share/nginx/html;
    index index.html;

    # 处理 Vue Router 的 history 模式
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 代理
    location /api {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # 静态资源缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip 压缩
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;
}
```

### 3. docker-compose.yml

```yaml
version: '3.8'

services:
  frontend:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:80"
    depends_on:
      - backend
    networks:
      - app-network

  backend:
    image: node:18-alpine
    working_dir: /app
    volumes:
      - ./backend:/app
    command: npm start
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://user:password@db:5432/mydb
    networks:
      - app-network

  db:
    image: postgres:14-alpine
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=mydb
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - app-network

networks:
  app-network:

volumes:
  postgres_data:
```

## 常用命令

### 构建和运行

```bash
# 构建镜像
docker build -t my-app .

# 运行容器
docker run -d -p 3000:80 my-app

# 查看运行中的容器
docker ps

# 查看日志
docker logs <container-id>

# 进入容器
docker exec -it <container-id> sh

# 停止容器
docker stop <container-id>

# 删除容器
docker rm <container-id>

# 删除镜像
docker rmi my-app
```

### Docker Compose

```bash
# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止所有服务
docker-compose down

# 重新构建
docker-compose up --build

# 查看服务状态
docker-compose ps
```

## 多阶段构建优化

### 1. 分离构建和运行环境

```dockerfile
# 阶段 1：构建
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 阶段 2：生产
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
```

**好处**：最终镜像只包含 Nginx 和构建产物，不包含 Node.js 和源代码。

### 2. 缓存优化

```dockerfile
# 好的顺序：先复制依赖文件，再复制源代码
COPY package*.json ./
RUN npm ci
COPY . .

# 不好的顺序：先复制所有文件，再安装依赖
COPY . .
RUN npm ci  # 任何文件变化都会导致重新安装依赖
```

## 生产环境最佳实践

### 1. 使用非 root 用户

```dockerfile
# 创建非 root 用户
RUN addgroup -g 1001 -S appgroup
RUN adduser -S appuser -u 1001

# 切换到非 root 用户
USER appuser

# 启动应用
CMD ["npm", "start"]
```

### 2. 健康检查

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/ || exit 1
```

### 3. 使用 .dockerignore

```
# .dockerignore
node_modules
.git
.env
.env.local
dist
build
*.md
.vscode
.idea
```

### 4. 镜像瘦身

```dockerfile
# 使用 Alpine 镜像
FROM node:18-alpine

# 清理 npm 缓存
RUN npm cache clean --force

# 使用多阶段构建
# 最终镜像不包含构建工具
```

## 实际案例：React 项目部署

### 项目结构

```
my-react-app/
├── src/
├── public/
├── package.json
├── Dockerfile
├── docker-compose.yml
├── nginx.conf
└── .dockerignore
```

### 完整流程

```bash
# 1. 构建并启动
docker-compose up --build -d

# 2. 访问应用
# http://localhost:3000

# 3. 查看日志
docker-compose logs -f frontend

# 4. 重新部署
docker-compose down
docker-compose up --build -d
```

### CI/CD 集成

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Build Docker image
        run: docker build -t my-app:${{ github.sha }} .

      - name: Push to registry
        run: |
          docker tag my-app:${{ github.sha }} registry.example.com/my-app:latest
          docker push registry.example.com/my-app:latest

      - name: Deploy to server
        run: |
          ssh user@server "docker pull registry.example.com/my-app:latest && \
                          docker-compose up -d"
```

## 常见问题

### Q：镜像太大怎么办？

A：
1. 使用 Alpine 镜像代替完整 Node.js 镜像
2. 使用多阶段构建
3. 添加 .dockerignore
4. 清理 npm 缓存

### Q：如何调试容器内的应用？

A：
```bash
# 进入容器
docker exec -it <container-id> sh

# 查看环境变量
env

# 查看文件系统
ls -la
```

### Q：如何持久化数据？

A：使用 Volume
```bash
# 命名卷
docker volume create mydata
docker run -v mydata:/app/data my-app

# 绑定挂载
docker run -v $(pwd)/data:/app/data my-app
```

## 总结

1. **Docker 解决了环境一致性问题**：一次构建，到处运行
2. **多阶段构建是关键**：分离构建环境和运行环境
3. **docker-compose 简化了多服务管理**：一键启动完整环境
4. **安全实践不可忽视**：非 root 用户、健康检查、镜像扫描
5. **CI/CD 集成是生产部署的基础**

Docker 不是银弹，但它确实让部署和运维变得更加简单可靠。作为前端工程师，掌握 Docker 是进入全栈领域的重要一步。
