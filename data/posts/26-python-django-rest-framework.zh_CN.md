---
title: "Python Django REST Framework：快速构建后端 API"
tag: python
description: Django REST Framework 是构建 RESTful API 的利器，从模型定义到序列化器，快速掌握后端 API 开发的核心流程。
date: "2022-07-20T08:00:00.000Z"
---

## 目标

使用 Django REST Framework 快速构建一个完整的 RESTful API 服务。

## 背景

### 为什么选择 Django + DRF？

| 特性 | Django | Flask |
|------|--------|-------|
| ORM | 内置，功能强大 | 需要 SQLAlchemy |
| Admin | 内置管理后台 | 需要自己做 |
| 认证 | 内置用户系统 | 需要自己做 |
| API 支持 | DRF 提供完整方案 | 需要 Flask-RESTful |

DRF 在 Django 的基础上，提供了构建 REST API 所需的一切。

## 项目初始化

### 1. 安装依赖

```bash
# 创建虚拟环境
python -m venv venv
source venv/bin/activate

# 安装 Django 和 DRF
pip install django djangorestframework

# 创建项目
django-admin startproject myproject
cd myproject

# 创建应用
python manage.py startapp api
```

### 2. 配置

```python
# myproject/settings.py
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # 第三方应用
    'rest_framework',
    # 本地应用
    'api',
]

# DRF 配置
REST_FRAMEWORK = {
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 10,
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.SessionAuthentication',
        'rest_framework.authentication.TokenAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
}
```

## 模型设计

```python
# api/models.py
from django.db import models
from django.contrib.auth.models import User

class Category(models.Model):
    name = models.CharField(max_length=100, unique=True)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name_plural = 'categories'
        ordering = ['name']

    def __str__(self):
        return self.name


class Article(models.Model):
    STATUS_CHOICES = [
        ('draft', '草稿'),
        ('published', '已发布'),
    ]

    title = models.CharField(max_length=200)
    slug = models.SlugField(max_length=200, unique=True)
    content = models.TextField()
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name='articles')
    category = models.ForeignKey(Category, on_delete=models.SET_NULL, null=True, related_name='articles')
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='draft')
    tags = models.ManyToManyField('Tag', blank=True, related_name='articles')
    views_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.title


class Tag(models.Model):
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name
```

## 序列化器

```python
# api/serializers.py
from rest_framework import serializers
from django.contrib.auth.models import User
from .models import Article, Category, Tag


class UserSerializer(serializers.ModelSerializer):
    article_count = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ['id', 'username', 'email', 'article_count']

    def get_article_count(self, obj):
        return obj.articles.count()


class TagSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tag
        fields = ['id', 'name']


class CategorySerializer(serializers.ModelSerializer):
    article_count = serializers.SerializerMethodField()

    class Meta:
        model = Category
        fields = ['id', 'name', 'description', 'article_count', 'created_at']

    def get_article_count(self, obj):
        return obj.articles.filter(status='published').count()


class ArticleListSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    category = CategorySerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    class Meta:
        model = Article
        fields = [
            'id', 'title', 'slug', 'author', 'category',
            'tags', 'status', 'views_count', 'created_at'
        ]


class ArticleDetailSerializer(serializers.ModelSerializer):
    author = UserSerializer(read_only=True)
    category = CategorySerializer(read_only=True)
    tags = TagSerializer(many=True, read_only=True)

    class Meta:
        model = Article
        fields = [
            'id', 'title', 'slug', 'content', 'author',
            'category', 'tags', 'status', 'views_count',
            'created_at', 'updated_at'
        ]


class ArticleCreateUpdateSerializer(serializers.ModelSerializer):
    tags = serializers.PrimaryKeyRelatedField(
        many=True, queryset=Tag.objects.all(), required=False
    )

    class Meta:
        model = Article
        fields = ['title', 'slug', 'content', 'category', 'tags', 'status']

    def validate_title(self, value):
        if len(value) < 5:
            raise serializers.ValidationError('标题至少需要 5 个字符')
        return value
```

## 视图

### 1. 使用 ModelViewSet

```python
# api/views.py
from rest_framework import viewsets, filters, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAuthenticatedOrReadOnly
from django_filters.rest_framework import DjangoFilterBackend
from .models import Article, Category, Tag
from .serializers import (
    ArticleListSerializer,
    ArticleDetailSerializer,
    ArticleCreateUpdateSerializer,
    CategorySerializer,
    TagSerializer,
)


class ArticleViewSet(viewsets.ModelViewSet):
    queryset = Article.objects.all()
    permission_classes = [IsAuthenticatedOrReadOnly]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['status', 'category', 'author']
    search_fields = ['title', 'content']
    ordering_fields = ['created_at', 'views_count']

    def get_serializer_class(self):
        if self.action == 'list':
            return ArticleListSerializer
        elif self.action in ['create', 'update', 'partial_update']:
            return ArticleCreateUpdateSerializer
        return ArticleDetailSerializer

    def perform_create(self, serializer):
        serializer.save(author=self.request.user)

    @action(detail=False, methods=['get'])
    def my_articles(self, request):
        articles = self.queryset.filter(author=request.user)
        serializer = ArticleListSerializer(articles, many=True)
        return Response(serializer.data)

    @action(detail=True, methods=['post'])
    def publish(self, request, pk=None):
        article = self.get_object()
        if article.author != request.user:
            return Response(
                {'error': '你没有权限发布这篇文章'},
                status=status.HTTP_403_FORBIDDEN
            )
        article.status = 'published'
        article.save()
        return Response({'message': '发布成功'})


class CategoryViewSet(viewsets.ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer
    permission_classes = [IsAuthenticatedOrReadOnly]


class TagViewSet(viewsets.ModelViewSet):
    queryset = Tag.objects.all()
    serializer_class = TagSerializer
    permission_classes = [IsAuthenticatedOrReadOnly]
```

