---
title: "Docker from Beginner to Practice: Containerization Every Frontend Engineer Should Know"
tag: devops
description: A Docker beginner's guide for frontend engineers, from understanding concepts to practical deployment, enabling your application to build once and run anywhere.
date: "2022-02-20T08:00:00.000Z"
---

## Goal

Understand Docker's core concepts and master the basic skills of using Docker in frontend projects.

## Background

### Why Should Frontend Engineers Learn Docker?

1. **Environment consistency**: No more saying "it works on my machine"
2. **Simple deployment**: Deploy to any server with one command
3. **CI/CD friendly**: Foundation for automated builds and deployments
4. **Microservices understanding**: Foundation for understanding modern architecture

### What is Docker?

```
Virtual Machine vs Docker:

Virtual Machine:
┌─────────────┐ ┌─────────────┐
│   App A     │ │   App B     │
├─────────────┤ ├─────────────┤
│   Guest OS  │ │   Guest OS  │
├─────────────┴─┴─────────────┤
│         Hypervisor          │
├─────────────────────────────┤
│         Host OS             │
└─────────────────────────────┘

Docker:
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

Docker containers share the host kernel, making them lighter and faster to start
```

## Core Concepts

### 1. Image

An image is a read-only template containing everything needed to run an application:
- Code
- Runtime environment
- System tools
- Libraries

### 2. Container

A container is a running instance of an image that can be started, stopped, and deleted.

### 3. Dockerfile

A Dockerfile is a configuration file for building images.

### 4. Registry

Registries like Docker Hub are used for storing and distributing images.

## Frontend Project Practice

### 1. Basic Dockerfile

```dockerfile
# Use Node.js official image as build environment
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build production version
RUN npm run build

# ---- Production stage ----
# Use Nginx image as runtime environment
FROM nginx:alpine

# Copy build artifacts from build stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start Nginx
CMD ["nginx", "-g", "daemon off;"]
```

### 2. Nginx Configuration

```nginx
# nginx.conf
server {
    listen 80;
    server_name localhost;

    root /usr/share/nginx/html;
    index index.html;

    # Handle Vue Router history mode
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api {
        proxy_pass http://backend:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Static resource caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip compression
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

## Common Commands

### Build and Run

```bash
# Build image
docker build -t my-app .

# Run container
docker run -d -p 3000:80 my-app

# View running containers
docker ps

# View logs
docker logs <container-id>

# Enter container
docker exec -it <container-id> sh

# Stop container
docker stop <container-id>

# Remove container
docker rm <container-id>

# Remove image
docker rmi my-app
```

### Docker Compose

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down

# Rebuild
docker-compose up --build

# View service status
docker-compose ps
```

## Multi-stage Build Optimization

### 1. Separate Build and Runtime Environments

```dockerfile
# Stage 1: Build
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
```

**Benefit**: The final image only contains Nginx and build artifacts, not Node.js and source code.

### 2. Cache Optimization

```dockerfile
# Good order: copy dependency files first, then source code
COPY package*.json ./
RUN npm ci
COPY . .

# Bad order: copy all files first, then install dependencies
COPY . .
RUN npm ci  # Any file change will cause dependencies to be reinstalled
```

## Production Best Practices

### 1. Use Non-root User

```dockerfile
# Create non-root user
RUN addgroup -g 1001 -S appgroup
RUN adduser -S appuser -u 1001

# Switch to non-root user
USER appuser

# Start application
CMD ["npm", "start"]
```

### 2. Health Check

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/ || exit 1
```

### 3. Use .dockerignore

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

### 4. Image Optimization

```dockerfile
# Use Alpine image
FROM node:18-alpine

# Clean npm cache
RUN npm cache clean --force

# Use multi-stage build
# Final image doesn't contain build tools
```

## Real Case: React Project Deployment

### Project Structure

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

### Complete Workflow

```bash
# 1. Build and start
docker-compose up --build -d

# 2. Access application
# http://localhost:3000

# 3. View logs
docker-compose logs -f frontend

# 4. Redeploy
docker-compose down
docker-compose up --build -d
```

### CI/CD Integration

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

## Common Questions

### Q: Image is too large?

A:
1. Use Alpine image instead of full Node.js image
2. Use multi-stage builds
3. Add .dockerignore
4. Clean npm cache

### Q: How to debug applications inside containers?

A:
```bash
# Enter container
docker exec -it <container-id> sh

# View environment variables
env

# View file system
ls -la
```

### Q: How to persist data?

A: Use Volumes
```bash
# Named volume
docker volume create mydata
docker run -v mydata:/app/data my-app

# Bind mount
docker run -v $(pwd)/data:/app/data my-app
```

## Summary

1. **Docker solves environment consistency**: Build once, run anywhere
2. **Multi-stage builds are key**: Separate build and runtime environments
3. **docker-compose simplifies multi-service management**: One-click startup for complete environments
4. **Security practices cannot be ignored**: Non-root users, health checks, image scanning
5. **CI/CD integration is the foundation of production deployment**

Docker is not a silver bullet, but it does make deployment and operations simpler and more reliable. As a frontend engineer, mastering Docker is an important step into the full-stack domain.
