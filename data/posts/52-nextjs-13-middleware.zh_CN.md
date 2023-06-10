---
title: "Next.js 13 中间件实战：鉴权、i18n、A/B 测试"
tag: nextjs
description: 深入探索 Next.js 13 中间件的高级用法，实现鉴权、国际化和 A/B 测试等场景。
date: "2023-06-10T08:00:00.000Z"
---

## 目标

Next.js 13 的中间件（Middleware）是一个强大的功能，它允许你在请求到达页面或 API 之前执行代码。本文将深入探索中间件的高级用法，通过实战案例展示如何实现鉴权、国际化（i18n）和 A/B 测试等常见场景。

## 背景

### 中间件的优势

1. **边缘执行**：在 Edge Runtime 运行，延迟极低
2. **请求拦截**：可以在任何页面之前执行
3. **灵活控制**：可以修改请求头、重定向、重写 URL
4. **无服务器**：无需管理服务器，自动部署到边缘节点

### 中间件的限制

```javascript
// 中间件不能做的事情
// 1. 不能访问 Node.js API（如 fs、path）
// 2. 不能使用大部分 npm 包
// 3. 不能操作数据库
// 4. 不能执行长时间运行的任务

// middleware.js
export function middleware(request) {
  // 可以使用 Web API
  const url = new URL(request.url)
  
  // 不能使用 Node.js API
  // const fs = require('fs') // 错误
  
  // 可以使用 Edge Runtime 支持的 API
  const response = NextResponse.next()
  
  return response
}
```

## 基础配置

### 创建中间件

```javascript
// middleware.js（必须放在项目根目录）
import { NextResponse } from 'next/server'

export function middleware(request) {
  // 获取请求 URL
  const url = new URL(request.url)
  
  // 获取响应头
  const headers = new Headers(request.headers)
  
  // 添加自定义响应头
  headers.set('x-custom-header', 'custom-value')
  
  // 创建响应
  const response = NextResponse.next({
    request: {
      headers
    }
  })
  
  // 设置 Cookie
  response.cookies.set('theme', 'dark', {
    path: '/',
    httpOnly: true,
    secure: true
  })
  
  return response
}

// 配置中间件匹配的路径
export const config = {
  matcher: [
    // 匹配所有路径
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
    
    // 或者使用更精确的匹配
    '/dashboard/:path*',
    '/admin/:path*'
  ]
}
```

### 中间件链

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// 中间件函数
function withAuth(handler) {
  return (request) => {
    const token = request.cookies.get('token')
    
    if (!token) {
      const url = new URL('/login', request.url)
      url.searchParams.set('redirect', request.url)
      return NextResponse.redirect(url)
    }
    
    return handler(request)
  }
}

function withLogging(handler) {
  return (request) => {
    console.log(`${request.method} ${request.url}`)
    return handler(request)
  }
}

// 组合中间件
export const middleware = withLogging(
  withAuth((request) => {
    return NextResponse.next()
  })
)
```

## 鉴权实现

### JWT 鉴权

```javascript
// middleware.js
import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

// 验证 JWT Token
async function verifyToken(token) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const { payload } = await jwtVerify(token, secret)
    return payload
  } catch (error) {
    return null
  }
}

// 公开路径（不需要鉴权）
const publicPaths = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/api/auth/login',
  '/api/auth/register'
]

// 静态资源路径
const staticPaths = [
  '/_next/static',
  '/_next/image',
  '/favicon.ico',
  '/images'
]

export async function middleware(request) {
  const { pathname } = request.nextUrl
  
  // 静态资源直接放行
  if (staticPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next()
  }
  
  // 公开路径直接放行
  if (publicPaths.includes(pathname)) {
    return NextResponse.next()
  }
  
  // 获取 Token
  const token = request.cookies.get('token')?.value
  
  // 未登录，重定向到登录页
  if (!token) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }
  
  // 验证 Token
  const payload = await verifyToken(token)
  
  if (!payload) {
    // Token 无效，清除 Cookie 并重定向
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('token')
    return response
  }
  
  // 检查用户角色
  const userRole = payload.role
  const requiredRole = getRequiredRole(pathname)
  
  if (requiredRole && userRole !== requiredRole) {
    return NextResponse.redirect(new URL('/unauthorized', request.url))
  }
  
  // 将用户信息添加到请求头
  const headers = new Headers(request.headers)
  headers.set('x-user-id', payload.userId)
  headers.set('x-user-role', userRole)
  
  return NextResponse.next({
    request: { headers }
  })
}

