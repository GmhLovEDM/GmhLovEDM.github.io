---
title: "Writing a Mini jQuery: Understanding the Mystery of Chain Calls"
tag: javascript
description: By writing a mini version of jQuery, deeply understand the implementation principles of selector engines, DOM operation encapsulation, and chain calls — know not just what but why.
date: "2021-06-20T08:00:00.000Z"
---

## Goal

By implementing a simplified version of jQuery (let's call it `$$`), deeply understand three core concepts:

1. How the **selector engine** works
2. How **DOM operations** are encapsulated
3. How **chain calls** are actually implemented

## Background

Many developers have used jQuery for years without ever understanding its internal implementation. Today we won't build a complete jQuery (that would require tens of thousands of lines of code), but instead implement a mini version that demonstrates the core ideas.

## Step 1: Basic Structure

jQuery's core is a constructor that accepts a selector and returns an array-like object (jQuery object):

```javascript
class MiniQuery {
    constructor(selector) {
        this.elements = [];
        this.length = 0;

        if (typeof selector === 'string') {
            // String selector
            this.elements = document.querySelectorAll(selector);
        } else if (selector instanceof HTMLElement) {
            // Single DOM element
            this.elements = [selector];
        } else if (selector instanceof NodeList || selector instanceof Array) {
            // Element collection
            this.elements = Array.from(selector);
        } else if (typeof selector === 'function') {
            // DOM Ready
            document.addEventListener('DOMContentLoaded', selector);
            return;
        }

        this.length = this.elements.length;
        // Map elements to indices, supporting access like $$('div')[0]
        this.elements.forEach((el, i) => { this[i] = el; });
    }
}

// Factory function, simulating $()
function $$(selector) {
    return new MiniQuery(selector);
}
```

## Step 2: The Secret of Chain Calls

**The key to chain calls: every method returns `this`.**

```javascript
// Without chain calls
$$('.box').addClass('active');
$$('.box').removeClass('old');
$$('.box').css('color', 'red');

// With chain calls
$$('.box').addClass('active').removeClass('old').css('color', 'red');
```

The implementation is very simple:

```javascript
MiniQuery.prototype.addClass = function(className) {
    this.elements.forEach(el => el.classList.add(className));
    return this; // Key: return this
};

MiniQuery.prototype.removeClass = function(className) {
    this.elements.forEach(el => el.classList.remove(className));
    return this;
};

MiniQuery.prototype.css = function(property, value) {
    if (typeof property === 'string' && value === undefined) {
        // Get style
        return window.getComputedStyle(this.elements[0])[property];
    }

    if (typeof property === 'object') {
        // Batch set
        this.elements.forEach(el => {
            Object.assign(el.style, property);
        });
    } else {
        // Single set
        this.elements.forEach(el => {
            el.style[property] = value;
        });
    }
    return this;
};
```

**Core principle**: In JavaScript, `this` refers to the object that called the method. When we return `this`, the next method call still operates on the same `MiniQuery` instance.

## Step 3: DOM Operation Encapsulation

### Text and HTML Content

```javascript
MiniQuery.prototype.html = function(content) {
    if (content === undefined) {
        return this.elements[0]?.innerHTML;
    }
    this.elements.forEach(el => { el.innerHTML = content; });
    return this;
};

MiniQuery.prototype.text = function(content) {
    if (content === undefined) {
        return this.elements[0]?.textContent;
    }
    this.elements.forEach(el => { el.textContent = content; });
    return this;
};

MiniQuery.prototype.val = function(value) {
    if (value === undefined) {
        return this.elements[0]?.value;
    }
    this.elements.forEach(el => { el.value = value; });
    return this;
};
```

### Attribute Operations

```javascript
MiniQuery.prototype.attr = function(name, value) {
    if (typeof name === 'object') {
        // Batch set
        this.elements.forEach(el => {
            Object.entries(name).forEach(([k, v]) => el.setAttribute(k, v));
        });
    } else if (value === undefined) {
        return this.elements[0]?.getAttribute(name);
    } else {
        this.elements.forEach(el => el.setAttribute(name, value));
    }
    return this;
};

MiniQuery.prototype.removeAttr = function(name) {
    this.elements.forEach(el => el.removeAttribute(name));
    return this;
};
```

### DOM Traversal

```javascript
MiniQuery.prototype.find = function(selector) {
    const results = [];
    this.elements.forEach(el => {
        el.querySelectorAll(selector).forEach(child => results.push(child));
    });
    return $$(results);
};

MiniQuery.prototype.parent = function() {
    const parents = new Set();
    this.elements.forEach(el => {
        if (el.parentElement) parents.add(el.parentElement);
    });
    return $$(Array.from(parents));
};

MiniQuery.prototype.children = function() {
    const children = [];
    this.elements.forEach(el => {
        Array.from(el.children).forEach(child => children.push(child));
    });
    return $$(children);
};

MiniQuery.prototype.next = function() {
    const nexts = [];
    this.elements.forEach(el => {
        if (el.nextElementSibling) nexts.push(el.nextElementSibling);
    });
    return $$(nexts);
};
```

### DOM Manipulation

```javascript
MiniQuery.prototype.append = function(content) {
    this.elements.forEach(el => {
        if (typeof content === 'string') {
            el.insertAdjacentHTML('beforeend', content);
        } else if (content instanceof HTMLElement) {
            el.appendChild(content);
        } else if (content instanceof MiniQuery) {
            content.elements.forEach(child => el.appendChild(child));
        }
    });
    return this;
};

MiniQuery.prototype.prepend = function(content) {
    this.elements.forEach(el => {
        if (typeof content === 'string') {
            el.insertAdjacentHTML('afterbegin', content);
        } else if (content instanceof HTMLElement) {
            el.insertBefore(content, el.firstChild);
        }
    });
    return this;
};

MiniQuery.prototype.remove = function() {
    this.elements.forEach(el => el.remove());
    return this;
};

MiniQuery.prototype.clone = function() {
    const clones = this.elements.map(el => el.cloneNode(true));
    return $$(clones);
};
```

## Step 4: Event System

```javascript
MiniQuery.prototype.on = function(event, handler) {
    this.elements.forEach(el => {
        el.addEventListener(event, handler);
    });
    return this;
};

MiniQuery.prototype.off = function(event, handler) {
    this.elements.forEach(el => {
        el.removeEventListener(event, handler);
    });
    return this;
};

// Shortcut methods
['click', 'focus', 'blur', 'mouseenter', 'mouseleave', 'keydown', 'keyup'].forEach(event => {
    MiniQuery.prototype[event] = function(handler) {
        return this.on(event, handler);
    };
});
```

### Event Delegation

```javascript
MiniQuery.prototype.delegate = function(selector, event, handler) {
    this.elements.forEach(el => {
        el.addEventListener(event, (e) => {
            if (e.target.closest(selector)) {
                handler.call(e.target, e);
            }
        });
    });
    return this;
};

// Usage
$$('.list').delegate('li', 'click', function(e) {
    console.log('Clicked:', this.textContent);
});
```

## Step 5: Animation Effects

```javascript
MiniQuery.prototype.animate = function(styles, duration = 300, callback) {
    this.elements.forEach(el => {
        el.style.transition = `all ${duration}ms ease`;
        Object.assign(el.style, styles);
    });

    setTimeout(() => {
        this.elements.forEach(el => {
            el.style.transition = '';
        });
        if (callback) callback();
    }, duration);

    return this;
};

MiniQuery.prototype.fadeIn = function(duration = 300) {
    this.elements.forEach(el => {
        el.style.opacity = '0';
        el.style.display = 'block';
    });
    // Trigger reflow
    this.elements[0]?.offsetHeight;
    return this.animate({ opacity: 1 }, duration);
};

MiniQuery.prototype.fadeOut = function(duration = 300) {
    return this.animate({ opacity: 0 }, duration, () => {
        this.elements.forEach(el => {
            el.style.display = 'none';
        });
    });
};
```

## Testing Our MiniQuery

```javascript
// HTML: <div class="box">Hello</div>

$$('.box')
    .addClass('active')
    .css({ color: 'red', fontSize: '20px' })
    .html('World')
    .on('click', function() {
        $$(this).fadeOut(500);
    });
```

## Truly Understanding Chain Calls

### Chain Calls vs Imperative

```javascript
// Imperative: each step is an independent statement
const box = $$('.box');
box.addClass('active');
box.css('color', 'red');
box.on('click', handler);

// Chain calls: one statement completes all operations
$$('.box')
    .addClass('active')
    .css('color', 'red')
    .on('click', handler);
```

### Limitations of Chain Calls

Chain calls are not suitable for methods that **return values**:

```javascript
// This method shouldn't be chain-called because it needs to return a value
$$('.box').width(); // Returns width, not this

// Solution: getter methods don't return this
MiniQuery.prototype.width = function() {
    if (this.elements[0]) {
        return this.elements[0].offsetWidth;
    }
};
```

## Comparison with Real jQuery

Our MiniQuery is about 150 lines of code, while jQuery 1.x minified is about 85KB. The main differences are:

1. **Selector engine**: We use `querySelectorAll`, jQuery has its own Sizzle engine
2. **Browser compatibility**: We only support modern browsers, jQuery supports IE6+
3. **Performance optimization**: jQuery has extensive performance optimizations (caching, batch operations, etc.)
4. **Plugin system**: jQuery has a complete plugin ecosystem

But the core ideas are the same: **selector → operation → chain call**.

## Summary

By writing MiniQuery, you should now understand:

1. **The `$()` factory function** is just syntactic sugar; behind it is a constructor
2. **Chain calls** are fundamentally about returning `this`
3. **The getter/setter pattern** lets the same method both read and write
4. **Event delegation** leverages the event bubbling mechanism
5. **jQuery objects** are array-like objects, not true arrays

With this understanding, you truly comprehend jQuery's design philosophy. Next time you use `$()`, you'll know exactly what happens behind the scenes.
