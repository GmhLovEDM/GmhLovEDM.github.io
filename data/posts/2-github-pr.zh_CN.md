---
title: 如何优雅地在 GitHub 上贡献代码
tag: github
description: GitHub 不仅是代码托管工具，更重要的价值在于参与开源项目、贡献代码。本文用最简单的方式介绍一次基础但规范的 GitHub 代码贡献流程。
date: "2025-12-13T23:54:00.000Z"
---

## Fork 项目

1. 打开目标项目主页  
2. 点击右上角 **Fork**  
3. 项目会被复制到你自己的账号下  

---

## 克隆到本地

```bash
git clone https://github.com/你的用户名/项目名.git
cd 项目名
````

---

## 创建分支

不要直接在 `main` 分支修改代码。

```bash
git checkout -b feature/xxx
```

---

## 修改并提交

```bash
git add .
git commit -m "feat: 做了什么修改"
```

---

## 推送并提交 PR

```bash
git push origin feature/xxx
```

然后在 GitHub 页面点击 **Pull Request**，填写简单说明即可。

---

## 等待合并

根据维护者的建议修改代码，PR 通过后即完成一次贡献。