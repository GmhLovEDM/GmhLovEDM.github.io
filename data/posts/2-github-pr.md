---
title: How to Contribute Code Gracefully on GitHub
tag: github
description: GitHub is more than just a code hosting platform. Its real value lies in participating in open-source projects and contributing code. This article introduces a basic yet standard GitHub contribution workflow in the simplest way.
date: "2025-12-13T23:54:00.000Z"
---

## Fork the Project

1. Open the target project’s homepage
2. Click **Fork** in the top-right corner
3. The project will be copied to your own account

---

## Clone to Local

```bash
git clone https://github.com/your-username/project-name.git
cd project-name
```

---

## Create a Branch

Do not modify code directly on the `main` branch.

```bash
git checkout -b feature/xxx
```

---

## Modify and Commit

```bash
git add .
git commit -m "feat: describe what you changed"
```

---

## Push and Open a PR

```bash
git push origin feature/xxx
```

Then go to the GitHub page and click **Pull Request**, and fill in a brief description.

---

## Wait for Review and Merge

Update your code according to the maintainer’s feedback. Once the PR is approved and merged, your contribution is complete.