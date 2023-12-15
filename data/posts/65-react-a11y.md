---
title: "Accessibility (A11y) in React: Making Your Pages Usable for Everyone"
tag: react
description: Comprehensive guide to Web Accessibility (A11y) practices in React, covering ARIA specifications, keyboard navigation, screen reader support, and making your application truly usable by everyone.
date: "2023-12-15T08:00:00.000Z"
---

## Goal

Accessibility (A11y) refers to enabling people with disabilities to successfully use Web applications. Approximately 1 billion people worldwide have some form of disability. Accessibility is not only a legal requirement (such as ADA, WCAG) but also a reflection of product responsibility. This article systematically explains accessibility practices in React, from basic semantic HTML to advanced ARIA patterns.

## Background

### Why A11y Matters

- **Approximately 15% of the global population** has some form of disability
- **Legal requirements**: Many countries require public service websites to meet accessibility standards
- **SEO friendly**: Search engine crawlers are similar to screen readers; accessible pages have better SEO
- **User experience**: All users benefit from clear navigation, sufficient contrast, and keyboard support

### WCAG Standards

The Web Content Accessibility Guidelines (WCAG) define three levels:

- **Level A**: Most basic requirements
- **Level AA**: Standard most websites should meet (recommended)
- **Level AAA**: Highest standard, usually for specific scenarios only

## Semantic HTML

### Correct Use of HTML Elements

```tsx
// ❌ Not recommended: div simulating button
<div className="button" onClick={handleClick}>
  Click me
</div>

// ✅ Recommended: Use native button
<button onClick={handleClick}>Click me</button>

// ❌ Not recommended: div simulating link
<div onClick={() => navigate('/about')}>About us</div>

// ✅ Recommended: Use Link component
<Link href="/about">About us</Link>
```

### Page Structure

```tsx
function Layout({ children }) {
  return (
    <div>
      {/* Semantic header */}
      <header role="banner">
        <nav aria-label="Main navigation">
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/about">About</a></li>
          </ul>
        </nav>
      </header>

      {/* Main content area */}
      <main role="main" id="main-content">
        {children}
      </main>

      {/* Sidebar */}
      <aside aria-label="Sidebar">
        {/* Sidebar content */}
      </aside>

      {/* Footer */}
      <footer role="contentinfo">
        <p>&copy; 2024 My Website</p>
      </footer>
    </div>
  );
}
```

### Form Accessibility

```tsx
function AccessibleForm() {
  return (
    <form>
      {/* Associate label and input */}
      <div>
        <label htmlFor="email">Email address *</label>
        <input
          id="email"
          type="email"
          name="email"
          required
          aria-required="true"
          aria-describedby="email-hint"
        />
        <span id="email-hint">Please enter a valid email address</span>
      </div>

      {/* Password field */}
      <div>
        <label htmlFor="password">Password *</label>
        <input
          id="password"
          type="password"
          name="password"
          required
          aria-required="true"
          aria-invalid={hasError}
          aria-describedby={hasError ? "password-error" : undefined}
        />
        {hasError && (
          <span id="password-error" role="alert">
            Password must be at least 8 characters
          </span>
        )}
      </div>

      <button type="submit">Submit</button>
    </form>
  );
}
```

## ARIA Attributes

### Common ARIA Attributes

```tsx
// aria-label: Provide accessible label for element
<button aria-label="Close dialog">
  <svg>...</svg>
</button>

// aria-describedby: Associate description information
<input aria-describedby="password-requirements" />
<div id="password-requirements">
  Password must contain at least 8 characters, including uppercase, lowercase, and numbers
</div>

// aria-live: Dynamic content update notification
<div aria-live="polite" aria-atomic="true">
  {notification && <p>{notification}</p>}
</div>

// aria-expanded: Expanded/collapsed state
<button aria-expanded={isOpen} aria-controls="menu">
  Menu
</button>
<ul id="menu" hidden={!isOpen}>
  <li>Item 1</li>
  <li>Item 2</li>
</ul>

// aria-hidden: Hide from accessibility tree
<div aria-hidden="true">Decorative content</div>

// role: Define element role
<div role="alert">Error message</div>
<div role="status">Loading...</div>
<div role="progressbar" aria-valuenow={50} aria-valuemin={0} aria-valuemax={100}>
  50%
</div>
```

### Practice: Accessible Dialog

