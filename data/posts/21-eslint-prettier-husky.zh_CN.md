---
title: "前端工程化入门：ESLint + Prettier + Husky 配置指南"
tag: engineering
description: 搭建完整的前端工程化工具链，从代码规范到 Git 提交检查，打造专业的开发流程。
date: "2022-05-10T08:00:00.000Z"
---

## 目标

搭建一套完整的前端工程化工具链，包括代码规范检查、代码格式化和 Git 提交检查。

## 背景

### 为什么需要工程化？

```
没有工程化：
- 团队成员代码风格不一致
- 提交时才发现代码有问题
- Code Review 花大量时间在格式问题上
- "在我电脑上是好的"

有工程化：
- 统一的代码风格
- 提交前自动检查
- Code Review 专注业务逻辑
- 一致的开发体验
```

## 工具介绍

| 工具 | 功能 | 解决的问题 |
|------|------|-----------|
| ESLint | 代码规范检查 | 发现潜在问题、统一编码规范 |
| Prettier | 代码格式化 | 统一代码风格 |
| Husky | Git hooks | 提交前自动检查 |
| lint-staged | 暂存区检查 | 只检查修改的文件 |

## ESLint 配置

### 1. 安装

```bash
npm install eslint --save-dev

# 初始化配置
npx eslint --init
```

### 2. 配置文件

```javascript
// .eslintrc.js
module.exports = {
    // 运行环境
    env: {
        browser: true,
        es2021: true,
        node: true,
    },

    // 继承的规则
    extends: [
        'eslint:recommended',
        'plugin:react/recommended',
        'plugin:react-hooks/recommended',
        'plugin:@typescript-eslint/recommended',
        // Vue 项目
        'plugin:vue/vue3-recommended',
    ],

    // 解析器
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true,
        },
    },

    // 插件
    plugins: [
        'react',
        'react-hooks',
        '@typescript-eslint',
        'vue',
    ],

    // 规则配置
    rules: {
        // 基础规则
        'no-console': 'warn',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

        // React 规则
        'react/react-in-jsx-scope': 'off',
        'react/prop-types': 'off',

        // Vue 规则
        'vue/multi-word-component-names': 'off',
        'vue/html-self-closing': ['error', {
            html: { void: 'always', normal: 'never', component: 'always' },
        }],
    },

    // 设置
    settings: {
        react: {
            version: 'detect',
        },
    },
}
```

### 3. 常用规则说明

```javascript
// 修复问题示例

// ❌ 不好的写法
var name = '张三'                    // 使用了 var
const list = [1, 2, 3]              // 未使用的变量
console.log('debug')                // 不要留 console.log
if (a == b) {}                      // 使用 === 而不是 ==

// ✅ 好的写法
const name = '张三'
const list = [1, 2, 3]
// console.log('debug') 已移除
if (a === b) {}
```

## Prettier 配置

### 1. 安装

```bash
npm install prettier --save-dev
```

### 2. 配置文件

```javascript
// .prettierrc
{
    "semi": true,                    // 分号
    "singleQuote": true,             // 单引号
    "tabWidth": 2,                   // 缩进
    "useTabs": false,                // 使用空格
    "trailingComma": "es5",          // 尾逗号
    "printWidth": 100,               // 行宽
    "bracketSpacing": true,          // 花括号空格
    "arrowParens": "always",         // 箭头函数参数括号
    "endOfLine": "lf",               // 换行符
    "vueIndentScriptAndStyle": false // Vue 文件缩进
}
```

### 3. 忽略文件

```
# .prettierignore
node_modules
dist
build
coverage
*.min.js
*.min.css
```

## ESLint + Prettier 整合

### 1. 安装整合插件

```bash
npm install eslint-config-prettier eslint-plugin-prettier --save-dev
```

### 2. 配置

