---
title: "Server Actions First Look: A New Paradigm for Next.js Form Handling"
tag: nextjs
description: Deep dive into Next.js Server Actions' core concepts and practical applications, from form handling to data mutations, exploring the new paradigm of server-side operations.
date: "2023-10-25T08:00:00.000Z"
---

## Goal

Traditional frontend form handling involves a lot of boilerplate code: event handling, API routes, optimistic updates, error handling. Server Actions is a new feature introduced in Next.js 14 that allows executing functions directly on the server, greatly simplifying the form handling workflow. This article deeply explains the core concepts, use cases, and best practices of Server Actions.

## Background

### Traditional Form Handling Pain Points

Before Next.js App Router, form handling required:

```tsx
// 1. Client component
'use client';

function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // 2. Call API route
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });

      if (!res.ok) throw new Error('Submission failed');

      // 3. Handle success
      toast.success('Submitted successfully');
    } catch (error) {
      // 4. Handle error
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
        {loading ? 'Submitting...' : 'Submit'}
      </button>
    </form>
  );
}
```

This code has several issues:
- Requires manual loading state management
- Requires creating separate API routes
- Client and server code are separated

### Server Actions Solution

Server Actions allow server-side functions to be called directly from the client:

```tsx
// Define action directly in server component
async function submitForm(formData: FormData) {
  'use server';

  const name = formData.get('name');
  const email = formData.get('email');

  // Directly operate database
  await db.users.create({ data: { name, email } });

  revalidatePath('/contacts');
}

// Use directly in server component
function ContactForm() {
  return (
    <form action={submitForm}>
      <input name="name" />
      <input name="email" />
      <button type="submit">Submit</button>
    </form>
  );
}
```

## Core Concepts

### 1. Server Action Definition

```tsx
// Define in server component
async function createPost(formData: FormData) {
  'use server';

  const title = formData.get('title') as string;
  const content = formData.get('content') as string;

  await db.posts.create({
    data: { title, content },
  });

  revalidatePath('/posts');
}

// Use in client component
export default function NewPostPage() {
  return (
    <form action={createPost}>
      <input name="title" required />
      <textarea name="content" required />
      <button type="submit">Publish</button>
    </form>
  );
}
```

### 2. Usage in Client Components

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
    return { success: true, message: 'Added to cart' };
  } catch (error) {
    return { success: false, message: 'Failed to add, please try again' };
  }
}

function ProductCard({ product }) {
  const [state, formAction, isPending] = useActionState(addToCart, null);

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={product.id} />
      <input type="number" name="quantity" defaultValue={1} min={1} />
      <button disabled={isPending}>
        {isPending ? 'Adding...' : 'Add to Cart'}
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

### 3. Form Validation

```tsx
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email format'),
  age: z.number().min(18, 'Age must be at least 18'),
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
    return { success: true, message: 'Created successfully' };
  } catch (error) {
    return { success: false, message: 'Failed to create' };
  }
}

function CreateUserForm() {
  const [state, formAction, isPending] = useActionState(createUser, null);

  return (
    <form action={formAction}>
      <div>
        <input name="name" placeholder="Name" />
        {state?.errors?.name && (
          <p className="text-red-500">{state.errors.name[0]}</p>
        )}
      </div>
      <div>
        <input name="email" type="email" placeholder="Email" />
        {state?.errors?.email && (
          <p className="text-red-500">{state.errors.email[0]}</p>
        )}
      </div>
      <div>
        <input name="age" type="number" placeholder="Age" />
        {state?.errors?.age && (
          <p className="text-red-500">{state.errors.age[0]}</p>
        )}
      </div>
      <button disabled={isPending}>Create</button>
    </form>
  );
}
```

## Practical Scenarios

### 1. Comment System

```tsx
// app/posts/[id]/page.tsx
import { auth } from '@/lib/auth';

async function addComment(postId: string, prevState: any, formData: FormData) {
  'use server';

  const session = await auth();
  if (!session?.user) {
    return { success: false, message: 'Please login first' };
  }

  const content = formData.get('content') as string;
  if (!content.trim()) {
    return { success: false, message: 'Comment cannot be empty' };
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
    return { success: true, message: 'Comment posted successfully' };
  } catch (error) {
    return { success: false, message: 'Failed to post comment' };
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
      <h2>Comments</h2>
      <form action={formAction}>
        <textarea name="content" rows={4} placeholder="Write your comment..." />
        <button disabled={isPending}>
          {isPending ? 'Posting...' : 'Post Comment'}
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

### 2. Optimistic Updates

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

### 3. Multi-Step Form

```tsx
// Multi-step form state passed through hidden fields
async function multiStepForm(prevState: any, formData: FormData) {
  'use server';

  const step = Number(formData.get('step'));

  if (step === 1) {
    // Validate first step
    const name = formData.get('name');
    if (!name) {
      return { success: false, step: 1, message: 'Name cannot be empty' };
    }
    // Return first step data, proceed to second step
    return {
      success: true,
      step: 2,
      data: { name },
      message: 'Please continue',
    };
  }

  if (step === 2) {
    // Collect all data and submit
    const name = formData.get('name');
    const email = formData.get('email');
    await db.users.create({ data: { name, email } });
    return { success: true, message: 'Submitted successfully' };
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
          <input name="name" placeholder="Name" />
          <button disabled={isPending}>Next</button>
        </>
      )}

      {state.step === 2 && (
        <>
          <input name="email" type="email" placeholder="Email" />
          <button disabled={isPending}>Submit</button>
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

## Performance Optimization

### 1. Use revalidatePath Appropriately

```tsx
// ❌ Not recommended: Revalidate entire page on every operation
await db.posts.create({ data });
revalidatePath('/');

// ✅ Recommended: Only revalidate affected paths
await db.posts.create({ data });
revalidatePath('/posts');
revalidatePath(`/posts/${newPost.id}`);
```

### 2. Use revalidateTag

```tsx
// Define tags
import { unstable_cache } from 'next/cache';

const getPosts = unstable_cache(
  async () => {
    return db.posts.findMany();
  },
  ['posts'],
  { tags: ['posts'] }
);

// After operation, only invalidate specific tags
await db.posts.create({ data });
revalidateTag('posts');
```

### 3. Avoid Unnecessary Serialization

```tsx
// ❌ Not recommended: Pass entire object
async function updatePost(post: Post) {
  'use server';
  await db.posts.update({ where: { id: post.id }, data: post });
}

// ✅ Recommended: Only pass required fields
async function updatePost(id: string, title: string) {
  'use server';
  await db.posts.update({ where: { id }, data: { title } });
}
```

## Conclusion

Server Actions have fundamentally changed how Next.js handles forms. Key takeaways:

1. **Simplified code**: No need for separate API routes, define server logic directly in components
2. **Type safety**: Server and client code can share types
3. **Built-in optimizations**: Automatic loading states, error handling, revalidation
4. **Progressive enhancement**: Forms work even if JavaScript fails to load

Server Actions are not a silver bullet. For complex client interactions (like drag-and-drop, real-time collaboration), traditional API approaches are still needed. But for most form handling scenarios, Server Actions are the better choice.
