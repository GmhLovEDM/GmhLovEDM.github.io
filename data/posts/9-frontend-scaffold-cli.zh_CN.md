---
title: "从零搭建一个前端脚手架 CLI 工具"
tag: nodejs
description: 手把手教你用 Node.js 搭建一个前端脚手架 CLI 工具，从命令行解析到模板生成，打造你自己的项目初始化方案。
date: "2021-11-02T08:00:00.000Z"
---

## 目标

搭建一个类似 `create-react-app` 或 `vue create` 的 CLI 工具，能够通过命令行交互式地创建新项目。

## 背景

### 为什么要自己做脚手架？

每个团队都有自己的项目规范：目录结构、代码风格、依赖版本、构建配置等。每次都手动搭建或者复制粘贴模板，效率低下且容易出错。

一个好的脚手架 CLI 可以：

1. **统一团队规范**：所有人用同一套模板
2. **提高开发效率**：一键创建项目
3. **减少配置时间**：预设好常用的工具链
4. **降低新人门槛**：不需要记住复杂的配置命令

## 技术选型

| 工具 | 用途 | 选择 |
|------|------|------|
| Commander.js | 命令行参数解析 | Yes |
| Inquirer.js | 交互式问答 | Yes |
| Handlebars | 模板引擎 | Yes |
| Chalk | 终端文字美化 | Yes |
| Ora | 加载动画 | Yes |

## 项目结构

```
my-scaffold/
├── bin/
│   └── cli.js          # 入口文件
├── lib/
│   ├── create.js       # 创建项目逻辑
│   ├── prompts.js      # 交互式问答
│   └── generator.js    # 模板生成器
├── templates/          # 项目模板
│   ├── react/
│   ├── vue/
│   └── node/
├── package.json
└── README.md
```

## 核心实现

### 1. 入口文件（bin/cli.js）

```javascript
#!/usr/bin/env node

const { program } = require('commander');
const pkg = require('../package.json');
const create = require('../lib/create');

program
    .name('my-scaffold')
    .description('前端项目脚手架')
    .version(pkg.version);

program
    .command('create <project-name>')
    .description('创建一个新项目')
    .option('-t, --template <template>', '指定模板 (react/vue/node)', 'react')
    .option('-p, --package-manager <pm>', '包管理器 (npm/yarn/pnpm)', 'npm')
    .action((projectName, options) => {
        create(projectName, options);
    });

program.parse();
```

### 2. 交互式问答（lib/prompts.js）

```javascript
const inquirer = require('inquirer');

async function askQuestions(projectName) {
    const questions = [
        {
            type: 'list',
            name: 'framework',
            message: '选择框架:',
            choices: [
                { name: 'React + TypeScript', value: 'react-ts' },
                { name: 'React + JavaScript', value: 'react-js' },
                { name: 'Vue 3 + TypeScript', value: 'vue-ts' },
                { name: 'Vue 3 + JavaScript', value: 'vue-js' },
                { name: 'Node.js + Express', value: 'node-express' },
                { name: '纯 HTML/CSS/JS', value: 'vanilla' },
            ]
        },
        {
            type: 'confirm',
            name: 'eslint',
            message: '是否配置 ESLint?',
            default: true
        },
        {
            type: 'confirm',
            name: 'prettier',
            message: '是否配置 Prettier?',
            default: true
        },
        {
            type: 'confirm',
            name: 'husky',
            message: '是否配置 Husky (Git hooks)?',
            default: true
        },
        {
            type: 'input',
            name: 'description',
            message: '项目描述:',
            default: `A new project: ${projectName}`
        },
        {
            type: 'input',
            name: 'author',
            message: '作者名称:',
            default: ''
        }
    ];

    return inquirer.prompt(questions);
}

module.exports = { askQuestions };
```

### 3. 项目创建逻辑（lib/create.js）

```javascript
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const { askQuestions } = require('./prompts');
const { generateTemplate } = require('./generator');

async function create(projectName, options) {
    const targetDir = path.resolve(process.cwd(), projectName);

    // 检查目录是否存在
    if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`目录 ${projectName} 已存在`));
        const { overwrite } = await require('inquirer').prompt([{
            type: 'confirm',
            name: 'overwrite',
            message: '是否覆盖?',
            default: false
        }]);

        if (!overwrite) {
            console.log(chalk.yellow('已取消创建'));
            return;
        }

        fs.removeSync(targetDir);
    }

    console.log(chalk.cyan(`\n正在创建项目 ${projectName}...\n`));

    // 获取用户选择
    const answers = await askQuestions(projectName);

    const spinner = ora('正在生成项目文件...').start();

    try {
        // 创建目录
        fs.mkdirSync(targetDir, { recursive: true });

        // 生成模板文件
        await generateTemplate(targetDir, {
            projectName,
            ...answers,
            ...options
        });

        // 初始化 package.json
        const packageJson = {
            name: projectName,
            version: '1.0.0',
            description: answers.description,
            author: answers.author,
            scripts: getScripts(answers.framework),
            dependencies: getDependencies(answers.framework),
            devDependencies: getDevDependencies(answers)
        };

        fs.writeJsonSync(path.join(targetDir, 'package.json'), packageJson, { spaces: 2 });

        spinner.succeed(chalk.green('项目创建成功!'));

        // 显示下一步提示
        console.log(chalk.cyan('\n下一步操作:'));
        console.log(chalk.white(`  cd ${projectName}`));
        console.log(chalk.white(`  ${options.packageManager} install`));
        console.log(chalk.white(`  ${options.packageManager} run dev\n`));

    } catch (error) {
        spinner.fail(chalk.red('项目创建失败'));
        console.error(error);
    }
}

function getScripts(framework) {
    const scripts = {
        'react-ts': { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        'react-js': { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        'vue-ts': { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        'vue-js': { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        'node-express': { dev: 'nodemon src/index.js', start: 'node src/index.js' },
        'vanilla': { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    };
    return scripts[framework] || scripts['vanilla'];
}

function getDependencies(framework) {
    const deps = {
        'react-ts': { react: '^18.0.0', 'react-dom': '^18.0.0' },
        'react-js': { react: '^18.0.0', 'react-dom': '^18.0.0' },
        'vue-ts': { vue: '^3.2.0' },
        'vue-js': { vue: '^3.2.0' },
        'node-express': { express: '^4.18.0' },
        'vanilla': {}
    };
    return deps[framework] || {};
}

function getDevDependencies(answers) {
    const devDeps = { vite: '^3.0.0' };

    if (answers.framework.includes('ts')) {
        devDeps.typescript = '^4.9.0';
    }

    if (answers.eslint) {
        devDeps.eslint = '^8.0.0';
        devDeps['eslint-plugin-react'] = '^7.0.0';
    }

    if (answers.prettier) {
        devDeps.prettier = '^2.8.0';
    }

    if (answers.husky) {
        devDeps.husky = '^8.0.0';
        devDeps['lint-staged'] = '^13.0.0';
    }

    return devDeps;
}

module.exports = create;
```

