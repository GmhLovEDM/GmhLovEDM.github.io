---
title: "Automated Frontend Deployment: GitHub Actions + Docker in Practice"
tag: devops
description: 手把手教你使用 GitHub Actions 和 Docker 实现前端项目的自动化构建与部署。
date: "2022-12-05T08:00:00.000Z"
---

## Goal

Manually deploying frontend projects is time-consuming and error-prone. With GitHub Actions and Docker, you can build a fully automated CI/CD pipeline: push your code, and it automatically builds, tests, packages a Docker image, and deploys to your server. This article provides a complete, production-ready walkthrough.

## Background

### Why GitHub Actions + Docker

1. **GitHub Actions**:
   - Seamless integration with GitHub repositories.
   - Generous free tier (unlimited for public repositories).
   - Rich community-maintained Actions marketplace.
   - YAML-based configuration that is easy to read and maintain.

2. **Docker**:
   - Environment consistency: development, staging, and production look exactly the same.
   - Fast deployment: layer-based images enable incremental updates.
   - Easy rollbacks: previous image versions are preserved and can be redeployed instantly.
   - Resource isolation: containerized deployments do not interfere with each other.

### Overall Architecture

```
Code Push --> GitHub Actions Trigger --> Build & Test --> Build Docker Image --> Push to Registry --> Deploy to Server
```

The beauty of this pipeline is its simplicity and reliability. Every push follows the same deterministic path, eliminating "it works on my machine" problems and manual deployment mistakes.

## Project Structure

```
my-frontend-app/
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI pipeline
│       ├── deploy-staging.yml  # Staging deployment
│       └── deploy-prod.yml     # Production deployment
├── src/
├── public/
├── Dockerfile
├── docker-compose.yml
├── nginx.conf
├── package.json
└── vite.config.ts
```

## Writing the Dockerfile

### Multi-Stage Build

```dockerfile
# Dockerfile
# Stage 1: Build stage
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Stage 2: Production stage
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

Multi-stage builds are essential for frontend Docker images. The build stage needs Node.js and the full dependency tree, but the final image only needs Nginx and the static build output. This reduces the image size from hundreds of megabytes to tens of megabytes.

### Optimized Dockerfile

```dockerfile
# Dockerfile.optimized
# Stage 1: Install dependencies
FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Stage 2: Build stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Stage 3: Production stage
FROM nginx:1.24-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder --chown=appuser:appgroup /app/dist /usr/share/nginx/html

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

The optimized version adds two important improvements. First, it separates dependency installation into its own stage, which improves Docker layer caching -- if only source code changes, Docker reuses the cached dependency layer. Second, it runs Nginx as a non-root user, which is a critical security best practice. The `HEALTHCHECK` instruction tells Docker (and orchestrators like Kubernetes) how to determine if the container is healthy.

## Nginx Configuration

```nginx
# nginx.conf
server {
    listen 8080;
    server_name localhost;

    root /usr/share/nginx/html;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json
               application/javascript application/xml+rss application/atom+xml
               image/svg+xml;

    # Static asset caching (long TTL)
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # HTML files: no caching (always fetch the latest)
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # SPA routing support
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy (adjust based on your backend)
    location /api/ {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check endpoint
    location /health {
        access_log off;
        return 200 'OK';
        add_header Content-Type text/plain;
    }
}
```

Key configuration decisions here: static assets with content hashes in their filenames get a one-year cache with `immutable` headers, while HTML files are never cached so users always get the latest entry point. The `try_files` directive is essential for single-page applications, routing all paths to `index.html` so the client-side router can handle them.

## GitHub Actions Configuration

### CI Pipeline

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

The CI pipeline runs three jobs in sequence: lint and test run in parallel, then the build job waits for both to pass. This ensures that broken code never gets built into a deployable artifact. The `--frozen-lockfile` flag is critical -- it prevents `pnpm install` from modifying the lockfile, ensuring reproducible builds.