### 2. 函数视图（简单场景）

```python
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from django.db.models import Count

@api_view(['GET'])
@permission_classes([AllowAny])
def article_stats(request):
    """文章统计"""
    stats = {
        'total_articles': Article.objects.count(),
        'published_articles': Article.objects.filter(status='published').count(),
        'categories': Category.objects.annotate(
            article_count=Count('articles')
        ).values('name', 'article_count'),
    }
    return Response(stats)
```

## URL 配置

```python
# api/urls.py
from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views

router = DefaultRouter()
router.register(r'articles', views.ArticleViewSet)
router.register(r'categories', views.CategoryViewSet)
router.register(r'tags', views.TagViewSet)

urlpatterns = [
    path('', include(router.urls)),
    path('stats/', views.article_stats, name='article-stats'),
]
```

```python
# myproject/urls.py
from django.contrib import admin
from django.urls import path, include
from rest_framework.authtoken.views import obtain_auth_token

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('api.urls')),
    path('api-auth/', include('rest_framework.urls')),
    path('api/token/', obtain_auth_token, name='api-token'),
]
```

## 认证和权限

```python
# api/permissions.py
from rest_framework import permissions

class IsAuthorOrReadOnly(permissions.BasePermission):
    """只有作者可以修改，其他人只读"""

    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.author == request.user


class IsAdminOrReadOnly(permissions.BasePermission):
    """管理员可以修改，其他人只读"""

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return request.user and request.user.is_staff
```

## 过滤和搜索

```python
# api/filters.py
import django_filters
from .models import Article

class ArticleFilter(django_filters.FilterSet):
    created_after = django_filters.DateFilter(field_name='created_at', lookup_expr='gte')
    created_before = django_filters.DateFilter(field_name='created_at', lookup_expr='lte')

    class Meta:
        model = Article
        fields = ['status', 'category', 'author']
```

## 序列化器验证

```python
# 自定义验证
class ArticleCreateUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Article
        fields = ['title', 'slug', 'content', 'category', 'tags', 'status']

    def validate_title(self, value):
        """验证标题"""
        if len(value) < 5:
            raise serializers.ValidationError('标题至少需要 5 个字符')
        return value

    def validate(self, data):
        """验证整体数据"""
        if data.get('status') == 'published' and not data.get('content'):
            raise serializers.ValidationError('发布文章必须有内容')
        return data

    def create(self, validated_data):
        """创建文章"""
        tags = validated_data.pop('tags', [])
        article = Article.objects.create(**validated_data)
        article.tags.set(tags)
        return article
```

## 测试

```python
# api/tests.py
from rest_framework.test import APITestCase
from rest_framework import status
from django.contrib.auth.models import User
from .models import Article, Category

class ArticleAPITest(APITestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='testuser',
            password='testpass123'
        )
        self.category = Category.objects.create(name='技术')
        self.article = Article.objects.create(
            title='测试文章',
            slug='test-article',
            content='测试内容',
            author=self.user,
            category=self.category
        )

    def test_list_articles(self):
        response = self.client.get('/api/articles/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_create_article(self):
        self.client.force_authenticate(user=self.user)
        data = {
            'title': '新文章',
            'slug': 'new-article',
            'content': '新内容',
            'category': self.category.id
        }
        response = self.client.post('/api/articles/', data)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_unauthorized_create(self):
        data = {
            'title': '新文章',
            'slug': 'new-article',
            'content': '新内容'
        }
        response = self.client.post('/api/articles/', data)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
```

## 部署

```bash
# 使用 Gunicorn
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:8000 myproject.wsgi

# Docker
FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:8000", "myproject.wsgi"]
```

## 总结

1. **DRF 提供了完整的 API 开发方案**：序列化器、视图、路由、认证
2. **ModelViewSet 是最常用的方式**：自动生成 CRUD 接口
3. **序列化器负责数据转换**：验证、转换、嵌套
4. **权限控制很重要**：保护敏感接口
5. **测试是必须的**：APITestCase 提供了便捷的测试工具

Django + DRF 是构建 RESTful API 的高效组合，特别适合需要快速开发的项目。