```tsx
import { useEffect, useRef } from 'react';

function Dialog({ isOpen, onClose, title, children }) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      // Save current focus element
      previousFocusRef.current = document.activeElement;
      // Focus the dialog
      dialogRef.current?.focus();
    } else {
      // Restore focus on close
      previousFocusRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      // Prevent background scrolling
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title">{title}</h2>
        {children}
        <button onClick={onClose} aria-label="Close dialog">
          ×
        </button>
      </div>
    </div>
  );
}
```

## Keyboard Navigation

### Basic Keyboard Operations

```tsx
function KeyboardNavigation() {
  const handleKeyDown = (e, action) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  };

  return (
    // Focusable elements need tabIndex
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => handleKeyDown(e, handleClick)}
    >
      Focusable element
    </div>
  );
}
```

### Focus Management

```tsx
// Focus trap (for dialogs, drawers, etc.)
function useFocusTrap(ref, isActive) {
  useEffect(() => {
    if (!isActive || !ref.current) return;

    const focusableElements = ref.current.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), ' +
      'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTabKey = (e) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement.focus();
        }
      }
    };

    ref.current.addEventListener('keydown', handleTabKey);
    firstElement?.focus();

    return () => {
      ref.current?.removeEventListener('keydown', handleTabKey);
    };
  }, [ref, isActive]);
}

// Usage
function Modal({ isOpen, onClose, children }) {
  const modalRef = useRef(null);
  useFocusTrap(modalRef, isOpen);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}
```

### Skip Navigation Links

```tsx
function SkipLink() {
  return (
    <a
      href="#main-content"
      className="skip-link"
      style={{
        position: 'absolute',
        left: '-9999px',
        top: 'auto',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
      }}
      onFocus={(e) => {
        e.target.style.left = '0';
        e.target.style.width = 'auto';
        e.target.style.height = 'auto';
      }}
      onBlur={(e) => {
        e.target.style.left = '-9999px';
        e.target.style.width = '1px';
        e.target.style.height = '1px';
      }}
    >
      Skip navigation, go directly to main content
    </a>
  );
}
```

## Screen Reader Support

### Live Regions

```tsx
// Notification system
function Notification({ message, type }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`notification ${type}`}
    >
      {message}
    </div>
  );
}

// Urgent notifications (e.g., errors)
function ErrorMessage({ message }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className="error"
    >
      {message}
    </div>
  );
}
```

### Loading States

```tsx
function LoadingSpinner({ isLoading, children }) {
  return (
    <div>
      {isLoading && (
        <div role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <span>Loading, please wait...</span>
        </div>
      )}
      <div aria-busy={isLoading}>
        {children}
      </div>
    </div>
  );
}
```

### Table Accessibility

```tsx
function AccessibleTable({ data }) {
  return (
    <table>
      <caption>User List</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Email</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {data.map((user) => (
          <tr key={user.id}>
            <th scope="row">{user.name}</th>
            <td>{user.email}</td>
            <td>
              <button aria-label={`Edit ${user.name}`}>Edit</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

## Accessibility Testing

### Automated Testing

```tsx
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

test('form should have no accessibility issues', async () => {
  const { container } = render(<ContactForm />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### React DevTools Plugin

Install the "axe-core" plugin to detect accessibility issues in real-time in the browser.

## Design-Level A11y

### Color Contrast

```css
/* WCAG AA standard: 4.5:1 (normal text) */
/* WCAG AA standard: 3:1 (large text) */

/* ❌ Insufficient contrast */
.text {
  color: #999; /* Gray text on white background has insufficient contrast */
}

/* ✅ Sufficient contrast */
.text {
  color: #595959; /* Dark gray, contrast > 4.5:1 */
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  .text {
    color: #d4d4d4;
  }
}

/* Respect user preference for reduced motion */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## Conclusion

Accessibility is not a "nice-to-have" but a "must-get-right." Key takeaways:

1. **Semantic HTML**: Using correct HTML elements is the foundation
2. **ARIA attributes**: Supplement semantic information, but don't overuse
3. **Keyboard navigation**: Ensure all interactions can be completed via keyboard
4. **Screen readers**: Provide real-time notifications for dynamic content
5. **Automated testing**: Include accessibility checks in CI/CD

Accessibility is a continuous process. It is recommended to consider it from the beginning of a project rather than as an afterthought. Remember: accessible websites are more friendly to all users.
