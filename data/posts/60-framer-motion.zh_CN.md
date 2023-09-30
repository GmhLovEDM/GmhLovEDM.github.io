---
title: "Framer Motion 实战：打造流畅的 React 动画"
tag: react
description: 从 Framer Motion 基础到高级动画编排，涵盖布局动画、手势交互、页面过渡等实战场景，让你的 React 应用动起来。
date: "2023-09-30T08:00:00.000Z"
---

## 目标

动画是提升用户体验的关键手段，但 React 中的动画开发一直是个痛点。CSS 动画难以维护，第三方库 API 不统一。Framer Motion（现已更名为 Motion）通过声明式 API 和强大的动画引擎，让 React 动画开发变得简单而强大。本文从基础到实战，系统讲解 Framer Motion 的核心用法。

## 背景

### React 动画的痛点

在 Framer Motion 出现之前，React 中做动画主要有几种方式：

- **CSS transition/animation**：简单场景够用，但复杂编排困难
- **React Transition Group**：只提供进出状态，需要手动管理动画
- **GSAP**：功能强大但体积大，且与 React 的声明式理念不完全匹配
- **react-spring**：弹簧物理模型学习成本较高

Framer Motion 的出现解决了这些问题，它提供了：

- **声明式 API**：与 React 的理念一致
- **布局动画**：无需计算即可实现流畅的布局过渡
- **手势系统**：拖拽、滑动、缩放等手势支持
- **页面过渡**：与 Next.js 深度集成

## 基础动画

### 简单动画

```tsx
import { motion } from 'framer-motion';

// 基础淡入
function FadeIn() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <h1>淡入效果</h1>
    </motion.div>
  );
}

// 悬停动画
function HoverCard() {
  return (
    <motion.div
      whileHover={{ scale: 1.05, y: -5 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      className="card"
    >
      <p>悬停我试试</p>
    </motion.div>
  );
}
```

### 动画属性详解

```tsx
<motion.div
  // 初始状态
  initial={{ opacity: 0, x: -100 }}

  // 目标状态
  animate={{ opacity: 1, x: 0 }}

  // 退出状态（配合 AnimatePresence）
  exit={{ opacity: 0, x: 100 }}

  // 过渡配置
  transition={{
    duration: 0.6,           // 持续时间
    ease: [0.25, 0.46, 0.45, 0.94], // 贝塞尔曲线
    delay: 0.2,              // 延迟
    type: 'spring',         // 弹簧动画
    stiffness: 260,          // 弹簧刚度
    damping: 20,             // 弹簧阻尼
    mass: 1,                 // 弹簧质量
  }}
>
  Content
</motion.div>
```

### 动画变体（Variants）

```tsx
// 定义变体
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1, // 子元素依次动画
      delayChildren: 0.3,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 300,
      damping: 24,
    },
  },
};

// 使用变体
function StaggerList() {
  return (
    <motion.ul
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {items.map((item, index) => (
        <motion.li key={item.id} variants={itemVariants}>
          {item.name}
        </motion.li>
      ))}
    </motion.ul>
  );
}
```

## 布局动画

### Layout 属性

Framer Motion 最强大的特性之一是布局动画，无需手动计算即可实现流畅的布局过渡：

```tsx
import { motion, LayoutGroup } from 'framer-motion';

function LayoutDemo() {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <LayoutGroup>
      <motion.div
        layout
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          width: isExpanded ? 400 : 200,
          height: isExpanded ? 300 : 100,
          backgroundColor: '#3b82f6',
        }}
        transition={{
          type: 'spring',
          stiffness: 500,
          damping: 30,
        }}
      >
        <p>点击切换大小</p>
      </motion.div>
    </LayoutGroup>
  );
}
```

### 交换动画

```tsx
function SwapAnimation() {
  const [items, setItems] = useState(['A', 'B', 'C']);

  const swap = () => {
    setItems(prev => {
      const newItems = [...prev];
      [newItems[0], newItems[2]] = [newItems[2], newItems[0]];
      return newItems;
    });
  };

  return (
    <div>
      <button onClick={swap}>交换</button>
      <motion.div layout className="container">
        {items.map(item => (
          <motion.div
            key={item}
            layout
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {item}
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
```

## 手势交互

### 拖拽

```tsx
function DraggableCard() {
  return (
    <motion.div
      drag
      dragConstraints={{
        top: -100,
        bottom: 100,
        left: -200,
        right: 200,
      }}
      dragElastic={0.1}
      whileDrag={{ scale: 1.1, boxShadow: '0 20px 40px rgba(0,0,0,0.3)' }}
      onDrag={(event, info) => {
        console.log('拖拽中:', info.point);
      }}
      onDragEnd={(event, info) => {
        console.log('拖拽结束:', info.offset);
      }}
    >
      拖拽我
    </motion.div>
  );
}
```

