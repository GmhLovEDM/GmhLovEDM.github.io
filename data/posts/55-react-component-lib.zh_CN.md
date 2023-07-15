---
title: "从零实现一个 React 组件库：基于 Radix UI 的最佳实践"
tag: react
description: 基于 Radix UI 无头组件，从零构建一套可复用、可访问、可主题化的 React 组件库，涵盖项目架构、样式方案、文档驱动开发等最佳实践。
date: "2023-07-15T08:00:00.000Z"
---

## 目标

团队内部组件库是提升研发效率和保证 UI 一致性的核心基础设施。本文以 Radix UI 为底层，从零搭建一套生产级 React 组件库，涵盖项目架构设计、样式系统选型、组件 API 设计、文档驱动开发以及发布流程。

## 背景

### 为什么需要自建组件库

市面上已有 Ant Design、Material UI 等成熟的组件库，但团队自建组件库仍然有其价值：

- **品牌定制**：商业产品需要独特的视觉风格，通用组件库难以满足
- **体积控制**：只包含业务需要的组件，避免打包无用代码
- **深度整合**：与团队的技术栈、设计规范、业务逻辑深度耦合
- **维护可控**：不受第三方库版本迭代的影响

### Radix UI 的价值

Radix UI 是一套「无头」（headless）组件库，它提供：

- **完整的无障碍（A11y）实现**：WAI-ARIA 规范、键盘导航、屏幕阅读器支持
- **逻辑与样式完全分离**：不包含任何 CSS，样式完全由开发者控制
- **行为可预测**：组合式 API，没有黑盒状态管理

## 项目架构设计

### 目录结构

```
my-ui-lib/
├── packages/
│   ├── core/              # 核心组件
│   │   ├── src/
│   │   │   ├── Button/
│   │   │   │   ├── Button.tsx
│   │   │   │   ├── Button.test.tsx
│   │   │   │   ├── Button.stories.tsx
│   │   │   │   └── index.ts
│   │   │   ├── Dialog/
│   │   │   ├── Select/
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── styles/            # 样式系统
│   │   ├── tokens/        # 设计 token
│   │   ├── components/    # 组件样式
│   │   └── index.ts
│   └── utils/             # 工具函数
├── docs/                  # 文档站点
├── turbo.json
├── package.json
└── pnpm-workspace.yaml
```

### Monorepo 配置

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
```

```json
{
  "name": "my-ui-lib",
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "storybook": "storybook dev -p 6006",
    "lint": "turbo run lint",
    "release": "changeset publish"
  }
}
```

## 样式系统设计

### 方案选型

组件库的样式方案有多种选择：

| 方案 | 优点 | 缺点 |
|------|------|------|
| CSS Modules | 零运行时、原生支持 | 类名不灵活 |
| Tailwind CSS | 开发效率高 | 包体积大、定制困难 |
| Vanilla Extract | 零运行时、类型安全 | 学习成本 |
| Styled Components | 运行时灵活 | 性能开销 |

对于组件库，推荐 **Vanilla Extract**，它的零运行时和类型安全特性非常适合构建可维护的样式系统。

### 设计 Token

```typescript
// packages/styles/tokens/index.ts
export const tokens = {
  colors: {
    primary: {
      50: '#eff6ff',
      100: '#dbeafe',
      200: '#bfdbfe',
      300: '#93c5fd',
      400: '#60a5fa',
      500: '#3b82f6',
      600: '#2563eb',
      700: '#1d4ed8',
      800: '#1e40af',
      900: '#1e3a8a',
    },
    gray: {
      50: '#f9fafb',
      100: '#f3f4f6',
      // ...
      900: '#111827',
    },
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
  },
  radius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    full: '9999px',
  },
  fontSize: {
    xs: '12px',
    sm: '14px',
    md: '16px',
    lg: '18px',
    xl: '24px',
  },
};
```

## 组件实现示例

### Button 组件

```tsx
// packages/core/src/Button/Button.tsx
import React, { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { styles } from './Button.css';

const buttonVariants = cva(styles.button, {
  variants: {
    variant: {
      primary: styles.primary,
      secondary: styles.secondary,
      ghost: styles.ghost,
      danger: styles.danger,
    },
    size: {
      sm: styles.sizeSm,
      md: styles.sizeMd,
      lg: styles.sizeLg,
    },
  },
  defaultVariants: {
    variant: 'primary',
    size: 'md',
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 加载状态 */
  loading?: boolean;
  /** 按钮图标 */
  leftIcon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      loading,
      leftIcon,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        className={buttonVariants({ variant, size, className })}
        disabled={disabled || loading}
        aria-disabled={disabled || loading}
        aria-busy={loading}
        {...props}
      >
        {loading && (
          <span className={styles.spinner} aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle
                cx="12" cy="12" r="10"
                fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round"
              />
            </svg>
          </span>
        )}
        {!loading && leftIcon && (
          <span className={styles.icon} aria-hidden="true">
            {leftIcon}
          </span>
        )}
        <span>{children}</span>
      </button>
    );
  }
);

Button.displayName = 'Button';
```

### Dialog 组件（基于 Radix）

```tsx
// packages/core/src/Dialog/Dialog.tsx
import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { styles } from './Dialog.css';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={styles.overlay} />
    <DialogPrimitive.Content
      ref={ref}
      className={`${styles.content} ${className ?? ''}`}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className={styles.closeButton}>
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" />
        </svg>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));

