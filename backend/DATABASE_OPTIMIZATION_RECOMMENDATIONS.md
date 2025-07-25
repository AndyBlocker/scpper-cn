# 数据库优化建议 - 支持Tag和Coauthor查询

## 当前数据库设计评估

### ✅ 已实现的功能

1. **页面删除状态管理** ✅
   ```sql
   -- 已有字段
   isDeleted      Boolean  @default(false)
   deletedAt      DateTime?
   deletionReason String?
   
   -- 已有索引
   @@index([isDeleted])
   @@index([deletedAt])
   ```

2. **页面版本管理** ✅
   ```sql
   -- PageHistory表已实现
   model PageHistory {
     versionNumber   Int      // 版本号
     capturedAt      DateTime // 记录时间
     changeType      String   // 'created', 'updated', 'deleted'
     
     -- 完整的页面状态快照
     title           String?
     rating          Int?
     voteCount       Int?
     revisionCount   Int?
     tags            Json?
   }
   ```

3. **Coauthor查询支持** ✅
   ```sql
   -- Attribution表支持多种贡献者关系
   model Attribution {
     attributionType String   // 'author', 'coauthor', 'translator', etc.
     userName        String
     pageUrl         String
     
     @@index([attributionType])  // 支持按类型查询
     @@index([userName])         // 支持按用户查询
   }
   ```

### 🔧 需要优化的Tag查询功能

#### 当前Tag设计的局限性
```sql
-- 当前设计
tags Json?  -- 存储为JSON数组，如 ["scp", "keter", "认知危害"]
```

**问题**:
- JSON查询性能有限
- 无法建立有效的关系查询
- 难以进行复杂的标签统计和分析

#### 推荐的Tag优化方案

**方案1: 专门的Tag表（推荐）**
```prisma
model Tag {
  name        String  @id @db.VarChar(50)
  description String? 
  category    String? @db.VarChar(20)  // 'content', 'rating', 'meta'
  usageCount  Int     @default(0)
  
  // 关联关系
  pageTags    PageTag[]
  
  @@index([category])
  @@index([usageCount])
  @@map("tags")
}

model PageTag {
  pageUrl String @db.VarChar(500)
  tagName String @db.VarChar(50)
  
  // 关联
  page Page @relation(fields: [pageUrl], references: [url], onDelete: Cascade)
  tag  Tag  @relation(fields: [tagName], references: [name], onDelete: Cascade)
  
  @@id([pageUrl, tagName])
  @@index([tagName])
  @@map("page_tags")
}

// 在Page model中添加
model Page {
  // ... 现有字段
  pageTags PageTag[]  // 新增关系
}
```

**优势**:
- 🚀 高性能的tag查询和统计
- 📊 支持复杂的tag分析（使用频率、组合模式）
- 🔍 支持tag自动补全和搜索
- 📈 可以追踪tag使用趋势

**方案2: 改进现有JSON设计**
```sql
-- PostgreSQL特定优化
CREATE INDEX idx_pages_tags_gin ON pages USING GIN (tags);

-- 支持的查询类型
-- 包含特定tag
SELECT * FROM pages WHERE tags @> '["scp"]';

-- 包含任一tag
SELECT * FROM pages WHERE tags ?| array['scp', 'keter'];

-- 包含所有tag
SELECT * FROM pages WHERE tags ?& array['scp', 'keter'];
```

## 具体优化建议

### 1. 立即可实施的索引优化

```prisma
// 在现有schema中添加这些索引
model Page {
  // ... 现有字段
  
  @@index([category, rating])           // 分类内评分排序
  @@index([createdByUser, createdAt])   // 用户创建历史
  @@index([isDeleted, rating])          // 活跃页面评分查询
  @@index([voteCount, rating])          // 热门内容查询
}

model Attribution {
  // ... 现有字段
  
  @@index([attributionType, userName])  // coauthor查询优化
  @@index([pageUrl, attributionType])   // 页面贡献者查询
}

model VoteRecord {
  // ... 现有字段
  
  @@index([pageUrl, direction])         // 页面投票类型统计
  @@index([userWikidotId, timestamp])   // 用户投票历史
}
```

### 2. 常见查询模式的优化