### Staging Deployment

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

The staging workflow triggers on pushes to the `develop` branch. It builds the Docker image with a `staging-{commit-sha}` tag plus `staging-latest`, pushes to Docker Hub, then SSHs into the staging server to pull and restart the container. The `cache-from` and `cache-to` options enable GitHub Actions cache for Docker layers, significantly speeding up subsequent builds.

### Production Deployment

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

Production deployment is triggered by pushing a version tag (e.g., `v1.0.0`). This workflow runs the full test suite before building, creates a semver-tagged Docker image, deploys to the production server, and automatically creates a GitHub Release. The `--remove-orphans` flag in `docker-compose up` cleans up any containers from previous versions.

## Docker Compose Configuration

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

Docker Compose makes it easy to manage the container lifecycle on the server. The `restart: unless-stopped` policy ensures the container restarts automatically after a server reboot. The health check enables Docker to monitor the application and restart it if Nginx becomes unresponsive. Resource limits prevent a misbehaving container from consuming all available resources.

## Secret Configuration

### GitHub Secrets

Configure these in your repository under Settings > Secrets and variables > Actions:

```
DOCKER_USERNAME        # Docker Hub username
DOCKER_PASSWORD        # Docker Hub password or Access Token
STAGING_HOST           # Staging server address
PRODUCTION_HOST        # Production server address
SSH_USERNAME           # SSH login username
SSH_PRIVATE_KEY        # SSH private key
STAGING_API_URL        # Staging API endpoint
PRODUCTION_API_URL     # Production API endpoint
CODECOV_TOKEN          # Codecov token for coverage reporting
```

Never commit secrets to your repository. GitHub Actions encrypts secret values and only exposes them during workflow runs, ensuring they are not leaked in logs or source code.

## Usage

### Local Development

```bash
# Start the dev server
pnpm dev

# Run tests
pnpm test

# Build a Docker image locally
docker build -t my-frontend-app .

# Run the container locally
docker run -p 8080:8080 my-frontend-app
```

### Triggering Deployments

```bash
# Staging: push to the develop branch
git push origin develop

# Production: create and push a version tag
git tag v1.0.0
git push origin v1.0.0
```

## Common Issues

### 1. Docker Build Failures

```dockerfile
# Problem: COPY fails because unwanted files are included
# Solution: ensure .dockerignore is correctly configured

# .dockerignore
node_modules
dist
.git
.github
*.md
.env*
```

A missing or incomplete `.dockerignore` file is the most common cause of Docker build failures. Without it, the `COPY . .` instruction copies `node_modules`, `.git`, and other large directories into the build context, which slows down the build and can cause conflicts.

### 2. GitHub Actions Timeout

```yaml
# Increase the timeout for longer builds
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
```

The default GitHub Actions timeout is 6 minutes per job. For projects with large dependency trees or extensive test suites, this may not be enough. Setting an explicit timeout prevents unexpected job termination.

### 3. Image Pull Failures

```yaml
# Configure a mirror registry on your server
# Add to /etc/docker/daemon.json on the deployment server
{
  "registry-mirrors": ["https://mirror.ccs.tencentyun.com"]
}
```

If your deployment server is in a region where Docker Hub access is slow or unreliable, configuring a mirror registry can dramatically speed up image pulls and reduce deployment failures.

## Summary

With GitHub Actions and Docker, you can achieve a complete automated deployment pipeline:

1. **Code push**: Automatically triggers the CI pipeline.
2. **Quality checks**: Lint, tests, and type checks run automatically.
3. **Build**: Docker image is built with multi-stage optimization.
4. **Push**: Image is pushed to the container registry.
5. **Deploy**: Server pulls and runs the new image automatically.
6. **Release**: GitHub Release is created for version tracking.

This setup significantly improves team development velocity, eliminates human error in deployment, and ensures consistency and traceability across every release.
