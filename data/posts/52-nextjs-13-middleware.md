---
title: "Next.js 13 Middleware in Practice: Authentication, i18n, and A/B Testing"
tag: nextjs
description: An in-depth exploration of advanced Next.js 13 middleware usage for implementing authentication, internationalization, and A/B testing scenarios.
date: "2023-06-10T08:00:00.000Z"
---

## Goal

Next.js 13 Middleware is a powerful feature that allows you to execute code before a request reaches a page or API route. This article explores advanced middleware usage patterns through practical examples, demonstrating how to implement authentication, internationalization (i18n), and A/B testing -- three of the most common real-world scenarios.

## Background

### Advantages of Middleware

1. **Edge execution**: Runs on the Edge Runtime with extremely low latency.
2. **Request interception**: Can execute before any page loads.
3. **Flexible control**: Can modify request headers, redirect, and rewrite URLs.
4. **Serverless**: No server management required; automatically deployed to edge nodes.

### Limitations of Middleware

```javascript
// Things middleware cannot do
// 1. Cannot access Node.js APIs (e.g., fs, path)
// 2. Cannot use most npm packages
// 3. Cannot interact with databases directly
// 4. Cannot execute long-running tasks

// middleware.js
export function middleware(request) {
  // Web APIs are available
  const url = new URL(request.url)
  
  // Node.js APIs are NOT available
  // const fs = require('fs') // Error
  
  // Edge Runtime supported APIs work fine
  const response = NextResponse.next()
  
  return response
}
```

## Basic Configuration

### Creating Middleware

```javascript
// middleware.js (must be placed in the project root)
import { NextResponse } from 'next/server'

export function middleware(request) {
  // Get the request URL
  const url = new URL(request.url)
  
  // Get request headers
  const headers = new Headers(request.headers)
  
  // Add custom response headers
  headers.set('x-custom-header', 'custom-value')
  
  // Create a response
  const response = NextResponse.next({
    request: {
      headers
    }
  })
  
  // Set a cookie
  response.cookies.set('theme', 'dark', {
    path: '/',
    httpOnly: true,
    secure: true
  })
  
  return response
}

// Configure which paths the middleware matches
export const config = {
  matcher: [
    // Match all paths
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
    
    // Or use more precise matching
    '/dashboard/:path*',
    '/admin/:path*'
  ]
}
```

### Middleware Chain

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// Auth middleware function
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

// Logging middleware function
function withLogging(handler) {
  return (request) => {
    console.log(`${request.method} ${request.url}`)
    return handler(request)
  }
}

// Compose middlewares
export const middleware = withLogging(
  withAuth((request) => {
    return NextResponse.next()
  })
)
```

## Authentication Implementation

### JWT Authentication

```javascript
// middleware.js
import { NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

// Verify JWT token
async function verifyToken(token) {
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const { payload } = await jwtVerify(token, secret)
    return payload
  } catch (error) {
    return null
  }
}

// Public paths (no authentication required)
const publicPaths = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/api/auth/login',
  '/api/auth/register'
]

// Static asset paths
const staticPaths = [
  '/_next/static',
  '/_next/image',
  '/favicon.ico',
  '/images'
]

export async function middleware(request) {
  const { pathname } = request.nextUrl
  
  // Allow static assets through directly
  if (staticPaths.some(path => pathname.startsWith(path))) {
    return NextResponse.next()
  }
  
  // Allow public paths through directly
  if (publicPaths.includes(pathname)) {
    return NextResponse.next()
  }
  
  // Get the token
  const token = request.cookies.get('token')?.value
  
  // Not logged in, redirect to login page
  if (!token) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }
  
  // Verify the token
  const payload = await verifyToken(token)
  
  if (!payload) {
    // Invalid token, clear cookie and redirect
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('token')
    return response
  }
  
  // Check user role
  const userRole = payload.role
  const requiredRole = getRequiredRole(pathname)
  
  if (requiredRole && userRole !== requiredRole) {
    return NextResponse.redirect(new URL('/unauthorized', request.url))
  }
  
  // Add user info to request headers
  const headers = new Headers(request.headers)
  headers.set('x-user-id', payload.userId)
  headers.set('x-user-role', userRole)
  
  return NextResponse.next({
    request: { headers }
  })
}

// Get the required role based on path
function getRequiredRole(pathname) {
  if (pathname.startsWith('/admin')) return 'admin'
  if (pathname.startsWith('/manager')) return 'manager'
  return null
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
}
```

### Session Authentication

```javascript
// middleware.js
import { NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'

// Session configuration
const sessionOptions = {
  password: process.env.SESSION_SECRET,
  cookieName: 'session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production'
  }
}

