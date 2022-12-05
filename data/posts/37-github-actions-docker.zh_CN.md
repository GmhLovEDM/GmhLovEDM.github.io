---
title: "前端部署自动化：GitHub Actions + Docker 实战"
tag: devops
description: 手把手教你使用 GitHub Actions 和 Docker 实现前端项目的自动化构建与部署。
date: "2022-12-05T08:00:00.000Z"
---

## 目标

手动部署前端项目既耗时又容易出错。通过 GitHub Actions 和 Docker，我们可以实现完全自动化的 CI/CD 流程：代码推送后自动构建、测试、打包 Docker 镜像并部署到服务器。本文将提供完整的实战指南。

## 背景

### 为什么选择 GitHub Actions + Docker

1. **GitHub Actions**：
   - 与 GitHub 无缝集成
   - 免费额度充足（公开项目无限制）
   - 丰富的社区 Actions
   - YAML 配置，易于维护

2. **Docker**：
   - 环境一致性：开发、测试、生产环境完全相同
   - 快速部署：镜像分层，增量更新
   - 易于回滚：保留历史版本镜像
   - 资源隔离：容器化部署互不影响

### 整体架构

```
代码推送 → GitHub Actions 触发 → 构建测试 → 构建 Docker 镜像 → 推送镜像仓库 → 部署到服务器
```

## 项目结构

```
my-frontend-app/
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI 流程
│       ├── deploy-staging.yml  # 测试环境部署
│       └── deploy-prod.yml     # 生产环境部署
├── src/
├── public/
├── Dockerfile
├── docker-compose.yml
├── nginx.conf
├── package.json
└── vite.config.ts
```

## Dockerfile 编写

### 多阶段构建

```dockerfile
# Dockerfile
# Stage 1: 构建阶段
FROM node:18-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

# 安装 pnpm 并安装依赖
RUN corepack enable && pnpm install --frozen-lockfile

# 复制源代码
COPY . .

# 构建应用
RUN pnpm build

# Stage 2: 生产阶段
FROM nginx:alpine

# 复制自定义 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html

# 暴露端口
EXPOSE 80

# 启动 nginx
CMD ["nginx", "-g", "daemon off;"]
```

### 优化的 Dockerfile

