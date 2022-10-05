---
title: "Nginx Configuration in Practice: Reverse Proxy, Load Balancing, and HTTPS"
tag: devops
description: A deep dive into core Nginx configuration, including best practices for reverse proxy, load balancing, and secure HTTPS setup.
date: "2022-10-05T08:00:00.000Z"
---

## Goal

Nginx is one of the most widely used web servers and reverse proxy tools in the world today. Whether you are deploying a frontend application, configuring an API gateway, or building a highly available architecture, Nginx is an indispensable piece of infrastructure. This article provides a systematic walkthrough of Nginx's core configuration, helping developers master best practices for reverse proxying, load balancing, and HTTPS.

## Background

### Why Choose Nginx

Nginx stands out for several compelling reasons:

1. **High Performance**: Its event-driven asynchronous architecture handles massive concurrency with ease.
2. **Low Memory Footprint**: Compared to Apache, Nginx uses significantly less memory under heavy workloads.
3. **Reverse Proxy**: Native support for load balancing and response caching.
4. **Static File Serving**: Highly efficient at delivering static assets such as images, stylesheets, and JavaScript files.
5. **Modular Design**: A rich ecosystem of third-party modules extends its capabilities.

### Common Use Cases

- **Frontend Application Deployment**: Serving built Vue/React applications as static files.
- **API Reverse Proxying**: Hiding backend services behind a unified entry point.
- **Load Balancing**: Distributing incoming requests across multiple servers.
- **HTTPS Termination**: Centralized management of SSL/TLS certificates.
- **Cache Acceleration**: Caching static resources and API responses to reduce backend load.

## Basic Configuration

### Nginx Configuration File Structure

```nginx
# /etc/nginx/nginx.conf - Main configuration file
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
    
    # Log format
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';
    
    access_log /var/log/nginx/access.log main;
    
    # Performance tuning
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    
    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json 
               application/javascript application/xml+rss application/atom+xml 
               image/svg+xml;
    
    # Include virtual host configs
    include /etc/nginx/conf.d/*.conf;
}
```

## Reverse Proxy Configuration

### Basic Reverse Proxy

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

### Detailed Proxy Configuration

```nginx
server {
    listen 80;
    server_name api.example.com;
    
    # Proxy timeout settings
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    
    # Buffer settings
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;
    
    # Proxy request headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Backend API service
    location /api/ {
        proxy_pass http://backend_api:8080;
        
        # Disable buffering for real-time responses
        proxy_buffering off;
        
        # Extended timeout for long-running requests
        proxy_read_timeout 300s;
    }
    
    # File upload endpoint
    location /api/upload/ {
        proxy_pass http://backend_upload:8080;
        
        # Larger body size limit for uploads
        client_max_body_size 100M;
        proxy_request_buffering off;
    }
}
```

### WebSocket Proxying

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
        # Very long timeouts to keep WebSocket connections alive
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## Load Balancing Configuration

### Basic Load Balancing

