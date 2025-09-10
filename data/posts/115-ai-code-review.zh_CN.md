---
title: "AI 代码审查实践：让 AI 帮你 Code Review"
tag: ai
description: 实践 AI 驱动的代码审查，涵盖 Prompt 设计、集成工作流、质量评估与最佳实践
date: "2025-09-10T10:00:00.000Z"
---

## 目标

代码审查（Code Review）是保证代码质量的关键环节，但人工审查耗时耗力。AI 代码审查可以作为人类审查的有力补充——它能快速发现常见问题、提供改进建议，并且 24/7 可用。本文将介绍如何构建和使用 AI 代码审查系统。

## 背景

### AI 代码审查的优势

| 维度 | 人工审查 | AI 审查 |
|------|----------|---------|
| 速度 | 需要等待 | 即时反馈 |
| 覆盖面 | 依赖经验 | 全面覆盖 |
| 一致性 | 因人而异 | 标准统一 |
| 可用性 | 工作时间 | 24/7 |
| 成本 | 人力成本高 | 相对低廉 |

### AI 审查的局限

- 可能遗漏业务逻辑问题
- 可能产生误报（False Positive）
- 无法替代人类的架构级审查
- 需要结合项目规范进行定制

## 构建 AI 审查系统

### 核心架构

```
┌─────────────────────────────────────────────────────────┐
│                    代码变更                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   Git Diff  │  │  PR/MR Info │  │  Context    │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    AI 审查引擎                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │   规则引擎  │  │   LLM 分析  │  │  上下文增强 │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    输出层                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  PR 评论    │  │  修复建议   │  │  质量报告   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### 审查 Prompt 设计

```typescript
// ai-review/prompts.ts

export const CODE_REVIEW_PROMPT = `你是一位资深的代码审查专家。请审查以下代码变更，并提供详细的反馈。

## 审查维度

### 1. 代码质量
- 命名是否清晰、符合规范？
- 代码是否可读、可维护？
- 是否有重复代码可以提取？

### 2. 潜在 Bug
- 是否有逻辑错误？
- 边界情况是否处理？
- 空值/异常是否处理？

### 3. 性能问题
- 是否有不必要的重渲染？
- 是否有内存泄漏风险？
- 是否有算法优化空间？

### 4. 安全漏洞
- 是否有 XSS 风险？
- 是否有注入漏洞？
- 敏感信息是否泄露？

### 5. 最佳实践
- 是否遵循框架最佳实践？
- 是否符合项目规范？
- 是否有更优雅的实现方式？

## 输出格式

对于每个问题，请按以下格式输出：

\`\`\`
[严重程度: 高/中/低] [类型: bug/performance/security/quality/best-practice]

**问题描述：** 简要说明问题

**影响范围：** 说明可能的影响

**修复建议：** 提供具体的修复方案（含代码示例）
\`\`\`

如果没有发现问题，请说明代码的优点。

## 代码变更

{diff}
`;

export const PR_SUMMARY_PROMPT = `请根据以下代码变更，生成一个简洁的 PR 描述。

## 要求
1. 使用中文
2. 包含变更目的
3. 列出主要改动
4. 说明注意事项（如果有）

## 代码变更

{diff}
`;
```

### 审查引擎实现

```typescript
// ai-review/engine.ts
import { Anthropic } from '@anthropic-ai/sdk';
import { CODE_REVIEW_PROMPT } from './prompts';

interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
  score: number;
}

interface ReviewIssue {
  severity: 'high' | 'medium' | 'low';
  type: 'bug' | 'performance' | 'security' | 'quality' | 'best-practice';
  description: string;
  impact: string;
  suggestion: string;
  line?: number;
}

class AIReviewEngine {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async reviewCode(diff: string, context?: string): Promise<ReviewResult> {
    const prompt = CODE_REVIEW_PROMPT.replace('{diff}', diff);

    const response = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';

    return this.parseReviewResult(content);
  }

  private parseReviewResult(content: string): ReviewResult {
    const issues: ReviewIssue[] = [];
    const lines = content.split('\n');
    
    let currentIssue: Partial<ReviewIssue> | null = null;

    for (const line of lines) {
      const issueMatch = line.match(/\[严重程度:\s*(高|中|低)\]\s*\[类型:\s*(\w+)\]/);
      if (issueMatch) {
        if (currentIssue) {
          issues.push(currentIssue as ReviewIssue);
        }
        currentIssue = {
          severity: issueMatch[1] === '高' ? 'high' : issueMatch[1] === '中' ? 'medium' : 'low',
          type: issueMatch[2] as ReviewIssue['type'],
        };
      }

      if (currentIssue) {
        if (line.startsWith('**问题描述：**')) {
          currentIssue.description = line.replace('**问题描述：**', '').trim();
        } else if (line.startsWith('**影响范围：**')) {
          currentIssue.impact = line.replace('**影响范围：**', '').trim();
        } else if (line.startsWith('**修复建议：**')) {
          currentIssue.suggestion = line.replace('**修复建议：**', '').trim();
        }
      }
    }

    if (currentIssue) {
      issues.push(currentIssue as ReviewIssue);
    }

    const score = this.calculateScore(issues);

    return {
      issues,
      summary: this.generateSummary(issues),
      score,
    };
  }