```javascript
// .eslintrc.js
module.exports = {
    extends: [
        'eslint:recommended',
        'plugin:react/recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:vue/vue3-recommended',
        'prettier',  // 放在最后，覆盖其他规则
    ],
    plugins: [
        'prettier',
    ],
    rules: {
        'prettier/prettier': 'error',
    },
}
```

## Husky 配置

### 1. 安装

```bash
npm install husky --save-dev

# 初始化
npx husky install

# 在 package.json 中添加 prepare 脚本
npm pkg set scripts.prepare="husky install"
```

### 2. 添加 pre-commit hook

```bash
npx husky add .husky/pre-commit "npx lint-staged"
```

## lint-staged 配置

### 1. 安装

```bash
npm install lint-staged --save-dev
```

### 2. 配置

```json
// package.json
{
    "lint-staged": {
        "*.{js,jsx,ts,tsx}": [
            "eslint --fix",
            "prettier --write"
        ],
        "*.{css,scss,less}": [
            "prettier --write"
        ],
        "*.{json,md}": [
            "prettier --write"
        ],
        "*.{vue}": [
            "eslint --fix",
            "prettier --write"
        ]
    }
}
```

### 3. 配置文件方式

```javascript
// lint-staged.config.js
module.exports = {
    '*.{js,jsx,ts,tsx}': ['eslint --fix', 'prettier --write'],
    '*.{css,scss,less}': ['prettier --write'],
    '*.{json,md}': ['prettier --write'],
    '*.{vue}': ['eslint --fix', 'prettier --write'],
}
```

## 完整流程演示

### 1. 提交前检查

```bash
# 当你执行 git commit 时，会自动触发：
# 1. lint-staged 运行
# 2. 对暂存的文件执行 ESLint 和 Prettier
# 3. 如果有问题，提交会被阻止

git add .
git commit -m "feat: 添加用户功能"
# → 自动运行 lint-staged
# → 如果有错误，修复后重新提交
```

### 2. 手动运行检查

```bash
# 检查所有文件
npx eslint .

# 检查并修复
npx eslint . --fix

# 格式化所有文件
npx prettier --write .

# 检查格式
npx prettier --check .
```

## VSCode 集成

### 1. 安装扩展

- ESLint
- Prettier - Code formatter

### 2. 配置

```json
// .vscode/settings.json
{
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
        "source.fixAll.eslint": true
    },
    "eslint.validate": [
        "javascript",
        "javascriptreact",
        "typescript",
        "typescriptreact",
        "vue"
    ]
}
```

## 常见问题

### Q：ESLint 和 Prettier 冲突怎么办？

A：使用 `eslint-config-prettier` 禁用所有与 Prettier 冲突的规则。

### Q：不想让某个文件被检查怎么办？

A：
```javascript
// .eslintignore
dist
build
node_modules

// 或者在文件中禁用
/* eslint-disable */
console.log('这个文件不被检查')
/* eslint-enable */
```

### Q：不想让某行代码被检查怎么办？

A：
```javascript
// eslint-disable-next-line
console.log('这行不被检查')

// 或者禁用特定规则
// eslint-disable-next-line no-console
console.log('允许 console.log')
```

## npm scripts 配置

```json
{
    "scripts": {
        "lint": "eslint . --ext .js,.jsx,.ts,.tsx,.vue",
        "lint:fix": "eslint . --ext .js,.jsx,.ts,.tsx,.vue --fix",
        "format": "prettier --write .",
        "format:check": "prettier --check .",
        "check": "npm run lint && npm run format:check"
    }
}
```

## 总结

1. **ESLint 检查代码质量**：发现潜在问题、统一编码规范
2. **Prettier 统一代码风格**：自动格式化，不用手动调整
3. **Husky + lint-staged 提交检查**：只检查修改的文件，效率高
4. **VSCode 集成**：保存时自动检查和格式化
5. **团队规范是基础**：所有人都遵守，工具才能发挥作用

这套工具链能让你的项目代码保持高质量和一致性。
