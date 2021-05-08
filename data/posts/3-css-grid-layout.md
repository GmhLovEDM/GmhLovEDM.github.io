---
title: "CSS Grid Layout in Practice: From Beginner to Fan"
tag: css
description: CSS Grid is the ultimate weapon for modern web layouts. This article starts from practical scenarios and deeply explains Grid's core concepts, common layout patterns, and practical techniques.
date: "2021-05-08T08:00:00.000Z"
---

## Goal

Help readers truly understand CSS Grid's design philosophy, master the 5 most common Grid layout patterns, and apply them flexibly in real projects.

## Background

### After Flexbox, Why Do We Still Need Grid?

Flexbox was born in 2012 and solved one-dimensional layout (row or column) problems. But in actual development, we often need to control both rows and columns simultaneously:

```css
/* What Flexbox can't do: precise control of two-dimensional grids */
/* For example: first row takes 2 cells, second row takes 3 cells */
```

In 2017, CSS Grid Layout Module Level 1 officially became a W3C recommended standard. Its core concept is: **liberate layout logic from HTML structure and control it entirely with CSS.**

## Grid's Core Concepts

### 1. Grid Container and Grid Items

```css
.container {
    display: grid;
    grid-template-columns: 200px 1fr 200px; /* Three columns */
    grid-template-rows: auto 1fr auto;       /* Three rows */
    gap: 16px;                                /* Spacing */
}
```

### 2. The fr Unit: Grid's Soul

`fr` (fraction) represents a proportional share of the remaining space:

```css
/* Three equal columns */
grid-template-columns: 1fr 1fr 1fr;

/* First column fixed 200px, remaining space divided equally */
grid-template-columns: 200px 1fr 1fr;

/* First column takes 2 parts, second column takes 1 part */
grid-template-columns: 200px 2fr 1fr;
```

### 3. repeat() and auto-fill/auto-fit

```css
/* Repeated column definitions */
grid-template-columns: repeat(3, 1fr);

/* Auto-fill: fit as many columns as the container allows */
grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));

/* Difference between auto-fill and auto-fit */
/* auto-fill: preserves empty grid tracks even without content */
/* auto-fit: collapses tracks without content */
```

## 5 Practical Layout Patterns

### Pattern 1: Holy Grail Layout

This is the most classic three-column layout — Header + Main + Footer, with fixed-width left and right columns and an adaptive center:

```css
.layout-holy-grail {
    display: grid;
    grid-template-areas:
        "header  header  header"
        "sidebar content aside"
        "footer  footer  footer";
    grid-template-columns: 200px 1fr 200px;
    grid-template-rows: auto 1fr auto;
    min-height: 100vh;
}

.header  { grid-area: header; }
.sidebar { grid-area: sidebar; }
.content { grid-area: content; }
.aside   { grid-area: aside; }
.footer  { grid-area: footer; }
```

**Advantages**: Clear semantics, responsive-friendly, no hacks needed.

### Pattern 2: Card Grid

E-commerce product listings:

```css
.card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 24px;
    padding: 24px;
}

.card {
    background: white;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}
```

This layout automatically determines how many columns to display based on container width, with a minimum of 280px per column and adaptive maximums. Responsive design requires no media queries at all.

### Pattern 3: Magazine Layout

Irregular grid layout, suitable for article lists or image displays:

```css
.magazine-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: 200px;
    gap: 16px;
}

/* First element spans two rows and two columns */
.magazine-grid .featured {
    grid-column: 1 / 3;
    grid-row: 1 / 3;
}

/* Second element spans two columns */
.magazine-grid .wide {
    grid-column: span 2;
}
```

### Pattern 4: Responsive Navigation Bar

```css
.navbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    padding: 0 24px;
    height: 64px;
}

.navbar__logo {
    /* Logo naturally on the left */
}

.navbar__links {
    display: flex;
    justify-content: center;
    gap: 24px;
}

.navbar__actions {
    /* Button group on the right */
    justify-self: end;
}

@media (max-width: 768px) {
    .navbar {
        grid-template-columns: 1fr auto;
    }
    .navbar__links {
        display: none; /* Hidden on mobile */
    }
}
```

### Pattern 5: Equal Height Cards

Flexbox requires extra handling for equal height cards, but Grid supports it natively:

```css
.equal-height-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 24px;
}

.card {
    /* All cards automatically equal height, no extra handling needed */
    display: grid; /* Nested Grid for internal layout */
    grid-template-rows: auto 1fr auto; /* Fixed image, adaptive content, fixed bottom button */
}
```

## Grid vs Flexbox: Which One to Use?

| Scenario | Recommendation | Reason |
|----------|---------------|--------|
| One-dimensional arrangement (row or column) | Flexbox | Simple and direct |
| Two-dimensional layout (row + column) | Grid | Precise control |
| Content-first (uncertain sizes) | Flexbox | Flexible distribution |
| Layout-first (determined structure) | Grid | Clear structure |
| Component internal alignment | Flexbox | Simple |
| Page-level layout | Grid | Powerful |

**In practice, both are often used together: Grid for page-level layout, Flexbox for component internal alignment.**

## Browser Compatibility (2021)

| Browser | Supported Version |
|---------|-------------------|
| Chrome | 57+ |
| Firefox | 52+ |
| Safari | 10.1+ |
| Edge | 16+ |
| IE | 11 (partial support, different syntax) |

**In 2021, Grid's compatibility is no longer a concern at all.** The only thing to note is IE's legacy syntax, but unless you need to support IE11, it can be ignored.

## Practical Tips

### 1. Named Grid Lines

```css
.layout {
    display: grid;
    grid-template-columns: [sidebar-start] 250px [sidebar-end content-start] 1fr [content-end];
}

.sidebar {
    grid-column: sidebar-start / sidebar-end;
}
```

### 2. Implicit Grid

When content exceeds the predefined number of rows, Grid automatically creates new rows:

```css
.container {
    display: grid;
    grid-template-rows: auto auto; /* Only two rows defined */
    /* Third and subsequent items automatically create new rows */
    grid-auto-rows: min-content; /* Minimum height for new rows */
}
```

### 3. Alignment Methods

```css
.container {
    display: grid;
    /* Alignment of the entire grid within the container */
    justify-content: center; /* Horizontal center */
    align-content: center;   /* Vertical center */

    /* Alignment of grid items within their cells */
    justify-items: center;
    align-items: center;
}

.item {
    /* Individual grid item overrides container alignment settings */
    justify-self: end;
    align-self: start;
}
```

## Summary

CSS Grid is not a collection of properties to memorize, but a shift in **layout thinking**:

1. From "float + position" to "two-dimensional grid"
2. From "calculating widths" to "proportional distribution"
3. From "piling up media queries" to "adaptive grids"
4. From "HTML determines layout" to "CSS controls structure"

Once you embrace this way of thinking, you'll find that many layouts that previously required dozens of lines of code can now be achieved with just a few lines of CSS.
