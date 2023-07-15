---
title: "Building a React Component Library from Scratch: Best Practices with Radix UI"
tag: react
description: Building a reusable, accessible, and themeable React component library from scratch based on Radix UI headless components, covering project architecture, styling solutions, documentation-driven development, and other best practices.
date: "2023-07-15T08:00:00.000Z"
---

## Goal

An internal team component library is core infrastructure for improving development efficiency and ensuring UI consistency. This article uses Radix UI as the foundation to build a production-grade React component library from scratch, covering project architecture design, styling system selection, component API design, documentation-driven development, and the release process.

## Background

### Why Build Your Own Component Library

While mature component libraries like Ant Design and Material UI exist on the market, building your own team component library still has its value:

- **Brand customization**: Commercial products need unique visual styles that generic component libraries cannot satisfy
- **Bundle size control**: Only includes components needed by the business, avoiding打包 unnecessary code
- **Deep integration**: Deeply coupled with the team's tech stack, design specifications, and business logic
- **Maintenance control**: Not affected by third-party library version iterations

### The Value of Radix UI

Radix UI is a "headless" component library that provides:

- **Complete accessibility (A11y) implementation**: WAI-ARIA specifications, keyboard navigation, screen reader support
- **Complete separation of logic and styles**: Contains no CSS, with styles entirely controlled by developers
- **Predictable behavior**: Compositional API with no black-box state management

## Project Architecture Design

### Directory Structure

```
my-ui-lib/
├── packages/
│   ├── core/              # Core components
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
│   ├── styles/            # Styling system
│   │   ├── tokens/        # Design tokens
│   │   ├── components/    # Component styles
│   │   └── index.ts
│   └── utils/             # Utility functions
├── docs/                  # Documentation site
├── turbo.json
├── package.json
└── pnpm-workspace.yaml
```

### Monorepo Configuration

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

## Styling System Design

### Solution Comparison

Component libraries have multiple styling options:

| Solution | Pros | Cons |
|----------|------|------|
| CSS Modules | Zero runtime, native support | Inflexible class names |
| Tailwind CSS | High development efficiency | Large bundle size, difficult customization |
| Vanilla Extract | Zero runtime, type safe | Learning curve |
| Styled Components | Runtime flexibility | Performance overhead |

For component libraries, **Vanilla Extract** is recommended -- its zero-runtime and type-safe characteristics are ideal for building maintainable styling systems.

### Design Tokens

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

## Component Implementation Examples

### Button Component

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
  /** Loading state */
  loading?: boolean;
  /** Button icon */
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

### Dialog Component (Based on Radix)

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

### Select Component (Based on Radix)

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

## Component API Design Principles

### 1. Consistency

```tsx
// All components follow a unified props pattern
<Button variant="primary" size="md" disabled={false} />
<Input variant="outlined" size="md" disabled={false} />
<Select variant="outlined" size="md" disabled={false} />
```

### 2. Composability

```tsx
// Components can be freely composed with each other
<Dialog>
  <DialogTrigger asChild>
    <Button>Open</Button>
  </DialogTrigger>
  <DialogContent>
    <DialogTitle>Confirm Action</DialogTitle>
    <DialogDescription>This action cannot be undone</DialogDescription>
    <DialogClose asChild>
      <Button variant="ghost">Cancel</Button>
    </DialogClose>
  </DialogContent>
</Dialog>
```

### 3. Progressive Complexity

```tsx
// Simple usage
<Button>Click</Button>

// Medium complexity
<Button variant="secondary" size="lg" leftIcon={<PlusIcon />}>
  Create New
</Button>

// Full usage
<Button
  variant="primary"
  size="md"
  loading={isSubmitting}
  disabled={!isValid}
  leftIcon={<SaveIcon />}
  onClick={handleSubmit}
>
  Save
</Button>
```

## Documentation-Driven Development

Using Storybook for component documentation:

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
    children: 'Primary Button',
    variant: 'primary',
  },
};

export const WithIcon: Story = {
  args: {
    children: 'Create New',
    leftIcon: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" /></svg>,
  },
};

export const Loading: Story = {
  args: {
    children: 'Submitting...',
    loading: true,
  },
};
```

## Release Process

```bash
# 1. Add change record
npx changeset

# 2. Version update
npx changeset version

# 3. Build
pnpm build

# 4. Publish
npx changeset publish
```

## Conclusion

Building a component library with Radix UI as the foundation allows us to focus on styles and business logic without implementing complex interaction behaviors and accessibility support from scratch. Key takeaways:

1. **Monorepo management**: pnpm workspace + Turborepo for efficient development
2. **Style isolation**: Vanilla Extract ensures zero runtime and type safety
3. **Headless components**: Radix UI provides complete behavior implementation, we only handle the appearance
4. **Documentation-driven**: Storybook as the standard workflow for component development
5. **Semantic versioning**: Changeset manages version changes and releases

A component library is a continuously evolving project. The core lies in establishing good specifications and workflows, allowing team members to contribute and maintain components in a consistent manner.
