---
title: "Frontend Microservices with Module Federation: A Hands-On Guide"
tag: engineering
description: An in-depth exploration of Webpack Module Federation principles and practices for building a frontend microservice architecture.
date: "2023-03-28T08:00:00.000Z"
---

## Goal

As frontend applications grow in scale, the monolithic architecture faces mounting challenges: long build times, difficult cross-team collaboration, and low code reuse across projects. Module Federation, introduced in Webpack 5, is a revolutionary feature that allows modules to be shared and loaded dynamically at runtime, making true frontend microservice architecture possible. This article provides a deep dive into the principles of Module Federation along with a complete hands-on guide.

## Background

### The Pain Points of Monolithic Frontends

1. **Build times** -- large projects can take minutes or even tens of minutes to build, slowing down the entire development cycle.
2. **Code reuse** -- sharing components across projects traditionally requires publishing npm packages, which adds versioning overhead and release friction.
3. **Team collaboration** -- multiple teams working in the same repository leads to frequent merge conflicts and coordination overhead.
4. **Deployment coupling** -- a small change in one area forces a redeploy of the entire application, increasing risk and reducing deployment frequency.

### Micro-Frontends as a Solution

Micro-frontends break a large application into smaller, independent pieces:

- **Independent development** -- each team develops their own module autonomously.
- **Independent deployment** -- modules can be deployed without affecting other modules.
- **Technology agnosticism** -- different modules can use different frameworks or libraries.
- **Runtime integration** -- modules are loaded and composed dynamically at runtime, not baked into a single bundle at build time.

## How Module Federation Works

### Core Concepts

```javascript
// Module Federation has three core concepts:
// 1. Host: the application that consumes remote modules
// 2. Remote: the application that exposes modules for others to consume
// 3. Shared: dependencies that are shared across multiple applications
```

The **Host** is the application shell that loads and renders remote modules. The **Remote** is a standalone application that exposes specific modules (components, utilities, etc.) for consumption by hosts. The **Shared** configuration ensures that common dependencies like React are loaded only once across the entire federated system.

### Configuration Example

```javascript
// Application A (Remote) -- provides components
// webpack.config.js
const { ModuleFederationPlugin } = require('webpack').container

module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: 'appA',
      filename: 'remoteEntry.js',
      exposes: {
        './Button': './src/components/Button',
        './Header': './src/components/Header'
      },
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true }
      }
    })
  ]
}

// Application B (Host) -- consumes remote components
// webpack.config.js
module.exports = {
  plugins: [
    new ModuleFederationPlugin({
      name: 'appB',
      remotes: {
        appA: 'appA@http://localhost:3001/remoteEntry.js'
      },
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true }
      }
    })
  ]
}
```

The `name` option identifies the application. The `filename` option specifies the entry point that the host will fetch at runtime. `exposes` declares which modules are available for remote consumption, and `shared` ensures that dependencies like React are loaded only once across the entire federated system.

## Hands-On Example

### Project Structure

```
micro-frontend/
├── shell/                    # Main application (Host)
│   ├── src/
│   │   ├── App.js
│   │   └── index.js
│   └── webpack.config.js
├── remote-header/            # Header module (Remote)
│   ├── src/
│   │   ├── Header.js
│   │   └── index.js
│   └── webpack.config.js
├── remote-sidebar/           # Sidebar module (Remote)
│   ├── src/
│   │   ├── Sidebar.js
│   │   └── index.js
│   └── webpack.config.js
└── remote-content/           # Content module (Remote)
    ├── src/
    │   ├── Content.js
    │   └── index.js
    └── webpack.config.js
```

Each module lives in its own directory with its own `webpack.config.js`, `package.json`, and build pipeline. This independence is the foundation of the micro-frontend approach.

### Implementing a Remote Module

```javascript
// remote-header/webpack.config.js
const { ModuleFederationPlugin } = require('webpack').container
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  entry: './src/index.js',
  mode: 'development',
  devServer: {
    port: 3001,
    hot: true
  },
  output: {
    publicPath: 'http://localhost:3001/'
  },
  resolve: {
    extensions: ['.js', '.jsx']
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-react']
          }
        }
      }
    ]
  },
  plugins: [
    new ModuleFederationPlugin({
      name: 'remoteHeader',
      filename: 'remoteEntry.js',
      exposes: {
        './Header': './src/Header'
      },
      shared: {
        react: {
          singleton: true,
          requiredVersion: '^18.0.0'
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '^18.0.0'
        }
      }
    }),
    new HtmlWebpackPlugin({
      template: './public/index.html'
    })
  ]
}
```

```jsx
// remote-header/src/Header.js
import React from 'react'

const Header = ({ user, onLogout }) => {
  return (
    <header style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '1rem 2rem',
      backgroundColor: '#1f2937',
      color: 'white'
    }}>
      <h1>My Micro Frontend App</h1>

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span>Welcome, {user.name}</span>
          <button
            onClick={onLogout}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '0.25rem',
              cursor: 'pointer'
            }}
          >
            Logout
          </button>
        </div>
      )}
    </header>
  )
}

export default Header
```

