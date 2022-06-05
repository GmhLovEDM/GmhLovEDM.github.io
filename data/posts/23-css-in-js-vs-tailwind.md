---
title: "CSS-in-JS or Tailwind? Choosing a Styling Solution in 2022"
tag: css
description: Frontend styling solutions emerge endlessly, with CSS-in-JS and Tailwind as two mainstream directions. This article analyzes the pros and cons of each to help you make the right choice.
date: "2022-06-05T08:00:00.000Z"
---

## Goal

Understand the design philosophies of CSS-in-JS and Tailwind CSS, and choose the appropriate styling solution based on project needs.

## Background

### Evolution of Styling Solutions

```
2010: CSS files (global styles)
2012: CSS preprocessors (Sass/Less)
2014: CSS Modules (local scope)
2015: CSS-in-JS (styled-components)
2017: Utility-first CSS (Tailwind)
```

Each solution solves problems from the previous generation but also introduces new issues.

## CSS-in-JS Representative: styled-components

### Core Philosophy

```javascript
// Write styles in JavaScript
import styled from 'styled-components'

const Button = styled.button`
    background: ${props => props.primary ? '#1890ff' : '#fff'};
    color: ${props => props.primary ? '#fff' : '#333'};
    border: 1px solid #d9d9d9;
    border-radius: 4px;
    padding: 8px 16px;
    cursor: pointer;

    &:hover {
        border-color: #1890ff;
    }
`

// Usage
<Button primary>Primary Button</Button>
<Button>Secondary Button</Button>
```

### Advantages

```javascript
// 1. Local scope, no class name conflicts
const StyledDiv = styled.div`
    color: red;
`
// Compiles to unique class name: sc-bdfBwQ

// 2. Dynamic styles based on props
const Box = styled.div`
    width: ${props => props.width}px;
    height: ${props => props.height}px;
    background: ${props => props.theme.background};
`

// 3. Style inheritance
const BaseButton = styled.button`
    padding: 8px 16px;
    border-radius: 4px;
`

const PrimaryButton = styled(BaseButton)`
    background: #1890ff;
    color: white;
`

// 4. Theme support
import { ThemeProvider } from 'styled-components'

const theme = {
    primary: '#1890ff',
    background: '#f5f5f5'
}

<ThemeProvider theme={theme}>
    <App />
</ThemeProvider>
```

### Disadvantages

```javascript
// 1. Runtime performance overhead
// Template strings need to be parsed on every render
// New CSS rules are generated

// 2. Learning curve
// Need to learn new syntax and APIs

// 3. Difficult debugging
// Generated class names have no semantics, hard to locate during debugging

// 4. Bundle size
// styled-components is about 12KB (gzipped)
```

## Tailwind CSS

### Core Philosophy

```html
<!-- Use utility classes directly in HTML -->
<button class="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
    Primary Button
</button>

<button class="bg-white text-gray-800 px-4 py-2 rounded border border-gray-300 hover:border-blue-500">
    Secondary Button
</button>
```

### Advantages

```html
<!-- 1. Fast development speed -->
<!-- Complete styling without leaving HTML -->

<!-- 2. No class names -->
<!-- No need to think of class names, reduces cognitive burden -->

<!-- 3. Consistent design system -->
<!-- Use predefined design tokens -->
<div class="p-4 m-2 text-sm font-medium text-gray-700">
    Using unified design system
</div>

<!-- 4. Responsive friendly -->
<div class="w-full md:w-1/2 lg:w-1/3">
    Responsive layout
</div>

<!-- 5. Dark mode -->
<div class="bg-white dark:bg-gray-800 dark:text-white">
    Dark mode support
</div>
```

### Disadvantages

```html
<!-- 1. Poor HTML readability -->
<div class="flex items-center justify-between p-4 bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 border border-gray-200">
    <!-- Too many class names, hard to read -->
</div>

<!-- 2. Repetitive class names -->
<!-- Same styles used in multiple places require repeating class names -->

<!-- 3. Complex styles are difficult -->
<!-- Animations, pseudo-elements, and other complex styles are painful to write -->
<style>
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
</style>

<!-- 4. Learning curve -->
<!-- Need to memorize a large number of utility classes -->
```

