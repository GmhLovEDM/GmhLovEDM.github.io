---
title: "Building a Frontend Scaffold CLI Tool from Scratch"
tag: nodejs
description: Step-by-step guide to building a frontend scaffold CLI tool with Node.js, from command-line parsing to template generation, creating your own project initialization solution.
date: "2021-11-02T08:00:00.000Z"
---

## Goal

Build a CLI tool similar to `create-react-app` or `vue create` that can interactively create new projects via command line.

## Background

### Why Build Your Own Scaffold?

Every team has its own project standards: directory structure, code style, dependency versions, build configurations, etc. Manually setting up or copy-pasting templates each time is inefficient and error-prone.

A good scaffold CLI can:

1. **Unify team standards**: Everyone uses the same template
2. **Improve development efficiency**: One-click project creation
3. **Reduce configuration time**: Pre-configured common toolchains
4. **Lower the barrier for newcomers**: No need to remember complex configuration commands

## Technology Selection

| Tool | Purpose | Selected |
|------|---------|----------|
| Commander.js | Command-line argument parsing | Yes |
| Inquirer.js | Interactive Q&A | Yes |
| Handlebars | Template engine | Yes |
| Chalk | Terminal text styling | Yes |
| Ora | Loading animation | Yes |

## Project Structure

```
my-scaffold/
├── bin/
│   └── cli.js          # Entry file
├── lib/
│   ├── create.js       # Project creation logic
│   ├── prompts.js      # Interactive Q&A
│   └── generator.js    # Template generator
├── templates/          # Project templates
│   ├── react/
│   ├── vue/
│   └── node/
├── package.json
└── README.md
```

## Core Implementation

### 1. Entry File (bin/cli.js)

```javascript
#!/usr/bin/env node

const { program } = require('commander');
const pkg = require('../package.json');
const create = require('../lib/create');

program
    .name('my-scaffold')
    .description('Frontend project scaffold')
    .version(pkg.version);

program
    .command('create <project-name>')
    .description('Create a new project')
    .option('-t, --template <template>', 'Specify template (react/vue/node)', 'react')
    .option('-p, --package-manager <pm>', 'Package manager (npm/yarn/pnpm)', 'npm')
    .action((projectName, options) => {
        create(projectName, options);
    });

program.parse();
```

### 2. Interactive Q&A (lib/prompts.js)

```javascript
const inquirer = require('inquirer');

async function askQuestions(projectName) {
    const questions = [
        {
            type: 'list',
            name: 'framework',
            message: 'Select framework:',
            choices: [
                { name: 'React + TypeScript', value: 'react-ts' },
                { name: 'React + JavaScript', value: 'react-js' },
                { name: 'Vue 3 + TypeScript', value: 'vue-ts' },
                { name: 'Vue 3 + JavaScript', value: 'vue-js' },
                { name: 'Node.js + Express', value: 'node-express' },
                { name: 'Plain HTML/CSS/JS', value: 'vanilla' },
            ]
        },
        {
            type: 'confirm',
            name: 'eslint',
            message: 'Configure ESLint?',
            default: true
        },
        {
            type: 'confirm',
            name: 'prettier',
            message: 'Configure Prettier?',
            default: true
        },
        {
            type: 'confirm',
            name: 'husky',
            message: 'Configure Husky (Git hooks)?',
            default: true
        },
        {
            type: 'input',
            name: 'description',
            message: 'Project description:',
            default: `A new project: ${projectName}`
        },
        {
            type: 'input',
            name: 'author',
            message: 'Author name:',
            default: ''
        }
    ];

    return inquirer.prompt(questions);
}

module.exports = { askQuestions };
```

### 3. Project Creation Logic (lib/create.js)

