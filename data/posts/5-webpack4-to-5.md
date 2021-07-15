---
title: "Webpack 4 to 5 Migration: A Complete Guide to Pitfalls"
tag: webpack
description: A complete migration guide from Webpack 4 to 5, covering configuration changes, Module Federation, persistent caching, and other core upgrade points, with real project migration experience.
date: "2021-07-15T08:00:00.000Z"
---

## Goal

This article documents the complete process of migrating a real project from Webpack 4 to Webpack 5, focusing on the "pitfalls" that documentation glosses over but will actually block you.

## Background

### Why Upgrade?

Webpack 5 was officially released in October 2020, bringing several important improvements:

1. **Persistent caching**: Build speed improved by 90%+
2. **Module Federation**: The ultimate solution for micro-frontend architecture
3. **Tree Shaking improvements**: Better side effects analysis
4. **Long-term caching**: More stable contenthash
5. **Better Tree Shaking**: Support for nested modules

But upgrading is never as simple as changing a version number.

## Pre-Upgrade Preparation

### 1. Version Check

```bash
# Check current webpack version
npx webpack --version

# Check all webpack-related dependencies
npm ls webpack webpack-cli webpack-dev-server
```

### 2. Backup Configuration

```bash
cp webpack.config.js webpack.config.js.backup
cp package.json package.json.backup
```

## Pitfall Records

### Pitfall 1: webpack-cli Version Incompatibility

**Symptom**: Error when running `webpack` command after upgrade

```
Error: Cannot find module 'webpack-cli'
```

**Cause**: Webpack 5 requires webpack-cli v4+

**Solution**:

```bash
npm install webpack-cli@4 --save-dev
```

### Pitfall 2: html-webpack-plugin Version

**Symptom**: Build succeeds but HTML file doesn't inject bundled JS

**Cause**: html-webpack-plugin v4 and v5 are incompatible with Webpack 5

**Solution**:

```bash
npm install html-webpack-plugin@5 --save-dev
```

Configuration changes:

```javascript
// Webpack 4
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Webpack 5 (import method unchanged, but configuration has changes)
const HtmlWebpackPlugin = require('html-webpack-plugin');

// New: ESM support
// import HtmlWebpackPlugin from 'html-webpack-plugin';
```

### Pitfall 3: css-loader and style-loader

**Symptom**: CSS file parsing error

```
Module build failed: TypeError: this.getOptions is not a function
```

**Cause**: Older versions of loaders used deprecated APIs

**Solution**:

```bash
npm install css-loader@6 style-loader@3 --save-dev
```

### Pitfall 4: url-loader and file-loader Deprecated

**Symptom**: Image and font loading errors

**Cause**: Webpack 5 has built-in **Asset Modules**, making these loaders unnecessary

```javascript
// Webpack 4
{
    test: /\.(png|svg|jpg|jpeg|gif)$/i,
    use: ['url-loader?limit=8192']
}

// Webpack 5 - Method 1: Use Asset Modules
{
    test: /\.(png|svg|jpg|jpeg|gif)$/i,
    type: 'asset',
    parser: {
        dataUrlCondition: {
            maxSize: 8 * 1024 // 8KB
        }
    }
}

// Webpack 5 - Method 2: Use Asset Module subtypes
{
    test: /\.(png|svg|jpg|jpeg|gif)$/i,
    type: 'asset/resource', // Always output as file
    generator: {
        filename: 'images/[name][hash:8][ext]'
    }
}
```

### Pitfall 5: Node.js Polyfills Removed

**Symptom**: Many `Module not found: Error: Can't resolve 'XXX'` errors

```
Module not found: Error: Can't resolve 'buffer'
Module not found: Error: Can't resolve 'crypto'
Module not found: Error: Can't resolve 'stream'
```

**Cause**: Webpack 5 no longer automatically polyfills Node.js core modules. This is the biggest breaking change.

**Solution 1: Manually install polyfills**

```bash
npm install buffer crypto-browserify stream-browserify stream-http assert util --save-dev
```

```javascript
// webpack.config.js
module.exports = {
    resolve: {
        fallback: {
            buffer: require.resolve('buffer/'),
            crypto: require.resolve('crypto-browserify'),
            stream: require.resolve('stream-browserify'),
            assert: require.resolve('assert/'),
            util: require.resolve('util/'),
            http: require.resolve('stream-http'),
        }
    }
};
```