The remote module runs as a standalone application on its own port. It exposes `Header` through the `exposes` configuration, making it available for any host to consume. The `singleton: true` option on React ensures only one copy of React is loaded at runtime, even if the host and remote use slightly different versions.

### Implementing the Host Application

```javascript
// shell/webpack.config.js
const { ModuleFederationPlugin } = require('webpack').container
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  entry: './src/index.js',
  mode: 'development',
  devServer: {
    port: 3000,
    hot: true
  },
  output: {
    publicPath: 'http://localhost:3000/'
  },
  resolve: {
    extensions: ['.js', '.jsx']
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-react']
          }
        }
      }
    ]
  },
  plugins: [
    new ModuleFederationPlugin({
      name: 'shell',
      remotes: {
        remoteHeader: 'remoteHeader@http://localhost:3001/remoteEntry.js',
        remoteSidebar: 'remoteSidebar@http://localhost:3002/remoteEntry.js',
        remoteContent: 'remoteContent@http://localhost:3003/remoteEntry.js'
      },
      shared: {
        react: {
          singleton: true,
          requiredVersion: '^18.0.0'
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '^18.0.0'
        }
      }
    }),
    new HtmlWebpackPlugin({
      template: './public/index.html'
    })
  ]
}
```

```jsx
// shell/src/App.js
import React, { Suspense, lazy, useState } from 'react'

// Dynamically load remote components
const RemoteHeader = lazy(() => import('remoteHeader/Header'))
const RemoteSidebar = lazy(() => import('remoteSidebar/Sidebar'))
const RemoteContent = lazy(() => import('remoteContent/Content'))

function App() {
  const [user, setUser] = useState({ name: 'John Doe' })
  const [activeModule, setActiveModule] = useState('dashboard')

  const handleLogout = () => {
    setUser(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Suspense fallback={<div>Loading Header...</div>}>
        <RemoteHeader user={user} onLogout={handleLogout} />
      </Suspense>

      <div style={{ display: 'flex', flex: 1 }}>
        <Suspense fallback={<div>Loading Sidebar...</div>}>
          <RemoteSidebar
            activeModule={activeModule}
            onModuleChange={setActiveModule}
          />
        </Suspense>

        <main style={{ flex: 1, padding: '2rem' }}>
          <Suspense fallback={<div>Loading Content...</div>}>
            <RemoteContent module={activeModule} />
          </Suspense>
        </main>
      </div>
    </div>
  )
}

export default App
```

The host application loads each remote module lazily using React's `lazy` and wraps them in `Suspense` boundaries. This means each module downloads independently and the host never needs to know the internals of a remote. The `remotes` configuration tells Webpack where to find each remote's `remoteEntry.js` at runtime.

### Error Handling

```jsx
// shell/src/ErrorBoundary.js
import React from 'react'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('Module loading failed:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '2rem',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '0.5rem'
        }}>
          <h3 style={{ color: '#dc2626', marginBottom: '0.5rem' }}>
            Module Loading Failed
          </h3>
          <p style={{ color: '#7f1d1d' }}>
            {this.props.fallbackMessage || 'Failed to load this module. Please try again.'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              backgroundColor: '#dc2626',
              color: 'white',
              border: 'none',
              borderRadius: '0.25rem',
              cursor: 'pointer'
            }}
          >
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

// Usage
<Suspense fallback={<div>Loading...</div>}>
  <ErrorBoundary fallbackMessage="Failed to load header module">
    <RemoteHeader />
  </ErrorBoundary>
</Suspense>
```

Error boundaries are essential in a micro-frontend architecture. If a remote module fails to load or crashes at runtime, the rest of the application should remain functional. Wrapping each remote in an error boundary with a retry mechanism provides a graceful degradation path.

## Advanced Features

### Shared Dependency Configuration

```javascript
// Advanced shared dependency options
new ModuleFederationPlugin({
  name: 'shell',
  remotes: {
    remoteApp: 'remoteApp@http://localhost:3001/remoteEntry.js'
  },
  shared: {
    react: {
      singleton: true,          // Only one instance across all apps
      requiredVersion: '^18.0.0', // Minimum version required
      eager: false               // Do not load eagerly
    },
    'react-dom': {
      singleton: true,
      requiredVersion: '^18.0.0'
    },
    // Optional dependency
    'react-router-dom': {
      singleton: true,
      requiredVersion: '^6.0.0'
    }
  }
})
```

The `singleton` option is critical for libraries like React that must have only one instance at runtime. The `requiredVersion` field lets you specify compatible version ranges, and `eager` controls whether the dependency is loaded immediately or on demand.

### Dynamic Remote Loading

