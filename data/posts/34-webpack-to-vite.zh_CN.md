---
title: "从 Webpack 迁移到 Vite：完整迁移指南与踩坑记录"
tag: vite
description: 提供从 Webpack 迁移到 Vite 的完整指南，包括配置对比、依赖处理和常见问题解决方案。
date: "2022-11-08T08:00:00.000Z"
---

## 目标

随着 Vite 生态的成熟，越来越多的项目开始从 Webpack 迁移到 Vite。Vite 带来的开发体验提升是显而易见的：毫秒级的冷启动、即时的热更新、更简洁的配置。本文将提供完整的迁移指南，帮助你平稳地完成迁移，并分享实际项目中的踩坑经验。

## 背景

### 为什么要迁移到 Vite

1. **开发体验**：冷启动速度从分钟级降到秒级
2. **热更新**：不再需要等待整个 bundle 重新构建
3. **配置简化**：约定优于配置，减少学习成本
4. **原生 ESM**：基于浏览器原生模块系统
5. **构建性能**：生产构建使用 Rollup，速度更快

### 迁移前的准备工作

```bash
# 1. 确保 Node.js 版本 >= 14.18
node -v

# 2. 备份现有配置
cp -r config config.backup
cp package.json package.json.backup

# 3. 创建迁移分支
git checkout -b feature/vite-migration
```

## 配置对比

### 入口文件变化

```html
<!-- 之前：Webpack -->
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
</head>
<body>
  <div id="root"></div>
  <script src="/dist/bundle.js"></script>
</body>
</html>

<!-- 之后：Vite -->
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

### 环境变量

```javascript
// 之前：Webpack
// .env 文件
REACT_APP_API_URL=https://api.example.com

// 访问方式
const apiUrl = process.env.REACT_APP_API_URL

// 之后：Vite
// .env 文件
VITE_API_URL=https://api.example.com

// 访问方式
const apiUrl = import.meta.env.VITE_API_URL
```

### 路径别名

```javascript
// 之前：Webpack (webpack.config.js)
const path = require('path')

module.exports = {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@utils': path.resolve(__dirname, 'src/utils')
    }
  }
}

// 之后：Vite (vite.config.ts)
import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@utils': path.resolve(__dirname, 'src/utils')
    }
  }
})
```

## 迁移步骤

### 步骤 1：安装 Vite 和相关插件

```bash
# Vue 项目
npm install -D vite @vitejs/plugin-vue

# React 项目
npm install -D vite @vitejs/plugin-react

# 通用插件
npm install -D vite-plugin-compression  # gzip 压缩
npm install -D vite-plugin-svg-icons    # SVG 图标
npm install -D vite-plugin-mock        # Mock 数据
```

### 步骤 2：创建 Vite 配置文件

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [
    vue({
      // Vue 3 配置
      script: {
        defineModel: true,
        propsDestructure: true
      }
    })
  ],
  
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    },
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue']
  },
  
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
  
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV === 'development',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: process.env.NODE_ENV === 'production',
        drop_debugger: process.env.NODE_ENV === 'production'
      }
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'element-plus': ['element-plus']
        }
      }
    }
  },
  
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@import "@/styles/variables.scss";`
      }
    }
  }
})
```

### 步骤 3：处理静态资源

```typescript
// vite.config.ts 中添加静态资源配置
export default defineConfig({
  assetsInclude: ['**/*.md'],
  
  // 静态资源处理
  json: {
    stringify: true // 大 JSON 文件优化
  }
})
```

```javascript
// 之前：Webpack
import logo from '@/assets/logo.png'
import data from '@/data/config.json'

// 之后：Vite（大部分相同，但需要注意）
import logo from '@/assets/logo.png'  // 相同
import data from '@/data/config.json' // 默认是作为对象导入

// 如果需要作为字符串导入
import data from '@/data/config.json?raw'

// 如果需要作为 URL 导入
import logo from '@/assets/logo.png?url'
```

### 步骤 4：处理 CSS

```javascript
// 之前：Webpack
// webpack.config.js
module: {
  rules: [
    {
      test: /\.css$/,
      use: ['style-loader', 'css-loader', 'postcss-loader']
    },
    {
      test: /\.scss$/,
      use: ['style-loader', 'css-loader', 'postcss-loader', 'sass-loader']
    }
  ]
}

// 之后：Vite（内置支持）
// vite.config.ts
export default defineConfig({
  css: {
    postcss: './postcss.config.js',
    preprocessorOptions: {
      scss: {
        additionalData: `@import "@/styles/variables.scss";`
      }
    }
  }
})
```

### 步骤 5：处理环境变量

```bash
# 之前：Webpack
# .env
REACT_APP_API_URL=https://api.example.com

# .env.development
REACT_APP_API_URL=http://localhost:8080

# .env.production
REACT_APP_API_URL=https://api.example.com

# 之后：Vite
# .env
VITE_API_URL=https://api.example.com

# .env.development
VITE_API_URL=http://localhost:8080

# .env.production
VITE_API_URL=https://api.example.com
```

```typescript
// 修改环境变量引用
// 之前
const apiUrl = process.env.REACT_APP_API_URL

// 之后
const apiUrl = import.meta.env.VITE_API_URL

// 类型声明（可选）
// env.d.ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_APP_TITLE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

### 步骤 6：处理公共路径

