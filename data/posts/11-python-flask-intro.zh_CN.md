---
title: "Python Flask 入门：10 分钟搭建一个 Web 服务"
tag: python
description: 用 Flask 快速搭建一个 Web 服务，从路由定义到模板渲染，10 分钟掌握 Python 后端开发的基础。
date: "2021-08-30T08:00:00.000Z"
---

## 目标

用 Flask 在 10 分钟内搭建一个可运行的 Web 服务，理解 Python 后端开发的核心流程。

## 背景

### 为什么选择 Flask？

Python 后端框架主要有 Django 和 Flask：

| 特性 | Django | Flask |
|------|--------|-------|
| 定位 | 全能框架 | 微框架 |
| 学习曲线 | 较陡 | 平缓 |
| 灵活性 | 一般 | 很高 |
| 适用场景 | 大型项目 | 小型项目/原型 |

Flask 的哲学是**"不要重复自己"（Don't Repeat Yourself）**——只提供核心功能，其他一切都可以通过扩展实现。

## 快速开始

### 1. 安装 Flask

```bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate   # Windows

# 安装 Flask
pip install flask
```

### 2. 第一个 Flask 应用

```python
# app.py
from flask import Flask

app = Flask(__name__)

@app.route('/')
def hello():
    return 'Hello, World!'

@app.route('/user/<name>')
def user(name):
    return f'Hello, {name}!'

if __name__ == '__main__':
    app.run(debug=True)
```

```bash
# 运行
python app.py

# 访问 http://127.0.0.1:5000
```

## 核心功能

### 1. 路由系统

```python
# 基础路由
@app.route('/')
def index():
    return '首页'

# 动态路由
@app.route('/user/<int:user_id>')
def get_user(user_id):
    return f'用户 ID: {user_id}'

@app.route('/post/<slug>')
def get_post(slug):
    return f'文章: {slug}'

# 多种 HTTP 方法
@app.route('/api/users', methods=['GET', 'POST'])
def users():
    if request.method == 'GET':
        return jsonify({'users': []})
    elif request.method == 'POST':
        data = request.get_json()
        return jsonify({'created': True}), 201

# URL 参数
@app.route('/search')
def search():
    query = request.args.get('q', '')
    page = request.args.get('page', 1, type=int)
    return jsonify({'query': query, 'page': page})
```

### 2. 模板渲染

```python
from flask import render_template

@app.route('/hello/<name>')
def hello_template(name):
    return render_template('hello.html', name=name, title='欢迎')
```

```html
<!-- templates/hello.html -->
<!DOCTYPE html>
<html>
<head>
    <title>{{ title }}</title>
</head>
<body>
    <h1>Hello, {{ name }}!</h1>
    {% if name == 'admin' %}
        <p>欢迎回来，管理员！</p>
    {% else %}
        <p>欢迎访问我们的网站</p>
    {% endif %}

    <ul>
    {% for item in items %}
        <li>{{ item }}</li>
    {% endfor %}
    </ul>
</body>
</html>
```

### 3. JSON API

```python
from flask import Flask, jsonify, request

app = Flask(__name__)

# 内存存储（生产环境用数据库）
users = []
next_id = 1

@app.route('/api/users', methods=['GET'])
def get_users():
    return jsonify(users)

@app.route('/api/users/<int:user_id>', methods=['GET'])
def get_user(user_id):
    user = next((u for u in users if u['id'] == user_id), None)
    if user:
        return jsonify(user)
    return jsonify({'error': '用户不存在'}), 404

@app.route('/api/users', methods=['POST'])
def create_user():
    global next_id
    data = request.get_json()

    if not data or 'name' not in data or 'email' not in data:
        return jsonify({'error': '缺少必要字段'}), 400

    user = {
        'id': next_id,
        'name': data['name'],
        'email': data['email']
    }
    users.append(user)
    next_id += 1

    return jsonify(user), 201

@app.route('/api/users/<int:user_id>', methods=['PUT'])
def update_user(user_id):
    user = next((u for u in users if u['id'] == user_id), None)
    if not user:
        return jsonify({'error': '用户不存在'}), 404

    data = request.get_json()
    user['name'] = data.get('name', user['name'])
    user['email'] = data.get('email', user['email'])

    return jsonify(user)

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    global users
    user = next((u for u in users if u['id'] == user_id), None)
    if not user:
        return jsonify({'error': '用户不存在'}), 404

    users = [u for u in users if u['id'] != user_id]
    return jsonify({'message': '删除成功'})
```

