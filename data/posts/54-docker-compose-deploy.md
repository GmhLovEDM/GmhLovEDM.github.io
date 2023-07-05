---
title: "Docker Compose in Practice: One-Click Deployment of Frontend, Backend, and Database"
tag: devops
description: Building a Docker Compose orchestration solution from scratch to achieve one-click deployment of frontend, backend, and database, covering differentiated configuration strategies for development and production environments.
date: "2023-07-05T08:00:00.000Z"
---

## Goal

In real-world projects, a frontend-backend separation architecture typically involves multiple services: frontend (Nginx-hosted), backend (Node.js/Go/Java), and database (MySQL/PostgreSQL/Redis). Manual deployment is not only time-consuming but also prone to issues caused by environment differences. This article aims to implement one-click orchestration deployment through Docker Compose, standardizing and making the deployment process repeatable across development and production environments.

## Background

### Why Containerized Deployment

Traditional deployment methods have several core pain points:

- **Environment inconsistency**: "It works on my machine" is a classic problem, with inconsistent dependency versions across development, testing, and production environments
- **Complex dependency management**: Different services require different runtime environments that interfere with each other
- **Manual deployment process**: Each deployment requires SSH access to servers and manual execution of a series of commands
- **Difficulty in scaling**: Unable to quickly add instances during traffic spikes

Docker solves the environment consistency problem, while Docker Compose solves the multi-service orchestration problem.

### Core Concepts of Docker Compose

Docker Compose defines a multi-container application architecture through a YAML file:

```yaml
# Services: each container is a service
# Networks: bridges for inter-service communication
# Volumes: persistent storage
# Depends_on: service startup order
```

## Project Architecture

Assuming our project structure is as follows:

```
project/
├── frontend/          # React/Vue frontend
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── backend/           # Node.js/Go backend
│   ├── Dockerfile
│   └── package.json
├── database/          # Database initialization scripts
│   └── init.sql
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env
```

## Dockerfile Writing

### Frontend Dockerfile (Multi-Stage Build)

```dockerfile
# frontend/Dockerfile
# Stage 1: Build
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build

# Stage 2: Production image
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

    # SPA routing support
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api {
        proxy_pass http://backend:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Static asset caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
}
```

### Backend Dockerfile

```dockerfile
# backend/Dockerfile
FROM node:18-alpine
WORKDIR /app

# Copy dependency files first to leverage Docker cache
COPY package*.json ./
RUN npm ci --only=production --registry=https://registry.npmmirror.com

# Copy source code
COPY . .

# Run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
```

## Docker Compose Orchestration

### Development Environment Configuration

```yaml
# docker-compose.yml
version: '3.8'

services:
  # Database
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

  # Redis cache
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

  # Backend service
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
      - /app/node_modules  # Exclude node_modules
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    networks:
      - app-network

  # Frontend service
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

### Production Environment Configuration Overlay

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
    ports: []  # Don't expose database ports in production
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
      target: production  # Multi-stage build production stage
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

### Environment Variable Configuration

```bash
# .env
DB_ROOT_PASSWORD=your_strong_root_password
DB_NAME=appdb
DB_USER=appuser
DB_PASSWORD=your_strong_password
REDIS_PASSWORD=your_redis_password

# Backend configuration
JWT_SECRET=your_jwt_secret
API_KEY=your_api_key
```

## Common Operations Commands

### Start and Stop

```bash
# Start all services (background)
docker compose up -d

# View service status
docker compose ps

# View real-time logs
docker compose logs -f backend

# Rebuild and start
docker compose up -d --build

# Stop and remove containers
docker compose down

# Stop and remove containers + volumes (dangerous! Will lose data)
docker compose down -v
```

### Database Operations

```bash
# Enter MySQL container
docker compose exec db mysql -u root -p

# Backup database
docker compose exec db mysqldump -u root -p appdb > backup.sql

# Restore database
docker compose exec -T db mysql -u root -p appdb < backup.sql
```

### Health Check and Debugging

```bash
# View container resource usage
docker stats

# View container details
docker inspect app-backend

# Enter container for debugging
docker compose exec backend sh

# Check network connectivity
docker compose exec backend ping db
```

## Performance Optimization Tips

### 1. Image Layer Caching

```dockerfile
# Before optimization: reinstall dependencies every time
COPY . .
RUN npm ci

# After optimization: leverage cache, only reinstall when package.json changes
COPY package*.json ./
RUN npm ci
COPY . .
```

### 2. Multi-Stage Build

```dockerfile
# Production stage copies only necessary files
FROM builder AS production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
```

### 3. Resource Limits

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

## Conclusion

Docker Compose makes multi-container application deployment standardized and repeatable through declarative YAML configuration. Key takeaways:

1. **Multi-stage builds** reduce production image size and improve security
2. **Dependency health checks** ensure services start in the correct order
3. **Development and production separation**: Dev configuration focuses on developer experience (hot reload), while prod configuration prioritizes performance and stability
4. **Environment variable management**: Sensitive information is managed through `.env` files, not hardcoded in YAML

Mastering Docker Compose orchestration is fundamental to modern application deployment. You can later integrate it with CI/CD pipelines to achieve automatic builds and deployments after code commits.