```javascript
// Load remote modules dynamically at runtime
async function loadRemoteModule(remoteName, moduleName) {
  // Initialize the shared scope
  await __webpack_init_sharing__('default')

  // Get the remote container
  const container = window[remoteName]

  if (!container) {
    throw new Error(`Remote ${remoteName} not found`)
  }

  // Initialize the container
  await container.init(__webpack_share_scopes__.default)

  // Get the module
  const factory = await container.get(moduleName)

  return factory()
}

// React hook for dynamic remotes
function useDynamicRemote(remoteName, moduleName) {
  const [Component, setComponent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadRemoteModule(remoteName, moduleName)
      .then(module => {
        setComponent(() => module.default)
        setLoading(false)
      })
      .catch(err => {
        setError(err)
        setLoading(false)
      })
  }, [remoteName, moduleName])

  return { Component, loading, error }
}
```

Dynamic remote loading is useful when the set of remotes is not known at build time -- for example, when different tenants, plugins, or feature modules are loaded based on user configuration or subscription tier.

## Deployment Strategies

### Independent Deployment

```yaml
# docker-compose.yml
version: '3.8'
services:
  shell:
    build: ./shell
    ports:
      - "3000:80"
    depends_on:
      - remote-header
      - remote-sidebar
      - remote-content

  remote-header:
    build: ./remote-header
    ports:
      - "3001:80"

  remote-sidebar:
    build: ./remote-sidebar
    ports:
      - "3002:80"

  remote-content:
    build: ./remote-content
    ports:
      - "3003:80"
```

Each service can be containerized independently and deployed on its own schedule. The shell depends on the remotes only for runtime resolution, not build-time bundling.

### CDN Deployment

```javascript
// Production configuration
new ModuleFederationPlugin({
  name: 'shell',
  remotes: {
    remoteHeader: 'remoteHeader@https://cdn.example.com/remote-header/remoteEntry.js',
    remoteSidebar: 'remoteSidebar@https://cdn.example.com/remote-sidebar/remoteEntry.js',
    remoteContent: 'remoteContent@https://cdn.example.com/remote-content/remoteEntry.js'
  },
  shared: {
    react: { singleton: true, requiredVersion: '^18.0.0' },
    'react-dom': { singleton: true, requiredVersion: '^18.0.0' }
  }
})
```

CDN deployment is the most common production pattern. Each remote's `remoteEntry.js` and associated chunks are served from a CDN, giving you global distribution, edge caching, and reduced origin load.

## Common Issues

### Version Conflicts

```javascript
// Solution: use singleton and requiredVersion
shared: {
  react: {
    singleton: true,
    requiredVersion: '^18.0.0',
    // Falls back gracefully if versions are incompatible
    version: '18.2.0'
  }
}
```

When different remotes depend on different versions of the same library, the `singleton` option ensures only one copy is loaded. If versions are incompatible, Module Federation will fall back to the remote's own copy, preventing runtime crashes.

### TypeScript Type Definitions

```typescript
// TypeScript type declarations for remote modules
// src/remote.d.ts
declare module 'remoteHeader/Header' {
  import { ComponentType } from 'react'

  interface HeaderProps {
    user?: {
      name: string
      email: string
    }
    onLogout?: () => void
  }

  const Header: ComponentType<HeaderProps>
  export default Header
}
```

Type declarations for remote modules need to be maintained manually or generated as part of a shared contract between teams. This is one of the areas where discipline and tooling really pay off -- a shared types package or automated type generation pipeline keeps everything in sync.

### Performance Optimization

```javascript
// Preload remote modules
const preloadRemotes = async () => {
  const remotes = [
    { name: 'remoteHeader', module: './Header' },
    { name: 'remoteSidebar', module: './Sidebar' }
  ]

  await Promise.all(
    remotes.map(remote => loadRemoteModule(remote.name, remote.module))
  )
}

// Preload on route transition
const routes = [
  {
    path: '/dashboard',
    component: Dashboard,
    preload: () => preloadRemotes()
  }
]
```

Preloading critical remote modules on navigation eliminates the flash of loading states and provides a smoother user experience. You can also implement prefetching on hover or during idle time to further reduce perceived latency.

## Conclusion

Module Federation provides a powerful foundation for frontend microservice architectures:

1. **Runtime sharing** -- modules are loaded and composed dynamically at runtime, not statically linked at build time. This decouples build pipelines and enables true independent deployment.
2. **Independent deployment** -- each module can be developed, tested, and deployed on its own schedule, reducing coordination overhead and deployment risk.
3. **Code reuse** -- share components and dependencies across projects without publishing npm packages, making cross-project reuse practical.
4. **Technology agnosticism** -- different modules can use different frameworks, as long as shared dependencies are compatible.

While Module Federation introduces additional complexity around shared dependency management, versioning, and deployment orchestration, it is an investment that pays dividends for large teams and complex applications. If your organization is struggling with monolithic build bottlenecks or cross-team deployment friction, Module Federation is well worth exploring.
