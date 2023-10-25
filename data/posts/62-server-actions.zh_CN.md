---
title: "Server Actions 初探：Next.js 表单处理新范式"
tag: nextjs
description: 深入 Next.js Server Actions 的核心概念与实战应用，从表单处理到数据变更，探索服务端操作的新范式。
date: "2023-10-25T08:00:00.000Z"
---

## 目标

传统的前端表单处理涉及大量样板代码：事件处理、API 路由、乐观更新、错误处理。Server Actions 是 Next.js 14 引入的新特性，允许直接在服务端执行函数，大幅简化表单处理流程。本文深入讲解 Server Actions 的核心概念、使用场景和最佳实践。

## 背景

### 传统表单处理的痛点

在 Next.js App Router 之前，表单处理需要：

```tsx
// 1. 客户端组件
'use client';

function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // 2. 调用 API 路由
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });

      if (!res.ok) throw new Error('提交失败');

      // 3. 处理成功
      toast.success('提交成功');
    } catch (error) {
      // 4. 处理错误
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input value={name} onChange={e => setName(e.target.value)} />
      <input value={email} onChange={e => setEmail(e.target.value)} />
      <button disabled={loading}>
        {loading ? '提交中...' : '提交'}
      </button>
    </form>
  );
}
```

这段代码存在几个问题：
- 需要手动管理 loading 状态
- 需要创建单独的 API 路由
- 客户端和服务端代码分离

### Server Actions 的解决方案

Server Actions 让服务端函数可以直接被客户端调用：

```tsx
// 直接在服务端组件中定义 action
async function submitForm(formData: FormData) {
  'use server';

  const name = formData.get('name');
  const email = formData.get('email');

  // 直接操作数据库
  await db.users.create({ data: { name, email } });

  revalidatePath('/contacts');
}

// 服务端组件中直接使用
function ContactForm() {
  return (
    <form action={submitForm}>
      <input name="name" />
      <input name="email" />
      <button type="submit">提交</button>
    </form>
  );
}
```

## 核心概念

### 1. Server Action 定义

```tsx
// 在服务端组件中定义
async function createPost(formData: FormData) {
  'use server';

  const title = formData.get('title') as string;
  const content = formData.get('content') as string;

  await db.posts.create({
    data: { title, content },
  });

  revalidatePath('/posts');
}

// 在客户端组件中使用
export default function NewPostPage() {
  return (
    <form action={createPost}>
      <input name="title" required />
      <textarea name="content" required />
      <button type="submit">发布</button>
    </form>
  );
}
```

### 2. 客户端组件中使用

```tsx
'use client';

import { useActionState } from 'react';

async function addToCart(prevState: any, formData: FormData) {
  'use server';

  const productId = formData.get('productId') as string;
  const quantity = Number(formData.get('quantity'));

  try {
    await cartService.add(productId, quantity);
    revalidatePath('/cart');
    return { success: true, message: '已添加到购物车' };
  } catch (error) {
    return { success: false, message: '添加失败，请重试' };
  }
}

function ProductCard({ product }) {
  const [state, formAction, isPending] = useActionState(addToCart, null);

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={product.id} />
      <input type="number" name="quantity" defaultValue={1} min={1} />
      <button disabled={isPending}>
        {isPending ? '添加中...' : '加入购物车'}
      </button>
      {state?.message && (
        <p className={state.success ? 'text-green-500' : 'text-red-500'}>
          {state.message}
        </p>
      )}
    </form>
  );
}
```

### 3. 表单验证

```tsx
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().min(2, '姓名至少 2 个字符'),
  email: z.string().email('邮箱格式不正确'),
  age: z.number().min(18, '年龄必须大于 18'),
});

async function createUser(prevState: any, formData: FormData) {
  'use server';

  const data = {
    name: formData.get('name'),
    email: formData.get('email'),
    age: Number(formData.get('age')),
  };

  const result = UserSchema.safeParse(data);

  if (!result.success) {
    return {
      success: false,
      errors: result.error.flatten().fieldErrors,
    };
  }

  try {
    await db.users.create({ data: result.data });
    revalidatePath('/users');
    return { success: true, message: '创建成功' };
  } catch (error) {
    return { success: false, message: '创建失败' };
  }
}

function CreateUserForm() {
  const [state, formAction, isPending] = useActionState(createUser, null);

  return (
    <form action={formAction}>
      <div>
        <input name="name" placeholder="姓名" />
        {state?.errors?.name && (
          <p className="text-red-500">{state.errors.name[0]}</p>
        )}
      </div>
      <div>
        <input name="email" type="email" placeholder="邮箱" />
        {state?.errors?.email && (
          <p className="text-red-500">{state.errors.email[0]}</p>
        )}
      </div>
      <div>
        <input name="age" type="number" placeholder="年龄" />
        {state?.errors?.age && (
          <p className="text-red-500">{state.errors.age[0]}</p>
        )}
      </div>
      <button disabled={isPending}>创建</button>
    </form>
  );
}
```

## 实战场景

### 1. 评论系统

