---
title: "Can jQuery Fight Another Decade? An Old Fan's Reflection"
tag: jquery
description: From jQuery's golden era to being replaced by modern frameworks, this article deeply analyzes jQuery's core value, historical limitations, and its true positioning in 2021 and beyond.
date: "2021-03-15T08:00:00.000Z"
---

## Goal

This article answers a question that many people care about but are reluctant to face directly: **Does jQuery still have value for learning and use in 2021?** If so, where are its applicable boundaries? If not, how should we gracefully say goodbye to it?

## Background

### jQuery's Golden Era

In 2006, John Resig released jQuery 1.0. That was a primitive era of frontend development — browser compatibility nightmares (IE6/7/8 each doing their own thing), cumbersome and difficult DOM APIs, and AJAX requiring manual handling of various `XMLHttpRequest` states.

jQuery burst onto the scene with "Write Less, Do More" and almost unified the way frontend development was done:

```javascript
// 2008, getting an element and binding events
$('#myButton').click(function() {
    $.ajax({
        url: '/api/data',
        success: function(data) {
            $('#result').html(data);
        }
    });
});
```

This code was simply magic at the time. No need to consider browser differences, no need to write piles of compatibility code — one `$` symbol handled everything.

### Why I'm "Reflecting"

As a developer who came through the jQuery era, I once thought it would always be the standard for frontend. But the reality is:

1. **The rise of React, Vue, and Angular** made jQuery's DOM manipulation mindset obsolete
2. **ES6+ native APIs** reclaimed many capabilities that jQuery once filled
3. **The prevalence of TypeScript** made jQuery's dynamic type design feel out of place
4. **The standardization of build tools** made jQuery's "script tag inclusion" approach no longer mainstream

## Deep Analysis: jQuery's Core Value

### 1. The Sizzle Selector Engine

One of jQuery's most core contributions was the **Sizzle selector engine**. It implemented complete CSS selector queries before CSS selectors were natively supported by browsers.

```javascript
// jQuery selectors (available since 2006)
$('ul > li:first-child');
$('[data-type="user"]:not(.admin)');
```

But modern browsers now natively support `querySelector` and `querySelectorAll`:

```javascript
// Native JS (completely replaceable in 2021)
document.querySelectorAll('ul > li:first-child');
document.querySelectorAll('[data-type="user"]:not(.admin)');
```

**Conclusion: Selector capability has been matched by native APIs.**

### 2. AJAX Encapsulation

jQuery's `$.ajax()` was once the de facto standard for frontend HTTP requests. It unified the implementation differences of `XMLHttpRequest` across different browsers.

```javascript
// jQuery AJAX
$.ajax({
    url: '/api/users',
    method: 'GET',
    dataType: 'json',
    success: function(data) { /* ... */ },
    error: function(xhr, status, error) { /* ... */ }
});
```

But the `fetch` API has become a W3C standard and is supported by all modern browsers:

```javascript
// Native fetch
fetch('/api/users')
    .then(res => res.json())
    .then(data => { /* ... */ })
    .catch(error => { /* ... */ });

// Or more elegantly with async/await
async function getUsers() {
    try {
        const res = await fetch('/api/users');
        const data = await res.json();
    } catch (error) {
        // handle error
    }
}
```

**Conclusion: fetch + Promise is already more modern and flexible than jQuery AJAX.**

### 3. DOM Manipulation

This is jQuery's last and most stubborn stronghold. Its chain calls and batch operations are indeed elegant:

```javascript
$('#list')
    .addClass('active')
    .find('li')
    .eq(0)
    .css('color', 'red')
    .end()
    .animate({ opacity: 0.5 }, 500);
```

But this imperative DOM manipulation approach is itself the problem. The core concept of modern frameworks is **declarative rendering** — you only need to describe the state, and the framework automatically updates the DOM:

```html
<!-- Vue 3 -->
<template>
  <ul :class="{ active: isActive }">
    <li v-for="(item, index) in list" :key="item.id" :style="{ color: index === 0 ? 'red' : '' }">
      {{ item.name }}
    </li>
  </ul>
</template>
```

## jQuery's True Positioning in 2021

### Still Suitable Scenarios

1. **Legacy project maintenance**: Many enterprise-level projects still use jQuery, and the cost of rash refactoring is extremely high
2. **Simple static pages**: Pure display websites, landing pages — no need for SPA complexity
3. **WordPress plugin development**: The WordPress ecosystem still heavily relies on jQuery
4. **jQuery plugin ecosystem**: Mature plugins like DataTable, Slick Carousel, etc.

### No Longer Suitable Scenarios

1. **Medium to large SPA applications**: State management, componentization, routing — capabilities jQuery doesn't possess
2. **Mobile development**: jQuery's DOM manipulation model is unfriendly to performance
3. **TypeScript projects**: jQuery's type definitions are not comprehensive enough
4. **SSR/SSG requirements**: jQuery depends on DOM and cannot be used in Node.js environments

## An Interesting Experiment: How Many Lines Does Native JS Need to Do What jQuery Can?

Let's compare some common operations:

### Fade In Effect

```javascript
// jQuery
$('#el').fadeIn(300);

// Native JS (requires more code)
function fadeIn(el, duration) {
    el.style.opacity = 0;
    el.style.display = 'block';
    el.style.transition = `opacity ${duration}ms`;
    requestAnimationFrame(() => {
        el.style.opacity = 1;
    });
}
```

### Event Delegation

```javascript
// jQuery
$(document).on('click', '.dynamic-item', function() { /* ... */ });

// Native JS
document.addEventListener('click', function(e) {
    if (e.target.closest('.dynamic-item')) {
        // handle
    }
});
```

As you can see, jQuery is indeed more concise, but native JS capabilities have completely covered it. **Writing a few more lines of code in exchange for zero dependencies and better performance** — this trade-off is worthwhile in 2021.

## My Recommendations

### For Beginner Developers

**Don't start learning with jQuery.** Learn modern JavaScript (ES6+) and a mainstream framework (Vue/React) directly. jQuery's mindset (DOM manipulation) and modern frontend's core philosophy (data-driven) are different directions.

### For Experienced Developers

1. **Don't introduce jQuery in new projects** — unless there's a clear reason (like needing to use a specific jQuery plugin)
2. **Learn native JS alternatives** — `fetch`, `querySelector`, `classList`, `IntersectionObserver`, etc.
3. **If maintaining old projects**, there's no rush to remove jQuery, but you can gradually replace it with native APIs

### A Pragmatic Migration Strategy

```javascript
// Step 1: Gradually replace selectors
// Before
const $el = $('.my-class');
// After
const el = document.querySelector('.my-class');

// Step 2: Replace AJAX
// Before
$.get('/api/data', callback);
// After
fetch('/api/data').then(res => res.json()).then(callback);

// Step 3: Replace DOM operations
// Before
$el.addClass('active').text('Hello');
// After
el.classList.add('active');
el.textContent = 'Hello';

// Step 4: Remove jQuery reference
```

## Conclusion

Can jQuery fight another decade? **As a library, it can continue to be maintained and used, but it will no longer become the mainstream of frontend development.** Just as jQuery eliminated Prototype.js and MooTools, the wheels of time keep turning.

jQuery's historical contributions are indelible — it taught the entire industry what "developer experience" means, what "chain calls" are, and what a "plugin ecosystem" looks like. These ideas deeply influenced every frontend framework that came after.

But frontend development in 2021 needs componentization, declarative programming, type safety, and engineering practices. jQuery is an excellent tool, but it's a tool from the previous era.

**Salute to jQuery, then keep moving forward.**
