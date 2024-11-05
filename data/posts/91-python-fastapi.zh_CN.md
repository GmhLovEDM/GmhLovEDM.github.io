---
title: "Python FastAPI 实战：异步高性能 API 开发"
tag: python
description: 全面介绍 FastAPI 框架的核心特性，包括异步编程、数据验证、依赖注入和性能优化，构建生产级 API 服务。
date: "2024-11-05T08:00:00.000Z"
---

## 目标

本文旨在帮助 Python 开发者掌握 FastAPI 框架的核心特性和最佳实践，理解异步编程模型，能够构建高性能、可维护的 REST API 服务。

## 背景

FastAPI 是一个现代、快速的 Python Web 框架，基于标准 Python 类型提示构建 API。它结合了 Flask 的简洁和 Django 的功能，同时提供了自动文档生成和数据验证功能。

### 为什么选择 FastAPI？

1. **高性能**：基于 Starlette 和 Pydantic，性能与 Node.js、Go 相当
2. **开发效率**：类型提示驱动，自动文档生成
3. **异步支持**：原生支持 async/await
4. **数据验证**：自动请求/响应验证
5. **类型安全**：完整的类型提示支持

### 与其他框架对比

| 特性 | FastAPI | Flask | Django |
|------|---------|-------|--------|
| 性能 | 极高 | 中等 | 中等 |
| 异步 | 原生支持 | 需要扩展 | 3.1+ 支持 |
| 自动文档 | 内置 | 需要扩展 | 需要扩展 |
| 数据验证 | 内置 | 需要扩展 | 需要扩展 |
| 学习曲线 | 低 | 低 | 中 |

## 一、环境搭建

### 安装依赖

```bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate  # Windows

# 安装 FastAPI
pip install fastapi uvicorn

# 安装额外依赖
pip install sqlalchemy asyncpg pydantic python-jose passlib bcrypt
```

### 第一个 FastAPI 应用

```python
# main.py
from fastapi import FastAPI

app = FastAPI(
    title="My API",
    description="A FastAPI application",
    version="1.0.0"
)

@app.get("/")
async def root():
    return {"message": "Hello World"}

@app.get("/items/{item_id}")
async def read_item(item_id: int, q: str | None = None):
    if q:
        return {"item_id": item_id, "q": q}
    return {"item_id": item_id}

# 运行：uvicorn main:app --reload
```

## 二、路径参数和查询参数

### 路径参数

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

# 基础路径参数
@app.get("/users/{user_id}")
async def get_user(user_id: int):
    return {"user_id": user_id}

# 多个路径参数
@app.get("/users/{user_id}/posts/{post_id}")
async def get_user_post(user_id: int, post_id: int):
    return {"user_id": user_id, "post_id": post_id}
```

### 查询参数

```python
@app.get("/search/")
async def search(
    q: str,
    skip: int = 0,
    limit: int = 10,
    order_by: str = "created_at"
):
    return {
        "query": q,
        "skip": skip,
        "limit": limit,
        "order_by": order_by
    }
```

### 请求体

```python
from pydantic import BaseModel, EmailStr
from datetime import datetime

class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str

class UserResponse(BaseModel):
    id: int
    name: str
    email: str
    created_at: datetime

    class Config:
        from_attributes = True

@app.post("/users/", response_model=UserResponse)
async def create_user(user: UserCreate):
    # 创建用户逻辑
    return {"id": 1, **user.dict(), "created_at": datetime.now()}
```

## 三、数据模型和验证

### Pydantic 模型

```python
from pydantic import BaseModel, Field, validator
from typing import Optional
from datetime import datetime
from enum import Enum

class UserRole(str, Enum):
    admin = "admin"
    user = "user"
    guest = "guest"

class UserBase(BaseModel):
    name: str = Field(..., min_length=2, max_length=50)
    email: EmailStr
    role: UserRole = UserRole.user
    bio: Optional[str] = None

    @validator('name')
    def name_must_be_alphanumeric(cls, v):
        if not v.isalnum():
            raise ValueError('Name must be alphanumeric')
        return v