**Solution 2: If you don't need these polyfills, set to false**

```javascript
module.exports = {
    resolve: {
        fallback: {
            buffer: false,
            crypto: false,
            stream: false,
        }
    }
};
```

**Solution 3: Disable completely (not recommended)**

```javascript
module.exports = {
    resolve: {
        fallback: false
    }
};
```

### Pitfall 6: Cache Configuration

**Symptom**: Build output hash changes every time, long-term caching fails

**Cause**: Webpack 5 uses a new caching mechanism by default, but it needs proper configuration

```javascript
module.exports = {
    // Enable persistent caching
    cache: {
        type: 'filesystem',
        buildDependencies: {
            config: [__filename] // Invalidate when config file changes
        }
    }
};
```

### Pitfall 7: devServer Configuration Changes

```javascript
// Webpack 4
module.exports = {
    devServer: {
        contentBase: path.join(__dirname, 'dist'),
        hot: true,
        open: true,
        port: 3000
    }
};

// Webpack 5
module.exports = {
    devServer: {
        static: {
            directory: path.join(__dirname, 'dist'),
        },
        hot: true,
        open: true,
        port: 3000,
        // New: Better error overlay
        client: {
            overlay: {
                errors: true,
                warnings: false,
            }
        }
    }
};
```

## Post-Migration Optimization

### 1. Enable Long-term Caching

```javascript
module.exports = {
    output: {
        filename: '[name].[contenthash:8].js',
        chunkFilename: '[name].[contenthash:8].chunk.js',
    },
    optimization: {
        moduleIds: 'deterministic', // Use deterministic module ids
        chunkIds: 'deterministic',  // Use deterministic chunk ids
    }
};
```

### 2. Module Federation

```javascript
const { ModuleFederationPlugin } = require('webpack').container;

module.exports = {
    plugins: [
        new ModuleFederationPlugin({
            name: 'app1',
            filename: 'remoteEntry.js',
            remotes: {
                app2: 'app2@http://localhost:3001/remoteEntry.js',
            },
            shared: {
                react: { singleton: true },
                'react-dom': { singleton: true },
            }
        })
    ]
};
```

### 3. Persistent Caching Results

In my project, the caching results were very significant:

| Scenario | Webpack 4 | Webpack 5 + Cache |
|----------|-----------|-------------------|
| First build | 45s | 42s |
| Second build | 42s | **8s** |
| Build after modifying one file | 38s | **3s** |

## Migration Checklist

```markdown
## Migration Checklist

### Dependency Updates
- [ ] webpack >= 5.0
- [ ] webpack-cli >= 4.0
- [ ] webpack-dev-server >= 4.0
- [ ] html-webpack-plugin >= 5.0
- [ ] css-loader >= 6.0
- [ ] style-loader >= 3.0
- [ ] Remove url-loader, file-loader (use Asset Modules)

### Configuration Updates
- [ ] Replace url-loader/file-loader with Asset Modules
- [ ] Configure resolve.fallback (handle Node.js polyfills)
- [ ] Update devServer configuration
- [ ] Enable persistent caching

### Testing Verification
- [ ] Local build successful
- [ ] devServer running normally
- [ ] Production build output correct
- [ ] CSS/JS injection working
- [ ] Image/font loading working
- [ ] API requests working
- [ ] Routing working
```

## FAQ

### Q: Build became slower after migration?

A: First build may be slightly slower, but subsequent builds will be significantly faster due to persistent caching. Make sure you've configured `cache: { type: 'filesystem' }`.

### Q: What if some npm packages internally use Node.js modules?

A: This is the most troublesome situation. You have two options:
1. Install the corresponding polyfills
2. Contact the package author to upgrade to a Webpack 5 compatible version

### Q: Do we have to migrate everything at once?

A: You can migrate gradually. Use `webpack@5` and `webpack@4` config files side by side and switch incrementally.

## Conclusion

Migrating from Webpack 4 to 5 is **worth the investment**. After upgrading, you'll gain:

1. **Build speed improvement**: Persistent caching is the biggest winner
2. **Better ecosystem support**: New features and libraries prioritize Webpack 5 support
3. **Module Federation**: Native support for micro-frontend architecture
4. **Long-term caching**: More stable contenthash, higher CDN caching efficiency

The biggest challenge during migration is **removing Node.js polyfills**, which requires checking and resolving one by one. But once completed, your project will see significant improvements in build performance and maintainability.
