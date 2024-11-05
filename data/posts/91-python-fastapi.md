---
title: "Python FastAPI in Practice: High-Performance Async API Development"
tag: python
description: A comprehensive introduction to the FastAPI framework covering async programming, data validation, dependency injection, and performance optimization for building production-grade API services.
date: "2024-11-05T08:00:00.000Z"
---

## Goal

This article aims to help Python developers master the core features and best practices of the FastAPI framework, understand the async programming model, and build high-performance, maintainable REST API services.

## Background

FastAPI is a modern, fast Python web framework built on standard Python type hints for API development. It combines Flask's simplicity with Django's features, while providing automatic documentation generation and data validation.

### Why Choose FastAPI?

1. **High Performance**: Built on Starlette and Pydantic, performance comparable to Node.js and Go
2. **Development Efficiency**: Type hint driven, automatic documentation generation
3. **Async Support**: Native support for async/await
4. **Data Validation**: Automatic request/response validation
5. **Type Safety**: Complete type hint support

### Comparison with Other Frameworks

| Feature | FastAPI | Flask | Django |
|---------|---------|-------|--------|
| Performance | Extremely high | Medium | Medium |
| Async | Native support | Requires extensions | Supported since 3.1+ |
| Auto Documentation | Built-in | Requires extensions | Requires extensions |
| Data Validation | Built-in | Requires extensions | Requires extensions |
| Learning Curve | Low | Low | Medium |

## 1. Environment Setup

### Install Dependencies

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Linux/Mac
# venv\Scripts\activate  # Windows

# Install FastAPI
pip install fastapi uvicorn

# Install additional dependencies
pip install sqlalchemy asyncpg pydantic python-jose passlib bcrypt
```

### First FastAPI Application

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

# Run: uvicorn main:app --reload
```

## 2. Path Parameters and Query Parameters

### Path Parameters

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

# Basic path parameter
@app.get("/users/{user_id}")
async def get_user(user_id: int):
    return {"user_id": user_id}

# Multiple path parameters
@app.get("/users/{user_id}/posts/{post_id}")
async def get_user_post(user_id: int, post_id: int):
    return {"user_id": user_id, "post_id": post_id}
```

### Query Parameters

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

### Request Body

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
    # Create user logic
    return {"id": 1, **user.dict(), "created_at": datetime.now()}
```

## 3. Data Models and Validation

### Pydantic Models

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

### Response Models

```python
from typing import List

@app.post("/users/", response_model=UserResponse, status_code=201)
async def create_user(user: UserCreate):
    # Create user
    pass

@app.get("/users/", response_model=List[UserResponse])
async def list_users(skip: int = 0, limit: int = 10):
    # Get user list
    pass

@app.get("/users/{user_id}", response_model=UserResponse)
async def get_user(user_id: int):
    # Get single user
    pass
```

## 4. Database Operations

### SQLAlchemy Configuration

```python
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

# Database connection
DATABASE_URL = "postgresql+asyncpg://user:password@localhost/dbname"

engine = create_async_engine(DATABASE_URL, echo=True)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

# Dependency injection
async def get_db():
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
```

### Data Models

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

### CRUD Operations

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

## 5. Dependency Injection

### Basic Dependencies

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT configuration
SECRET_KEY = "your-secret-key"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

# Dependency injection function
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

# Use dependency
@app.get("/users/me/", response_model=UserResponse)
async def read_users_me(current_user: UserModel = Depends(get_current_user)):
    return current_user
```

### Permission Control

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

# Usage
@app.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    current_user: UserModel = require_role([UserRole.admin])
):
    # Only admins can delete users
    pass
```

## 6. Middleware and Exception Handling

### Middleware

```python
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
import time

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request timing middleware
@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response
```

### Exception Handling

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

# Usage
@app.get("/users/{user_id}")
async def get_user(user_id: int, db: AsyncSession = Depends(get_db)):
    user_repo = UserRepository(db)
    user = await user_repo.get_user(user_id)
    if not user:
        raise AppException(status_code=404, detail="User not found")
    return user
```

## 7. Performance Optimization

### Async Operations

```python
# Good practice: async database operations
async def get_users(db: AsyncSession):
    result = await db.execute(select(UserModel))
    return result.scalars().all()

# Bad practice: sync database operations
def get_users_sync(db: Session):
    return db.query(UserModel).all()
```

### Caching

```python
from functools import lru_cache
import redis.asyncio as redis

# Redis caching
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)

async def get_user_cached(user_id: int):
    # Get from cache
    cached = await redis_client.get(f"user:{user_id}")
    if cached:
        return json.loads(cached)
    
    # Get from database
    async with async_session() as db:
        user_repo = UserRepository(db)
        user = await user_repo.get_user(user_id)
        if user:
            # Write to cache
            await redis_client.setex(
                f"user:{user_id}",
                300,
                json.dumps(UserResponse.from_orm(user).dict())
            )
        return user
```

### Pagination

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

## 8. Testing

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
    # Create user first
    create_response = client.post(
        "/users/",
        json={
            "name": "testuser",
            "email": "test@example.com",
            "password": "password123"
        }
    )
    user_id = create_response.json()["id"]
    
    # Get user
    response = client.get(f"/users/{user_id}")
    assert response.status_code == 200
    assert response.json()["name"] == "testuser"
```

## 9. Project Structure

```
my-fastapi-app/
├── app/
│   ├── __init__.py
│   ├── main.py              # Application entry
│   ├── config.py            # Configuration management
│   ├── database.py          # Database configuration
│   ├── models/              # SQLAlchemy models
│   │   ├── __init__.py
│   │   ├── user.py
│   │   └── post.py
│   ├── schemas/             # Pydantic models
│   │   ├── __init__.py
│   │   ├── user.py
│   │   └── post.py
│   ├── api/                 # API routes
│   │   ├── __init__.py
│   │   ├── deps.py          # Dependency injection
│   │   ├── users.py
│   │   └── posts.py
│   ├── services/            # Business logic
│   │   ├── __init__.py
│   │   └── user_service.py
│   └── repositories/        # Data access
│       ├── __init__.py
│       └── user_repo.py
├── tests/                   # Tests
│   ├── __init__.py
│   ├── test_users.py
│   └── test_posts.py
├── alembic/                 # Database migrations
├── requirements.txt
└── README.md
```

## Summary

| Feature | Advantage | Use Case |
|---------|-----------|----------|
| High Performance | Async processing, high concurrency | API services |
| Type Safety | Automatic validation | Data-intensive applications |
| Auto Documentation | Reduced communication costs | Team collaboration |
| Dependency Injection | Code reuse | Complex business logic |

**Recommendations**:

1. **Start Simple**: Implement core features first, then optimize
2. **Leverage Type Hints**: This is FastAPI's greatest advantage
3. **Async First**: Use async whenever possible
4. **Test First**: FastAPI has excellent test support
5. **Watch Documentation**: Auto-generated documentation is a great communication tool

FastAPI is one of the best choices for Python web frameworks, especially for building high-performance API services. This guide will help you get started quickly.