```dockerfile
# Dockerfile.optimized
# Stage 1: 依赖安装
FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Stage 2: 构建阶段
FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Stage 3: 生产阶段
FROM nginx:1.24-alpine AS production

# 安全配置：使用非 root 用户
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# 复制 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 复制构建产物并设置权限
COPY --from=builder --chown=appuser:appgroup /app/dist /usr/share/nginx/html

# 切换用户
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

## Nginx 配置

```nginx
# nginx.conf
server {
    listen 8080;
    server_name localhost;
    
    root /usr/share/nginx/html;
    index index.html;
    
    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json 
               application/javascript application/xml+rss application/atom+xml 
               image/svg+xml;
    
    # 静态资源缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
    
    # HTML 不缓存
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
    
    # SPA 路由支持
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # API 代理（根据实际情况调整）
    location /api/ {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # 健康检查
    location /health {
        access_log off;
        return 200 'OK';
        add_header Content-Type text/plain;
    }
}
```

## GitHub Actions 配置

### CI 流程

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Run lint
        run: pnpm lint
      
      - name: Run type check
        run: pnpm type-check

  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Run tests
        run: pnpm test:coverage
      
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          files: ./coverage/lcov.info

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Build
        run: pnpm build
        env:
          VITE_API_URL: ${{ secrets.VITE_API_URL }}
      
      - name: Upload build artifacts
        uses: actions/upload-artifact@v3
        with:
          name: dist
          path: dist/
          retention-days: 7
```

### 测试环境部署

```yaml
# .github/workflows/deploy-staging.yml
name: Deploy to Staging

on:
  push:
    branches: [develop]

jobs:
  deploy:
    name: Deploy Staging
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Build
        run: pnpm build
        env:
          VITE_API_URL: ${{ secrets.STAGING_API_URL }}
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
      
      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      
      - name: Generate image tag
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ secrets.DOCKER_USERNAME }}/my-frontend-app
          tags: |
            type=raw,value=staging-{{ sha }}
            type=raw,value=staging-latest
      
      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      - name: Deploy to server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: ${{ secrets.SSH_USERNAME }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/my-app
            docker-compose pull
            docker-compose up -d
            docker image prune -f
```

### 生产环境部署

```yaml
# .github/workflows/deploy-prod.yml
name: Deploy to Production

on:
  push:
    tags:
      - 'v*'

jobs:
  deploy:
    name: Deploy Production
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 8
      
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      
      - name: Run tests
        run: pnpm test
      
      - name: Build
        run: pnpm build
        env:
          VITE_API_URL: ${{ secrets.PRODUCTION_API_URL }}
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
      
      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}
      
      - name: Extract version from tag
        id: version
        run: echo "VERSION=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT
      
      - name: Generate image tag
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ secrets.DOCKER_USERNAME }}/my-frontend-app
          tags: |
            type=semver,pattern={{version}}
            type=raw,value=latest
      
      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      - name: Deploy to server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.PRODUCTION_HOST }}
          username: ${{ secrets.SSH_USERNAME }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            cd /opt/my-app
            docker-compose pull
            docker-compose up -d --remove-orphans
            docker image prune -f
            echo "Deployed version: ${{ steps.version.outputs.VERSION }}"
      
      - name: Create GitHub Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: ${{ github.ref }}
          release_name: Release ${{ steps.version.outputs.VERSION }}
          draft: false
          prerelease: false
```

## Docker Compose 配置

```yaml
# docker-compose.yml
version: '3.8'

services:
  frontend:
    build:
      context: .
      dockerfile: Dockerfile
    image: my-frontend-app:latest
    container_name: my-frontend-app
    ports:
      - "8080:8080"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    networks:
      - app-network
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M

networks:
  app-network:
    driver: bridge
```

## 密钥配置

### GitHub Secrets

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中添加：

```
DOCKER_USERNAME        # Docker Hub 用户名
DOCKER_PASSWORD        # Docker Hub 密码或 Access Token
STAGING_HOST           # 测试环境服务器地址
PRODUCTION_HOST        # 生产环境服务器地址
SSH_USERNAME           # SSH 登录用户名
SSH_PRIVATE_KEY        # SSH 私钥
STAGING_API_URL        # 测试环境 API 地址
PRODUCTION_API_URL     # 生产环境 API 地址
CODECOV_TOKEN          # Codecov Token
```

## 使用方式

### 本地开发

```bash
# 启动开发服务器
pnpm dev

# 运行测试
pnpm test

# 构建 Docker 镜像
docker build -t my-frontend-app .

# 本地运行容器
docker run -p 8080:8080 my-frontend-app
```

### 触发部署

```bash
# 测试环境：推送到 develop 分支
git push origin develop

# 生产环境：创建版本标签
git tag v1.0.0
git push origin v1.0.0
```

## 常见问题

### 1. Docker 构建失败

```dockerfile
# 问题：COPY 失败
# 解决：确保 .dockerignore 文件正确

# .dockerignore
node_modules
dist
.git
.github
*.md
.env*
```

### 2. GitHub Actions 超时

```yaml
# 增加超时时间
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
```

### 3. 镜像拉取失败

```yaml
# 配置镜像加速器
# 在服务器的 /etc/docker/daemon.json 中添加
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]
}
```

## 总结

通过 GitHub Actions + Docker，我们可以实现完整的自动化部署流程：

1. **代码推送**：自动触发 CI 流程
2. **质量检查**：自动运行 lint、测试、类型检查
3. **构建打包**：自动构建 Docker 镜像
4. **镜像推送**：自动推送到镜像仓库
5. **服务器部署**：自动部署到目标服务器
6. **版本管理**：自动创建 Release

这套方案能够显著提升团队的开发效率，减少人为错误，确保部署的一致性和可追溯性。
