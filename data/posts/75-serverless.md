---
title: "Serverless in Practice: Building Lightweight Backends with Cloud Functions"
tag: cloud
description: From Serverless core concepts to cloud function practice, explaining how to use AWS Lambda, Vercel Edge Functions, and others to build lightweight, elastic backend services.
date: "2024-04-18T08:00:00.000Z"
---

## Goal

Serverless (serverless architecture) lets developers focus on business logic without managing server infrastructure. Cloud Functions are the core implementation of Serverless, executing on demand and charging by usage. This article explains Serverless core concepts and practical applications on mainstream platforms.

## Background

### Traditional Architecture vs Serverless

```
Traditional architecture:
  Developer → Server → Operations → Scaling → Cost

Serverless architecture:
  Developer → Cloud Functions → Auto-scaling → Pay per use
```

### Core Advantages of Serverless

- **Zero operations**: No need to manage servers, operating systems
- **Auto-scaling**: Automatic scaling from 0 to infinity
- **Pay per use**: Only pay for actual execution time
- **Fast deployment**: Second-level deployment, rapid iteration
- **High availability**: Cloud providers guarantee availability

### Mainstream Platform Comparison

| Platform | Provider | Language Support | Cold Start | Free Tier |
|----------|----------|------------------|------------|-----------|
| AWS Lambda | Amazon | Node.js, Python, Go, Java | 100-500ms | 1M requests/month |
| Cloud Functions | Google | Node.js, Python, Go | 100-300ms | 2M requests/month |
| Azure Functions | Microsoft | Node.js, Python, C# | 100-500ms | 1M requests/month |
| Vercel Edge Functions | Vercel | JavaScript, TypeScript | < 10ms | 100GB-Hrs/month |
| Cloudflare Workers | Cloudflare | JavaScript, TypeScript | < 5ms | 100K requests/day |

## AWS Lambda Practice

### Basic Usage

```javascript
// handler.js
exports.handler = async (event) => {
  const response = {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      message: 'Hello from Lambda!',
      input: event,
    }),
  };
  return response;
};
```

### API Gateway + Lambda

```javascript
// Handle HTTP requests
exports.handler = async (event) => {
  const { httpMethod, path, body, queryStringParameters } = event;

  // Route handling
  if (httpMethod === 'GET' && path === '/users') {
    const users = await getUsers();
    return {
      statusCode: 200,
      body: JSON.stringify(users),
    };
  }

  if (httpMethod === 'POST' && path === '/users') {
    const data = JSON.parse(body);
    const user = await createUser(data);
    return {
      statusCode: 201,
      body: JSON.stringify(user),
    };
  }

  return {
    statusCode: 404,
    body: JSON.stringify({ error: 'Not found' }),
  };
};

// Database operations
const { DynamoDB } = require('aws-sdk');
const dynamoDb = new DynamoDB.DocumentClient();

async function getUsers() {
  const result = await dynamoDb.scan({
    TableName: 'Users',
  }).promise();
  return result.Items;
}

async function createUser(data) {
  const params = {
    TableName: 'Users',
    Item: {
      id: Date.now().toString(),
      ...data,
      createdAt: new Date().toISOString(),
    },
  };
  await dynamoDb.put(params).promise();
  return params.Item;
}
```

### Serverless Framework Configuration

```yaml
# serverless.yml
service: my-api

provider:
  name: aws
  runtime: nodejs18.x
  region: ap-northeast-1
  environment:
    TABLE_NAME: ${self:service}-users

functions:
  users:
    handler: handler.handler
    events:
      - httpApi:
          path: /users
          method: get
      - httpApi:
          path: /users
          method: post
    iamRoleStatements:
      - Effect: Allow
        Action:
          - dynamodb:Scan
          - dynamodb:PutItem
        Resource: arn:aws:dynamodb:${self:provider.region}:*:table/${self:provider.environment.TABLE_NAME}

resources:
  Resources:
    UsersTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: ${self:provider.environment.TABLE_NAME}
        AttributeDefinitions:
          - AttributeName: id
            AttributeType: S
        KeySchema:
          - AttributeName: id
            KeyType: HASH
        BillingMode: PAY_PER_REQUEST
```

## Vercel Edge Functions

### Basic Usage

```typescript
// api/hello.ts (Pages Router)
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  const { name = 'World' } = req.query;
  res.status(200).json({ message: `Hello ${name}!` });
}
```

### Usage in App Router

```typescript
// app/api/users/route.ts
import { NextResponse } from 'next/server';

export async function GET() {
  const users = await fetchUsers();
  return NextResponse.json(users);
}

export async function POST(request: Request) {
  const data = await request.json();
  const user = await createUser(data);
  return NextResponse.json(user, { status: 201 });
}
```

### Edge Runtime

```typescript
// app/api/edge/route.ts
export const runtime = 'edge';

export async function GET(request: Request) {
  // APIs supported by Edge Runtime
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || 'World';

  return new Response(`Hello ${name}!`, {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 's-maxage=86400',
    },
  });
}
```

