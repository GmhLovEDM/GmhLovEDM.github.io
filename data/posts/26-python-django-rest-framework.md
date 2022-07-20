---
title: "Python Django REST Framework: Quickly Build Backend APIs"
tag: python
description: Django REST Framework is a powerful tool for building RESTful APIs. From model definitions to serializers, quickly master the core workflow of backend API development.
date: "2022-07-20T08:00:00.000Z"
---

## Goal

Use Django REST Framework to quickly build a complete RESTful API service.

## Background

### Why Choose Django + DRF?

| Feature | Django | Flask |
|---------|--------|-------|
| ORM | Built-in, powerful | Requires SQLAlchemy |
| Admin | Built-in admin panel | Need to build yourself |
| Authentication | Built-in user system | Need to build yourself |
| API support | DRF provides complete solution | Requires Flask-RESTful |

DRF provides everything needed to build REST APIs on top of Django.

## Project Initialization

### 1. Install Dependencies

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install Django and DRF
pip install django djangorestframework

# Create project
django-admin startproject myproject
cd myproject

# Create app
python manage.py startapp api
```

### 2. Configuration

```python
# myproject/settings.py
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Third-party apps
    'rest_framework',
    # Local apps
    'api',
]

# DRF configuration
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

## Model Design

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
        ('draft', 'Draft'),
        ('published', 'Published'),
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

## Serializers

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
            raise serializers.ValidationError('Title must be at least 5 characters')
        return value
```

## Views

### 1. Using ModelViewSet

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
                {'error': 'You do not have permission to publish this article'},
                status=status.HTTP_403_FORBIDDEN
            )
        article.status = 'published'
        article.save()
        return Response({'message': 'Published successfully'})


class CategoryViewSet(viewsets.ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer
    permission_classes = [IsAuthenticatedOrReadOnly]


class TagViewSet(viewsets.ModelViewSet):
    queryset = Tag.objects.all()
    serializer_class = TagSerializer
    permission_classes = [IsAuthenticatedOrReadOnly]
```

### 2. Function-based Views (Simple Scenarios)

```python
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from django.db.models import Count

@api_view(['GET'])
@permission_classes([AllowAny])
def article_stats(request):
    """Article statistics"""
    stats = {
        'total_articles': Article.objects.count(),
        'published_articles': Article.objects.filter(status='published').count(),
        'categories': Category.objects.annotate(
            article_count=Count('articles')
        ).values('name', 'article_count'),
    }
    return Response(stats)
```

## URL Configuration

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

## Authentication and Permissions

```python
# api/permissions.py
from rest_framework import permissions

class IsAuthorOrReadOnly(permissions.BasePermission):
    """Only the author can modify, others read-only"""

    def has_object_permission(self, request, view, obj):
        if request.method in permissions.SAFE_METHODS:
            return True
        return obj.author == request.user


class IsAdminOrReadOnly(permissions.BasePermission):
    """Admin can modify, others read-only"""

    def has_permission(self, request, view):
        if request.method in permissions.SAFE_METHODS:
            return True
        return request.user and request.user.is_staff
```

## Filtering and Search

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

## Serializer Validation

```python
# Custom validation
class ArticleCreateUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Article
        fields = ['title', 'slug', 'content', 'category', 'tags', 'status']

    def validate_title(self, value):
        """Validate title"""
        if len(value) < 5:
            raise serializers.ValidationError('Title must be at least 5 characters')
        return value

    def validate(self, data):
        """Validate overall data"""
        if data.get('status') == 'published' and not data.get('content'):
            raise serializers.ValidationError('Published articles must have content')
        return data

    def create(self, validated_data):
        """Create article"""
        tags = validated_data.pop('tags', [])
        article = Article.objects.create(**validated_data)
        article.tags.set(tags)
        return article
```

## Testing

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
        self.category = Category.objects.create(name='Technology')
        self.article = Article.objects.create(
            title='Test Article',
            slug='test-article',
            content='Test content',
            author=self.user,
            category=self.category
        )

    def test_list_articles(self):
        response = self.client.get('/api/articles/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_create_article(self):
        self.client.force_authenticate(user=self.user)
        data = {
            'title': 'New Article',
            'slug': 'new-article',
            'content': 'New content',
            'category': self.category.id
        }
        response = self.client.post('/api/articles/', data)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_unauthorized_create(self):
        data = {
            'title': 'New Article',
            'slug': 'new-article',
            'content': 'New content'
        }
        response = self.client.post('/api/articles/', data)
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
```

## Deployment

```bash
# Using Gunicorn
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

## Summary

1. **DRF provides complete API development solutions**: Serializers, views, routing, authentication
2. **ModelViewSet is the most common approach**: Auto-generates CRUD interfaces
3. **Serializers handle data transformation**: Validation, transformation, nesting
4. **Permission control is important**: Protect sensitive endpoints
5. **Testing is essential**: APITestCase provides convenient testing tools

Django + DRF is an efficient combination for building RESTful APIs, especially suitable for projects requiring rapid development.
