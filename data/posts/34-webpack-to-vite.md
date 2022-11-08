---
title: "Migrating from Webpack to Vite: A Complete Guide with Pitfall Notes"
tag: vite
description: A comprehensive guide to migrating from Webpack to Vite, including configuration comparison, dependency handling, and solutions for common issues.
date: "2022-11-08T08:00:00.000Z"
---

## Goal

As the Vite ecosystem has matured, more and more projects are making the switch from Webpack. The improvement in developer experience is undeniable: sub-second cold starts, instant hot module replacement, and far simpler configuration. This article provides a complete migration guide to help you transition smoothly, along with practical pitfalls encountered in real-world projects.

## Background

### Why Migrate to Vite

1. **Developer Experience**: Cold start drops from minutes to seconds.
2. **Hot Module Replacement**: No more waiting for the entire bundle to rebuild -- changes appear almost instantly.
3. **Simplified Configuration**: Convention over configuration reduces the learning curve significantly.
4. **Native ESM**: Built on the browser's native ES module system, eliminating bundling during development.
5. **Build Performance**: Production builds use Rollup, which is faster and produces cleaner output.

### Pre-Migration Preparation

```bash
# 1. Ensure Node.js version >= 14.18
node -v

# 2. Back up existing configuration
cp -r config config.backup
cp package.json package.json.backup

# 3. Create a migration branch
git checkout -b feature/vite-migration
```

## Configuration Comparison

### Entry File Changes

```html
<!-- Before: Webpack -->
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

<!-- After: Vite -->
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

The most visible change is that Vite serves your source files directly via native ES modules during development. There is no bundled output -- the browser imports modules on demand. This is why the `type="module"` attribute is essential.

### Environment Variables

```javascript
// Before: Webpack
// .env file
REACT_APP_API_URL=https://api.example.com

// Accessing it
const apiUrl = process.env.REACT_APP_API_URL

// After: Vite
// .env file
VITE_API_URL=https://api.example.com

// Accessing it
const apiUrl = import.meta.env.VITE_API_URL
```

Vite uses `import.meta.env` instead of `process.env`, and only variables prefixed with `VITE_` are exposed to client-side code. This is a deliberate security measure to prevent accidentally leaking server-side secrets into the browser bundle.

### Path Aliases

```javascript
// Before: Webpack (webpack.config.js)
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

// After: Vite (vite.config.ts)
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

The alias syntax is nearly identical. The main difference is that Vite uses ESM imports (`import`/`export`) instead of CommonJS (`require`).

## Migration Steps

### Step 1: Install Vite and Related Plugins

```bash
# Vue project
npm install -D vite @vitejs/plugin-vue

# React project
npm install -D vite @vitejs/plugin-react

# Common plugins
npm install -D vite-plugin-compression  # gzip compression
npm install -D vite-plugin-svg-icons    # SVG icons
npm install -D vite-plugin-mock        # Mock data
```