#### Tag查询示例
```javascript
// 当前方法（可用但不够高效）
const pagesWithSCPTag = await prisma.page.findMany({
  where: {
    tags: {
      array_contains: ["scp"]
    }
  }
});

// 推荐方法（使用专门Tag表）
const pagesWithSCPTag = await prisma.page.findMany({
  where: {
    pageTags: {
      some: {
        tagName: "scp"
      }
    }
  },
  include: {
    pageTags: {
      include: { tag: true }
    }
  }
});
```

#### Coauthor查询示例
```javascript
// 查找特定用户作为coauthor的页面
const coauthoredPages = await prisma.page.findMany({
  where: {
    attributions: {
      some: {
        userName: "用户名",
        attributionType: "coauthor"
      }
    }
  },
  include: {
    attributions: {
      where: { attributionType: "coauthor" }
    }
  }
});

// 查找页面的所有coauthor
const pageCoauthors = await prisma.attribution.findMany({
  where: {
    pageUrl: "页面URL",
    attributionType: "coauthor"
  },
  include: { user: true }
});
```

### 3. 数据库性能监控建议

```sql
-- 创建用于性能分析的视图
CREATE VIEW page_stats AS
SELECT 
  category,
  COUNT(*) as page_count,
  AVG(rating) as avg_rating,
  MAX(rating) as max_rating,
  SUM(vote_count) as total_votes
FROM pages 
WHERE is_deleted = false
GROUP BY category;

-- Tag使用统计视图（如果实施方案1）
CREATE VIEW tag_usage_stats AS
SELECT 
  t.name,
  t.category,
  COUNT(pt.page_url) as usage_count,
  AVG(p.rating) as avg_rating_of_tagged_pages
FROM tags t
LEFT JOIN page_tags pt ON t.name = pt.tag_name
LEFT JOIN pages p ON pt.page_url = p.url AND p.is_deleted = false
GROUP BY t.name, t.category;
```

### 4. 高级查询功能建议

#### 标签组合分析
```javascript
// 查找标签组合模式
const tagCombinations = await prisma.$queryRaw`
  SELECT 
    t1.tag_name as tag1,
    t2.tag_name as tag2,
    COUNT(*) as combination_count
  FROM page_tags t1
  JOIN page_tags t2 ON t1.page_url = t2.page_url AND t1.tag_name < t2.tag_name
  GROUP BY t1.tag_name, t2.tag_name
  HAVING COUNT(*) >= 5
  ORDER BY combination_count DESC
`;
```

#### 作者协作网络分析
```javascript
// 查找协作最频繁的作者对
const collaborationNetwork = await prisma.$queryRaw`
  SELECT 
    a1.user_name as author1,
    a2.user_name as author2,
    COUNT(DISTINCT a1.page_url) as collaboration_count
  FROM attributions a1
  JOIN attributions a2 ON a1.page_url = a2.page_url AND a1.user_name < a2.user_name
  WHERE a1.attribution_type IN ('author', 'coauthor')
    AND a2.attribution_type IN ('author', 'coauthor')
  GROUP BY a1.user_name, a2.user_name
  HAVING COUNT(DISTINCT a1.page_url) >= 3
  ORDER BY collaboration_count DESC
`;
```

## 实施优先级

### 高优先级 🔴（立即实施）
1. **JSON索引优化**: 为现有tags字段添加GIN索引
2. **复合索引**: 添加常用查询组合的索引
3. **数据库同步脚本修复**: 确保PageHistory正确实现

### 中优先级 🟡（下个版本）
1. **专门Tag表**: 实施规范化的tag管理系统
2. **性能监控**: 添加查询性能分析工具
3. **数据归档**: 实施历史数据归档策略

### 低优先级 🟢（后续优化）
1. **分区策略**: 大数据量下的表分区
2. **缓存优化**: Redis缓存热门查询
3. **全文搜索**: 集成Elasticsearch

## 结论

现有的数据库设计已经很好地支持了：
- ✅ **页面删除状态管理**: 完整的软删除功能
- ✅ **版本管理**: PageHistory表提供完整的变更追踪
- ✅ **Coauthor查询**: Attribution表支持灵活的贡献者关系

主要需要优化的是：
- 🔧 **Tag查询性能**: 建议实施专门的Tag表设计
- 📊 **查询索引**: 添加针对常见查询模式的复合索引

整体而言，当前设计已经为高级功能奠定了良好基础，只需要有针对性的优化即可满足所有需求。