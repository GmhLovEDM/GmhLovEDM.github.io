---
title: "Flutter Layout Practice: Correct Usage of Row, Column, and Stack"
tag: flutter
description: Deep dive into Flutter's three core layout components Row, Column, and Stack, their core properties and practical usage, mastering techniques for building flexible responsive UIs.
date: "2024-03-10T08:00:00.000Z"
---

## Goal

Flutter's layout system is based on Widget composition. Understanding Row, Column, and Stack is fundamental to building UIs. This article deeply explains these three components' core properties, common layout scenarios, and practical techniques to help developers flexibly build various complex UI layouts.

## Background

### Flutter Layout Model

Flutter uses a box model for layout, where each Widget occupies a rectangular area:

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

### Layout Component Categories

- **Row/Column**: Linear layout (horizontal/vertical)
- **Flex**: Flexible layout (parent of Row/Column)
- **Stack**: Stacking layout
- **Wrap**: Flow layout
- **GridView**: Grid layout

## Row Horizontal Layout

### Basic Usage

```dart
Row(
  children: [
    Icon(Icons.star),
    Icon(Icons.star),
    Icon(Icons.star),
  ],
)
```

### MainAxisAlignment (Main Axis Alignment)

```dart
Row(
  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
  children: [
    Icon(Icons.star),
    Icon(Icons.star),
    Icon(Icons.star),
  ],
)

// MainAxisAlignment enum values
// start: Left-aligned
// end: Right-aligned
// center: Centered
// spaceBetween: Space between, evenly distributed
// spaceAround: Space around each element
// spaceEvenly: All spaces equal
```

### CrossAxisAlignment (Cross Axis Alignment)

```dart
Row(
  crossAxisAlignment: CrossAxisAlignment.center,
  children: [
    Icon(Icons.star, size: 32),
    Icon(Icons.star, size: 16),
    Icon(Icons.star, size: 24),
  ],
)

// CrossAxisAlignment enum values
// start: Top-aligned
// end: Bottom-aligned
// center: Centered
// stretch: Stretch to fill
// baseline: Baseline aligned
```

### Practice: Navigation Bar

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
          // Left: Back button
          IconButton(
            icon: Icon(Icons.arrow_back),
            onPressed: () => Navigator.pop(context),
          ),

          // Center: Title
          Text(
            title,
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.bold,
            ),
          ),

          // Right: Action buttons
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

## Column Vertical Layout

### Basic Usage

```dart
Column(
  children: [
    Text('Title'),
    Text('Content'),
    Text('Footer'),
  ],
)
```

### Practice: Profile Card

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
          // Avatar
          CircleAvatar(
            radius: 40,
            backgroundImage: NetworkImage(avatar),
          ),
          SizedBox(height: 12),

          // Name
          Text(
            name,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.bold,
            ),
          ),
          SizedBox(height: 8),

          // Bio
          Text(
            bio,
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.grey),
          ),
          SizedBox(height: 16),

          // Action buttons
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _buildButton(Icons.message, 'Message'),
              _buildButton(Icons.person_add, 'Follow'),
              _buildButton(Icons.share, 'Share'),
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

## Stack Stacking Layout

### Basic Usage

```dart
Stack(
  children: [
    // Bottom layer: Background image
    Image.network('https://example.com/bg.jpg'),

    // Middle layer: Semi-transparent overlay
    Container(color: Colors.black54),

    // Top layer: Text content
    Center(
      child: Text(
        'Title',
        style: TextStyle(color: Colors.white, fontSize: 24),
      ),
    ),
  ],
)
```

### Positioned Precise Positioning

```dart
Stack(
  children: [
    // Background
    Container(
      width: 200,
      height: 200,
      color: Colors.blue,
    ),

    // Top-left corner
    Positioned(
      top: 10,
      left: 10,
      child: Icon(Icons.star, color: Colors.yellow),
    ),

    // Bottom-right corner
    Positioned(
      bottom: 10,
      right: 10,
      child: Icon(Icons.favorite, color: Colors.red),
    ),

    // Center
    Positioned(
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      child: Center(
        child: Text('Center', style: TextStyle(color: Colors.white)),
      ),
    ),
  ],
)
```

### Practice: Product Card

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
        // Card body
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
              // Product image
              ClipRRect(
                borderRadius: BorderRadius.vertical(top: Radius.circular(12)),
                child: Image.network(
                  imageUrl,
                  height: 150,
                  width: double.infinity,
                  fit: BoxFit.cover,
                ),
              ),

              // Product info
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

        // New product label
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
                'New',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 12,
                ),
              ),
            ),
          ),

        // Shopping cart button
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

## Combined Layouts

### Practice: Chat Interface

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
          // Other person's avatar
          if (!isMe) ...[
            CircleAvatar(
              radius: 16,
              backgroundImage: NetworkImage(avatar),
            ),
            SizedBox(width: 8),
          ],

          // Message content
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

          // My avatar
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

### Practice: Tab Layout

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
        title: Text('Tab Layout'),
        bottom: TabBar(
          controller: _tabController,
          tabs: [
            Tab(icon: Icon(Icons.home), text: 'Home'),
            Tab(icon: Icon(Icons.search), text: 'Search'),
            Tab(icon: Icon(Icons.person), text: 'Profile'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          Center(child: Text('Home content')),
          Center(child: Text('Search content')),
          Center(child: Text('Profile content')),
        ],
      ),
    );
  }
}
```

## Responsive Layout

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

// Usage
ResponsiveLayout(
  mobile: Column(children: [...]),
  tablet: Row(children: [...]),
  desktop: Row(children: [...]),
)
```

## Conclusion

Flutter's layout system is flexible and powerful. Key takeaways:

1. **Row/Column**: Foundation of linear layout, master main axis and cross axis alignment
2. **Stack**: Stacking layout, suitable for UI scenarios requiring overlap
3. **Combined usage**: Complex UIs are composed of simple layout components
4. **Responsive design**: Use LayoutBuilder to adapt to different screen sizes

Once you master these three core layout components, you can build the vast majority of UI layouts. Remember Flutter's core philosophy: everything is a Widget, build complex UIs by composing small Widgets.
