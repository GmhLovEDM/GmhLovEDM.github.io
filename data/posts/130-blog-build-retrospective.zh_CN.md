---
title: "博客搭建复盘：用 Next.js + AI 打造个人技术博客的完整指南"
tag: misc
description: 复盘整个博客搭建过程，分享技术选型、架构设计、AI 辅助开发的经验与教训
date: "2026-07-10T10:00:00.000Z"
---

## 目标

写完 130 篇技术文章后，是时候复盘一下这个博客的搭建过程了。本文将分享使用 Next.js 和 AI 打造个人技术博客的完整经验，包括技术选型、架构设计、AI 辅助开发的实践，以及踩过的坑和学到的教训。

## 背景

### 为什么搭建这个博客

```markdown
## 搭建初衷

1. **知识沉淀**：将学习和实践经验系统化记录
2. **技术分享**：帮助其他开发者少走弯路
3. **个人品牌**：建立技术影响力
4. **学习驱动**：写作是最好的学习方式
```

### 技术选型决策

| 维度 | 选择 | 理由 |
|------|------|------|
| 框架 | Next.js 15 | React 生态 + SSR + 边缘部署 |
| 部署 | Vercel | 零配置部署 + 边缘网络 |
| 样式 | Tailwind CSS | 快速开发 + 一致性 |
| 内容 | Markdown | 简单、专注写作 |
| AI | Claude API | 辅助写作和翻译 |

## 架构设计

### 项目结构

```
blog/
├── app/                    # Next.js App Router
│   ├── layout.tsx         # 根布局
│   ├── page.tsx          # 首页
│   ├── blog/             # 博客页面
│   │   ├── [slug]/
│   │   │   └── page.tsx  # 文章详情
│   │   └── page.tsx      # 文章列表
│   └── api/              # API 路由
│       └── search/       # 搜索 API
├── components/           # 组件库
│   ├── BlogCard.tsx     # 文章卡片
│   ├── Header.tsx       # 导航头部
│   └── Footer.tsx       # 页脚
├── lib/                 # 工具库
│   ├── mdx.ts          # MDX 处理
│   └── search.ts       # 搜索功能
├── data/               # 内容数据
│   └── posts/          # 博客文章
└── public/             # 静态资源
```

### 核心配置

```typescript
// next.config.js
const nextConfig = {
  // 启用 MDX
  experimental: {
    mdxRs: true,
  },
  
  // 图片优化
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  
  // 性能优化
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production',
  },
};

module.exports = nextConfig;
```

### 内容管理

```typescript
// lib/mdx.ts
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
      
      return {
        id,
        ...(matterResult.data as { title: string; tag: string; description: string; date: string }),
      };
    });
  
  return allPostsData.sort((a, b) => {
    if (a.date < b.date) {
      return 1;
    } else {
      return -1;
    }
  });
}

export async function getPostData(id: string): Promise<PostData> {
  const fullPath = path.join(postsDirectory, `${id}.md`);
  const fileContents = fs.readFileSync(fullPath, 'utf8');
  
  const matterResult = matter(fileContents);
  
  const processedContent = await remark()
    .use(html)
    .process(matterResult.content);
  
  const contentHtml = processedContent.toString();
  
  return {
    id,
    content: contentHtml,
    ...(matterResult.data as { title: string; tag: string; description: string; date: string }),
  };
}
```

## AI 辅助开发

### 使用 AI 生成文章

```typescript
// ai/content-generator.ts
import Anthropic from '@anthropic-ai/sdk';

class ContentGenerator {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  async generateArticle(
    topic: string,
    category: string
  ): Promise<{ title: string; content: string }> {
    const prompt = `
你是一位技术博客作者。请为以下主题撰写一篇深度技术文章。

主题：${topic}
分类：${category}

要求：
1. 文章长度：800-1500 字
2. 包含"目标"和"背景"部分
3. 有实际的代码示例
4. 有实用的建议和总结
5. 使用中文撰写

