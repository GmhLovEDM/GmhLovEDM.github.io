---
title: "Blog Build Retrospective: A Complete Guide to Building a Personal Tech Blog with Next.js + AI"
tag: misc
description: Retrospecting the entire blog building process, sharing tech choices, architecture design, AI-assisted development experiences and lessons learned
date: "2026-07-10T10:00:00.000Z"
---

## Goal

After writing 130 technical articles, it is time to retrospect on the blog building process. This article shares the complete experience of building a personal tech blog using Next.js and AI, including tech choices, architecture design, AI-assisted development practices, pitfalls encountered, and lessons learned.

## Background

### Why Build This Blog

```markdown
## Original Motivation

1. **Knowledge Consolidation**: Systematically record learning and practical experience
2. **Technical Sharing**: Help other developers avoid common pitfalls
3. **Personal Branding**: Build technical influence
4. **Learning-Driven**: Writing is the best way to learn
```

### Tech Stack Decision

| Dimension | Choice | Rationale |
|-----------|--------|-----------|
| Framework | Next.js 15 | React ecosystem + SSR + edge deployment |
| Deployment | Vercel | Zero-config deployment + edge network |
| Styling | Tailwind CSS | Fast development + consistency |
| Content | Markdown | Simple, focused on writing |
| AI | Claude API | Assists writing and translation |

## Architecture Design

### Project Structure

```
blog/
├── app/                    # Next.js App Router
│   ├── layout.tsx         # Root layout
│   ├── page.tsx          # Homepage
│   ├── blog/             # Blog pages
│   │   ├── [slug]/
│   │   │   └── page.tsx  # Article detail
│   │   └── page.tsx      # Article list
│   └── api/              # API routes
│       └── search/       # Search API
├── components/           # Component library
│   ├── BlogCard.tsx     # Article card
│   ├── Header.tsx       # Navigation header
│   └── Footer.tsx       # Footer
├── lib/                 # Utility library
│   ├── mdx.ts          # MDX processing
│   └── search.ts       # Search functionality
├── data/               # Content data
│   └── posts/          # Blog articles
└── public/             # Static assets
```

### Core Configuration

```typescript
const nextConfig = {
  experimental: { mdxRs: true },
  images: { formats: ['image/avif', 'image/webp'] },
  compiler: { removeConsole: process.env.NODE_ENV === 'production' },
};

module.exports = nextConfig;
```

### Content Management

```typescript
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import html from 'remark-html';

const postsDirectory = path.join(process.cwd(), 'data/posts');

export interface PostData {
  id: string;
  title: string;
  tag: string;
  description: string;
  date: string;
  content?: string;
}

export function getSortedPostsData(): PostData[] {
  const fileNames = fs.readdirSync(postsDirectory);
  
  const allPostsData = fileNames
    .filter(fileName => fileName.endsWith('.md'))
    .map((fileName) => {
      const id = fileName.replace(/\.md$/, '');
      const fullPath = path.join(postsDirectory, fileName);
      const fileContents = fs.readFileSync(fullPath, 'utf8');
      const matterResult = matter(fileContents);
      
      return { id, ...(matterResult.data as { title: string; tag: string; description: string; date: string }) };
    });
  
  return allPostsData.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function getPostData(id: string): Promise<PostData> {
  const fullPath = path.join(postsDirectory, `${id}.md`);
  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const matterResult = matter(fileContents);
  const processedContent = await remark().use(html).process(matterResult.content);
  const contentHtml = processedContent.toString();
  
  return { id, content: contentHtml, ...(matterResult.data as { title: string; tag: string; description: string; date: string }) };
}
```

## AI-Assisted Development

### Using AI to Generate Articles

```typescript
import Anthropic from '@anthropic-ai/sdk';

class ContentGenerator {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async generateArticle(topic: string, category: string): Promise<{ title: string; content: string }> {
    const prompt = `You are a tech blog author. Write a deep technical article for the following topic.

Topic: ${topic}
Category: ${category}

Requirements:
1. Article length: 800-1500 words
2. Include "Goal" and "Background" sections
3. Include practical code examples
4. Include practical advice and summary
5. Write in English

