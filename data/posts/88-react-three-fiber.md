---
title: "Introduction to 3D on the Web: Three.js + React Three Fiber in Practice"
tag: react
description: A beginner's guide to 3D graphics programming on the web, building interactive 3D scenes using Three.js and React Three Fiber.
date: "2024-09-30T08:00:00.000Z"
---

## Goal

This article aims to help frontend developers get started with 3D graphics programming, master the basic concepts and practical techniques of Three.js and React Three Fiber, and build interactive 3D web applications.

## Background

With the development of web technology, 3D graphics are increasingly used on the web. From product displays to data visualization to game development, 3D technology is changing how users interact with web pages.

### Why Choose Three.js + React Three Fiber?

1. **Three.js**: The most popular WebGL library, wrapping low-level graphics APIs
2. **React Three Fiber (R3F)**: Three.js's React renderer, writing 3D with React
3. **Ecosystem**: Drei (utility library), React Three Postprocessing (post-processing)

### Prerequisites

- React basics
- TypeScript basics (recommended)
- 3D math concepts (vectors, matrices, rotations)

## 1. Environment Setup

### Install Dependencies

```bash
# Create React project
npx create-react-app my-3d-app --template typescript

# Install Three.js and React Three Fiber
npm install three @react-three/fiber @react-three/drei

# Install type definitions
npm install -D @types/three
```

### First 3D Scene

```tsx
// App.tsx
import { Canvas } from '@react-three/fiber';

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Canvas>
        {/* Ambient light */}
        <ambientLight intensity={0.5} />
        
        {/* Point light */}
        <pointLight position={[10, 10, 10]} />
        
        {/* Cube */}
        <mesh>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="orange" />
        </mesh>
      </Canvas>
    </div>
  );
}

export default App;
```

## 2. Three.js Core Concepts

### Scene

```typescript
import * as THREE from 'three';

// Create scene
const scene = new THREE.Scene();

// Set background color
scene.background = new THREE.Color(0x1a1a2e);

// Add fog effect
scene.fog = new THREE.Fog(0x1a1a2e, 10, 50);
```

### Camera

```typescript
// Perspective camera (most commonly used)
const camera = new THREE.PerspectiveCamera(
  75,  // Field of view
  window.innerWidth / window.innerHeight,  // Aspect ratio
  0.1,  // Near clipping plane
  1000  // Far clipping plane
);

camera.position.set(0, 2, 5);
camera.lookAt(0, 0, 0);
```

### Renderer

```typescript
const renderer = new THREE.WebGLRenderer({
  antialias: true,  // Anti-aliasing
  alpha: true,      // Transparent background
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

### Geometry

```typescript
// Box
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

// Sphere
const sphereGeometry = new THREE.SphereGeometry(0.5, 32, 32);

// Cylinder
const cylinderGeometry = new THREE.CylinderGeometry(0.5, 0.5, 2, 32);

// Plane
const planeGeometry = new THREE.PlaneGeometry(10, 10);
```

### Material

```typescript
// Basic material
const basicMaterial = new THREE.MeshBasicMaterial({
  color: 0x00ff00,
  wireframe: true,
});

// Standard material (PBR)
const standardMaterial = new THREE.MeshStandardMaterial({
  color: 0xff0000,
  metalness: 0.5,
  roughness: 0.5,
  envMapIntensity: 1.0,
});

// Normal material
const normalMaterial = new THREE.MeshNormalMaterial();
```

## 3. React Three Fiber Basics

### Canvas Component

```tsx
import { Canvas } from '@react-three/fiber';

function Scene() {
  return (
    <Canvas
      camera={{ position: [0, 2, 5], fov: 75 }}
      style={{ background: '#1a1a2e' }}
      shadows
      gl={{ antialias: true }}
    >
      <ambientLight intensity={0.5} />
      <pointLight position={[10, 10, 10]} castShadow />
      
      <mesh receiveShadow castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="orange" />
      </mesh>
      
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]} receiveShadow>
        <planeGeometry args={[10, 10]} />
        <meshStandardMaterial color="gray" />
      </mesh>
    </Canvas>
  );
}
```

### Mesh Component

```tsx
// Basic Mesh
<mesh position={[0, 0, 0]} rotation={[0, 0, 0]} scale={[1, 1, 1]}>
  <boxGeometry args={[1, 1, 1]} />
  <meshStandardMaterial color="orange" />
</mesh>

// Mesh with events
<mesh
  onClick={(e) => console.log('clicked', e.object)}
  onPointerOver={(e) => document.body.style.cursor = 'pointer'}
  onPointerOut={(e) => document.body.style.cursor = 'auto'}
>
  <sphereGeometry args={[0.5, 32, 32]} />
  <meshStandardMaterial color="blue" />
</mesh>
```

### Using Hooks

```tsx
import { useFrame, useThree } from '@react-three/fiber';

function AnimatedBox() {
  const meshRef = useRef<THREE.Mesh>(null);
  
  // Update every frame
  useFrame((state, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.x += delta;
      meshRef.current.rotation.y += delta * 0.5;
    }
  });

  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="orange" />
    </mesh>
  );
}
```

## 4. Drei Utility Library

### Common Components

```tsx
import {
  OrbitControls,
  PerspectiveCamera,
  Environment,
  ContactShadows,
  Text,
  Float,
  MeshReflectorMaterial,
} from '@react-three/drei';