```javascript
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const { askQuestions } = require('./prompts');
const { generateTemplate } = require('./generator');

async function create(projectName, options) {
    const targetDir = path.resolve(process.cwd(), projectName);

    // Check if directory exists
    if (fs.existsSync(targetDir)) {
        console.log(chalk.red(`Directory ${projectName} already exists`));
        const { overwrite } = await require('inquirer').prompt([{
            type: 'confirm',
            name: 'overwrite',
            message: 'Overwrite?',
            default: false
        }]);

        if (!overwrite) {
            console.log(chalk.yellow('Creation cancelled'));
            return;
        }

        fs.removeSync(targetDir);
    }

    console.log(chalk.cyan(`\nCreating project ${projectName}...\n`));

    // Get user selections
    const answers = await askQuestions(projectName);

    const spinner = ora('Generating project files...').start();

    try {
        // Create directory
        fs.mkdirSync(targetDir, { recursive: true });

        // Generate template files
        await generateTemplate(targetDir, {
            projectName,
            ...answers,
            ...options
        });

        // Initialize package.json
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

        spinner.succeed(chalk.green('Project created successfully!'));

        // Show next steps
        console.log(chalk.cyan('\nNext steps:'));
        console.log(chalk.white(`  cd ${projectName}`));
        console.log(chalk.white(`  ${options.packageManager} install`));
        console.log(chalk.white(`  ${options.packageManager} run dev\n`));

    } catch (error) {
        spinner.fail(chalk.red('Project creation failed'));
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

### 4. Template Generator (lib/generator.js)

```javascript
const fs = require('fs-extra');
const path = require('path');
const Handlebars = require('handlebars');

async function generateTemplate(targetDir, data) {
    const templateDir = path.join(__dirname, '..', 'templates', data.framework);

    // If template directory doesn't exist, create basic template
    if (!fs.existsSync(templateDir)) {
        await createBasicTemplate(targetDir, data);
        return;
    }

    // Read template directory
    const files = await readDirRecursive(templateDir);

    for (const file of files) {
        const content = await fs.readFile(path.join(templateDir, file), 'utf-8');

        // Render template with Handlebars
        const compiled = Handlebars.compile(content);
        const rendered = compiled(data);

        const targetPath = path.join(targetDir, file.replace('.hbs', ''));
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, rendered);
    }
}

async function createBasicTemplate(targetDir, data) {
    // Create basic files based on framework
    const templates = getTemplates(data.framework);

    for (const [filename, content] of Object.entries(templates)) {
        const filePath = path.join(targetDir, filename);
        await fs.ensureDir(path.dirname(filePath));

        // Render template
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

    // Templates for other frameworks...
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

## Installation and Usage

### 1. Link Globally

```bash
# In the project directory
npm link
```

### 2. Use the Scaffold

```bash
# Create React + TypeScript project
my-scaffold create my-app

# Create Vue 3 project
my-scaffold create my-vue-app --template vue-ts

# Create Node.js project
my-scaffold create my-api --template node-express
```

### 3. Publish to npm

```bash
# Update package.json
# Add bin field
{
  "bin": {
    "my-scaffold": "./bin/cli.js"
  }
}

# Publish
npm publish
```

## Extended Features

### 1. Support Remote Templates

```javascript
const git = require('simple-git');

async function downloadTemplate(templateUrl, targetDir) {
    await git().clone(templateUrl, targetDir);
    // Remove .git directory
    fs.removeSync(path.join(targetDir, '.git'));
}
```

### 2. Template Marketplace

```javascript
async function fetchTemplates() {
    const response = await fetch('https://api.example.com/templates');
    return await response.json();
}
```

### 3. Plugin System

```javascript
class ScaffoldPlugin {
    constructor(options) {
        this.options = options;
    }

    apply(scaffold) {
        scaffold.hook('beforeCreate', async (context) => {
            console.log('Preparing to create project...');
        });

        scaffold.hook('afterCreate', async (context) => {
            console.log('Project created, installing dependencies...');
            await exec('npm install');
        });
    }
}
```

## Summary

1. **CLI tools are powerful for improving team efficiency**: Unified standards, reduced repetitive work
2. **Core components**: Commander.js (argument parsing) + Inquirer.js (interaction) + Handlebars (templates)
3. **Progressive implementation**: Implement core features first, then gradually expand
4. **Publish and share**: Publish via npm, team members can install with one command

Master these, and you can build a custom project scaffold for yourself or your team.