  private calculateScore(issues: ReviewIssue[]): number {
    let score = 100;
    
    for (const issue of issues) {
      switch (issue.severity) {
        case 'high':
          score -= 20;
          break;
        case 'medium':
          score -= 10;
          break;
        case 'low':
          score -= 5;
          break;
      }
    }

    return Math.max(0, score);
  }

  private generateSummary(issues: ReviewIssue[]): string {
    const highCount = issues.filter(i => i.severity === 'high').length;
    const mediumCount = issues.filter(i => i.severity === 'medium').length;
    const lowCount = issues.filter(i => i.severity === 'low').length;

    if (issues.length === 0) {
      return '代码质量很好，没有发现问题。';
    }

    return `发现 ${issues.length} 个问题：${highCount} 个高优先级，${mediumCount} 个中优先级，${lowCount} 个低优先级。`;
  }
}
```

### GitHub Actions 集成

```yaml
# .github/workflows/ai-review.yml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  ai-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get PR diff
        id: diff
        run: |
          DIFF=$(git diff origin/${{ github.base_ref }}...HEAD)
          echo "diff<<EOF" >> $GITHUB_OUTPUT
          echo "$DIFF" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: AI Review
        uses: ./ai-review-action
        with:
          diff: ${{ steps.diff.outputs.diff }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          ai-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

```typescript
// ai-review-action/index.ts
import * as core from '@actions/core';
import * as github from '@actions/github';
import { AIReviewEngine } from '../ai-review/engine';

async function run() {
  const diff = core.getInput('diff');
  const apiKey = core.getInput('ai-api-key');
  
  const engine = new AIReviewEngine(apiKey);
  const result = await engine.reviewCode(diff);

  const octokit = github.getOctokit(core.getInput('github-token'));
  const { owner, repo, number } = github.context.issue;

  const body = formatReviewComment(result);
  
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body,
  });

  if (result.score < 60) {
    core.setFailed('代码审查未通过，分数低于 60');
  }
}

function formatReviewComment(result: any): string {
  let comment = `## AI 代码审查报告\n\n`;
  comment += `**总分：** ${result.score}/100\n\n`;
  comment += `**摘要：** ${result.summary}\n\n`;

  if (result.issues.length > 0) {
    comment += `### 发现的问题\n\n`;
    for (const issue of result.issues) {
      const severityEmoji = {
        high: '🔴',
        medium: '🟡',
        low: '🟢',
      }[issue.severity];

      comment += `#### ${severityEmoji} [${issue.severity.toUpperCase()}] ${issue.type}\n\n`;
      comment += `**问题：** ${issue.description}\n\n`;
      comment += `**影响：** ${issue.impact}\n\n`;
      comment += `**建议：** ${issue.suggestion}\n\n`;
      comment += `---\n\n`;
    }
  } else {
    comment += `### ✅ 代码质量良好\n\n没有发现明显问题。\n`;
  }

  return comment;
}

run().catch(console.error);
```

## 使用示例

### 本地使用

```typescript
// scripts/review.ts
import { AIReviewEngine } from '../ai-review/engine';
import { execSync } from 'child_process';
import * as fs from 'fs';

async function main() {
  const diff = execSync('git diff main...HEAD', { encoding: 'utf-8' });

  const engine = new AIReviewEngine(process.env.ANTHROPIC_API_KEY!);
  const result = await engine.reviewCode(diff);

  console.log('\n=== AI 代码审查报告 ===\n');
  console.log(`总分：${result.score}/100`);
  console.log(`摘要：${result.summary}\n`);

  if (result.issues.length > 0) {
    console.log('发现问题：\n');
    for (const issue of result.issues) {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.description}`);
      console.log(`建议：${issue.suggestion}\n`);
    }
  }

  fs.writeFileSync('review-report.md', formatMarkdown(result));
  console.log('报告已保存到 review-report.md');
}

main();
```

## 质量评估

### 评估指标

```typescript
interface ReviewMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
}

function calculateMetrics(
  aiIssues: ReviewIssue[],
  humanIssues: ReviewIssue[]
): ReviewMetrics {
  const aiSet = new Set(aiIssues.map(i => `${i.type}:${i.description}`));
  const humanSet = new Set(humanIssues.map(i => `${i.type}:${i.description}`));

  const truePositives = [...aiSet].filter(x => humanSet.has(x)).length;
  const falsePositives = [...aiSet].filter(x => !humanSet.has(x)).length;
  const falseNegatives = [...humanSet].filter(x => !aiSet.has(x)).length;

  const precision = truePositives / (truePositives + falsePositives) || 0;
  const recall = truePositives / (truePositives + falseNegatives) || 0;
  const f1Score = 2 * (precision * recall) / (precision + recall) || 0;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1Score,
  };
}
```

## 总结

AI 代码审查的最佳实践：

1. **Prompt 工程**：设计清晰、结构化的审查 Prompt
2. **渐进式集成**：先作为建议，再逐步增加权重
3. **人工复核**：AI 审查结果需要人工确认
4. **持续优化**：根据误报/漏报调整策略
5. **团队规范**：结合项目规范定制审查规则

AI 代码审查不是要取代人类审查，而是作为强大的辅助工具，提高审查效率和覆盖率。最佳实践是让 AI 处理低级问题，人类专注于架构和业务逻辑。