### 拖拽排序

```tsx
function DragSort() {
  const [items, setItems] = useState([1, 2, 3, 4, 5]);

  return (
    <Reorder.Group axis="y" values={items} onReorder={setItems}>
      {items.map(item => (
        <Reorder.Item key={item} value={item}>
          <div className="item">{item}</div>
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}
```

### 手势检测

```tsx
function GestureDemo() {
  return (
    <motion.div
      // 悬停
      whileHover={{ scale: 1.1 }}
      // 按下
      whileTap={{ scale: 0.95 }}
      // 焦点
      whileFocus={{ outline: '2px solid blue' }}
      // 拖拽
      drag
      // 手势回调
      onHoverStart={() => console.log('hover start')}
      onHoverEnd={() => console.log('hover end')}
      onTap={() => console.log('tap')}
      onTapStart={() => console.log('tap start')}
      onTapCancel={() => console.log('tap cancel')}
    >
      手势交互
    </motion.div>
  );
}
```

## 页面过渡

### AnimatePresence

```tsx
import { AnimatePresence } from 'framer-motion';

function PageTransition() {
  const [currentPage, setCurrentPage] = useState('home');

  return (
    <div>
      <nav>
        <button onClick={() => setCurrentPage('home')}>首页</button>
        <button onClick={() => setCurrentPage('about')}>关于</button>
      </nav>

      <AnimatePresence mode="wait">
        {currentPage === 'home' && (
          <motion.div
            key="home"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.3 }}
          >
            <h1>首页</h1>
          </motion.div>
        )}

        {currentPage === 'about' && (
          <motion.div
            key="about"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={{ duration: 0.3 }}
          >
            <h1>关于</h1>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

### 与 Next.js App Router 集成

```tsx
// app/layout.tsx
'use client';

import { motion } from 'framer-motion';

export default function RootLayout({ children }) {
  return (
    <html lang="zh">
      <body>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          {children}
        </motion.div>
      </body>
    </html>
  );
}
```

## 高级动画编排

### 时间线动画

```tsx
function TimelineAnimation() {
  return (
    <motion.div
      animate={{
        x: [0, 100, 100, 0],
        y: [0, 0, 100, 100],
        rotate: [0, 90, 180, 270],
      }}
      transition={{
        duration: 2,
        times: [0, 0.3, 0.6, 1],
        ease: 'easeInOut',
        repeat: Infinity,
      }}
    />
  );
}
```

### 滚动驱动动画

```tsx
import { useScroll, useTransform } from 'framer-motion';

function ScrollAnimation() {
  const { scrollYProgress } = useScroll();
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.8]);

  return (
    <motion.div style={{ opacity, scale }}>
      滚动时淡出和缩小
    </motion.div>
  );
}

// 基于元素滚动位置的动画
function ElementScrollAnimation() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  });

  const rotate = useTransform(scrollYProgress, [0, 1], [0, 360]);

  return (
    <div ref={ref}>
      <motion.div style={{ rotate }}>
        滚动时旋转
      </motion.div>
    </div>
  );
}
```

## 性能优化

### 使用 layoutId 优化动画

```tsx
// ❌ 不推荐：每个卡片独立动画
{items.map(item => (
  <motion.div
    key={item.id}
    animate={{ x: item.x, y: item.y }}
  />
))}

// ✅ 推荐：使用 layoutId 进行动画编排
{items.map(item => (
  <motion.div
    key={item.id}
    layoutId={`card-${item.id}`}
    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
  />
))}
```

### 避免不必要的重渲染

```tsx
// ❌ 不推荐：每次渲染都创建新的动画对象
function Bad() {
  return <motion.div animate={{ x: Math.random() * 100 }} />;
}

// ✅ 推荐：使用 useMemo 或 variants
function Good() {
  const variants = useMemo(() => ({
    idle: { x: 0 },
    animate: { x: 100 },
  }), []);

  return <motion.div variants={variants} animate="animate" />;
}
```

## 总结

Framer Motion 通过声明式 API 和强大的动画引擎，让 React 动画开发变得简单而高效。关键要点：

1. **声明式动画**：initial → animate → exit 三阶段模型
2. **布局动画**：layout 属性实现无需计算的流畅过渡
3. **手势系统**：拖拽、悬停、点击等手势的原生支持
4. **动画编排**：variants、stagger、timeline 实现复杂动画序列
5. **性能优化**：合理使用 layoutId，避免不必要的重渲染

动画不是花哨的装饰，而是提升用户体验的重要手段。掌握 Framer Motion，能让你的 React 应用更加生动、流畅。
