---
title: "Frontend Engineering Introduction: ESLint + Prettier + Husky Configuration Guide"
tag: engineering
description: Build a complete frontend engineering toolchain, from code standards to Git commit checks, creating a professional development workflow.
date: "2022-05-10T08:00:00.000Z"
---

## Goal

Build a complete frontend engineering toolchain including code linting, code formatting, and Git commit checks.

## Background

### Why Do We Need Engineering?

```
Without engineering:
- Inconsistent code styles among team members
- Discovering code issues only at commit time
- Code Review spends lots of time on formatting issues
- "It works on my machine"

With engineering:
- Unified code style
- Automatic checks before commit
- Code Review focuses on business logic
- Consistent development experience
```

## Tool Introduction

| Tool | Function | Problem Solved |
|------|----------|----------------|
| ESLint | Code linting | Find potential issues, unify coding standards |
| Prettier | Code formatting | Unify code style |
| Husky | Git hooks | Automatic checks before commit |
| lint-staged | Staged file checks | Only check modified files |

## ESLint Configuration

### 1. Installation

```bash
npm install eslint --save-dev

# Initialize configuration
npx eslint --init
```

### 2. Configuration File

```javascript
// .eslintrc.js
module.exports = {
    // Runtime environment
    env: {
        browser: true,
        es2021: true,
        node: true,
    },

    // Inherited rules
    extends: [
        'eslint:recommended',
        'plugin:react/recommended',
        'plugin:react-hooks/recommended',
        'plugin:@typescript-eslint/recommended',
        // Vue projects
        'plugin:vue/vue3-recommended',
    ],

    // Parser
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true,
        },
    },

    // Plugins
    plugins: [
        'react',
        'react-hooks',
        '@typescript-eslint',
        'vue',
    ],

    // Rule configuration
    rules: {
        // Basic rules
        'no-console': 'warn',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

        // React rules
        'react/react-in-jsx-scope': 'off',
        'react/prop-types': 'off',

        // Vue rules
        'vue/multi-word-component-names': 'off',
        'vue/html-self-closing': ['error', {
            html: { void: 'always', normal: 'never', component: 'always' },
        }],
    },

    // Settings
    settings: {
        react: {
            version: 'detect',
        },
    },
}
```

### 3. Common Rules Explanation

```javascript
// Fix examples

// Bad practices
var name = 'Zhang San'              // Using var
const list = [1, 2, 3]              // Unused variable
console.log('debug')                // Don't leave console.log
if (a == b) {}                      // Use === instead of ==

// Good practices
const name = 'Zhang San'
const list = [1, 2, 3]
// console.log('debug') removed
if (a === b) {}
```

## Prettier Configuration

### 1. Installation

```bash
npm install prettier --save-dev
```

### 2. Configuration File

```javascript
// .prettierrc
{
    "semi": true,                    // Semicolons
    "singleQuote": true,             // Single quotes
    "tabWidth": 2,                   // Indentation
    "useTabs": false,                // Use spaces
    "trailingComma": "es5",          // Trailing commas
    "printWidth": 100,               // Line width
    "bracketSpacing": true,          // Bracket spacing
    "arrowParens": "always",         // Arrow function parentheses
    "endOfLine": "lf",               // Line endings
    "vueIndentScriptAndStyle": false // Vue file indentation
}
```

### 3. Ignore Files

```
# .prettierignore
node_modules
dist
build
coverage
*.min.js
*.min.css
```

## ESLint + Prettier Integration

### 1. Install Integration Plugins

```bash
npm install eslint-config-prettier eslint-plugin-prettier --save-dev
```

### 2. Configuration

```javascript
// .eslintrc.js
module.exports = {
    extends: [
        'eslint:recommended',
        'plugin:react/recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:vue/vue3-recommended',
        'prettier',  // Put last, overrides other rules
    ],
    plugins: [
        'prettier',
    ],
    rules: {
        'prettier/prettier': 'error',
    },
}
```

## Husky Configuration

### 1. Installation

```bash
npm install husky --save-dev

# Initialize
npx husky install

# Add prepare script to package.json
npm pkg set scripts.prepare="husky install"
```

### 2. Add pre-commit hook

```bash
npx husky add .husky/pre-commit "npx lint-staged"
```

## lint-staged Configuration

### 1. Installation

```bash
npm install lint-staged --save-dev
```

### 2. Configuration

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

### 3. Configuration File Approach

```javascript
// lint-staged.config.js
module.exports = {
    '*.{js,jsx,ts,tsx}': ['eslint --fix', 'prettier --write'],
    '*.{css,scss,less}': ['prettier --write'],
    '*.{json,md}': ['prettier --write'],
    '*.{vue}': ['eslint --fix', 'prettier --write'],
}
```

## Complete Workflow Demo

### 1. Pre-commit Check

```bash
# When you execute git commit, it automatically triggers:
# 1. lint-staged runs
# 2. ESLint and Prettier execute on staged files
# 3. If there are issues, commit is blocked

git add .
git commit -m "feat: Add user feature"
# → Automatically runs lint-staged
# → If there are errors, fix and resubmit
```

### 2. Manual Check

```bash
# Check all files
npx eslint .

# Check and fix
npx eslint . --fix

# Format all files
npx prettier --write .

# Check formatting
npx prettier --check .
```

## VSCode Integration

### 1. Install Extensions

- ESLint
- Prettier - Code formatter

### 2. Configuration

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

## Common Issues

### Q: ESLint and Prettier conflict?

A: Use `eslint-config-prettier` to disable all rules that conflict with Prettier.

### Q: Don't want a file to be checked?

A:
```javascript
// .eslintignore
dist
build
node_modules

// Or disable in file
/* eslint-disable */
console.log('This file is not checked')
/* eslint-enable */
```

### Q: Don't want a line to be checked?

A:
```javascript
// eslint-disable-next-line
console.log('This line is not checked')

// Or disable specific rule
// eslint-disable-next-line no-console
console.log('Allow console.log')
```

## npm scripts Configuration

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

## Summary

1. **ESLint checks code quality**: Find potential issues, unify coding standards
2. **Prettier unifies code style**: Automatic formatting, no manual adjustment needed
3. **Husky + lint-staged commit checks**: Only check modified files, high efficiency
4. **VSCode integration**: Automatic check and format on save
5. **Team standards are fundamental**: Everyone must follow for tools to work

This toolchain will keep your project code high-quality and consistent.