## Comparative Analysis

### 1. Development Experience

```javascript
// CSS-in-JS
const Card = styled.div`
    background: white;
    border-radius: 8px;
    padding: 24px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
`

// Tailwind
// <div class="bg-white rounded-lg p-6 shadow-md">
```

**Comparison**:
- CSS-in-JS: Styles are centralized, clear structure
- Tailwind: HTML is slightly longer, but no need for separate style files

### 2. Performance

```
CSS-in-JS (runtime):
- First render: needs to parse template strings
- Subsequent renders: needs to compare props changes
- Bundle size: ~12KB

Tailwind (build time):
- Generates static CSS
- Only includes used classes
- Usually < 10KB

Conclusion: Tailwind has the advantage in performance
```

### 3. Maintainability

```javascript
// CSS-in-JS
// Styles are bound to components, modifying component syncs style changes
const Button = styled.button`
    background: ${({ theme }) => theme.primary};
`

// Tailwind
// Styles are scattered in HTML, modifying design system requires global replacement
// <button class="bg-blue-500">
```

### 4. Design System

```javascript
// CSS-in-JS: through theme provider
const theme = {
    colors: {
        primary: '#1890ff',
        secondary: '#722ed1'
    },
    spacing: {
        sm: '8px',
        md: '16px',
        lg: '24px'
    }
}

// Tailwind: through configuration file
// tailwind.config.js
module.exports = {
    theme: {
        colors: {
            primary: '#1890ff',
            secondary: '#722ed1'
        },
        spacing: {
            'sm': '8px',
            'md': '16px',
            'lg': '24px'
        }
    }
}
```

## Selection Guide

### When to Choose CSS-in-JS

```
✓ Need complex dynamic styles
✓ Component library development
✓ Team familiar with CSS-in-JS
✓ Need theme switching
✓ Complex style logic
```

### When to Choose Tailwind

```
✓ Rapid prototype development
✓ Team collaboration (reduces style conflicts)
✓ Design system driven
✓ High performance requirements
✓ Small projects
```

### Mixed Usage

```javascript
// Can use both together
// Tailwind for base styles
// CSS-in-JS for complex logic

const StyledCard = styled.div`
    // Complex animations and pseudo-classes
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    animation: fadeIn 0.3s ease;
`

// Use Tailwind for base styles
<div className="p-6 bg-white rounded-lg">
    <StyledCard>
        Complex styled content
    </StyledCard>
</div>
```

## Other Solutions

### 1. CSS Modules

```css
/* Button.module.css */
.primary {
    background: #1890ff;
    color: white;
}

.secondary {
    background: white;
    color: #333;
}
```

```javascript
import styles from './Button.module.css'

<button className={styles.primary}>Primary Button</button>
```

### 2. UnoCSS

```html
<!-- On-demand generated atomic CSS -->
<button class="bg-blue-500 text-white px-4 py-2">
    Similar to Tailwind, but generated on demand
</button>
```

### 3. Vanilla Extract

```typescript
// Type-safe CSS-in-JS, generated at build time
import { style } from '@vanilla-extract/css'

export const button = style({
    background: 'blue',
    color: 'white'
})
```

## Real Project Recommendations

### 1. New Projects

```
Small projects → Tailwind (rapid development)
Medium projects → Tailwind or CSS Modules
Large projects → CSS-in-JS or Tailwind + CSS Modules
```

### 2. Migration Strategy

```javascript
// Don't rewrite everything at once, migrate gradually
// 1. New components use new solution
// 2. Gradually modify old components
// 3. Finally delete old style files
```

### 3. Team Decision

```
Consider:
1. Team's tech stack preference
2. Project scale and complexity
3. Performance requirements
4. Design system complexity
5. Long-term maintenance cost
```

## Summary

1. **No perfect solution**: Each has its applicable scenarios
2. **CSS-in-JS suits complex scenarios**: Dynamic styles, theme systems, component libraries
3. **Tailwind suits rapid development**: Prototypes, small projects, design system driven
4. **Performance considerations**: Tailwind's build-time generation has advantages
5. **Team consistency**: Choose what the team is familiar with and suits the project

Choosing a styling solution is not a technical problem, but a balance between team collaboration and project requirements.