// 根据路径获取所需角色
function getRequiredRole(pathname) {
  if (pathname.startsWith('/admin')) return 'admin'
  if (pathname.startsWith('/manager')) return 'manager'
  return null
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
}
```

### Session 鉴权

```javascript
// middleware.js
import { NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'

// Session 配置
const sessionOptions = {
  password: process.env.SESSION_SECRET,
  cookieName: 'session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production'
  }
}

export async function middleware(request) {
  const response = NextResponse.next()
  
  // 获取 Session
  const session = await getIronSession(request, response, sessionOptions)
  
  // 检查是否已登录
  if (!session.user) {
    // 未登录，重定向到登录页
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', request.url)
    return NextResponse.redirect(loginUrl)
  }
  
  // 检查 Session 是否过期
  if (session.expiresAt && Date.now() > session.expiresAt) {
    // Session 过期，清除并重定向
    session.destroy()
    return NextResponse.redirect(new URL('/login', request.url))
  }
  
  // 续期 Session
  session.expiresAt = Date.now() + 24 * 60 * 60 * 1000 // 24 小时
  await session.save()
  
  return response
}
```

## 国际化（i18n）

### 语言检测与路由

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// 支持的语言
const locales = ['en', 'zh', 'ja', 'ko']
const defaultLocale = 'en'

// 获取用户的语言偏好
function getLocale(request) {
  // 1. 检查 URL 参数
  const url = new URL(request.url)
  const urlLocale = url.searchParams.get('lang')
  if (urlLocale && locales.includes(urlLocale)) {
    return urlLocale
  }
  
  // 2. 检查 Cookie
  const cookieLocale = request.cookies.get('locale')?.value
  if (cookieLocale && locales.includes(cookieLocale)) {
    return cookieLocale
  }
  
  // 3. 检查 Accept-Language 头
  const acceptLanguage = request.headers.get('Accept-Language')
  if (acceptLanguage) {
    const preferredLocale = acceptLanguage
      .split(',')
      .map(lang => lang.split(';')[0].split('-')[0])
      .find(lang => locales.includes(lang))
    
    if (preferredLocale) {
      return preferredLocale
    }
  }
  
  // 4. 使用默认语言
  return defaultLocale
}

export function middleware(request) {
  const { pathname } = request.nextUrl
  
  // 检查是否已经包含语言前缀
  const pathnameHasLocale = locales.some(
    locale => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`
  )
  
  if (pathnameHasLocale) {
    // 已有语言前缀，直接放行
    const locale = pathname.split('/')[1]
    const response = NextResponse.next()
    response.cookies.set('locale', locale)
    return response
  }
  
  // 检测用户语言
  const locale = getLocale(request)
  
  // 重定向到带语言前缀的路径
  const newUrl = new URL(`/${locale}${pathname}`, request.url)
  const response = NextResponse.redirect(newUrl)
  response.cookies.set('locale', locale)
  
  return response
}

export const config = {
  matcher: [
    // 匹配所有路径，但排除 API、静态资源等
    '/((?!api|_next/static|_next/image|favicon.ico|public).*)'
  ]
}
```

### 翻译文件加载

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// 翻译映射
const translations = {
  en: {
    home: 'Home',
    about: 'About',
    contact: 'Contact'
  },
  zh: {
    home: '首页',
    about: '关于',
    contact: '联系我们'
  }
}

export function middleware(request) {
  const response = NextResponse.next()
  
  // 获取当前语言
  const locale = request.cookies.get('locale')?.value || 'en'
  
  // 将翻译数据添加到响应头
  response.headers.set('x-locale', locale)
  response.headers.set('x-translations', JSON.stringify(translations[locale] || translations.en))
  
  return response
}
```

## A/B 测试

### 实现 A/B 测试

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// 实验配置
const experiments = {
  'new-checkout': {
    variants: ['control', 'variant-a', 'variant-b'],
    weights: [50, 25, 25] // 流量分配
  },
  'homepage-design': {
    variants: ['control', 'new-design'],
    weights: [70, 30]
  }
}

// 获取用户分组
function getUserGroup(userId, experimentName) {
  const experiment = experiments[experimentName]
  if (!experiment) return 'control'
  
  // 使用确定性哈希分组
  const hash = hashString(`${userId}-${experimentName}`)
  const bucket = hash % 100
  
  let cumulative = 0
  for (let i = 0; i < experiment.variants.length; i++) {
    cumulative += experiment.weights[i]
    if (bucket < cumulative) {
      return experiment.variants[i]
    }
  }
  
  return experiment.variants[0]
}

// 简单的哈希函数
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