class UserCreate(UserBase):
    password: str = Field(..., min_length=8)

class UserUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    bio: Optional[str] = None

class UserInDB(UserBase):
    id: int
    hashed_password: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
```

### 响应模型

```python
from typing import List

@app.post("/users/", response_model=UserResponse, status_code=201)
async def create_user(user: UserCreate):
    # 创建用户
    pass

@app.get("/users/", response_model=List[UserResponse])
async def list_users(skip: int = 0, limit: int = 10):
    # 获取用户列表
    pass

@app.get("/users/{user_id}", response_model=UserResponse)
async def get_user(user_id: int):
    # 获取单个用户
    pass
```

## 四、数据库操作

### SQLAlchemy 配置

```python
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

# 数据库连接
DATABASE_URL = "postgresql+asyncpg://user:password@localhost/dbname"

engine = create_async_engine(DATABASE_URL, echo=True)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

# 依赖注入
async def get_db():
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
```

### 数据模型

```python
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from datetime import datetime

class UserModel(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50))
    email = Column(String(100), unique=True, index=True)
    hashed_password = Column(String(100))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    posts = relationship("PostModel", back_populates="owner")

class PostModel(Base):
    __tablename__ = "posts"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(100))
    content = Column(String)
    owner_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    owner = relationship("UserModel", back_populates="posts")
```

### CRUD 操作

```python
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

class UserRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_user(self, user_id: int):
        result = await self.db.execute(
            select(UserModel).where(UserModel.id == user_id)
        )
        return result.scalar_one_or_none()

    async def get_user_by_email(self, email: str):
        result = await self.db.execute(
            select(UserModel).where(UserModel.email == email)
        )
        return result.scalar_one_or_none()

    async def create_user(self, user_data: UserCreate):
        db_user = UserModel(**user_data.dict())
        self.db.add(db_user)
        await self.db.flush()
        return db_user

    async def update_user(self, user_id: int, user_data: UserUpdate):
        db_user = await self.get_user(user_id)
        if db_user:
            for key, value in user_data.dict(exclude_unset=True).items():
                setattr(db_user, key, value)
            await self.db.flush()
        return db_user

    async def delete_user(self, user_id: int):
        db_user = await self.get_user(user_id)
        if db_user:
            await self.db.delete(db_user)
            return True
        return False
```

## 五、依赖注入

### 基础依赖

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

# 密码加密
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT 配置
SECRET_KEY = "your-secret-key"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

# 依赖注入函数
async def get_current_user(token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id: int = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    user_repo = UserRepository(db)
    user = await user_repo.get_user(user_id)
    if user is None:
        raise credentials_exception
    return user

# 使用依赖
@app.get("/users/me/", response_model=UserResponse)
async def read_users_me(current_user: UserModel = Depends(get_current_user)):
    return current_user
```

### 权限控制

```python
from functools import wraps

def require_role(roles: list[UserRole]):
    async def role_checker(current_user: UserModel = Depends(get_current_user)):
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Not enough permissions"
            )
        return current_user
    return Depends(role_checker)

# 使用
@app.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    current_user: UserModel = require_role([UserRole.admin])
):
    # 只有管理员可以删除用户
    pass
```

## 六、中间件和异常处理

### 中间件

```python
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
import time

# CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 请求时间中间件
@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response
```

### 异常处理

```python
from fastapi import Request
from fastapi.responses import JSONResponse

class AppException(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail

@app.exception_handler(AppException)
async def app_exception_handler(request: Request, exc: AppException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail}
    )

# 使用
@app.get("/users/{user_id}")
async def get_user(user_id: int, db: AsyncSession = Depends(get_db)):
    user_repo = UserRepository(db)
    user = await user_repo.get_user(user_id)
    if not user:
        raise AppException(status_code=404, detail="User not found")
    return user
```

## 七、性能优化

### 异步操作

```python
# 好的做法：异步数据库操作
async def get_users(db: AsyncSession):
    result = await db.execute(select(UserModel))
    return result.scalars().all()

# 不好的做法：同步数据库操作
def get_users_sync(db: Session):
    return db.query(UserModel).all()
```