```tsx
// app/posts/[id]/page.tsx
import { auth } from '@/lib/auth';

async function addComment(postId: string, prevState: any, formData: FormData) {
  'use server';

  const session = await auth();
  if (!session?.user) {
    return { success: false, message: '请先登录' };
  }

  const content = formData.get('content') as string;
  if (!content.trim()) {
    return { success: false, message: '评论内容不能为空' };
  }

  try {
    await db.comments.create({
      data: {
        postId,
        userId: session.user.id,
        content,
      },
    });

    revalidatePath(`/posts/${postId}`);
    return { success: true, message: '评论成功' };
  } catch (error) {
    return { success: false, message: '评论失败' };
  }
}

export default async function PostPage({ params }) {
  const post = await db.posts.findUnique({ where: { id: params.id } });

  return (
    <article>
      <h1>{post.title}</h1>
      <p>{post.content}</p>

      <Comments postId={params.id} />
    </article>
  );
}

function Comments({ postId }) {
  const [state, formAction, isPending] = useActionState(
    addComment.bind(null, postId),
    null
  );

  return (
    <section>
      <h2>评论</h2>
      <form action={formAction}>
        <textarea name="content" rows={4} placeholder="写下你的评论..." />
        <button disabled={isPending}>
          {isPending ? '提交中...' : '发表评论'}
        </button>
      </form>
      {state?.message && (
        <p className={state.success ? 'text-green-500' : 'text-red-500'}>
          {state.message}
        </p>
      )}
    </section>
  );
}
```

### 2. 乐观更新

```tsx
import { useOptimistic } from 'react';

async function toggleLike(postId: string) {
  'use server';

  const session = await auth();
  if (!session?.user) return;

  const existingLike = await db.likes.findUnique({
    where: {
      postId_userId: { postId, userId: session.user.id },
    },
  });

  if (existingLike) {
    await db.likes.delete({ where: { id: existingLike.id } });
  } else {
    await db.likes.create({
      data: { postId, userId: session.user.id },
    });
  }

  revalidatePath(`/posts/${postId}`);
}

function LikeButton({ postId, initialLikes, isLiked }) {
  const [optimisticLikes, addOptimisticLike] = useOptimistic(
    initialLikes,
    (state, action) => {
      return action.type === 'like' ? state + 1 : state - 1;
    }
  );

  const handleClick = async () => {
    addOptimisticLike({ type: isLiked ? 'unlike' : 'like' });
    await toggleLike(postId);
  };

  return (
    <form action={handleClick}>
      <button type="submit">
        {isLiked ? '❤️' : '🤍'} {optimisticLikes}
      </button>
    </form>
  );
}
```

### 3. 多步骤表单

```tsx
// 多步骤表单的状态通过隐藏字段传递
async function multiStepForm(prevState: any, formData: FormData) {
  'use server';

  const step = Number(formData.get('step'));

  if (step === 1) {
    // 验证第一步
    const name = formData.get('name');
    if (!name) {
      return { success: false, step: 1, message: '姓名不能为空' };
    }
    // 返回第一步数据，进入第二步
    return {
      success: true,
      step: 2,
      data: { name },
      message: '请继续填写',
    };
  }

  if (step === 2) {
    // 收集所有数据并提交
    const name = formData.get('name');
    const email = formData.get('email');
    await db.users.create({ data: { name, email } });
    return { success: true, message: '提交成功' };
  }
}

function MultiStepForm() {
  const [state, formAction, isPending] = useActionState(multiStepForm, {
    step: 1,
    data: {},
  });

  return (
    <form action={formAction}>
      <input type="hidden" name="step" value={state.step} />
      <input type="hidden" name="name" value={state.data?.name} />

      {state.step === 1 && (
        <>
          <input name="name" placeholder="姓名" />
          <button disabled={isPending}>下一步</button>
        </>
      )}

      {state.step === 2 && (
        <>
          <input name="email" type="email" placeholder="邮箱" />
          <button disabled={isPending}>提交</button>
        </>
      )}

      {state.message && (
        <p className={state.success ? 'text-green-500' : 'text-red-500'}>
          {state.message}
        </p>
      )}
    </form>
  );
}
```

## 性能优化

### 1. 合理使用 revalidatePath

```tsx
// ❌ 不推荐：每次操作都重新验证整个页面
await db.posts.create({ data });
revalidatePath('/');

// ✅ 推荐：只重新验证受影响的路径
await db.posts.create({ data });
revalidatePath('/posts');
revalidatePath(`/posts/${newPost.id}`);
```

### 2. 使用 revalidateTag

```tsx
// 定义标签
import { unstable_cache } from 'next/cache';

const getPosts = unstable_cache(
  async () => {
    return db.posts.findMany();
  },
  ['posts'],
  { tags: ['posts'] }
);

// 操作后只失效特定标签
await db.posts.create({ data });
revalidateTag('posts');
```

### 3. 避免不必要的序列化

```tsx
// ❌ 不推荐：传递整个对象
async function updatePost(post: Post) {
  'use server';
  await db.posts.update({ where: { id: post.id }, data: post });
}

// ✅ 推荐：只传递需要的字段
async function updatePost(id: string, title: string) {
  'use server';
  await db.posts.update({ where: { id }, data: { title } });
}
```

## 总结

Server Actions 彻底改变了 Next.js 的表单处理方式。关键要点：

1. **简化代码**：无需单独的 API 路由，直接在组件中定义服务端逻辑
2. **类型安全**：服务端和客户端代码可以共享类型
3. **内置优化**：自动的 loading 状态、错误处理、重新验证
4. **渐进增强**：即使 JavaScript 加载失败，表单也能工作

Server Actions 不是银弹，对于复杂的客户端交互（如拖拽、实时协作），仍然需要传统的 API 方式。但对于大多数表单处理场景，Server Actions 是更好的选择。
