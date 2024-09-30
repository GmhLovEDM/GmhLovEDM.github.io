---
title: "前端 3D 入门：Three.js + React Three Fiber 实战"
tag: react
description: 从零开始学习前端 3D 开发，使用 Three.js 和 React Three Fiber 构建交互式 3D 场景。
date: "2024-09-30T08:00:00.000Z"
---

## 目标

本文旨在帮助前端开发者入门 3D 图形编程，掌握 Three.js 和 React Three Fiber 的基础概念和实战技巧，能够构建交互式的 3D Web 应用。

## 背景

随着 Web 技术的发展，3D 图形在 Web 中的应用越来越广泛。从产品展示、数据可视化到游戏开发，3D 技术正在改变用户与网页交互的方式。

### 为什么选择 Three.js + React Three Fiber？

1. **Three.js**：最流行的 WebGL 库，封装了底层图形 API
2. **React Three Fiber (R3F)**：Three.js 的 React 渲染器，用 React 的方式写 3D
3. **生态系统**：Drei（工具库）、React Three Postprocessing（后处理）

### 前置知识

- React 基础
- TypeScript 基础（推荐）
- 3D 数学概念（向量、矩阵、旋转）

## 一、环境搭建

### 安装依赖

```bash
# 创建 React 项目
npx create-react-app my-3d-app --template typescript

# 安装 Three.js 和 React Three Fiber
npm install three @react-three/fiber @react-three/drei

# 安装类型定义
npm install -D @types/three
```

### 第一个 3D 场景

```tsx
// App.tsx
import { Canvas } from '@react-three/fiber';

function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Canvas>
        {/* 环境光 */}
        <ambientLight intensity={0.5} />
        
        {/* 点光源 */}
        <pointLight position={[10, 10, 10]} />
        
        {/* 立方体 */}
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

## 二、Three.js 核心概念

### 场景（Scene）

```typescript
import * as THREE from 'three';

// 创建场景
const scene = new THREE.Scene();

// 设置背景色
scene.background = new THREE.Color(0x1a1a2e);

// 添加雾效果
scene.fog = new THREE.Fog(0x1a1a2e, 10, 50);
```

### 相机（Camera）

```typescript
// 透视相机（最常用）
const camera = new THREE.PerspectiveCamera(
  75,  // 视角
  window.innerWidth / window.innerHeight,  // 宽高比
  0.1,  // 近裁剪面
  1000  // 远裁剪面
);

camera.position.set(0, 2, 5);
camera.lookAt(0, 0, 0);
```

### 渲染器（Renderer）

```typescript
const renderer = new THREE.WebGLRenderer({
  antialias: true,  // 抗锯齿
  alpha: true,      // 透明背景
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

### 几何体（Geometry）

```typescript
// 盒子
const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

// 球体
const sphereGeometry = new THREE.SphereGeometry(0.5, 32, 32);

// 圆柱体
const cylinderGeometry = new THREE.CylinderGeometry(0.5, 0.5, 2, 32);

// 平面
const planeGeometry = new THREE.PlaneGeometry(10, 10);
```

### 材质（Material）

```typescript
// 基础材质
const basicMaterial = new THREE.MeshBasicMaterial({
  color: 0x00ff00,
  wireframe: true,
});

// 标准材质（PBR）
const standardMaterial = new THREE.MeshStandardMaterial({
  color: 0xff0000,
  metalness: 0.5,
  roughness: 0.5,
  envMapIntensity: 1.0,
});

// 法线贴图材质
const normalMaterial = new THREE.MeshNormalMaterial();
```

## 三、React Three Fiber 基础

### Canvas 组件

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

### Mesh 组件

```tsx
// 基础 Mesh
<mesh position={[0, 0, 0]} rotation={[0, 0, 0]} scale={[1, 1, 1]}>
  <boxGeometry args={[1, 1, 1]} />
  <meshStandardMaterial color="orange" />
</mesh>

// 带事件的 Mesh
<mesh
  onClick={(e) => console.log('clicked', e.object)}
  onPointerOver={(e) => document.body.style.cursor = 'pointer'}
  onPointerOut={(e) => document.body.style.cursor = 'auto'}
>
  <sphereGeometry args={[0.5, 32, 32]} />
  <meshStandardMaterial color="blue" />
</mesh>
```

### 使用 Hooks

```tsx
import { useFrame, useThree } from '@react-three/fiber';

function AnimatedBox() {
  const meshRef = useRef<THREE.Mesh>(null);
  
  // 每帧更新
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

## 四、Drei 工具库

### 常用组件

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
      {/* 轨道控制器 */}
      <OrbitControls
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={2}
        maxDistance={10}
      />

      {/* 环境贴图 */}
      <Environment preset="sunset" />

      {/* 接触阴影 */}
      <ContactShadows
        position={[0, -1.5, 0]}
        opacity={0.4}
        scale={10}
        blur={2.5}
        far={4}
      />

      {/* 3D 文字 */}
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

      {/* 反射地面 */}
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

      {/* 模型 */}
      <Model url="/models/character.glb" />
    </Canvas>
  );
}
```

### 加载 3D 模型

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

// 预加载
useGLTF.preload('/models/character.glb');
```

## 五、交互与动画

### 点击交互

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

### 动画系统

```tsx
import { useAnimations } from '@react-three/drei';

function AnimatedModel() {
  const { scene, animations } = useGLTF('/models/character.glb');
  const { actions, names } = useAnimations(animations);

  useEffect(() => {
    // 播放第一个动画
    actions[names[0]]?.play();
  }, [actions, names]);

  return <primitive object={scene} />;
}
```

### 物理效果

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

## 六、性能优化

### 实例化渲染

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

### LOD（Level of Detail）

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

### 视锥体剔除

```tsx
// 自动启用，但可以手动控制
<mesh frustumCulled={true}>
  <boxGeometry args={[1, 1, 1]} />
  <meshStandardMaterial />
</mesh>
```

## 七、实战：3D 产品展示

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

## 总结

| 概念 | Three.js | React Three Fiber |
|------|----------|-------------------|
| 场景创建 | 命令式 | 声明式（JSX） |
| 状态管理 | 手动管理 | React Hooks |
| 组件复用 | 类继承 | 函数组件 |
| 性能优化 | 手动优化 | 自动优化 |
| 学习曲线 | 陡峭 | 平缓（React 开发者） |

**姐姐的建议**：

1. **从 R3F 开始**：React 开发者应该直接使用 React Three Fiber
2. **善用 Drei**：Drei 提供了大量开箱即用的组件
3. **性能优先**：3D 应用很容易性能不佳，注意优化
4. **模型优化**：使用 glTF 格式，压缩模型大小
5. **渐进增强**：先实现核心功能，再添加效果

3D Web 开发是一个有趣的领域，希望这篇指南能帮助宝宝们开启 3D 开发之旅。
