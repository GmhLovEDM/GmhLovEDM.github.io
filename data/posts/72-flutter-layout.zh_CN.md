---
title: "Flutter 布局实战：Row、Column、Stack 的正确用法"
tag: flutter
description: 深入 Flutter 三大布局组件 Row、Column、Stack 的核心属性和实战用法，掌握灵活构建响应式 UI 的技巧。
date: "2024-03-10T08:00:00.000Z"
---

## 目标

Flutter 的布局系统基于 Widget 组合，理解 Row、Column、Stack 三大布局组件是构建 UI 的基础。本文深入讲解这三个组件的核心属性、常见布局场景和实战技巧，帮助开发者灵活构建各种复杂的 UI 布局。

## 背景

### Flutter 布局模型

Flutter 使用盒模型布局，每个 Widget 占据一个矩形区域：

```
┌─────────────────────────────────┐
│           Parent Widget         │
│  ┌──────────┐  ┌──────────┐    │
│  │  Child 1  │  │  Child 2  │   │
│  └──────────┘  └──────────┘    │
│  ┌──────────────────────────┐  │
│  │         Child 3          │  │
│  └──────────────────────────┘  │
└─────────────────────────────────┘
```

### 布局组件分类

- **Row/Column**：线性布局（水平/垂直）
- **Flex**：弹性布局（Row/Column 的父类）
- **Stack**：堆叠布局
- **Wrap**：流式布局
- **GridView**：网格布局

## Row 水平布局

### 基本用法

```dart
Row(
  children: [
    Icon(Icons.star),
    Icon(Icons.star),
    Icon(Icons.star),
  ],
)
```

### MainAxisAlignment（主轴对齐）

```dart
Row(
  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
  children: [
    Icon(Icons.star),
    Icon(Icons.star),
    Icon(Icons.star),
  ],
)

// MainAxisAlignment 枚举值
// start: 靠左对齐
// end: 靠右对齐
// center: 居中对齐
// spaceBetween: 两端对齐，中间均匀分布
// spaceAround: 每个元素两侧都有间距
// spaceEvenly: 所有间距相等
```

### CrossAxisAlignment（交叉轴对齐）

```dart
Row(
  crossAxisAlignment: CrossAxisAlignment.center,
  children: [
    Icon(Icons.star, size: 32),
    Icon(Icons.star, size: 16),
    Icon(Icons.star, size: 24),
  ],
)

// CrossAxisAlignment 枚举值
// start: 顶部对齐
// end: 底部对齐
// center: 居中对齐
// stretch: 拉伸填满
// baseline: 基线对齐
```

### 实战：导航栏

```dart
class NavBar extends StatelessWidget {
  final String title;

  const NavBar({super.key, required this.title});

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 56,
      padding: EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        boxShadow: [
          BoxShadow(
            color: Colors.black12,
            blurRadius: 4,
          ),
        ],
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          // 左侧：返回按钮
          IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () => Navigator.pop(context),
          ),

          // 中间：标题
          Text(
            title,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),

          // 右侧：操作按钮
          Row(
            children: [
              IconButton(
                icon: Icon(Icons.search),
                onPressed: () {},
              ),
              IconButton(
                icon: Icon(Icons.more_vert),
                onPressed: () {},
              ),
            ],
          ),
        ],
      ),
    );
  }
}
```

## Column 垂直布局

### 基本用法

```dart
Column(
  children: [
    Text('标题'),
    Text('内容'),
    Text('底部'),
  ],
)
```

### 实战：个人资料卡

```dart
class ProfileCard extends StatelessWidget {
  final String name;
  final String avatar;
  final String bio;

  const ProfileCard({
    super.key,
    required this.name,
    required this.avatar,
    required this.bio,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        boxShadow: [
          BoxShadow(
            color: Colors.black12,
            blurRadius: 8,
          ),
        ],
      ),
      child: Column(
        children: [
          // 头像
          CircleAvatar(
            radius: 40,
            backgroundImage: NetworkImage(avatar),
          ),
          SizedBox(height: 12),

          // 名字
          Text(
            name,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
            ),
          ),
          SizedBox(height: 8),

          // 简介
          Text(
            bio,
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.grey),
          ),
          SizedBox(height: 16),

          // 操作按钮
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _buildButton(Icons.message, '消息'),
              _buildButton(Icons.person_add, '关注'),
              _buildButton(Icons.share, '分享'),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildButton(IconData icon, String label) {
    return Column(
      children: [
        Icon(icon, color: Colors.blue),
        SizedBox(height: 4),
        Text(label, style: TextStyle(color: Colors.blue)),
      ],
    );
  }
}
```

## Stack 堆叠布局

### 基本用法

```dart
Stack(
  children: [
    // 底层：背景图片
    Image.network('https://example.com/bg.jpg'),

    // 中层：半透明遮罩
    Container(color: Colors.black54),

    // 顶层：文字内容
    Center(
      child: Text(
        '标题',
        style: TextStyle(color: Colors.white, fontSize: 24),
      ),
    ),
  ],
)
```

### Positioned 精确定位