export async function middleware(request) {
  const response = NextResponse.next()
  
  // Get the session
  const session = await getIronSession(request, response, sessionOptions)
  
  // Check if the user is logged in
  if (!session.user) {
    // Not logged in, redirect to login page
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', request.url)
    return NextResponse.redirect(loginUrl)
  }
  
  // Check if the session has expired
  if (session.expiresAt && Date.now() > session.expiresAt) {
    // Session expired, destroy it and redirect
    session.destroy()
    return NextResponse.redirect(new URL('/login', request.url))
  }
  
  // Renew the session
  session.expiresAt = Date.now() + 24 * 60 * 60 * 1000 // 24 hours
  await session.save()
  
  return response
}
```

## Internationalization (i18n)

### Language Detection and Routing

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// Supported languages
const locales = ['en', 'zh', 'ja', 'ko']
const defaultLocale = 'en'

// Get the user's language preference
function getLocale(request) {
  // 1. Check URL parameter
  const url = new URL(request.url)
  const urlLocale = url.searchParams.get('lang')
  if (urlLocale && locales.includes(urlLocale)) {
    return urlLocale
  }
  
  // 2. Check cookie
  const cookieLocale = request.cookies.get('locale')?.value
  if (cookieLocale && locales.includes(cookieLocale)) {
    return cookieLocale
  }
  
  // 3. Check Accept-Language header
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
  
  // 4. Fall back to default language
  return defaultLocale
}

export function middleware(request) {
  const { pathname } = request.nextUrl
  
  // Check if the path already contains a locale prefix
  const pathnameHasLocale = locales.some(
    locale => pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`
  )
  
  if (pathnameHasLocale) {
    // Already has a locale prefix, proceed directly
    const locale = pathname.split('/')[1]
    const response = NextResponse.next()
    response.cookies.set('locale', locale)
    return response
  }
  
  // Detect user language
  const locale = getLocale(request)
  
  // Redirect to the path with a locale prefix
  const newUrl = new URL(`/${locale}${pathname}`, request.url)
  const response = NextResponse.redirect(newUrl)
  response.cookies.set('locale', locale)
  
  return response
}

export const config = {
  matcher: [
    // Match all paths, but exclude API routes, static assets, etc.
    '/((?!api|_next/static|_next/image|favicon.ico|public).*)'
  ]
}
```

### Translation File Loading

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// Translation mapping
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
  
  // Get current language
  const locale = request.cookies.get('locale')?.value || 'en'
  
  // Add translation data to response headers
  response.headers.set('x-locale', locale)
  response.headers.set('x-translations', JSON.stringify(translations[locale] || translations.en))
  
  return response
}
```

## A/B Testing

### Implementing A/B Testing

```javascript
// middleware.js
import { NextResponse } from 'next/server'

// Experiment configuration
const experiments = {
  'new-checkout': {
    variants: ['control', 'variant-a', 'variant-b'],
    weights: [50, 25, 25] // Traffic distribution
  },
  'homepage-design': {
    variants: ['control', 'new-design'],
    weights: [70, 30]
  }
}

// Get user group assignment
function getUserGroup(userId, experimentName) {
  const experiment = experiments[experimentName]
  if (!experiment) return 'control'
  
  // Use deterministic hashing for grouping
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

// Simple hash function
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
  
  // Get user ID (can come from cookie or session)
  const userId = request.cookies.get('user-id')?.value || 
                 request.headers.get('x-user-id') || 
                 'anonymous'
  
  // Assign groups for each experiment
  const groups = {}
  for (const experimentName of Object.keys(experiments)) {
    groups[experimentName] = getUserGroup(userId, experimentName)
  }
  
  // Add group information to response headers
  response.headers.set('x-experiment-groups', JSON.stringify(groups))
  
  // Set cookie for client-side access
  response.cookies.set('experiment-groups', JSON.stringify(groups), {
    path: '/',
    httpOnly: false, // Client needs to access this
    secure: process.env.NODE_ENV === 'production'
  })
  
  return response
}
```

### Client-Side Usage

```jsx
// hooks/useExperiment.js
import { useState, useEffect } from 'react'

export function useExperiment(experimentName) {
  const [variant, setVariant] = useState('control')
  
  useEffect(() => {
    // Get experiment group from cookie
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

// Usage
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

## Rewrites and Redirects

### URL Rewriting

```javascript
// middleware.js
import { NextResponse } from 'next/server'

export function middleware(request) {
  const { pathname } = request.nextUrl
  
  // API versioning
  if (pathname.startsWith('/api/v1/')) {
    // Rewrite to v1 API
    const url = request.nextUrl.clone()
    url.pathname = pathname.replace('/api/v1/', '/api/')
    return NextResponse.rewrite(url)
  }
  
  // Redirect old paths to new paths
  const redirects = {
    '/old-blog': '/blog',
    '/old-about': '/about',
    '/old-contact': '/contact'
  }
  
  if (redirects[pathname]) {
    return NextResponse.redirect(new URL(redirects[pathname], request.url))
  }
  
  // A/B test route rewriting
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
      // Parse failed, use default route
    }
  }
  
  return NextResponse.next()
}
```

### Geolocation-Based Redirects

```javascript
// middleware.js
import { NextResponse } from 'next/server'

export function middleware(request) {
  // Get geolocation (Edge Runtime supported)
  const country = request.geo?.country || 'US'
  
  // Redirect based on country
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

## Performance Optimization

### Caching Strategies

```javascript
// middleware.js
import { NextResponse } from 'next/server'

export function middleware(request) {
  const response = NextResponse.next()
  
  // Static asset caching
  if (request.nextUrl.pathname.startsWith('/static')) {
    response.headers.set(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    )
  }
  
  // API response caching
  if (request.nextUrl.pathname.startsWith('/api/public')) {
    response.headers.set(
      'Cache-Control',
      'public, max-age=3600, s-maxage=3600'
    )
  }
  
  return response
}
```

## Summary

Next.js 13 Middleware provides powerful request handling capabilities for frontend development:

1. **Authentication control**: JWT, Session, and role-based access.
2. **Internationalization**: Language detection and route rewriting.
3. **A/B testing**: User grouping and experiment tracking.
4. **URL handling**: Rewrites, redirects, and versioning.
5. **Performance optimization**: Caching strategies and geolocation.

Mastering middleware usage makes your Next.js application more flexible, secure, and efficient.
