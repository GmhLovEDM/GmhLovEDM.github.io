---
title: "Webpack 4 到 5 迁移踩坑全记录"
tag: webpack
description: 从 Webpack 4 升级到 5 的完整踩坑指南，涵盖配置变更、模块联邦、持久化缓存等核心升级点，附带实际项目迁移经验。
date: "2021-07-15T08:00:00.000Z"
---

## 目标

这篇文章记录一个真实项目从 Webpack 4 迁移到 Webpack 5 的完整过程，重点记录那些文档里一笔带过但实际会卡住你的"坑"。

## 背景

### 为什么要升级？

Webpack 5 于 2020 年 10 月正式发布，带来了几个重要的改进：

1. **持久化缓存**：构建速度提升 90%+
2. **模块联邦（Module Federation）**：微前端架构的终极方案
3. **Tree Shaking 改进**：更好的副作用分析
4. **长期缓存**：contenthash 更稳定
5. **更好的 Tree Shaking**：对嵌套模块的支持

但升级从来不是改个版本号那么简单。

## 升级前的准备

### 1. 版本检查

```bash
# 查看当前 webpack 版本
npx webpack --version

# 查看所有 webpack 相关依赖
npm ls webpack webpack-cli webpack-dev-server
```

### 2. 备份配置

```bash
cp webpack.config.js webpack.config.js.backup
cp package.json package.json.backup
```

## 踩坑记录

### 坑 1：webpack-cli 版本不兼容

**现象**：升级后运行 `webpack` 命令报错

```
Error: Cannot find module 'webpack-cli'
```

**原因**：Webpack 5 需要 webpack-cli v4+

**解决**：

```bash
npm install webpack-cli@4 --save-dev
```

### 坑 2：html-webpack-plugin 版本

**现象**：构建成功但 HTML 文件没有注入打包后的 JS

**原因**：html-webpack-plugin v4 和 v5 不兼容 Webpack 5

**解决**：

```bash
npm install html-webpack-plugin@5 --save-dev
```

配置变化：

```javascript
// Webpack 4
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Webpack 5（引入方式不变，但配置有变化）
const HtmlWebpackPlugin = require('html-webpack-plugin');

// 新增：支持 ESM
// import HtmlWebpackPlugin from 'html-webpack-plugin';
```

### 坑 3：css-loader 和 style-loader

**现象**：CSS 文件解析报错

```
Module build failed: TypeError: this.getOptions is not a function
```

**原因**：旧版 loader 使用了已废弃的 API

**解决**：

```bash
npm install css-loader@6 style-loader@3 --save-dev
```

### 坑 4：url-loader 和 file-loader 被废弃

**现象**：图片和字体加载报错

**原因**：Webpack 5 内置了**资源模块（Asset Modules）**，不再需要这些 loader

```javascript
// Webpack 4
{
    test: /\.(png|svg|jpg|jpeg|gif)$/i,
    use: ['url-loader?limit=8192']
}

// Webpack 5 - 方式 1：使用资源模块
{
    test: /\.(png|svg|jpg|jpeg|gif)$/i,
    type: 'asset',
    parser: {
        dataUrlCondition: {
            maxSize: 8 * 1024 // 8KB
        }
    }
}

// Webpack 5 - 方式 2：使用资源模块的子类型
{
    test: /\.(png|svg|jpg|jpeg|gif)$/i,
    type: 'asset/resource', // 始终输出为文件
    generator: {
        filename: 'images/[name][hash:8][ext]'
    }
}
```

### 坑 5：Node.js Polyfill 被移除

**现象**：大量 `Module not found: Error: Can't resolve 'XXX'` 错误

```
Module not found: Error: Can't resolve 'buffer'
Module not found: Error: Can't resolve 'crypto'
Module not found: Error: Can't resolve 'stream'
```

**原因**：Webpack 5 不再自动 polyfill Node.js 核心模块。这是最大的 breaking change。

**解决方式 1：手动安装 polyfill**

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

**解决方式 2：如果不需要这些 polyfill，设置为 false**

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

**解决方式 3：完全禁用（不推荐）**

```javascript
module.exports = {
    resolve: {
        fallback: false
    }
};
```

### 坑 6：缓存配置

**现象**：构建产物的 hash 每次都变，长期缓存失效

**原因**：Webpack 5 默认使用新的缓存机制，但需要正确配置

```javascript
module.exports = {
    // 启用持久化缓存
    cache: {
        type: 'filesystem',
        buildDependencies: {
            config: [__filename] // 配置文件变化时失效
        }
    }
};
```

### 坑 7：devServer 配置变化

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
        // 新增：更好的错误覆盖层
        client: {
            overlay: {
                errors: true,
                warnings: false,
            }
        }
    }
};
```

## 迁移后的优化

### 1. 启用长期缓存

```javascript
module.exports = {
    output: {
        filename: '[name].[contenthash:8].js',
        chunkFilename: '[name].[contenthash:8].chunk.js',
    },
    optimization: {
        moduleIds: 'deterministic', // 使用确定性的 module id
        chunkIds: 'deterministic',  // 使用确定性的 chunk id
    }
};
```

### 2. 模块联邦（Module Federation）

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

### 3. 持久化缓存效果

在我的项目中，缓存效果非常明显：

| 场景 | Webpack 4 | Webpack 5 + 缓存 |
|------|-----------|------------------|
| 首次构建 | 45s | 42s |
| 第二次构建 | 42s | **8s** |
| 修改一个文件后构建 | 38s | **3s** |

## 迁移检查清单

```markdown
## 迁移检查清单

### 依赖更新
- [ ] webpack >= 5.0
- [ ] webpack-cli >= 4.0
- [ ] webpack-dev-server >= 4.0
- [ ] html-webpack-plugin >= 5.0
- [ ] css-loader >= 6.0
- [ ] style-loader >= 3.0
- [ ] 移除 url-loader、file-loader（使用 Asset Modules）

### 配置更新
- [ ] 替换 url-loader/file-loader 为 Asset Modules
- [ ] 配置 resolve.fallback（处理 Node.js polyfill）
- [ ] 更新 devServer 配置
- [ ] 启用持久化缓存

### 测试验证
- [ ] 本地构建成功
- [ ] devServer 正常运行
- [ ] 生产构建产物正确
- [ ] CSS/JS 注入正常
- [ ] 图片/字体加载正常
- [ ] API 请求正常
- [ ] 路由正常
```

## 常见问题 FAQ

### Q：迁移后构建变慢了？

A：首次构建可能稍慢，但第二次构建会因为持久化缓存而大幅加速。确保配置了 `cache: { type: 'filesystem' }`。

### Q：有些 npm 包内部使用了 Node.js 模块怎么办？

A：这是最麻烦的情况。你有两个选择：
1. 安装对应的 polyfill
2. 联系包作者升级到 Webpack 5 兼容版本

### Q：必须一次迁移完吗？

A：可以渐进式迁移。使用 `webpack@5` 和 `webpack@4` 的配置文件共存，逐步切换。

## 总结

Webpack 4 到 5 的迁移是一个**值得投入**的工作。升级后你将获得：

1. **构建速度提升**：持久化缓存是最大的赢家
2. **更好的生态支持**：新功能和新库都优先支持 Webpack 5
3. **模块联邦**：为微前端架构提供了原生支持
4. **长期缓存**：contenthash 更稳定，CDN 缓存效率更高

迁移过程中最大的挑战是 **Node.js polyfill 的移除**，需要逐一排查和解决。但一旦完成，你的项目将在构建性能和可维护性上获得显著提升。
