---
title: "Building a Dark Mode Theme with CSS Variables"
tag: css
description: Implement dark mode switching with CSS variables, from design specifications to code implementation, creating a maintainable theme system.
date: "2021-08-12T08:00:00.000Z"
---

## Goal

Implement a **scalable, maintainable, performance-first** dark mode solution. Not just simply inverting colors, but building a complete theme system.

## Background

### The Rise of Dark Mode

In 2019, Apple introduced system-level dark mode in iOS 13, followed by Android 10 and Windows 10. Dark mode went from "nice to have" to "must have."

But many frontend developers implement it this way:

```css
/* Brute force approach: two complete sets of styles */
body.light { /* 200 lines of color definitions */ }
body.dark  { /* Another 200 lines of color definitions */ }
```

The problems with this approach:
1. Severe code duplication
2. Need to add styles in two places when adding new components
3. Maintenance cost increases linearly with project growth

**CSS variables are the best solution to this problem.**

## CSS Variable Basics

### Definition and Usage

```css
:root {
    /* Theme colors */
    --color-primary: #1890ff;
    --color-success: #52c41a;
    --color-warning: #faad14;
    --color-error: #ff4d4f;

    /* Text colors */
    --text-primary: rgba(0, 0, 0, 0.85);
    --text-secondary: rgba(0, 0, 0, 0.65);
    --text-disabled: rgba(0, 0, 0, 0.25);

    /* Background colors */
    --bg-base: #ffffff;
    --bg-light: #fafafa;
    --bg-dark: #f0f2f5;

    /* Borders */
    --border-color: #d9d9d9;
    --border-radius: 4px;
}

/* Using variables */
.button {
    background: var(--color-primary);
    color: white;
    border-radius: var(--border-radius);
}

.text-secondary {
    color: var(--text-secondary);
}
```

### Dark Mode Override

```css
/* Toggle via class */
body.dark {
    --text-primary: rgba(255, 255, 255, 0.85);
    --text-secondary: rgba(255, 255, 255, 0.65);
    --text-disabled: rgba(255, 255, 255, 0.25);

    --bg-base: #141414;
    --bg-light: #1f1f1f;
    --bg-dark: #262626;

    --border-color: #434343;
}

/* Or follow system via media query */
@media (prefers-color-scheme: dark) {
    :root:not(.light) {
        --text-primary: rgba(255, 255, 255, 0.85);
        --text-secondary: rgba(255, 255, 255, 0.65);
        /* ... other variables */
    }
}
```

## Complete Theme System Design

### 1. Design Token Layering

```css
:root {
    /* === Base Tokens (raw values) === */
    --gray-50: #fafafa;
    --gray-100: #f5f5f5;
    --gray-200: #e8e8e8;
    --gray-300: #d9d9d9;
    --gray-400: #bfbfbf;
    --gray-500: #8c8c8c;
    --gray-600: #595959;
    --gray-700: #434343;
    --gray-800: #262626;
    --gray-900: #141414;

    --blue-50: #e6f7ff;
    --blue-100: #bae7ff;
    --blue-200: #91d5ff;
    --blue-300: #69c0ff;
    --blue-400: #40a9ff;
    --blue-500: #1890ff;
    --blue-600: #096dd9;
    --blue-700: #0050b3;

    /* === Semantic Tokens (functional mapping) === */
    --color-primary: var(--blue-500);
    --color-primary-hover: var(--blue-400);
    --color-primary-active: var(--blue-600);

    --color-bg-base: var(--gray-50);
    --color-bg-light: var(--gray-100);
    --color-bg-dark: var(--gray-200);

    --color-text-primary: var(--gray-900);
    --color-text-secondary: var(--gray-600);
    --color-text-disabled: var(--gray-400);

    --color-border: var(--gray-300);
    --color-border-light: var(--gray-200);
}

/* Dark mode: only override semantic tokens */
body.dark {
    --color-primary: var(--blue-500); /* Primary color usually unchanged */
    --color-primary-hover: var(--blue-400);
    --color-primary-active: var(--blue-600);

    --color-bg-base: var(--gray-900);
    --color-bg-light: var(--gray-800);
    --color-bg-dark: var(--gray-700);

    --color-text-primary: rgba(255, 255, 255, 0.85);
    --color-text-secondary: rgba(255, 255, 255, 0.65);
    --color-text-disabled: rgba(255, 255, 255, 0.25);

    --color-border: var(--gray-700);
    --color-border-light: var(--gray-800);
}
```