export function middleware(request) {
  const response = NextResponse.next()
  
  // 获取用户 ID（可以从 Cookie 或 Session 获取）
  const userId = request.cookies.get('user-id')?.value || 
                 request.headers.get('x-user-id') || 
                 'anonymous'
  
  // 为每个实验分配分组
  const groups = {}
  for (const experimentName of Object.keys(experiments)) {
    groups[experimentName] = getUserGroup(userId, experimentName)
  }
  
  // 将分组信息添加到响应头
  response.headers.set('x-experiment-groups', JSON.stringify(groups))
  
  // 设置 Cookie 以便客户端访问
  response.cookies.set('experiment-groups', JSON.stringify(groups), {
    path: '/',
    httpOnly: false, // 客户端需要访问
    secure: process.env.NODE_ENV === 'production'
  })
  
  return response
}
```

### 客户端使用

```jsx
// hooks/useExperiment.js
import { useState, useEffect } from 'react'

export function useExperiment(experimentName) {
  const [variant, setVariant] = useState('control')
  
  useEffect(() => {
    // 从 Cookie 获取实验分组
    const groups = document.cookie
      .split('; ')
      .find(row => row.startsWith('experiment-groups='))
      ?.split('=')[1]
    
    if (groups) {
      try {
        const parsed = JSON.parse(decodeURIComponent(groups))
        setVariant(parsed[experimentName] || 'control')
      } catch (error) {
        console.error('Failed to parse experiment groups:', error)
      }
    }
  }, [experimentName])
  
  return variant
}

// 使用
function CheckoutPage() {
  const variant = useExperiment('new-checkout')
  
  return (
    <div>
      {variant === 'control' && <OriginalCheckout />}
      {variant === 'variant-a' && <NewCheckoutVariantA />}
      {variant === 'variant-b' && <NewCheckoutVariantB />}
    </div>
  )
}
```

## 重写与重定向

### URL 重写

```javascript
// middleware.js
import { NextResponse } from 'next/server'

export function middleware(request) {
  const { pathname } = request.nextUrl
  
  // API 版本控制
  if (pathname.startsWith('/api/v1/')) {
    // 重写到 v1 API
    const url = request.nextUrl.clone()
    url.pathname = pathname.replace('/api/v1/', '/api/')
    return NextResponse.rewrite(url)
  }
  
  // 旧路径重定向到新路径
  const redirects = {
    '/old-blog': '/blog',
    '/old-about': '/about',
    '/old-contact': '/contact'
  }
  
  if (redirects[pathname]) {
    return NextResponse.redirect(new URL(redirects[pathname], request.url))
  }
  
  // A/B 测试路由重写
  const experimentGroups = request.cookies.get('experiment-groups')?.value
  
  if (experimentGroups) {
    try {
      const groups = JSON.parse(experimentGroups)
      
      if (groups['homepage-design'] === 'new-design') {
        const url = request.nextUrl.clone()
        url.pathname = '/new-homepage'
        return NextResponse.rewrite(url)
      }
    } catch (error) {
      // 解析失败，使用默认路由
    }
  }
  
  return NextResponse.next()
}
```

### 地理位置重定向

```javascript
// middleware.js
import { NextResponse } from 'next/server'

export function middleware(request) {
  // 获取地理位置（Edge Runtime 支持）
  const country = request.geo?.country || 'US'
  
  // 根据国家重定向
  const countryRedirects = {
    CN: '/zh',
    JP: '/ja',
    KR: '/ko'
  }
  
  const redirectPath = countryRedirects[country]
  
  if (redirectPath && !request.nextUrl.pathname.startsWith(redirectPath)) {
    const url = request.nextUrl.clone()
    url.pathname = `${redirectPath}${request.nextUrl.pathname}`
    return NextResponse.redirect(url)
  }
  
  return NextResponse.next()
}
```

## 性能优化

### 缓存策略

```javascript
// middleware.js
import { NextResponse } from 'next/server'

export function middleware(request) {
  const response = NextResponse.next()
  
  // 静态资源缓存
  if (request.nextUrl.pathname.startsWith('/static')) {
    response.headers.set(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    )
  }
  
  // API 响应缓存
  if (request.nextUrl.pathname.startsWith('/api/public')) {
    response.headers.set(
      'Cache-Control',
      'public, max-age=3600, s-maxage=3600'
    )
  }
  
  return response
}
```

## 总结

Next.js 13 的中间件为前端开发提供了强大的请求处理能力：

1. **鉴权控制**：JWT、Session、角色权限
2. **国际化**：语言检测、路由重写
3. **A/B 测试**：用户分组、实验追踪
4. **URL 处理**：重写、重定向、版本控制
5. **性能优化**：缓存策略、地理位置

掌握中间件的使用，能够让你的 Next.js 应用更加灵活、安全、高效。