```nginx
# Define an upstream server group
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

### Load Balancing Strategies

```nginx
# Round Robin (default)
upstream backend_round_robin {
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

# Weighted Round Robin
upstream backend_weighted {
    server backend1.example.com:8080 weight=3;
    server backend2.example.com:8080 weight=2;
    server backend3.example.com:8080 weight=1;
}

# IP Hash (session persistence)
upstream backend_ip_hash {
    ip_hash;
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

# Least Connections
upstream backend_least_conn {
    least_conn;
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}

# URL Hash (consistent hashing)
upstream backend_url_hash {
    hash $request_uri consistent;
    server backend1.example.com:8080;
    server backend2.example.com:8080;
    server backend3.example.com:8080;
}
```

### Health Checks

```nginx
upstream backend {
    # Active health checks: mark server down after 3 failures within 30 seconds
    server backend1.example.com:8080 max_fails=3 fail_timeout=30s;
    server backend2.example.com:8080 max_fails=3 fail_timeout=30s;
    server backend3.example.com:8080 backup;  # Backup server
    
    # Passive health check via keepalive connections
    keepalive 32;
}

server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://backend;
        
        # Connection pool for keepalive
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

## HTTPS Configuration

### SSL Certificate Setup

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    
    # SSL certificate files
    ssl_certificate /etc/nginx/ssl/example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;
    
    # SSL protocol and cipher configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    
    # SSL session caching for performance
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;
    
    # HSTS header
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    
    # Security headers
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

# HTTP to HTTPS redirect
server {
    listen 80;
    server_name example.com;
    return 301 https://$server_name$request_uri;
}
```

### Let's Encrypt Automation

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d example.com -d www.example.com

# Test auto-renewal
sudo certbot renew --dry-run
```

### Certificate Renewal Hook Script

```bash
#!/bin/bash
# /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "Reloading Nginx..."
systemctl reload nginx
```

## Frontend Application Deployment

### Vue/React Single-Page Application

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;
    
    # SSL configuration
    ssl_certificate /etc/nginx/ssl/example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;
    
    root /var/www/html;
    index index.html;
    
    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1000;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json 
               application/javascript application/xml+rss application/atom+xml 
               image/svg+xml;
    
    # Static asset caching (long-lived, immutable)
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
    
    # HTML files: never cache (always fetch fresh)
    location ~* \.html$ {
        expires -1;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
    
    # SPA routing support: serve index.html for all routes
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # API proxy to backend
    location /api/ {
        proxy_pass http://backend_api:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Multi-Environment Configuration

```nginx
# Development environment
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

# Staging environment
server {
    listen 80;
    server_name test.example.com;
    
    location / {
        root /var/www/test;
        try_files $uri $uri/ /index.html;
    }
}

# Production environment
server {
    listen 443 ssl http2;
    server_name example.com;
    
    # Full production configuration
    ssl_certificate /etc/nginx/ssl/example.com.crt;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;
    
    root /var/www/prod;
    try_files $uri $uri/ /index.html;
}
```

## Performance Optimization

### Connection Tuning

```nginx
events {
    worker_connections 4096;
    multi_accept on;
    use epoll;
}

http {
    # Keepalive tuning
    keepalive_timeout 65;
    keepalive_requests 1000;
    
    # Buffer size optimization
    client_body_buffer_size 16k;
    client_header_buffer_size 1k;
    client_max_body_size 8m;
    large_client_header_buffers 4 8k;
}
```

### Static Asset Optimization

```nginx
# Image caching
location ~* \.(jpg|jpeg|png|gif|ico|svg)$ {
    expires 30d;
    add_header Cache-Control "public, no-transform";
    access_log off;
}

# Font files with CORS
location ~* \.(woff|woff2|ttf|eot)$ {
    expires 1y;
    add_header Cache-Control "public";
    add_header Access-Control-Allow-Origin "*";
}

# JavaScript and CSS with immutable cache
location ~* \.(js|css)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

## Monitoring and Logging

### Access Log Format

```nginx
log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                '$status $body_bytes_sent "$http_referer" '
                '"$http_user_agent" "$http_x_forwarded_for" '
                '$request_time $upstream_response_time';

access_log /var/log/nginx/access.log main;
```

### Status Monitoring

```nginx
# Enable stub_status for monitoring
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

## Common Troubleshooting

### 1. 502 Bad Gateway

```nginx
# Verify the backend service is running
# Check the proxy_pass configuration -- note the trailing slash
location /api/ {
    proxy_pass http://127.0.0.1:8080/;
}
```

### 2. 413 Request Entity Too Large

```nginx
# Increase the client request body size limit
client_max_body_size 100M;
```

### 3. CORS Issues

```nginx
# Add CORS headers for cross-origin requests
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

## Summary

Nginx is a core component of modern web architecture, and its configuration directly impacts the performance, security, and availability of your applications. Here are the key takeaways:

1. **Reverse Proxy**: Configure proxy headers correctly so that backend services receive accurate client information.
2. **Load Balancing**: Choose the appropriate load-balancing strategy based on your business requirements.
3. **HTTPS**: Use TLS 1.3, enable HSTS, and configure proper security headers.
4. **Performance Optimization**: Tune caching, compression, and connection pool settings for your workload.
5. **Monitoring and Logging**: Set up comprehensive logging to make troubleshooting straightforward.

Mastering these Nginx configuration techniques will help your applications run more stably, securely, and efficiently in production.
