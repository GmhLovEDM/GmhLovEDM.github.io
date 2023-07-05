---
title: "Docker Compose 实战：一键部署前后端 + 数据库"
tag: devops
description: 从零搭建 Docker Compose 编排方案，实现前端、后端、数据库的一键部署，涵盖开发与生产环境的差异化配置策略。
date: "2023-07-05T08:00:00.000Z"
---

## 目标

在实际项目中，前后端分离架构通常涉及多个服务：前端（Nginx 托管）、后端（Node.js/Go/Java）、数据库（MySQL/PostgreSQL/Redis）。手动部署不仅耗时，还容易因环境差异导致问题。本文旨在通过 Docker Compose 实现一键编排部署，让开发和生产环境的部署流程标准化、可重复。

## 背景

### 为什么需要容器化部署

传统的部署方式存在几个核心痛点：

- **环境不一致**："在我电脑上能跑"是经典问题，开发、测试、生产环境的依赖版本不统一
- **依赖管理复杂**：不同服务需要不同的运行时环境，互相干扰
- **部署流程手工化**：每次部署需要 SSH 到服务器，手动执行一系列命令
- **扩缩容困难**：流量高峰时无法快速增加实例

Docker 解决了环境一致性问题，Docker Compose 则解决了多服务编排问题。

### Docker Compose 的核心概念

Docker Compose 通过一个 YAML 文件定义多容器应用的架构：

```yaml
# 服务（Services）：每个容器是一个服务
# 网络（Networks）：服务间通信的桥梁
# 卷（Volumes）：持久化存储
# 依赖（Depends_on）：服务启动顺序
```

## 项目架构

假设我们的项目结构如下：

```
project/
├── frontend/          # React/Vue 前端
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── backend/           # Node.js/Go 后端
│   ├── Dockerfile
│   └── package.json
├── database/          # 数据库初始化脚本
│   └── init.sql
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env
```

## Dockerfile 编写

### 前端 Dockerfile（多阶段构建）

```dockerfile
# frontend/Dockerfile
# Stage 1: 构建
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build

# Stage 2: 生产镜像
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

```nginx
# frontend/nginx.conf
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # SPA 路由支持
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 代理
    location /api {
        proxy_pass http://backend:3000;
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
    gzip_types text/plain text/css application/json application/javascript text/xml;
}
```

### 后端 Dockerfile

```dockerfile
# backend/Dockerfile
FROM node:18-alpine
WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存
COPY package*.json ./
RUN npm ci --only=production --registry=https://registry.npmmirror.com

# 复制源码
COPY . .

# 非 root 用户运行
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
```

## Docker Compose 编排

### 开发环境配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  # 数据库
  db:
    image: mysql:8.0
    container_name: app-mysql
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:-root123}
      MYSQL_DATABASE: ${DB_NAME:-appdb}
      MYSQL_USER: ${DB_USER:-appuser}
      MYSQL_PASSWORD: ${DB_PASSWORD:-app123}
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./database/init.sql:/docker-entrypoint-initdb.d/init.sql
    networks:
      - app-network
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis 缓存
  redis:
    image: redis:7-alpine
    container_name: app-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    networks:
      - app-network
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD:-redis123}

  # 后端服务
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: app-backend
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DB_HOST=db
      - DB_PORT=3306
      - DB_NAME=${DB_NAME:-appdb}
      - DB_USER=${DB_USER:-appuser}
      - DB_PASSWORD=${DB_PASSWORD:-app123}
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - REDIS_PASSWORD=${REDIS_PASSWORD:-redis123}
    volumes:
      - ./backend:/app
      - /app/node_modules  # 排除 node_modules
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    networks:
      - app-network

  # 前端服务
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: app-frontend
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      - backend
    networks:
      - app-network

volumes:
  mysql_data:
  redis_data:

networks:
  app-network:
    driver: bridge
```

### 生产环境配置覆盖

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  db:
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ${DB_NAME}
      MYSQL_USER: ${DB_USER}
      MYSQL_PASSWORD: ${DB_PASSWORD}
    ports: []  # 生产环境不暴露数据库端口
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2'

  redis:
    ports: []
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
      target: production  # 多阶段构建的生产阶段
    ports: []
    environment:
      - NODE_ENV=production
    deploy:
      replicas: 2
      resources:
        limits:
          memory: 1G
          cpus: '1'
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  frontend:
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.prod.conf:/etc/nginx/conf.d/default.conf
      - ./ssl:/etc/nginx/ssl
    deploy:
      resources:
        limits:
          memory: 512M
```

### 环境变量配置

```bash
# .env
DB_ROOT_PASSWORD=your_strong_root_password
DB_NAME=appdb
DB_USER=appuser
DB_PASSWORD=your_strong_password
REDIS_PASSWORD=your_redis_password

# 后端配置
JWT_SECRET=your_jwt_secret
API_KEY=your_api_key
```

## 常用运维命令

### 启动与停止

```bash
# 启动所有服务（后台）
docker compose up -d

# 查看服务状态
docker compose ps

# 查看实时日志
docker compose logs -f backend

# 重新构建并启动
docker compose up -d --build

# 停止并删除容器
docker compose down

# 停止并删除容器 + 数据卷（危险！会丢失数据）
docker compose down -v
```

### 数据库操作

```bash
# 进入 MySQL 容器
docker compose exec db mysql -u root -p

# 备份数据库
docker compose exec db mysqldump -u root -p appdb > backup.sql

# 恢复数据库
docker compose exec -T db mysql -u root -p appdb < backup.sql
```

### 健康检查与调试

```bash
# 查看容器资源使用
docker stats

# 查看容器详细信息
docker inspect app-backend

# 进入容器调试
docker compose exec backend sh

# 检查网络连通性
docker compose exec backend ping db
```

## 性能优化技巧

### 1. 镜像层缓存

```dockerfile
# 优化前：每次都重新安装依赖
COPY . .
RUN npm ci

# 优化后：利用缓存，只在 package.json 变化时重新安装
COPY package*.json ./
RUN npm ci
COPY . .
```

### 2. 多阶段构建

```dockerfile
# 生产阶段只复制必要文件
FROM builder AS production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
```

### 3. 资源限制

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
    reservations:
      cpus: '1'
      memory: 1G
```

## 总结

Docker Compose 通过声明式的 YAML 配置，将多容器应用的部署变得标准化和可重复。关键要点：

1. **多阶段构建**减小生产镜像体积，提升安全性
2. **依赖健康检查**确保服务按正确顺序启动
3. **开发与生产分离**：dev 配置侧重开发体验（热重载），prod 配置侧重性能与稳定性
4. **环境变量管理**：敏感信息通过 `.env` 文件管理，不要硬编码到 YAML 中

掌握了 Docker Compose 编排，就掌握了现代应用部署的基本功。后续可以结合 CI/CD 流水线，实现代码提交后的自动构建和部署。