### Step 2: Create the Vite Configuration File

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [
    vue({
      // Vue 3 specific options
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

### Step 3: Handle Static Assets

```typescript
// Add to vite.config.ts
export default defineConfig({
  assetsInclude: ['**/*.md'],
  
  json: {
    stringify: true // Optimize large JSON file imports
  }
})
```

```javascript
// Before: Webpack
import logo from '@/assets/logo.png'
import data from '@/data/config.json'

// After: Vite (mostly the same, but watch for differences)
import logo from '@/assets/logo.png'  // Same
import data from '@/data/config.json' // Imported as a module object by default

// If you need the raw string content
import data from '@/data/config.json?raw'

// If you need the URL string
import logo from '@/assets/logo.png?url'
```

Vite introduces `?raw` and `?url` suffixes as explicit import hints, giving you fine-grained control over how assets are imported.

### Step 4: Handle CSS

```javascript
// Before: Webpack
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

// After: Vite (built-in support -- no loaders needed)
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

One of Vite's biggest conveniences is that CSS processing is built in. No more managing a chain of loaders -- just configure what you need.

### Step 5: Handle Environment Variables

```bash
# Before: Webpack
# .env
REACT_APP_API_URL=https://api.example.com

# .env.development
REACT_APP_API_URL=http://localhost:8080

# .env.production
REACT_APP_API_URL=https://api.example.com

# After: Vite
# .env
VITE_API_URL=https://api.example.com

# .env.development
VITE_API_URL=http://localhost:8080

# .env.production
VITE_API_URL=https://api.example.com
```

```typescript
// Update environment variable references throughout your codebase
// Before
const apiUrl = process.env.REACT_APP_API_URL

// After
const apiUrl = import.meta.env.VITE_API_URL

// Type declarations (optional but recommended)
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

Adding TypeScript declarations for `ImportMetaEnv` gives you autocompletion and compile-time checking for all your environment variables.

### Step 6: Handle the Public Path

```javascript
// Before: Webpack
// webpack.config.js
module.exports = {
  output: {
    publicPath: '/my-app/'
  }
}

// After: Vite
// vite.config.ts
export default defineConfig({
  base: '/my-app/',
  
  // Or set dynamically based on environment
  base: process.env.NODE_ENV === 'production' ? '/my-app/' : '/'
})
```

### Step 7: Update package.json Scripts

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

## Common Issues and Solutions

### Issue 1: CommonJS Module Compatibility

```javascript
// Problem: Some npm packages only provide CommonJS format
// Error: SyntaxError: The requested module xxx does not provide an export named 'xxx'

// Solution 1: Use @vitejs/plugin-commonjs
import commonjs from '@vitejs/plugin-commonjs'

export default defineConfig({
  plugins: [
    commonjs()
  ]
})

// Solution 2: Configure dependency pre-bundling
export default defineConfig({
  optimizeDeps: {
    include: ['lodash-es', 'element-plus']
  }
})
```

Vite uses esbuild for dependency pre-bundling, which automatically converts CommonJS to ESM. In most cases, simply adding the problematic package to `optimizeDeps.include` resolves the issue.

### Issue 2: CSS Preprocessor Variables

```javascript
// Problem: Sass/SCSS variables are not available in components

// Solution: Configure in vite.config.ts
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

### Issue 3: Path Alias Resolution in TypeScript

```javascript
// Problem: TypeScript cannot resolve path aliases

// Solution 1: Update tsconfig.json
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

// Solution 2: Install vite-tsconfig-paths plugin
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [
    tsconfigPaths()
  ]
})
```

The `vite-tsconfig-paths` plugin reads your `tsconfig.json` path mappings and applies them automatically in Vite, keeping your configuration in a single source of truth.

### Issue 4: Mock Data

```javascript
// Before: webpack-dev-mock
// After: vite-plugin-mock

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

### Issue 5: SVG Icons

```javascript
// Before: svg-sprite-loader
// After: vite-plugin-svg-icons

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
// Register in main.ts
import 'virtual:svg-icons-register'
```

## Performance Optimization

### Dependency Pre-Bundling

```javascript
export default defineConfig({
  optimizeDeps: {
    // Pre-bundle these dependencies
    include: [
      'vue',
      'vue-router',
      'pinia',
      'axios',
      'element-plus'
    ],
    
    // Exclude from pre-bundling
    exclude: ['your-local-package'],
    
    // Force re-bundle (useful during debugging)
    force: true
  }
})
```

### Code Splitting

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

### Image Optimization

```javascript
// Using vite-plugin-imagemin
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

## Migration Checklist

- [ ] Create `vite.config.ts`
- [ ] Configure path aliases
- [ ] Configure dev server proxy
- [ ] Configure CSS preprocessor options
- [ ] Migrate environment variables (rename prefixes to `VITE_`, update references to `import.meta.env`)
- [ ] Update `index.html` (move to project root, add `type="module"` to script tags)
- [ ] Check CommonJS compatibility and configure `optimizeDeps` if needed
- [ ] Update import statements (if any use CommonJS-style syntax)
- [ ] Verify dev server starts correctly
- [ ] Verify hot module replacement works
- [ ] Verify production build completes successfully
- [ ] Run production deployment test
- [ ] Compare performance metrics before and after
- [ ] Remove old Webpack configuration files
- [ ] Remove Webpack-related dependencies
- [ ] Update CI/CD pipeline scripts
- [ ] Update project documentation

## Post-Migration Benefits

### Developer Experience Improvement

```bash
# Before: Webpack
npm run dev
# Cold start: 30-60 seconds
# HMR update: 5-10 seconds

# After: Vite
npm run dev
# Cold start: 1-3 seconds
# HMR update: milliseconds
```

### Build Performance Improvement

```bash
# Before: Webpack
npm run build
# Build time: 60-120 seconds

# After: Vite
npm run build
# Build time: 15-30 seconds
```

The difference is immediately noticeable. Development iterations become faster, and the reduced feedback loop translates directly into higher productivity.

## Summary

Migrating from Webpack to Vite is a worthwhile investment:

1. **Developer Experience**: Dramatically faster startup and hot module replacement.
2. **Simplified Configuration**: Less configuration to write and maintain, with sensible defaults.
3. **Build Performance**: Significantly faster production builds.
4. **Future-Proof**: Built on native ES modules, aligned with the direction of the web platform.

The migration process requires careful planning. Pay attention to CommonJS compatibility, environment variable changes, path alias configuration, and the other common pitfalls covered in this guide. Following the step-by-step instructions and checklist in this article will help you complete the migration smoothly and confidently.