### 缓存

```python
from functools import lru_cache
import redis.asyncio as redis

# Redis 缓存
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)

async def get_user_cached(user_id: int):
    # 从缓存获取
    cached = await redis_client.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)
    
    # 从数据库获取
    async with async_session() as db:
        user_repo = UserRepository(db)
        user = await user_repo.get_user(user_id)
        if user:
            # 写入缓存
            await redis_client.setex(
                f"user:{user_id}",
                300,
                json.dumps(UserResponse.from_orm(user).dict())
            )
        return user
```

### 分页

```python
from typing import Generic, TypeVar, List
from pydantic import BaseModel

T = TypeVar('T')

class PaginatedResponse(BaseModel, Generic[T]):
    items: List[T]
    total: int
    page: int
    page_size: int
    pages: int

@app.get("/users/", response_model=PaginatedResponse[UserResponse])
async def list_users(
    page: int = 1,
    page_size: int = 10,
    db: AsyncSession = Depends(get_db)
):
    user_repo = UserRepository(db)
    users = await user_repo.get_users(page, page_size)
    total = await user_repo.count_users()
    
    return PaginatedResponse(
        items=users,
        total=total,
        page=page,
        page_size=page_size,
        pages=(total + page_size - 1) // page_size
    )
```

## 八、测试

```python
from fastapi.testclient import TestClient
import pytest

@pytest.fixture
def client():
    return TestClient(app)

@pytest.fixture
async def db_session():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    async with async_session() as session:
        yield session
    
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

def test_create_user(client):
    response = client.post(
        "/users/",
        json={
            "name": "testuser",
            "email": "test@example.com",
            "password": "password123"
        }
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "testuser"
    assert data["email"] == "test@example.com"
    assert "id" in data

def test_get_user(client):
    # 先创建用户
    create_response = client.post(
        "/users/",
        json={
            "name": "testuser",
            "email": "test@example.com",
            "password": "password123"
        }
    )
    user_id = create_response.json()["id"]
    
    # 获取用户
    response = client.get(f"/users/{user_id}")
    assert response.status_code == 200
    assert response.json()["name"] == "testuser"
```

## 九、项目结构

```
my-fastapi-app/
├── app/
│   ├── __init__.py
│   ├── main.py              # 应用入口
│   ├── config.py            # 配置管理
│   ├── database.py          # 数据库配置
│   ├── models/              # SQLAlchemy 模型
│   │   ├── __init__.py
│   │   ├── user.py
│   │   └── post.py
│   ├── schemas/             # Pydantic 模型
│   │   ├── __init__.py
│   │   ├── user.py
│   │   └── post.py
│   ├── api/                 # API 路由
│   │   ├── __init__.py
│   │   ├── deps.py          # 依赖注入
│   │   ├── users.py
│   │   └── posts.py
│   ├── services/            # 业务逻辑
│   │   ├── __init__.py
│   │   └── user_service.py
│   └── repositories/        # 数据访问
│       ├── __init__.py
│       └── user_repo.py
├── tests/                   # 测试
│   ├── __init__.py
│   ├── test_users.py
│   └── test_posts.py
├── alembic/                 # 数据库迁移
├── requirements.txt
└── README.md
```

## 总结

| 特性 | 优势 | 适用场景 |
|------|------|----------|
| 高性能 | 异步处理，高并发 | API 服务 |
| 类型安全 | 自动验证 | 数据密集型应用 |
| 自动文档 | 降低沟通成本 | 团队协作 |
| 依赖注入 | 代码复用 | 复杂业务逻辑 |

**姐姐的建议**：

1. **从简单开始**：先实现核心功能，再优化
2. **善用类型提示**：这是 FastAPI 的最大优势
3. **异步优先**：能异步就异步
4. **测试先行**：FastAPI 的测试支持很好
5. **关注文档**：自动生成的文档是很好的沟通工具

FastAPI 是目前 Python Web 框架的最佳选择之一，特别适合构建高性能 API 服务。希望这篇指南能帮助宝宝们快速上手 FastAPI。
