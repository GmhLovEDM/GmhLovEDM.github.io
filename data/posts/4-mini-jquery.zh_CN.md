---
title: "手写一个简易版 jQuery，理解链式调用的奥秘"
tag: javascript
description: 通过手写一个迷你版 jQuery，深入理解选择器引擎、DOM 操作封装和链式调用的实现原理，知其然更知其所以然。
date: "2021-06-20T08:00:00.000Z"
---

## 目标

通过实现一个简化版的 jQuery（暂且叫它 `$$`），深入理解三个核心概念：

1. **选择器引擎**是如何工作的
2. **DOM 操作**是如何被封装的
3. **链式调用**到底是怎么实现的

## 背景

很多开发者用了多年 jQuery，却从未理解过它的内部实现。今天我们不造一个完整的 jQuery（那需要几万行代码），而是实现一个能展示核心思想的迷你版本。

## 第一步：基础结构

jQuery 的核心是一个构造函数，它接收一个选择器，返回一个类数组对象（jQuery 对象）：

```javascript
class MiniQuery {
    constructor(selector) {
        this.elements = [];
        this.length = 0;

        if (typeof selector === 'string') {
            // 字符串选择器
            this.elements = document.querySelectorAll(selector);
        } else if (selector instanceof HTMLElement) {
            // 单个 DOM 元素
            this.elements = [selector];
        } else if (selector instanceof NodeList || selector instanceof Array) {
            // 元素集合
            this.elements = Array.from(selector);
        } else if (typeof selector === 'function') {
            // DOM Ready
            document.addEventListener('DOMContentLoaded', selector);
            return;
        }

        this.length = this.elements.length;
        // 将元素映射到索引上，支持 $$('div')[0] 这样的访问
        this.elements.forEach((el, i) => { this[i] = el; });
    }
}

// 工厂函数，模拟 $()
function $$(selector) {
    return new MiniQuery(selector);
}
```

## 第二步：链式调用的秘密

**链式调用的关键：每个方法都返回 `this`。**

```javascript
// 没有链式调用
$$('.box').addClass('active');
$$('.box').removeClass('old');
$$('.box').css('color', 'red');

// 有链式调用
$$('.box').addClass('active').removeClass('old').css('color', 'red');
```

实现方式非常简单：

```javascript
MiniQuery.prototype.addClass = function(className) {
    this.elements.forEach(el => el.classList.add(className));
    return this; // 关键：返回 this
};

MiniQuery.prototype.removeClass = function(className) {
    this.elements.forEach(el => el.classList.remove(className));
    return this;
};

MiniQuery.prototype.css = function(property, value) {
    if (typeof property === 'string' && value === undefined) {
        // 获取样式
        return window.getComputedStyle(this.elements[0])[property];
    }

    if (typeof property === 'object') {
        // 批量设置
        this.elements.forEach(el => {
            Object.assign(el.style, property);
        });
    } else {
        // 单个设置
        this.elements.forEach(el => {
            el.style[property] = value;
        });
    }
    return this;
};
```

**核心原理**：JavaScript 中 `this` 指向调用方法的对象。当我们返回 `this` 时，下一个方法调用仍然在同一个 `MiniQuery` 实例上进行。

## 第三步：DOM 操作封装

### 文本和 HTML 内容

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

### 属性操作

```javascript
MiniQuery.prototype.attr = function(name, value) {
    if (typeof name === 'object') {
        // 批量设置
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

### DOM 遍历

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

### DOM 操作

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

## 第四步：事件系统

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

// 快捷方法
['click', 'focus', 'blur', 'mouseenter', 'mouseleave', 'keydown', 'keyup'].forEach(event => {
    MiniQuery.prototype[event] = function(handler) {
        return this.on(event, handler);
    };
});
```

### 事件委托

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

// 使用
$$('.list').delegate('li', 'click', function(e) {
    console.log('点击了:', this.textContent);
});
```

## 第五步：动画效果

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
    // 触发 reflow
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

## 测试我们的 MiniQuery

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

## 真正理解链式调用

### 链式调用 vs 命令式

```javascript
// 命令式：每一步都是独立的语句
const box = $$('.box');
box.addClass('active');
box.css('color', 'red');
box.on('click', handler);

// 链式调用：一条语句完成所有操作
$$('.box')
    .addClass('active')
    .css('color', 'red')
    .on('click', handler);
```

### 链式调用的局限

链式调用不适合**返回值**的方法：

```javascript
// 这个方法不应该链式调用，因为它需要返回值
$$('.box').width(); // 返回宽度，不是 this

// 解决方案：getter 方法不返回 this
MiniQuery.prototype.width = function() {
    if (this.elements[0]) {
        return this.elements[0].offsetWidth;
    }
};
```

## 与真实 jQuery 的对比

我们的 MiniQuery 大约 150 行代码，而 jQuery 1.x 压缩后约 85KB。差异主要在于：

1. **选择器引擎**：我们用 `querySelectorAll`，jQuery 有自己的 Sizzle 引擎
2. **浏览器兼容**：我们只支持现代浏览器，jQuery 兼容 IE6+
3. **性能优化**：jQuery 有大量的性能优化（缓存、批量操作等）
4. **插件系统**：jQuery 有完整的插件生态

但核心思想是一致的：**选择器 → 操作 → 链式调用**。

## 总结

通过手写 MiniQuery，你应该理解了：

1. **`$()` 工厂函数**只是一个语法糖，背后是构造函数
2. **链式调用**的核心就是返回 `this`
3. **getter/setter 模式**让同一个方法既能读又能写
4. **事件委托**利用事件冒泡机制实现
5. **jQuery 对象**是一个类数组对象，不是真正的数组

理解了这些，你就真正理解了 jQuery 的设计哲学。下次再用 `$()` 的时候，你知道它背后发生了什么。
