---
title: "Python Flask Introduction: Build a Web Service in 10 Minutes"
tag: python
description: Quickly build a web service with Flask, from route definitions to template rendering, mastering the basics of Python backend development in 10 minutes.
date: "2021-08-30T08:00:00.000Z"
---

## Goal

Build a runnable web service with Flask in 10 minutes and understand the core workflow of Python backend development.

## Background

### Why Choose Flask?

Python backend frameworks mainly include Django and Flask:

| Feature | Django | Flask |
|---------|--------|-------|
| Positioning | Full-stack framework | Micro framework |
| Learning curve | Steep | Gentle |
| Flexibility | Average | Very high |
| Use cases | Large projects | Small projects/prototypes |

Flask's philosophy is **"Don't Repeat Yourself"** — it only provides core functionality, and everything else can be implemented through extensions.

## Quick Start

### 1. Install Flask

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate   # Windows

# Install Flask
pip install flask
```

### 2. First Flask Application

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
# Run
python app.py

# Visit http://127.0.0.1:5000
```

## Core Features

### 1. Routing System

```python
# Basic route
@app.route('/')
def index():
    return 'Home'

# Dynamic route
@app.route('/user/<int:user_id>')
def get_user(user_id):
    return f'User ID: {user_id}'

@app.route('/post/<slug>')
def get_post(slug):
    return f'Article: {slug}'

# Multiple HTTP methods
@app.route('/api/users', methods=['GET', 'POST'])
def users():
    if request.method == 'GET':
        return jsonify({'users': []})
    elif request.method == 'POST':
        data = request.get_json()
        return jsonify({'created': True}), 201

# URL parameters
@app.route('/search')
def search():
    query = request.args.get('q', '')
    page = request.args.get('page', 1, type=int)
    return jsonify({'query': query, 'page': page})
```

### 2. Template Rendering

```python
from flask import render_template

@app.route('/hello/<name>')
def hello_template(name):
    return render_template('hello.html', name=name, title='Welcome')
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
        <p>Welcome back, admin!</p>
    {% else %}
        <p>Welcome to our website</p>
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

# In-memory storage (use database in production)
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
    return jsonify({'error': 'User not found'}), 404

@app.route('/api/users', methods=['POST'])
def create_user():
    global next_id
    data = request.get_json()

    if not data or 'name' not in data or 'email' not in data:
        return jsonify({'error': 'Missing required fields'}), 400

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
        return jsonify({'error': 'User not found'}), 404

    data = request.get_json()
    user['name'] = data.get('name', user['name'])
    user['email'] = data.get('email', user['email'])

    return jsonify(user)

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
def delete_user(user_id):
    global users
    user = next((u for u in users if u['id'] == user_id), None)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    users = [u for u in users if u['id'] != user_id]
    return jsonify({'message': 'Deleted successfully'})
```

### 4. Error Handling

```python
from flask import jsonify

@app.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Resource not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

@app.errorhandler(400)
def bad_request(error):
    return jsonify({'error': 'Bad request parameters'}), 400
```

### 5. Database Integration (SQLite)

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
        return jsonify({'message': 'Created successfully'}), 201
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Email already exists'}), 400
```

## Project Structure

```
my-flask-app/
├── app.py              # Main application
├── config.py           # Configuration
├── requirements.txt    # Dependencies
├── templates/          # Templates
│   ├── base.html
│   └── index.html
├── static/             # Static files
│   ├── css/
│   ├── js/
│   └── images/
└── tests/              # Tests
    └── test_app.py
```

## Configuration Management

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

## Deployment

### Using Gunicorn (Production)

```bash
# Install
pip install gunicorn

# Run
gunicorn -w 4 -b 0.0.0.0:8000 app:app

# -w 4: 4 worker processes
# -b 0.0.0.0:8000: bind address and port
```

### Docker Deployment

```dockerfile
FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:8000", "app:app"]
```

## Common Extensions

| Extension | Purpose |
|-----------|---------|
| Flask-SQLAlchemy | ORM |
| Flask-Login | User authentication |
| Flask-Mail | Email sending |
| Flask-RESTful | REST API |
| Flask-CORS | CORS support |
| Flask-Migrate | Database migration |

## Testing

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
        json={'name': 'Zhang San', 'email': 'zhangsan@example.com'})
    assert response.status_code == 201
```

## Summary

1. **Flask is simple enough**: Build a web service in 10 minutes
2. **Intuitive routing system**: Decorators define routes, clear and straightforward
3. **Powerful template engine**: Jinja2 supports inheritance, filters, and other advanced features
4. **Rich extension ecosystem**: Almost every need has a ready-made extension
5. **Ideal for rapid prototyping**: The first choice framework for validating ideas

Flask's simplicity is not a flaw, but a design philosophy. It gives you the minimal core and lets you build freely.