export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
```

### Select 组件（基于 Radix）

```tsx
// packages/core/src/Select/Select.tsx
import React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { styles } from './Select.css';

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={`${styles.trigger} ${className ?? ''}`}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <svg className={styles.icon} viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Content
    ref={ref}
    className={`${styles.content} ${className ?? ''}`}
    position="popper"
    sideOffset={4}
    {...props}
  >
    <SelectPrimitive.Viewport className={styles.viewport}>
      {children}
    </SelectPrimitive.Viewport>
  </SelectPrimitive.Content>
));

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={`${styles.item} ${className ?? ''}`}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className={styles.indicator}>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
```

## 组件 API 设计原则

### 1. 一致性

```tsx
// 所有组件遵循统一的 props 模式
<Button variant="primary" size="md" disabled={false} />
<Input variant="outlined" size="md" disabled={false} />
<Select variant="outlined" size="md" disabled={false} />
```

### 2. 可组合性

```tsx
// 组件之间可以自由组合
<Dialog>
  <DialogTrigger asChild>
    <Button>打开</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogTitle>确认操作</DialogTitle>
    <DialogDescription>此操作不可撤销</DialogDescription>
    <DialogClose asChild>
      <Button variant="ghost">取消</Button>
    </DialogClose>
  </DialogContent>
</Dialog>
```

### 3. 渐进式复杂度

```tsx
// 简单用法
<Button>点击</Button>

// 中等复杂度
<Button variant="secondary" size="lg" leftIcon={<PlusIcon />}>
  新建
</Button>

// 完整用法
<Button
  variant="primary"
  size="md"
  loading={isSubmitting}
  disabled={!isValid}
  leftIcon={<SaveIcon />}
  onClick={handleSubmit}
>
  保存
</Button>
```

## 文档驱动开发

使用 Storybook 进行组件文档化：

```tsx
// Button.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'ghost', 'danger'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: {
    children: '主要按钮',
    variant: 'primary',
  },
};

export const WithIcon: Story = {
  args: {
    children: '新建',
    leftIcon: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" /></svg>,
  },
};

export const Loading: Story = {
  args: {
    children: '提交中...',
    loading: true,
  },
};
```

## 发布流程

```bash
# 1. 添加变更记录
npx changeset

# 2. 版本更新
npx changeset version

# 3. 构建
pnpm build

# 4. 发布
npx changeset publish
```

## 总结

基于 Radix UI 构建组件库，能让我们将精力集中在样式和业务逻辑上，而无需从零实现复杂的交互行为和无障碍支持。关键要点：

1. **Monorepo 管理**：pnpm workspace + Turborepo 实现高效开发
2. **样式隔离**：Vanilla Extract 保证零运行时和类型安全
3. **无头组件**：Radix UI 提供完整的行为实现，我们只负责外观
4. **文档驱动**：Storybook 作为组件开发的标准工作流
5. **语义化版本**：Changeset 管理版本变更和发布

组件库是一个持续演进的工程，核心在于建立好的规范和工作流，让团队成员都能以一致的方式贡献和维护组件。