```dart
Stack(
  children: [
    // 背景
    Container(
      width: 200,
      height: 200,
      color: Colors.blue,
    ),

    // 左上角
    Positioned(
      top: 10,
      left: 10,
      child: Icon(Icons.star, color: Colors.yellow),
    ),

    // 右下角
    Positioned(
      bottom: 10,
      right: 10,
      child: Icon(Icons.favorite, color: Colors.red),
    ),

    // 居中
    Positioned(
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      child: Center(
        child: Text('居中', style: TextStyle(color: Colors.white)),
      ),
    ),
  ],
)
```

### 实战：产品卡片

```dart
class ProductCard extends StatelessWidget {
  final String imageUrl;
  final String name;
  final double price;
  final double? originalPrice;
  final bool isNew;

  const ProductCard({
    super.key,
    required this.imageUrl,
    required this.name,
    required this.price,
    this.originalPrice,
    this.isNew = false,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // 卡片主体
        Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            boxShadow: [
              BoxShadow(
                color: Colors.black12,
                blurRadius: 8,
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 商品图片
              ClipRRect(
                borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
                child: Image.network(
                  imageUrl,
                  height: 150,
                  width: double.infinity,
                  fit: BoxFit.cover,
                ),
              ),

              // 商品信息
              Padding(
                padding: EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    SizedBox(height: 8),
                    Row(
                      children: [
                        Text(
                          '\$${price.toStringAsFixed(2)}',
                          style: TextStyle(
                            color: Colors.red,
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        if (originalPrice != null) ...[
                          SizedBox(width: 8),
                          Text(
                            '\$${originalPrice!.toStringAsFixed(2)}',
                            style: TextStyle(
                              color: Colors.grey,
                              decoration: TextDecoration.lineThrough,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),

        // 新品标签
        if (isNew)
          Positioned(
            top: 8,
            left: 8,
            child: Container(
              padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: Colors.orange,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                '新品',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 12,
                ),
              ),
            ),
          ),

        // 购物车按钮
        Positioned(
          bottom: 70,
          right: 8,
          child: Container(
            decoration: BoxDecoration(
              color: Colors.blue,
              shape: BoxShape.circle,
            ),
            child: IconButton(
              icon: Icon(Icons.add_shopping_cart, color: Colors.white, size: 20),
              onPressed: () {},
            ),
          ),
        ),
      ],
    );
  }
}
```

## 组合布局

### 实战：聊天界面

```dart
class ChatBubble extends StatelessWidget {
  final String message;
  final bool isMe;
  final String avatar;
  final DateTime time;

  const ChatBubble({
    super.key,
    required this.message,
    required this.isMe,
    required this.avatar,
    required this.time,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Row(
        mainAxisAlignment: isMe ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          // 对方头像
          if (!isMe) ...[
            CircleAvatar(
              radius: 16,
              backgroundImage: NetworkImage(avatar),
            ),
            SizedBox(width: 8),
          ],

          // 消息内容
          Flexible(
            child: Container(
              padding: EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: isMe ? Colors.blue : Colors.grey[200],
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(16),
                  topRight: Radius.circular(16),
                  bottomLeft: isMe ? Radius.circular(16) : Radius.circular(4),
                  bottomRight: isMe ? Radius.circular(4) : Radius.circular(16),
                ),
              ),
              child: Text(
                message,
                style: TextStyle(
                  color: isMe ? Colors.white : Colors.black,
                ),
              ),
            ),
          ),

          // 我的头像
          if (isMe) ...[
            SizedBox(width: 8),
            CircleAvatar(
              radius: 16,
              backgroundImage: NetworkImage(avatar),
            ),
          ],
        ],
      ),
    );
  }
}
```

### 实战：Tab 布局

```dart
class TabBarDemo extends StatefulWidget {
  const TabBarDemo({super.key});

  @override
  State<TabBarDemo> createState() => _TabBarDemoState();
}

class _TabBarDemoState extends State<TabBarDemo>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Tab 布局'),
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(icon: Icon(Icons.home), text: '首页'),
            Tab(icon: Icon(Icons.search), text: '搜索'),
            Tab(icon: Icon(Icons.person), text: '我的'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          Center(child: Text('首页内容')),
          Center(child: Text('搜索内容')),
          Center(child: Text('我的内容')),
        ],
      ),
    );
  }
}
```

## 响应式布局

### LayoutBuilder

```dart
class ResponsiveLayout extends StatelessWidget {
  final Widget mobile;
  final Widget tablet;
  final Widget desktop;

  const ResponsiveLayout({
    super.key,
    required this.mobile,
    required this.tablet,
    required this.desktop,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 600) {
          return mobile;
        } else if (constraints.maxWidth < 1200) {
          return tablet;
        } else {
          return desktop;
        }
      },
    );
  }
}

// 使用
ResponsiveLayout(
  mobile: Column(children: [...]),
  tablet: Row(children: [...]),
  desktop: Row(children: [...]),
)
```

## 总结

Flutter 的布局系统灵活而强大，关键要点：

1. **Row/Column**：线性布局的基础，掌握主轴和交叉轴对齐
2. **Stack**：堆叠布局，适合需要重叠的 UI 场景
3. **组合使用**：复杂的 UI 由简单的布局组件组合而成
4. **响应式设计**：使用 LayoutBuilder 适配不同屏幕尺寸

掌握了这三个核心布局组件，就能构建出绝大多数的 UI 布局。记住 Flutter 的核心理念：一切皆 Widget，通过组合小 Widget 构建复杂 UI。
