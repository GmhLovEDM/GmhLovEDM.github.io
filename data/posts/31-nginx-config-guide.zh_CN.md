---
title: "Nginx 配置实战：反向代理、负载均衡与 HTTPS"
tag: devops
description: 深入讲解 Nginx 的核心配置，包括反向代理、负载均衡和 HTTPS 安全配置的最佳实践。
date: "2022-10-05T08:00:00.000Z"
---

## 目标

Nginx 是目前最流行的 Web 服务器和反向代理工具之一。无论是部署前端应用、配置 API 网关，还是实现高可用架构，Nginx 都是不可或缺的基础设施。本文将系统性地讲解 Nginx 的核心配置，帮助开发者掌握反向代理、负载均衡和 HTTPS 的最佳实践。

## 背景

### 为什么选择 Nginx

Nginx 的优势在于：

1. **高性能**：基于事件驱动的异步架构，轻松处理高并发
2. **低内存**：相比 Apache，Nginx 内存占用极低
3. **反向代理**：天然支持负载均衡和缓存
4. **静态资源**：高效处理静态文件服务
5. **模块化**：丰富的第三方模块支持

### 典型使用场景

- **前端应用部署**：Vue/React 构建产物的静态服务
- **API 反向代理**：隐藏后端服务，统一入口
- **负载均衡**：多台服务器的请求分发
- **HTTPS 终止**：SSL/TLS 证书的统一管理
- **缓存加速**：静态资源和 API 响应的缓存

## 基础配置

### Nginx 配置文件结构

```nginx
# /etc/nginx/nginx.conf 主配置文件
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    
    # 日志格式
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';
    
    access_log /var/log/nginx/access.log main;
    
    # 性能优化
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    
    # 压缩
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json 
               application/javascript application/xml+rss application/atom+xml 
               image/svg+xml;
    
    # 引入虚拟主机配置
    include /etc/nginx/conf.d/*.conf;
}
```

## 反向代理配置

### 基础反向代理