### 2. Component-Level Theme Variables

```css
:root {
    /* Button */
    --btn-height: 32px;
    --btn-padding: 0 16px;
    --btn-font-size: 14px;
    --btn-border-radius: var(--radius-sm);

    /* Input */
    --input-height: 32px;
    --input-padding: 0 12px;
    --input-border: 1px solid var(--color-border);
    --input-border-radius: var(--radius-sm);

    /* Card */
    --card-padding: 24px;
    --card-bg: var(--color-bg-base);
    --card-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    --card-border-radius: var(--radius-md);
}

/* Dark mode card shadow adjustment */
body.dark .card {
    --card-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
```

### 3. Color Contrast Checking

Dark mode must ensure sufficient contrast (WCAG AA standard: at least 4.5:1):

```javascript
function getContrastRatio(color1, color2) {
    const getLuminance = (r, g, b) => {
        const [rs, gs, bs] = [r, g, b].map(c => {
            c = c / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };

    const l1 = getLuminance(...color1);
    const l2 = getLuminance(...color2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

// Test contrast
const ratio = getContrastRatio([255, 255, 255], [20, 20, 20]);
console.log(`Contrast ratio: ${ratio.toFixed(2)}:1`); // About 18.1:1, passes WCAG AAA
```

## Theme Switching Implementation

### Method 1: Class Toggle

```javascript
class ThemeManager {
    constructor() {
        this.theme = localStorage.getItem('theme') || 'light';
        this.apply();
    }

    toggle() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        this.apply();
        localStorage.setItem('theme', this.theme);
    }

    apply() {
        document.body.classList.remove('light', 'dark');
        document.body.classList.add(this.theme);
    }

    // Follow system
    followSystem() {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.theme = mediaQuery.matches ? 'dark' : 'light';
        this.apply();

        mediaQuery.addEventListener('change', (e) => {
            this.theme = e.matches ? 'dark' : 'light';
            this.apply();
        });
    }
}

const themeManager = new ThemeManager();
```

### Method 2: CSS Media Query Auto-Switching

```css
/* Default light mode */
:root {
    --color-bg-base: #ffffff;
    --color-text-primary: #000000;
}

/* Follow system preference */
@media (prefers-color-scheme: dark) {
    :root {
        --color-bg-base: #141414;
        --color-text-primary: #ffffff;
    }
}

/* Allow manual user override */
body.light {
    --color-bg-base: #ffffff;
    --color-text-primary: #000000;
}

body.dark {
    --color-bg-base: #141414;
    --color-text-primary: #ffffff;
}
```

## Common Pitfalls

### 1. Images Too Bright in Dark Mode

```css
/* Add dark mode adaptation for images */
body.dark img:not(.no-filter) {
    filter: brightness(0.8);
}

/* Or use mix-blend-mode */
body.dark .logo {
    mix-blend-mode: screen;
}
```

### 2. Shadows Invisible in Dark Mode

```css
:root {
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.1);
    --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.1);
}

body.dark {
    /* Shadows need to be stronger in dark mode */
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 8px rgba(0, 0, 0, 0.4);
    /* Or use borders instead of shadows */
}
```

### 3. SVG Icon Colors

```css
/* Light mode */
.icon {
    fill: var(--color-text-primary);
}

/* Dark mode - use currentColor */
.icon {
    fill: currentColor;
    color: var(--color-text-primary);
}
```

## Summary

1. **CSS variables are the foundation of theme systems**: Define once, use everywhere
2. **Layered design**: Base Tokens → Semantic Tokens → Component Tokens
3. **Dark mode is not simple inversion**: Need to consider contrast, shadows, image adaptation
4. **Follow system + manual override**: Provides the best user experience
5. **Performance first**: CSS variable switching is zero-cost, no need to repaint the entire page

Build your theme system with CSS variables, and your code will be cleaner, more maintainable, and more extensible.