function AdvancedScene() {
  return (
    <Canvas>
      {/* Orbit controls */}
      <OrbitControls
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={2}
        maxDistance={10}
      />

      {/* Environment map */}
      <Environment preset="sunset" />

      {/* Contact shadows */}
      <ContactShadows
        position={[0, -1.5, 0]}
        opacity={0.4}
        scale={10}
        blur={2.5}
        far={4}
      />

      {/* 3D text */}
      <Float speed={1.4} rotationIntensity={0.5}>
        <Text
          fontSize={0.5}
          color="white"
          anchorX="center"
          anchorY="middle"
        >
          Hello R3F
        </Text>
      </Float>

      {/* Reflective floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.5, 0]}>
        <planeGeometry args={[50, 50]} />
        <MeshReflectorMaterial
          blur={[300, 100]}
          resolution={1024}
          mixBlur={1}
          mixStrength={40}
          roughness={1}
          depthScale={1.2}
          minDepthThreshold={0.4}
          maxDepthThreshold={1.4}
          color="#151515"
          metalness={0.5}
        />
      </mesh>

      {/* Model */}
      <Model url="/models/character.glb" />
    </Canvas>
  );
}
```

### Loading 3D Models

```tsx
import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const modelRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (modelRef.current) {
      modelRef.current.rotation.y += 0.01;
    }
  });

  return (
    <primitive
      ref={modelRef}
      object={scene}
      scale={0.5}
      position={[0, -1, 0]}
    />
  );
}

// Preload
useGLTF.preload('/models/character.glb');
```

## 5. Interaction and Animation

### Click Interaction

```tsx
function InteractiveBox() {
  const [hovered, setHovered] = useState(false);
  const [clicked, setClicked] = useState(false);

  return (
    <mesh
      onClick={() => setClicked(!clicked)}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      scale={clicked ? 1.5 : 1}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={hovered ? 'hotpink' : 'orange'}
      />
    </mesh>
  );
}
```

### Animation System

```tsx
import { useAnimations } from '@react-three/drei';

function AnimatedModel() {
  const { scene, animations } = useGLTF('/models/character.glb');
  const { actions, names } = useAnimations(animations);

  useEffect(() => {
    // Play the first animation
    actions[names[0]]?.play();
  }, [actions, names]);

  return <primitive object={scene} />;
}
```

### Physics

```tsx
import { Physics, useSphere, useBox, usePlane } from '@react-three/rapier';

function PhysicsScene() {
  return (
    <Physics>
      <Ball position={[0, 5, 0]} />
      <Floor />
      <Box position={[2, 3, 0]} />
    </Physics>
  );
}

function Ball({ position }: { position: [number, number, number] }) {
  const [ref] = useSphere(() => ({
    mass: 1,
    position,
  }));

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.5, 32, 32]} />
      <meshStandardMaterial color="blue" />
    </mesh>
  );
}

function Floor() {
  const [ref] = usePlane(() => ({
    rotation: [-Math.PI / 2, 0, 0],
    position: [0, 0, 0],
  }));

  return (
    <mesh ref={ref}>
      <planeGeometry args={[20, 20]} />
      <meshStandardMaterial color="gray" />
    </mesh>
  );
}
```

## 6. Performance Optimization

### Instanced Rendering

```tsx
import { Instances, Instance } from '@react-three/drei';

function InstancedBoxes() {
  const count = 1000;
  
  return (
    <Instances limit={count}>
      <boxGeometry args={[0.1, 0.1, 0.1]} />
      <meshStandardMaterial />
      
      {Array.from({ length: count }).map((_, i) => (
        <Instance
          key={i}
          position={[
            Math.random() * 10 - 5,
            Math.random() * 10 - 5,
            Math.random() * 10 - 5,
          ]}
          color={`hsl(${Math.random() * 360}, 100%, 50%)`}
        />
      ))}
    </Instances>
  );
}
```

### LOD (Level of Detail)

```tsx
import { useGLTF, LOD } from '@react-three/drei';

function LODModel() {
  const highDetail = useGLTF('/models/high.glb');
  const lowDetail = useGLTF('/models/low.glb');

  return (
    <LOD>
      <primitive object={highDetail.scene} />
      <primitive object={lowDetail.scene} distance={10} />
    </LOD>
  );
}
```

### Frustum Culling

```tsx
// Automatically enabled, but can be manually controlled
<mesh frustumCulled={true}>
  <boxGeometry args={[1, 1, 1]} />
  <meshStandardMaterial />
</mesh>
```

## 7. Practical Example: 3D Product Showcase

```tsx
function ProductShowcase() {
  return (
    <Canvas camera={{ position: [0, 1, 3] }}>
      <ambientLight intensity={0.5} />
      <spotLight
        position={[10, 10, 10]}
        angle={0.15}
        penumbra={1}
        castShadow
      />
      
      <Environment preset="studio" />
      
      <Float speed={2} rotationIntensity={0.5}>
        <ProductModel />
      </Float>
      
      <ContactShadows
        position={[0, -1, 0]}
        opacity={0.5}
        scale={10}
        blur={2}
      />
      
      <OrbitControls
        enableZoom={false}
        minPolarAngle={Math.PI / 4}
        maxPolarAngle={Math.PI / 2}
      />
    </Canvas>
  );
}
```

## Summary

| Concept | Three.js | React Three Fiber |
|---------|----------|-------------------|
| Scene Creation | Imperative | Declarative (JSX) |
| State Management | Manual | React Hooks |
| Component Reuse | Class inheritance | Function components |
| Performance Optimization | Manual | Automatic |
| Learning Curve | Steep | Gentle (for React developers) |

**Recommendations**:

1. **Start with R3F**: React developers should use React Three Fiber directly
2. **Leverage Drei**: Drei provides many out-of-the-box components
3. **Performance First**: 3D applications can easily have performance issues; pay attention to optimization
4. **Model Optimization**: Use glTF format; compress model size
5. **Progressive Enhancement**: Implement core features first, then add effects

3D web development is an exciting field, and this guide will help you start your 3D development journey.
