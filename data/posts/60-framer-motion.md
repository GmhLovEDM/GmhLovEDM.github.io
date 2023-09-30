---
title: "Framer Motion in Practice: Building Smooth React Animations"
tag: react
description: From Framer Motion basics to advanced animation orchestration, covering layout animations, gesture interactions, page transitions, and other practical scenarios to bring your React application to life.
date: "2023-09-30T08:00:00.000Z"
---

## Goal

Animation is a key手段 for improving user experience, but animation development in React has always been a pain point. CSS animations are difficult to maintain, and third-party library APIs are inconsistent. Framer Motion (now renamed Motion) makes React animation development simple yet powerful through its declarative API and powerful animation engine. This article systematically explains Framer Motion's core usage from basics to practice.

## Background

### React Animation Pain Points

Before Framer Motion, there were several ways to do animations in React:

- **CSS transition/animation**: Sufficient for simple scenarios, but complex orchestration is difficult
- **React Transition Group**: Only provides enter/exit states, requiring manual animation management
- **GSAP**: Powerful but large in size, and not fully aligned with React's declarative philosophy
- **react-spring**: Spring physics model has a steep learning curve

Framer Motion addresses these issues by providing:

- **Declarative API**: Consistent with React's philosophy
- **Layout animations**: Smooth layout transitions without manual calculation
- **Gesture system**: Support for drag, swipe, zoom, and other gestures
- **Page transitions**: Deep integration with Next.js

## Basic Animations

### Simple Animations

```tsx
import { motion } from 'framer-motion';

// Basic fade-in
function FadeIn() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <h1>Fade In Effect</h1>
    </motion.div>
  );
}

// Hover animation
function HoverCard() {
  return (
    <motion.div
      whileHover={{ scale: 1.05, y: -5 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      className="card"
    >
      <p>Hover over me</p>
    </motion.div>
  );
}
```

### Animation Properties Explained

```tsx
<motion.div
  // Initial state
  initial={{ opacity: 0, x: -100 }}

  // Target state
  animate={{ opacity: 1, x: 0 }}

  // Exit state (with AnimatePresence)
  exit={{ opacity: 0, x: 100 }}

  // Transition configuration
  transition={{
    duration: 0.6,           // Duration
    ease: [0.25, 0.46, 0.45, 0.94], // Bezier curve
    delay: 0.2,              // Delay
    type: 'spring',         // Spring animation
    stiffness: 260,          // Spring stiffness
    damping: 20,             // Spring damping
    mass: 1,                 // Spring mass
  }}
>
  Content
</motion.div>
```

### Animation Variants

```tsx
// Define variants
const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1, // Children animate sequentially
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

// Use variants
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

## Layout Animations

### Layout Property

One of Framer Motion's most powerful features is layout animations, enabling smooth layout transitions without manual calculation:

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
        <p>Click to toggle size</p>
      </motion.div>
    </LayoutGroup>
  );
}
```

### Swap Animation

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
      <button onClick={swap}>Swap</button>
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

## Gesture Interactions

### Drag

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
        console.log('Dragging:', info.point);
      }}
      onDragEnd={(event, info) => {
        console.log('Drag ended:', info.offset);
      }}
    >
      Drag me
    </motion.div>
  );
}
```

### Drag Sorting

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

### Gesture Detection

```tsx
function GestureDemo() {
  return (
    <motion.div
      // Hover
      whileHover={{ scale: 1.1 }}
      // Tap
      whileTap={{ scale: 0.95 }}
      // Focus
      whileFocus={{ outline: '2px solid blue' }}
      // Drag
      drag
      // Gesture callbacks
      onHoverStart={() => console.log('hover start')}
      onHoverEnd={() => console.log('hover end')}
      onTap={() => console.log('tap')}
      onTapStart={() => console.log('tap start')}
      onTapCancel={() => console.log('tap cancel')}
    >
      Gesture Interaction
    </motion.div>
  );
}
```

## Page Transitions

### AnimatePresence

```tsx
import { AnimatePresence } from 'framer-motion';

function PageTransition() {
  const [currentPage, setCurrentPage] = useState('home');

  return (
    <div>
      <nav>
        <button onClick={() => setCurrentPage('home')}>Home</button>
        <button onClick={() => setCurrentPage('about')}>About</button>
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
            <h1>Home</h1>
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
            <h1>About</h1>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

### Integration with Next.js App Router

```tsx
// app/layout.tsx
'use client';

import { motion } from 'framer-motion';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
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

## Advanced Animation Orchestration

### Timeline Animation

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

### Scroll-Driven Animation

```tsx
import { useScroll, useTransform } from 'framer-motion';

function ScrollAnimation() {
  const { scrollYProgress } = useScroll();
  const opacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const scale = useTransform(scrollYProgress, [0, 0.5], [1, 0.8]);

  return (
    <motion.div style={{ opacity, scale }}>
      Fade out and scale down on scroll
    </motion.div>
  );
}

// Animation based on element scroll position
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
        Rotate on scroll
      </motion.div>
    </div>
  );
}
```

## Performance Optimization

### Using layoutId for Animation Optimization

```tsx
// ❌ Not recommended: Each card animates independently
{items.map(item => (
  <motion.div
    key={item.id}
    animate={{ x: item.x, y: item.y }}
  />
))}

// ✅ Recommended: Use layoutId for animation orchestration
{items.map(item => (
  <motion.div
    key={item.id}
    layoutId={`card-${item.id}`}
    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
  />
))}
```

### Avoiding Unnecessary Re-renders

```tsx
// ❌ Not recommended: Creates new animation objects on every render
function Bad() {
  return <motion.div animate={{ x: Math.random() * 100 }} />;
}

// ✅ Recommended: Use useMemo or variants
function Good() {
  const variants = useMemo(() => ({
    idle: { x: 0 },
    animate: { x: 100 },
  }), []);

  return <motion.div variants={variants} animate="animate" />;
}
```

## Conclusion

Framer Motion makes React animation development simple and efficient through its declarative API and powerful animation engine. Key takeaways:

1. **Declarative animation**: initial -> animate -> exit three-phase model
2. **Layout animations**: layout property enables smooth transitions without calculation
3. **Gesture system**: Native support for drag, hover, click, and other gestures
4. **Animation orchestration**: variants, stagger, timeline for complex animation sequences
5. **Performance optimization**: Use layoutId appropriately, avoid unnecessary re-renders

Animation is not just flashy decoration -- it is an important means of improving user experience. Mastering Framer Motion will make your React applications more vivid and fluid.