### 4. 错误处理

```python
from flask import jsonify

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': '资源不存在'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': '服务器内部错误'}), 500

@app.errorhandler(400)
def bad_request(error):
    return jsonify({'error': '请求参数错误'}), 400
```

### 5. 数据库集成（SQLite）

```python
import sqlite3
from flask import g

DATABASE = 'database.db'

def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(exception):
    db = g.pop('db', None)
    if db is not None:
        db.close()

def init_db():
    db = get_db()
    db.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    db.commit()

@app.route('/api/users/db', methods=['GET'])
def get_users_db():
    db = get_db()
    users = db.execute('SELECT * FROM users').fetchall()
    return jsonify([dict(user) for user in users])

@app.route('/api/users/db', methods=['POST'])
def create_user_db():
    db = get_db()
    data = request.get_json()

    try:
        db.execute(
            'INSERT INTO users (name, email) VALUES (?, ?)',
            (data['name'], data['email'])
        )
        db.commit()
        return jsonify({'message': '创建成功'}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': '邮箱已存在'}), 400
```

## 项目结构

```
my-flask-app/
├── app.py              # 主应用
├── config.py           # 配置
├── requirements.txt    # 依赖
├── templates/          # 模板
│   ├── base.html
│   └── index.html
├── static/             # 静态文件
│   ├── css/
│   ├── js/
│   └── images/
└── tests/              # 测试
    └── test_app.py
```

## 配置管理

```python
# config.py
import os

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'dev-secret-key'
    DEBUG = False
    TESTING = False

class DevelopmentConfig(Config):
    DEBUG = True
    DATABASE = 'dev.db'

class ProductionConfig(Config):
    DATABASE = os.environ.get('DATABASE_URL')

class TestingConfig(Config):
    TESTING = True
    DATABASE = ':memory:'

# app.py
from config import DevelopmentConfig

app = Flask(__name__)
app.config.from_object(DevelopmentConfig)
```

## 部署

### 使用 Gunicorn（生产环境）

```bash
# 安装
pip install gunicorn

# 运行
gunicorn -w 4 -b 0.0.0.0:8000 app:app

# -w 4: 4 个工作进程
# -b 0.0.0.0:8000: 绑定地址和端口
```

### Docker 部署

```dockerfile
FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:8000", "app:app"]
```

## 常用扩展

| 扩展 | 用途 |
|------|------|
| Flask-SQLAlchemy | ORM |
| Flask-Login | 用户认证 |
| Flask-Mail | 邮件发送 |
| Flask-RESTful | REST API |
| Flask-CORS | 跨域支持 |
| Flask-Migrate | 数据库迁移 |

## 测试

```python
import pytest
from app import app

@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_hello(client):
    response = client.get('/')
    assert response.status_code == 200
    assert b'Hello, World!' in response.data

def test_create_user(client):
    response = client.post('/api/users',
        json={'name': '张三', 'email': 'zhangsan@example.com'})
    assert response.status_code == 201
```

## 总结

1. **Flask 足够简单**：10 分钟就能搭建一个 Web 服务
2. **路由系统直观**：装饰器定义路由，清晰明了
3. **模板引擎强大**：Jinja2 支持继承、过滤器等高级特性
4. **扩展生态丰富**：几乎所有需求都有现成的扩展
5. **适合快速原型**：验证想法的首选框架

Flask 的简单不是缺陷，而是设计哲学。它给你最小的核心，让你自由构建。
