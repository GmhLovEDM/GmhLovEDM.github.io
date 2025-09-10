---
title: "AI Code Review in Practice: Let AI Help You Code Review"
tag: ai
description: Implementing AI-driven code review, covering Prompt design, workflow integration, quality evaluation, and best practices
date: "2025-09-10T10:00:00.000Z"
---

## Goal

Code Review is a critical process for ensuring code quality, but manual review is time-consuming and labor-intensive. AI code review can serve as a powerful complement to human review -- it can quickly identify common issues, provide improvement suggestions, and is available 24/7. This article introduces how to build and use an AI code review system.

## Background

### Advantages of AI Code Review

| Dimension | Manual Review | AI Review |
|-----------|--------------|-----------|
| Speed | Requires waiting | Instant feedback |
| Coverage | Experience-dependent | Comprehensive |
| Consistency | Varies by person | Standardized |
| Availability | Working hours | 24/7 |
| Cost | High labor cost | Relatively low |

### Limitations of AI Review

- May miss business logic issues
- May produce false positives
- Cannot replace human architectural-level review
- Needs customization based on project standards

## Building the AI Review System

### Core Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Code Changes                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  Git Diff   │  │  PR/MR Info │  │   Context   │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    AI Review Engine                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ Rule Engine │  │  LLM Analysis│  │  Context    │     │
│  │             │  │             │  │  Enhancement│     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
├─────────────────────────────────────────────────────────┤
│                    Output Layer                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  PR Comments│  │ Fix Suggestions│ │ Quality     │     │
│  │             │  │             │  │  Report     │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
```

### Review Prompt Design

```typescript
export const CODE_REVIEW_PROMPT = `You are a senior code review expert. Please review the following code changes and provide detailed feedback.

## Review Dimensions

### 1. Code Quality
- Are naming conventions clear and consistent?
- Is the code readable and maintainable?
- Is there duplicated code that could be extracted?

### 2. Potential Bugs
- Are there logic errors?
- Are edge cases handled?
- Are null values/exceptions handled?

### 3. Performance Issues
- Are there unnecessary re-renders?
- Are there memory leak risks?
- Is there room for algorithm optimization?

### 4. Security Vulnerabilities
- Are there XSS risks?
- Are there injection vulnerabilities?
- Is sensitive information leaked?

### 5. Best Practices
- Does it follow framework best practices?
- Does it comply with project standards?
- Is there a more elegant implementation?

## Output Format

For each issue, output in the following format:

\`\`\`
[Severity: HIGH/MEDIUM/LOW] [Type: bug/performance/security/quality/best-practice]

**Description:** Brief description of the issue

**Impact:** Potential impact

**Fix Suggestion:** Specific fix suggestion (with code example)
\`\`\`

If no issues are found, describe the code's strengths.

## Code Changes

{diff}
`;

export const PR_SUMMARY_PROMPT = `Generate a concise PR description based on the following code changes.

## Requirements
1. Include the purpose of changes
2. List main changes
3. Note any caveats (if applicable)

## Code Changes

{diff}
`;
```

### Review Engine Implementation

```typescript
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

    const content = response.content[0].type === 'text' ? response.content[0].text : '';

    return this.parseReviewResult(content);
  }

  private parseReviewResult(content: string): ReviewResult {
    const issues: ReviewIssue[] = [];
    const lines = content.split('\n');
    let currentIssue: Partial<ReviewIssue> | null = null;

    for (const line of lines) {
      const issueMatch = line.match(/\[Severity:\s*(HIGH|MEDIUM|LOW)\]\s*\[Type:\s*(\w+)\]/i);
      if (issueMatch) {
        if (currentIssue) issues.push(currentIssue as ReviewIssue);
        currentIssue = {
          severity: issueMatch[1].toLowerCase() as ReviewIssue['severity'],
          type: issueMatch[2] as ReviewIssue['type'],
        };
      }

      if (currentIssue) {
        if (line.startsWith('**Description:**')) currentIssue.description = line.replace('**Description:**', '').trim();
        else if (line.startsWith('**Impact:**')) currentIssue.impact = line.replace('**Impact:**', '').trim();
        else if (line.startsWith('**Fix Suggestion:**')) currentIssue.suggestion = line.replace('**Fix Suggestion:**', '').trim();
      }
    }

    if (currentIssue) issues.push(currentIssue as ReviewIssue);

    const score = this.calculateScore(issues);

    return { issues, summary: this.generateSummary(issues), score };
  }

  private calculateScore(issues: ReviewIssue[]): number {
    let score = 100;
    for (const issue of issues) {
      switch (issue.severity) {
        case 'high': score -= 20; break;
        case 'medium': score -= 10; break;
        case 'low': score -= 5; break;
      }
    }
    return Math.max(0, score);
  }

  private generateSummary(issues: ReviewIssue[]): string {
    if (issues.length === 0) return 'Code quality is good. No issues found.';
    const high = issues.filter(i => i.severity === 'high').length;
    const med = issues.filter(i => i.severity === 'medium').length;
    const low = issues.filter(i => i.severity === 'low').length;
    return `Found ${issues.length} issues: ${high} high priority, ${med} medium priority, ${low} low priority.`;
  }
}
```

### GitHub Actions Integration

```yaml
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

## Usage Examples

### Local Usage

```typescript
import { AIReviewEngine } from '../ai-review/engine';
import { execSync } from 'child_process';
import * as fs from 'fs';

async function main() {
  const diff = execSync('git diff main...HEAD', { encoding: 'utf-8' });

  const engine = new AIReviewEngine(process.env.ANTHROPIC_API_KEY!);
  const result = await engine.reviewCode(diff);

  console.log('\n=== AI Code Review Report ===\n');
  console.log(`Score: ${result.score}/100`);
  console.log(`Summary: ${result.summary}\n`);

  if (result.issues.length > 0) {
    console.log('Issues Found:\n');
    for (const issue of result.issues) {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.description}`);
      console.log(`Suggestion: ${issue.suggestion}\n`);
    }
  }

  fs.writeFileSync('review-report.md', formatMarkdown(result));
  console.log('Report saved to review-report.md');
}

main();
```

## Quality Evaluation

### Metrics

```typescript
interface ReviewMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1Score: number;
}

function calculateMetrics(aiIssues: ReviewIssue[], humanIssues: ReviewIssue[]): ReviewMetrics {
  const aiSet = new Set(aiIssues.map(i => `${i.type}:${i.description}`));
  const humanSet = new Set(humanIssues.map(i => `${i.type}:${i.description}`));

  const truePositives = [...aiSet].filter(x => humanSet.has(x)).length;
  const falsePositives = [...aiSet].filter(x => !humanSet.has(x)).length;
  const falseNegatives = [...humanSet].filter(x => !aiSet.has(x)).length;

  const precision = truePositives / (truePositives + falsePositives) || 0;
  const recall = truePositives / (truePositives + falseNegatives) || 0;
  const f1Score = 2 * (precision * recall) / (precision + recall) || 0;

  return { truePositives, falsePositives, falseNegatives, precision, recall, f1Score };
}
```

## Summary

Best practices for AI code review:

1. **Prompt Engineering**: Design clear, structured review prompts.
2. **Gradual Integration**: Start with suggestions, then increase weight over time.
3. **Human Verification**: AI review results need human confirmation.
4. **Continuous Optimization**: Adjust strategies based on false positives/negatives.
5. **Team Standards**: Customize review rules based on project standards.

AI code review is not meant to replace human review but to serve as a powerful assistant tool that improves review efficiency and coverage. The best practice is to let AI handle low-level issues while humans focus on architecture and business logic.