### Edge Middleware

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Geolocation detection
  const country = request.geo?.country || 'US';

  // Redirect
  if (request.nextUrl.pathname === '/admin') {
    const token = request.cookies.get('token');
    if (!token) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  // A/B testing
  const bucket = request.cookies.get('ab-test')?.value || 
    Math.random() > 0.5 ? 'a' : 'b';

  const response = NextResponse.next();
  response.cookies.set('ab-test', bucket);

  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/api/:path*'],
};
```

## Cloudflare Workers

### Basic Usage

```javascript
// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Route handling
    if (url.pathname === '/api/hello') {
      return new Response(
        JSON.stringify({ message: 'Hello from Workers!' }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // KV storage
    if (url.pathname === '/api/counter') {
      const count = parseInt(await env.COUNTER_KV.get('count') || '0');
      await env.COUNTER_KV.put('count', (count + 1).toString());
      return new Response(JSON.stringify({ count: count + 1 }));
    }

    return new Response('Not found', { status: 404 });
  },
};
```

### Wrangler Configuration

```toml
# wrangler.toml
name = "my-worker"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
API_KEY = "my-api-key"

[[kv_namespaces]]
binding = "COUNTER_KV"
id = "your-kv-namespace-id"

[[durable_objects]]
class_name = "ChatRoom"
```

## Practical Scenarios

### 1. Image Processing

```javascript
// Image resizing and format conversion
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const imageUrl = url.searchParams.get('url');
    const width = parseInt(url.searchParams.get('width') || '300');
    const format = url.searchParams.get('format') || 'webp';

    // Use Cloudflare Image Resizing
    const response = await fetch(imageUrl, {
      cf: {
        image: {
          width,
          format,
          quality: 80,
        },
      },
    });

    return new Response(response.body, {
      headers: {
        'Content-Type': `image/${format}`,
        'Cache-Control': 's-maxage=86400',
      },
    });
  },
};
```

### 2. API Proxy

```typescript
// API proxy in Vercel
// app/api/proxy/[...path]/route.ts
export async function GET(
  request: Request,
  { params }: { params: { path: string[] } }
) {
  const targetUrl = `https://api.external.com/${params.path.join('/')}`;
  const response = await fetch(targetUrl, {
    headers: {
      'Authorization': `Bearer ${process.env.EXTERNAL_API_KEY}`,
    },
  });

  const data = await response.json();
  return NextResponse.json(data);
}
```

### 3. Webhook Handling

```javascript
// Handle Stripe Webhook
// api/webhook/stripe.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      await handlePaymentSuccess(paymentIntent);
      break;
    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      await handlePaymentFailure(failedPayment);
      break;
  }

  res.status(200).json({ received: true });
}

async function handlePaymentSuccess(paymentIntent) {
  // Update order status
  await db.orders.update({
    where: { stripeId: paymentIntent.id },
    data: { status: 'paid' },
  });
}
```

## Performance Optimization

### 1. Cold Start Optimization

```javascript
// Initialize in global scope
const dynamoDb = new DynamoDB.DocumentClient();

exports.handler = async (event) => {
  // Reuse already initialized client
  const result = await dynamoDb.scan({ TableName: 'Users' }).promise();
  return {
    statusCode: 200,
    body: JSON.stringify(result.Items),
  };
};
```

### 2. Connection Pool Management

```javascript
// Database connection pool
let pool;

async function getPool() {
  if (!pool) {
    pool = await mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionLimit: 1, // Limited to 1 in Lambda
    });
  }
  return pool;
}
```

### 3. Caching Strategy

```javascript
// Use Redis caching
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

export default async function handler(req, res) {
  const cacheKey = 'users';
  
  // Try to get from cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.status(200).json(JSON.parse(cached));
  }

  // Cache miss, query database
  const users = await getUsers();
  
  // Write to cache
  await redis.setex(cacheKey, 3600, JSON.stringify(users));

  return res.status(200).json(users);
}
```

## Cost Analysis

### AWS Lambda Pricing Example

```
1M requests per month, average execution time 100ms:

Request cost:
  1,000,000 requests × $0.20/million = $0.20

Compute cost:
  1,000,000 requests × 100ms × $0.0000166667/GB-s
  = 1,000,000 × 0.1s × $0.0000166667
  = $1.67

Total cost: $0.20 + $1.67 = $1.87/month

Compared to traditional servers:
  Minimum EC2 instance: ~$10/month
  Database: ~$15/month
  Total: ~$25/month
```

## Conclusion

Serverless is an ideal choice for building lightweight backends. Key takeaways:

1. **Platform selection**: Choose the right platform based on language, performance needs, and cost
2. **Cold start optimization**: Global initialization, reduce package size, choose appropriate runtime
3. **Cost control**: Set memory appropriately, optimize execution time, leverage free tier
4. **Monitoring and debugging**: Use platform-provided logging and monitoring tools

Serverless is not a silver bullet. For long connections, high concurrency, and scenarios requiring persistent execution, traditional servers may be more suitable. But for API services, webhook handling, scheduled tasks, and other scenarios, Serverless is the better choice.