请输出 JSON 格式：
{
  "title": "文章标题",
  "content": "文章内容（Markdown 格式）
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-5-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = JSON.parse(response.content[0].text);
    return result;
  }

  async translateArticle(
    article: string,
    targetLanguage: 'en' | 'zh'
  ): Promise<string> {
    const prompt = `
将以下技术文章翻译成${targetLanguage === 'en' ? '英文' : '中文'}。

要求：
1. 保持技术术语的准确性
2. 保持文章的结构
3. 保持代码示例不变

文章：
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

### 使用 AI 优化 SEO

```typescript
// ai/seo-optimizer.ts
class SEOOptimizer {
  async generateMetaTags(
    title: string,
    content: string
  ): Promise<{
    description: string;
    keywords: string[];
    ogTitle: string;
    ogDescription: string;
  }> {
    const prompt = `
为以下技术文章生成 SEO 优化的元数据。

标题：${title}
内容预览：${content.substring(0, 500)}...

请输出 JSON 格式：
{
  "description": "150 字以内的描述",
  "keywords": ["关键词1", "关键词2"],
  "ogTitle": "Open Graph 标题",
  "ogDescription": "Open Graph 描述"
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

## 性能优化

### Core Web Vitals 优化

```typescript
// 1. 图片优化
import Image from 'next/image';

function OptimizedImage({ src, alt }: { src: string; alt: string }) {
  return (
    <Image
      src={src}
      alt={alt}
      width={800}
      height={400}
      priority={false}
      placeholder="blur"
      blurDataURL="data:image/png;base64,..."
    />
  );
}

// 2. 字体优化
import { Inter } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
});

// 3. 代码分割
const SearchComponent = dynamic(() => import('./Search'), {
  loading: () => <p>加载中...</p>,
});

// 4. 静态生成
export async function generateStaticParams() {
  const posts = getSortedPostsData();
  return posts.map((post) => ({
    slug: post.id,
  }));
}
```

### 部署配置

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
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        }
      ]
    }
  ]
}
```

## 踩过的坑

### 1. Markdown 处理问题

```typescript
// 问题：中文标点导致的解析错误
// 解决：使用 remark-gfm 和自定义插件

import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

const remarkPlugins = [
  remarkGfm,
  remarkBreaks,
  // 自定义插件处理中文标点
  () => (tree: any) => {
    // 处理逻辑
  },
];
```

### 2. 搜索性能问题

```typescript
// 问题：文章多了搜索变慢
// 解决：使用 FlexSearch 构建索引

import FlexSearch from 'flexsearch';

const index = new FlexSearch.Document({
  document: {
    id: 'id',
    index: ['title', 'content', 'tag'],
    store: ['title', 'description', 'date'],
  },
  tokenize: 'forward',
});

// 构建索引
posts.forEach(post => index.add(post));

// 搜索
function search(query: string) {
  return index.search(query, {
    enrich: true,
    limit: 10,
  });
}
```

### 3. 样式一致性问题

```typescript
// 问题：不同文章的样式不统一
// 解决：使用 CSS 变量和统一的样式系统

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

## 经验总结

### 技术选型建议

```markdown
## 个人博客技术选型建议

### 推荐方案
- **框架**：Next.js（React 生态）或 Nuxt（Vue 生态）
- **部署**：Vercel（零配置）或 Cloudflare Pages（免费额度高）
- **样式**：Tailwind CSS（快速开发）
- **内容**：Markdown + MDX（简单灵活）
- **搜索**：FlexSearch（本地搜索）或 Algolia（托管服务）

### 不推荐
- 复杂的 CMS 系统（个人博客不需要）
- 自建服务器（维护成本高）
- 过于复杂的架构（简单最好）
```

### 写作效率提升

```markdown
## AI 辅助写作工作流

### 1. 选题阶段
- 使用 AI 分析热门话题
- 生成文章大纲
- 评估文章价值

### 2. 写作阶段
- AI 生成初稿
- 人工优化和补充
- 添加代码示例

### 3. 优化阶段
- AI 优化 SEO
- 检查语法和拼写
- 生成摘要和标签

### 4. 发布阶段
- 自动化发布流程
- 社交媒体推广
- 数据分析和反馈
```

### 内容策略

```markdown
## 技术博客内容策略

### 内容类型
1. **教程类**：Step by step 的指南
2. **原理类**：深入分析技术原理
3. **实践类**：项目经验分享
4. **思考类**：行业趋势和思考

### 写作原则
1. **深度优先**：宁可少写，也要写深
2. **实用为主**：给读者可操作的建议
3. **持续更新**：定期更新旧文章
4. **原创为主**：AI 辅助，但保持原创性
```

## 未来规划

```markdown
## 博客未来规划

### 短期（3 个月）
- 完善搜索功能
- 添加评论系统
- 优化移动端体验
- 添加订阅功能

### 中期（6 个月）
- 支持多语言
- 添加 RSS 订阅
- 集成分析工具
- 优化 SEO

### 长期（1 年）
- 构建社区功能
- 开源博客模板
- 分享更多实战经验
```

## 总结

搭建个人技术博客的核心经验：

1. **技术选型**：简单为主，选择熟悉的技术栈
2. **AI 辅助**：善用 AI 提升效率，但保持原创性
3. **持续优化**：性能、SEO、用户体验持续改进
4. **内容为王**：技术再好，内容才是核心
5. **坚持写作**：最难的不是技术，而是坚持

### 给想搭建博客的朋友的建议

```markdown
## 立即行动

1. **不要完美主义**：先上线，再优化
2. **选择简单方案**：Next.js + Vercel 是最佳组合
3. **AI 辅助写作**：使用 AI 提升效率
4. **坚持更新**：每周至少一篇
5. **分享经验**：帮助他人就是帮助自己

记住：最好的博客是你正在写的博客。
```

---

*感谢你读到这里。如果这篇文章对你有帮助，欢迎分享给更多人。*

*博客地址：[https://blog.example.com](https://blog.example.com)*

*GitHub：[https://github.com/example/blog](https://github.com/example/blog)*