```nginx
# /etc/nginx/conf.d/app.conf
server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 代理配置详解

```nginx
server {
    listen 80;
    server_name api.example.com;
    
    # 代理超时设置
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    
    # 缓冲设置
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;
    
    # 代理请求头
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # 后端服务
    location /api/ {
        proxy_pass http://backend_api:8080;
        
        # 不缓冲后端响应
        proxy_buffering off;
        
        # 超时设置
        proxy_read_timeout 300s;
    }
    
    location /api/upload/ {
        proxy_pass http://backend_upload:8080;
        
        # 文件上传需要更大缓冲
        client_max_body_size 100M;
        proxy_request_buffering off;
    }
}
```

### WebSocket 代理

```nginx
server {
    listen 80;
    server_name ws.example.com;
    
    location /ws {
        proxy_pass http://websocket_backend:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 负载均衡配置

### 基础负载均衡

```nginx
# 定义上游服务器组
upstream backend {
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 负载均衡策略

```nginx
# 轮询（默认）
upstream backend_round_robin {
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

# 加权轮询
upstream backend_weighted {
    server backend1.example.com:8080 weight=3;
    server backend2.example.com:8080 weight=2;
    server backend3.example.com:8080 weight=1;
}

# IP 哈希（会话保持）
upstream backend_ip_hash {
    ip_hash;
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

# 最少连接
upstream backend_least_conn {
    least_conn;
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

# URL 哈希
upstream backend_url_hash {
    hash $request_uri consistent;
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}
```

### 健康检查

```nginx
upstream backend {
    # 主动健康检查
    server backend1.example.com:8080 max_fails=3 fail_timeout=30s;
    server backend2.example.com:8080 max_fails=3 fail_timeout=30s;
    server backend3.example.com:8080 backup;  # 备用服务器
    
    # 被动健康检查
    keepalive 32;
}

server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://backend;
        
        # 连接池配置
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

## HTTPS 配置

### SSL 证书配置

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    
    # SSL 证书
    ssl_certificate /etc/nginx/ssl/example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;
    
    # SSL 协议
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    # SSL 会话缓存
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;
    
    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    
    # 安全头
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;" always;
    
    location / {
        root /var/www/html;
        try_files $uri $uri/ /index.html;
    }
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name example.com;
    return 301 https://$server_name$request_uri;
}
```

### Let's Encrypt 自动化

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d example.com -d www.example.com

# 自动续期
sudo certbot renew --dry-run
```

### 证书续期脚本

```bash
#!/bin/bash
# /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

#!/bin/bash
echo "Reloading Nginx..."
systemctl reload nginx
```

## 前端应用部署

### Vue/React 单页应用

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    
    # SSL 配置
    ssl_certificate /etc/nginx/ssl/example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;
    
    root /var/www/html;
    index index.html;
    
    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1000;
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
    
    # HTML 文件不缓存
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
    
    # SPA 路由支持
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # API 代理
    location /api/ {
        proxy_pass http://backend_api:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 多环境配置

```nginx
# 开发环境
server {
    listen 80;
    server_name dev.example.com;
    
    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# 测试环境
server {
    listen 80;
    server_name test.example.com;
    
    location / {
        root /var/www/test;
        try_files $uri $uri/ /index.html;
    }
}

# 生产环境
server {
    listen 443 ssl http2;
    server_name example.com;
    
    # 完整的生产配置
    ssl_certificate /etc/nginx/ssl/example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;
    
    root /var/www/prod;
    try_files $uri $uri/ /index.html;
}
```

## 性能优化

### 连接优化

```nginx
events {
    worker_connections 4096;
    multi_accept on;
    use epoll;
}

http {
    # 连接优化
    keepalive_timeout 65;
    keepalive_requests 1000;
    
    # 缓冲区优化
    client_body_buffer_size 16k;
    client_header_buffer_size 1k;
    client_max_body_size 8m;
    large_client_header_buffers 4 8k;
}
```

### 静态资源优化

```nginx
# 图片优化
location ~* \.(jpg|jpeg|png|gif|ico|svg)$ {
    expires 30d;
    add_header Cache-Control "public, no-transform";
    access_log off;
}

# 字体文件
location ~* \.(woff|woff2|ttf|eot)$ {
    expires 1y;
    add_header Cache-Control "public";
    add_header Access-Control-Allow-Origin "*";
}

# JavaScript 和 CSS
location ~* \.(js|css)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## 监控与日志

### 访问日志格式

```nginx
log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                '$status $body_bytes_sent "$http_referer" '
                '"$http_user_agent" "$http_x_forwarded_for" '
                '$request_time $upstream_response_time';

access_log /var/log/nginx/access.log main;
```

### 状态监控

```nginx
# 启用 stub_status
server {
    listen 80;
    server_name localhost;
    
    location /nginx_status {
        stub_status on;
        access_log off;
        allow 127.0.0.1;
        deny all;
    }
}
```

## 常见问题排查

### 1. 502 Bad Gateway

```nginx
# 检查后端服务是否运行
# 检查 proxy_pass 配置
location /api/ {
    proxy_pass http://127.0.0.1:8080/;  # 注意尾部斜杠
}
```

### 2. 413 Request Entity Too Large

```nginx
# 增大客户端请求大小限制
client_max_body_size 100M;
```

### 3. 跨域问题

```nginx
# 添加 CORS 头
location /api/ {
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS";
    add_header Access-Control-Allow-Headers "Content-Type, Authorization";
    
    if ($request_method = 'OPTIONS') {
        return 204;
    }
    
    proxy_pass http://backend;
}
```

## 总结

Nginx 作为现代 Web 架构的核心组件，其配置能力直接影响应用的性能、安全性和可用性。关键要点：

1. **反向代理**：合理配置代理头，确保后端服务获取真实客户端信息
2. **负载均衡**：根据业务场景选择合适的负载策略
3. **HTTPS**：使用 TLS 1.3，启用 HSTS，配置安全头
4. **性能优化**：合理配置缓存、压缩和连接池
5. **监控日志**：完善的日志配置便于问题排查

掌握这些 Nginx 配置技巧，能够让你的应用在生产环境中运行得更稳定、更安全、更高效。