### 4. 模板生成器（lib/generator.js）

```javascript
const fs = require('fs-extra');
const path = require('path');
const Handlebars = require('handlebars');

async function generateTemplate(targetDir, data) {
    const templateDir = path.join(__dirname, '..', 'templates', data.framework);

    // 如果模板目录不存在，创建基础模板
    if (!fs.existsSync(templateDir)) {
        await createBasicTemplate(targetDir, data);
        return;
    }

    // 读取模板目录
    const files = await readDirRecursive(templateDir);

    for (const file of files) {
        const content = await fs.readFile(path.join(templateDir, file), 'utf-8');

        // 使用 Handlebars 渲染模板
        const compiled = Handlebars.compile(content);
        const rendered = compiled(data);

        const targetPath = path.join(targetDir, file.replace('.hbs', ''));
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, rendered);
    }
}

async function createBasicTemplate(targetDir, data) {
    // 根据框架创建基础文件
    const templates = getTemplates(data.framework);

    for (const [filename, content] of Object.entries(templates)) {
        const filePath = path.join(targetDir, filename);
        await fs.ensureDir(path.dirname(filePath));

        // 渲染模板
        const compiled = Handlebars.compile(content);
        const rendered = compiled(data);
        await fs.writeFile(filePath, rendered);
    }
}

function getTemplates(framework) {
    if (framework.includes('react')) {
        return {
            'src/App.tsx': `
import React from 'react';

function App() {
  return (
    <div className="App">
      <h1>{{projectName}}</h1>
    </div>
  );
}

export default App;
`,
            'src/main.tsx': `
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
            'index.html': `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{projectName}}</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`,
            'vite.config.ts': `
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`
        };
    }

    // 其他框架的模板...
    return {};
}

async function readDirRecursive(dir) {
    const files = [];
    const items = await fs.readdir(dir);

    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            const subFiles = await readDirRecursive(fullPath);
            files.push(...subFiles.map(f => path.join(item, f)));
        } else {
            files.push(item);
        }
    }

    return files;
}

module.exports = { generateTemplate };
```

## 安装和使用

### 1. 链接到全局

```bash
# 在项目目录下
npm link
```

### 2. 使用脚手架

```bash
# 创建 React + TypeScript 项目
my-scaffold create my-app

# 创建 Vue 3 项目
my-scaffold create my-vue-app --template vue-ts

# 创建 Node.js 项目
my-scaffold create my-api --template node-express
```

### 3. 发布到 npm

```bash
# 更新 package.json
# 添加 bin 字段
{
  "bin": {
    "my-scaffold": "./bin/cli.js"
  }
}

# 发布
npm publish
```

## 扩展功能

### 1. 支持远程模板

```javascript
const git = require('simple-git');

async function downloadTemplate(templateUrl, targetDir) {
    await git().clone(templateUrl, targetDir);
    // 删除 .git 目录
    fs.removeSync(path.join(targetDir, '.git'));
}
```

### 2. 模板市场

```javascript
async function fetchTemplates() {
    const response = await fetch('https://api.example.com/templates');
    return await response.json();
}
```

### 3. 插件系统

```javascript
class ScaffoldPlugin {
    constructor(options) {
        this.options = options;
    }

    apply(scaffold) {
        scaffold.hook('beforeCreate', async (context) => {
            console.log('正在准备创建项目...');
        });

        scaffold.hook('afterCreate', async (context) => {
            console.log('项目创建完成，正在安装依赖...');
            await exec('npm install');
        });
    }
}
```

## 总结

1. **CLI 工具是提高团队效率的利器**：统一规范、减少重复工作
2. **核心组件**：Commander.js（参数解析）+ Inquirer.js（交互）+ Handlebars（模板）
3. **渐进式实现**：先实现核心功能，再逐步扩展
4. **发布分享**：通过 npm 发布，团队成员一键安装使用

掌握了这些，你就可以为自己或团队打造专属的项目脚手架了。