```javascript
// 之前：Webpack
// webpack.config.js
module.exports = {
  output: {
    publicPath: '/my-app/'
  }
}

// 之后：Vite
// vite.config.ts
export default defineConfig({
  base: '/my-app/',
  
  // 或者根据环境变量动态设置
  base: process.env.NODE_ENV === 'production' ? '/my-app/' : '/'
})
```

### 步骤 7：更新 package.json 脚本

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "serve": "vite preview"
  }
}
```

## 常见问题与解决方案

### 问题 1：CommonJS 模块兼容

```javascript
// 问题：某些 npm 包只提供 CommonJS 格式
// 错误：SyntaxError: The requested module xxx does not provide an export named 'xxx'

// 解决方案 1：使用 @originjs/vite-plugin-commonjs
import commonjs from '@vitejs/plugin-commonjs'

export default defineConfig({
  plugins: [
    commonjs()
  ]
})

// 解决方案 2：在依赖预构建中配置
export default defineConfig({
  optimizeDeps: {
    include: ['lodash-es', 'element-plus']
  }
})
```

### 问题 2：CSS 预处理器

```javascript
// 问题：Sass/SCSS 变量无法在组件中使用

// 解决方案：在 vite.config.ts 中配置
export default defineConfig({
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `
          @import "@/styles/variables.scss";
          @import "@/styles/mixins.scss";
        `
      }
    }
  }
})
```

### 问题 3：别名路径

```javascript
// 问题：TypeScript 无法识别路径别名

// 解决方案 1：修改 tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}

// 解决方案 2：安装 vite-tsconfig-paths 插件
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [
    tsconfigPaths()
  ]
})
```

### 问题 4：Mock 数据

```javascript
// 之前：使用 webpack-dev-mock
// 之后：使用 vite-plugin-mock

import { viteMockServe } from 'vite-plugin-mock'

export default defineConfig({
  plugins: [
    viteMockServe({
      mockPath: 'mock',
      localEnabled: true,
      prodEnabled: false,
      injectCode: `
        import { setupProdMockServer } from '../mock/_setupProdServer';
        setupProdMockServer();
      `
    })
  ]
})
```

### 问题 5：SVG 图标

```javascript
// 之前：使用 svg-sprite-loader
// 之后：使用 vite-plugin-svg-icons

import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

export default defineConfig({
  plugins: [
    createSvgIconsPlugin({
      iconDirs: [path.resolve(process.cwd(), 'src/icons/svg')],
      symbolId: 'icon-[dir]-[name]'
    })
  ]
})
```

```javascript
// 在 main.ts 中引入
import 'virtual:svg-icons-register'
```

## 性能优化

### 依赖预构建

```javascript
export default defineConfig({
  optimizeDeps: {
    // 预构建的依赖
    include: [
      'vue',
      'vue-router',
      'pinia',
      'axios',
      'element-plus'
    ],
    
    // 排除预构建
    exclude: ['your-local-package'],
    
    // 强制预构建
    force: true
  }
})
```

### 代码分割

```javascript
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'element-plus': ['element-plus'],
          'echarts': ['echarts']
        }
      }
    }
  }
})
```

### 图片优化

```javascript
// 使用 vite-plugin-imagemin
import viteImagemin from 'vite-plugin-imagemin'

export default defineConfig({
  plugins: [
    viteImagemin({
      gifsicle: { optimizationLevel: 7 },
      optipng: { optimizationLevel: 7 },
      mozjpeg: { quality: 20 },
      pngquant: { quality: [0.8, 0.9], speed: 4 },
      svgo: {
        plugins: [
          { removeViewBox: false },
          { removeEmptyAttrs: false }
        ]
      }
    })
  ]
})
```

## 迁移检查清单

```markdown
## 迁移检查清单

### 配置文件
- [ ] 创建 vite.config.ts
- [ ] 配置路径别名
- [ ] 配置代理服务器
- [ ] 配置 CSS 预处理器
- [ ] 配置环境变量

### 入口文件
- [ ] 更新 index.html
- [ ] 添加 type="module" 到 script 标签
- [ ] 更新环境变量引用

### 依赖处理
- [ ] 检查 CommonJS 兼容性
- [ ] 配置依赖预构建
- [ ] 更新导入语句（如有）

### 测试验证
- [ ] 开发服务器正常启动
- [ ] 热更新正常工作
- [ ] 构建产物正常
- [ ] 生产环境部署测试
- [ ] 性能对比测试

### 清理工作
- [ ] 删除 webpack 配置文件
- [ ] 移除 webpack 相关依赖
- [ ] 更新 CI/CD 脚本
- [ ] 更新文档
```

## 迁移后的优势

### 开发体验提升

```bash
# 之前：Webpack
npm run dev
# 启动时间：30-60 秒
# 热更新：5-10 秒

# 之后：Vite
npm run dev
# 启动时间：1-3 秒
# 热更新：毫秒级
```

### 构建性能提升

```bash
# 之前：Webpack
npm run build
# 构建时间：60-120 秒

# 之后：Vite
npm run build
# 构建时间：15-30 秒
```

## 总结

从 Webpack 迁移到 Vite 是一个值得的投资：

1. **开发体验**：显著提升的启动和热更新速度
2. **配置简化**：更少的配置，更多的约定
3. **构建性能**：更快的构建速度
4. **未来兼容**：基于原生 ESM，面向未来

迁移过程需要仔细规划，注意 CommonJS 兼容性、环境变量变化、路径别名等关键点。遵循本文的迁移指南和检查清单，能够帮助你平稳地完成迁移。