Output JSON:
{
  "title": "article title",
  "content": "article content (Markdown format)"
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-5-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    return JSON.parse(response.content[0].text);
  }

  async translateArticle(article: string, targetLanguage: 'en' | 'zh'): Promise<string> {
    const prompt = `Translate the following technical article to ${targetLanguage === 'en' ? 'English' : 'Chinese'}.

Requirements:
1. Maintain accuracy of technical terminology
2. Maintain article structure
3. Keep code examples unchanged

Article:
${article}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-5-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0].text;
  }
}
```

### Using AI for SEO Optimization

```typescript
class SEOOptimizer {
  async generateMetaTags(title: string, content: string): Promise<{
    description: string;
    keywords: string[];
    ogTitle: string;
    ogDescription: string;
  }> {
    const prompt = `Generate SEO-optimized metadata for the following technical article.

Title: ${title}
Content preview: ${content.substring(0, 500)}...

Output JSON:
{
  "description": "description within 150 characters",
  "keywords": ["keyword1", "keyword2"],
  "ogTitle": "Open Graph title",
  "ogDescription": "Open Graph description"
}`;

    const response = await fetch('/api/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });

    return response.json();
  }
}
```

## Performance Optimization

### Core Web Vitals Optimization

```typescript
// 1. Image optimization
import Image from 'next/image';

function OptimizedImage({ src, alt }: { src: string; alt: string }) {
  return (
    <Image src={src} alt={alt} width={800} height={400} priority={false} placeholder="blur" blurDataURL="data:image/png;base64,..." />
  );
}

// 2. Font optimization
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], display: 'swap' });

// 3. Code splitting
const SearchComponent = dynamic(() => import('./Search'), {
  loading: () => <p>Loading...</p>,
});

// 4. Static generation
export async function generateStaticParams() {
  const posts = getSortedPostsData();
  return posts.map((post) => ({ slug: post.id }));
}
```

### Deployment Configuration

```json
{
  "framework": "nextjs",
  "buildCommand": "next build",
  "outputDirectory": ".next",
  "installCommand": "npm install",
  "regions": ["sin1", "hnd1", "sfo1"],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" }
      ]
    }
  ]
}
```

## Pitfalls Encountered

### 1. Markdown Processing Issues

```typescript
// Problem: Chinese punctuation causing parsing errors
// Solution: Use remark-gfm and custom plugins

import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const remarkPlugins = [
  remarkGfm,
  remarkBreaks,
  () => (tree: any) => {
    // Processing logic
  },
];
```

### 2. Search Performance Issues

```typescript
// Problem: Search becomes slow with many articles
// Solution: Use FlexSearch to build an index

import FlexSearch from 'flexsearch';

const index = new FlexSearch.Document({
  document: {
    id: 'id',
    index: ['title', 'content', 'tag'],
    store: ['title', 'description', 'date'],
  },
  tokenize: 'forward',
});

posts.forEach(post => index.add(post));

function search(query: string) {
  return index.search(query, { enrich: true, limit: 10 });
}
```

### 3. Style Consistency Issues

```typescript
// Problem: Inconsistent styles across articles
// Solution: Use CSS variables and unified style system

// globals.css
:root {
  --color-primary: #3b82f6;
  --color-secondary: #6b7280;
  --color-background: #ffffff;
  --color-text: #1f2937;
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
}
```

## Experience Summary

### Tech Stack Recommendations

```markdown
## Personal Blog Tech Stack Recommendations

### Recommended
- **Framework**: Next.js (React ecosystem) or Nuxt (Vue ecosystem)
- **Deployment**: Vercel (zero-config) or Cloudflare Pages (high free tier)
- **Styling**: Tailwind CSS (fast development)
- **Content**: Markdown + MDX (simple and flexible)
- **Search**: FlexSearch (local search) or Algolia (managed service)

### Not Recommended
- Complex CMS systems (personal blogs don't need them)
- Self-hosted servers (high maintenance cost)
- Overly complex architecture (simple is best)
```

### Writing Efficiency Improvement

```markdown
## AI-Assisted Writing Workflow

### 1. Topic Selection Phase
- Use AI to analyze trending topics
- Generate article outlines
- Evaluate article value

### 2. Writing Phase
- AI generates first draft
- Human optimization and supplementation
- Add code examples

### 3. Optimization Phase
- AI optimizes SEO
- Check grammar and spelling
- Generate summaries and tags

### 4. Publishing Phase
- Automated publishing workflow
- Social media promotion
- Data analysis and feedback
```

### Content Strategy

```markdown
## Tech Blog Content Strategy

### Content Types
1. **Tutorial**: Step-by-step guides
2. **Deep Dive**: In-depth technical analysis
3. **Practice**: Project experience sharing
4. **Thought**: Industry trends and reflections

### Writing Principles
1. **Depth First**: Write less but write deeper
2. **Practical Focus**: Give readers actionable advice
3. **Continuous Updates**: Regularly update old articles
4. **Original First**: AI-assisted but maintain originality
```

## Future Plans

```markdown
## Blog Future Plans

### Short-term (3 months)
- Improve search functionality
- Add comment system
- Optimize mobile experience
- Add subscription feature

### Mid-term (6 months)
- Support multi-language
- Add RSS subscription
- Integrate analytics tools
- Optimize SEO

### Long-term (1 year)
- Build community features
- Open-source blog template
- Share more practical experience
```

## Summary

Core experience for building a personal tech blog:

1. **Tech Stack**: Keep it simple, choose familiar technologies
2. **AI Assistance**: Leverage AI for efficiency while maintaining originality
3. **Continuous Optimization**: Performance, SEO, and user experience improvements
4. **Content is King**: No matter how good the technology, content is the core
5. **Keep Writing**: The hardest part is not the technology, but the persistence

### Advice for Friends Who Want to Build a Blog

```markdown
## Take Action Now

1. **Don't Be a Perfectionist**: Launch first, optimize later
2. **Choose Simple Solutions**: Next.js + Vercel is the best combination
3. **AI-Assisted Writing**: Use AI to improve efficiency
4. **Keep Updating**: At least one article per week
5. **Share Experience**: Helping others is helping yourself

Remember: The best blog is the one you are writing.
```

---

*Thank you for reading this far. If this article was helpful, feel free to share it with others.*

*Blog: [https://blog.example.com](https://blog.example.com)*

*GitHub: [https://github.com/example/blog](https://github.com/example/blog)*