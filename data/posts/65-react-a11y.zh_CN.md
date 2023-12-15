---
title: "React 中的可访问性（A11y）：让你的页面人人可用"
tag: react
description: 全面讲解 Web 可访问性（A11y）在 React 中的实践，涵盖 ARIA 规范、键盘导航、屏幕阅读器支持，让你的应用真正做到人人可用。
date: "2023-12-15T08:00:00.000Z"
---

## 目标

可访问性（Accessibility，简称 A11y）是指让残障人士也能顺利使用 Web 应用。全球约有 10 亿残障人士，可访问性不仅是法律要求（如 ADA、WCAG），更是产品责任感的体现。本文系统讲解 React 中的可访问性实践，从基础的语义化 HTML 到高级的 ARIA 模式。

## 背景

### 为什么需要 A11y

- **全球约 15% 的人口**有某种形式的残疾
- **法律要求**：许多国家要求公共服务网站符合可访问性标准
- **SEO 友好**：搜索引擎爬虫类似屏幕阅读器，可访问性好的页面 SEO 也更好
- **用户体验**：所有用户都受益于清晰的导航、足够的对比度、键盘操作支持

### WCAG 标准

Web 内容可访问性指南（WCAG）定义了三个等级：

- **A 级**：最基本的要求
- **AA 级**：大多数网站应达到的标准（推荐）
- **AAA 级**：最高标准，通常只针对特定场景

## 语义化 HTML

### 正确使用 HTML 元素

```tsx
// ❌ 不推荐：div 模拟按钮
<div className="button" onClick={handleClick}>
  点击我
</div>

// ✅ 推荐：使用原生 button
<button onClick={handleClick}>点击我</button>

// ❌ 不推荐：div 模拟链接
<div onClick={() => navigate('/about')}>关于我们</div>

// ✅ 推荐：使用 Link 组件
<Link href="/about">关于我们</Link>
```

### 页面结构

```tsx
function Layout({ children }) {
  return (
    <div>
      {/* 语义化头部 */}
      <header role="banner">
        <nav aria-label="主导航">
          <ul>
            <li><a href="/">首页</a></li>
            <li><a href="/about">关于</a></li>
          </ul>
        </nav>
      </header>

      {/* 主要内容区 */}
      <main role="main" id="main-content">
        {children}
      </main>

      {/* 侧边栏 */}
      <aside aria-label="侧边栏">
        {/* 侧边栏内容 */}
      </aside>

      {/* 页脚 */}
      <footer role="contentinfo">
        <p>&copy; 2024 我的网站</p>
      </footer>
    </div>
  );
}
```

### 表单可访问性

```tsx
function AccessibleForm() {
  return (
    <form>
      {/* 关联 label 和 input */}
      <div>
        <label htmlFor="email">邮箱地址 *</label>
        <input
          id="email"
          type="email"
          name="email"
          required
          aria-required="true"
          aria-describedby="email-hint"
        />
        <span id="email-hint">请输入有效的邮箱地址</span>
      </div>

      {/* 密码字段 */}
      <div>
        <label htmlFor="password">密码 *</label>
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
            密码至少 8 位
          </span>
        )}
      </div>

      <button type="submit">提交</button>
    </form>
  );
}
```

## ARIA 属性

### 常用 ARIA 属性

```tsx
// aria-label：为元素提供无障碍标签
<button aria-label="关闭对话框">
  <svg>...</svg>
</button>

// aria-describedby：关联描述信息
<input aria-describedby="password-requirements" />
<div id="password-requirements">
  密码必须包含至少 8 个字符，包含大小写字母和数字
</div>

// aria-live：动态内容更新通知
<div aria-live="polite" aria-atomic="true">
  {notification && <p>{notification}</p>}
</div>

// aria-expanded：展开/折叠状态
<button aria-expanded={isOpen} aria-controls="menu">
  菜单
</button>
<ul id="menu" hidden={!isOpen}>
  <li>项目 1</li>
  <li>项目 2</li>
</ul>

// aria-hidden：从无障碍树中隐藏
<div aria-hidden="true">装饰性内容</div>

// role：定义元素角色
<div role="alert">错误信息</div>
<div role="status">加载中...</div>
<div role="progressbar" aria-valuenow={50} aria-valuemin={0} aria-valuemax={100}>
  50%
</div>
```

### 实战：可访问的对话框

```tsx
import { useEffect, useRef } from 'react';

function Dialog({ isOpen, onClose, title, children }) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      // 保存当前焦点元素
      previousFocusRef.current = document.activeElement;
      // 聚焦对话框
      dialogRef.current?.focus();
    } else {
      // 关闭时恢复焦点
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
      // 阻止背景滚动
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
        <button onClick={onClose} aria-label="关闭对话框">
          ×
        </button>
      </div>
    </div>
  );
}
```

## 键盘导航

### 基本键盘操作

```tsx
function KeyboardNavigation() {
  const handleKeyDown = (e, action) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  };

  return (
    // 可聚焦元素需要 tabIndex
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => handleKeyDown(e, handleClick)}
    >
      可聚焦的元素
    </div>
  );
}
```

### 焦点管理

```tsx
// 焦点陷阱（对话框、抽屉等）
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

// 使用
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

### 跳过导航链接

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
      跳过导航，直接进入主内容
    </a>
  );
}
```

## 屏幕阅读器支持

### 实时区域

```tsx
// 通知系统
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

// 紧急通知（如错误）
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

### 加载状态

```tsx
function LoadingSpinner({ isLoading, children }) {
  return (
    <div>
      {isLoading && (
        <div role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <span>正在加载，请稍候...</span>
        </div>
      )}
      <div aria-busy={isLoading}>
        {children}
      </div>
    </div>
  );
}
```

### 表格可访问性

```tsx
function AccessibleTable({ data }) {
  return (
    <table>
      <caption>用户列表</caption>
      <thead>
        <tr>
          <th scope="col">姓名</th>
          <th scope="col">邮箱</th>
          <th scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        {data.map((user) => (
          <tr key={user.id}>
            <th scope="row">{user.name}</th>
            <td>{user.email}</td>
            <td>
              <button aria-label={`编辑 ${user.name}`}>编辑</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

## 无障碍测试

### 自动化测试

```tsx
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

test('表单应该没有可访问性问题', async () => {
  const { container } = render(<ContactForm />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

### React DevTools 插件

安装「axe-core」插件，可以在浏览器中实时检测可访问性问题。

## 设计层面的 A11y

### 颜色对比度

```css
/* WCAG AA 标准：4.5:1（普通文本）*/
/* WCAG AA 标准：3:1（大文本）*/

/* ❌ 对比度不足 */
.text {
  color: #999; /* 灰色文字在白色背景上对比度不足 */
}

/* ✅ 足够的对比度 */
.text {
  color: #595959; /* 深灰色，对比度 > 4.5:1 */
}

/* 深色模式支持 */
@media (prefers-color-scheme: dark) {
  .text {
    color: #d4d4d4;
  }
}

/* 尊重用户减少动画的偏好 */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 总结

可访问性不是「锦上添花」，而是「必须做对」。关键要点：

1. **语义化 HTML**：使用正确的 HTML 元素是基础
2. **ARIA 属性**：补充语义信息，但不要过度使用
3. **键盘导航**：确保所有交互都可以通过键盘完成
4. **屏幕阅读器**：为动态内容提供实时通知
5. **自动化测试**：将可访问性检查纳入 CI/CD

可访问性是一个持续的过程，建议在项目初期就纳入考虑，而不是事后补救。记住：可访问性好的网站，对所有用户都更友好。
