# SCPPER-CN 存储设计方案

## 📊 数据规模估算

基于CROM API测试结果：
- **页面数量**: 30,849个
- **用户数量**: ~8,000个  
- **投票记录**: ~300,000条 (平均每页10条)
- **修订记录**: ~100,000条 (平均每页3条)
- **页面内容**: ~150MB (平均5KB/页面)

**总存储需求**: ~2-5GB (含索引)

## 🔧 技术选型对比

### 1. PostgreSQL (推荐) ✅
**优势:**
- 原生JSON支持，适合复杂数据结构
- 强大的全文搜索 (FTS)
- 复杂查询和分析能力
- 成熟的生态系统
- 支持并发读写

**适用场景:**
- 复杂的关系查询 (用户投票网络)
- 全文搜索 (页面内容搜索)
- 聚合分析 (统计排名)

### 2. SQLite (轻量级选择)
**优势:**
- 零配置，单文件
- 足够的性能 (5GB数据)
- 易于备份和分发

**劣势:**
- 并发写入限制
- 复杂查询性能较差

### 3. MongoDB (文档数据库)
**优势:**
- 文档结构天然适合CROM数据
- 水平扩展能力

**劣势:**
- 关系查询复杂
- 学习成本

## 🎯 推荐方案: PostgreSQL + Redis

### PostgreSQL (主存储)
```sql
-- 核心表结构
CREATE TABLE pages (
  url VARCHAR(500) PRIMARY KEY,
  title TEXT,
  wikidot_id INTEGER,
  category VARCHAR(100),
  rating INTEGER,
  vote_count INTEGER,
  created_at TIMESTAMP,
  revision_count INTEGER,
  source TEXT,
  text_content TEXT,
  tags JSONB,
  is_private BOOLEAN,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_by_user VARCHAR(100),
  parent_url VARCHAR(500),
  thumbnail_url TEXT,
  last_synced_at TIMESTAMP DEFAULT NOW(),
  
  -- 索引
  INDEX idx_pages_rating (rating),
  INDEX idx_pages_created_at (created_at),
  INDEX idx_pages_tags USING GIN (tags),
  INDEX idx_pages_text_search USING GIN (to_tsvector('english', text_content))
);

CREATE TABLE users (
  name VARCHAR(100) PRIMARY KEY,
  display_name VARCHAR(100),
  wikidot_id INTEGER UNIQUE,
  unix_name VARCHAR(100),
  rank INTEGER,
  total_rating INTEGER,
  mean_rating DECIMAL(5,2),
  page_count INTEGER,
  page_count_scp INTEGER,
  page_count_tale INTEGER,
  page_count_goi_format INTEGER,
  page_count_artwork INTEGER,
  last_synced_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE vote_records (
  id SERIAL PRIMARY KEY,
  page_url VARCHAR(500) REFERENCES pages(url),
  user_wikidot_id INTEGER,
  user_name VARCHAR(100),
  timestamp TIMESTAMP,
  direction SMALLINT, -- -1, 0, 1
  
  UNIQUE(page_url, user_wikidot_id, timestamp)
);

CREATE TABLE revisions (
  id SERIAL PRIMARY KEY,
  page_url VARCHAR(500) REFERENCES pages(url),
  revision_index INTEGER,
  wikidot_id INTEGER,
  timestamp TIMESTAMP,
  type VARCHAR(50),
  user_wikidot_id INTEGER,
  user_name VARCHAR(100),
  comment TEXT,
  
  UNIQUE(page_url, revision_index)
);

CREATE TABLE page_relations (
  page_url VARCHAR(500) REFERENCES pages(url),
  related_url VARCHAR(500),
  relation_type VARCHAR(20), -- 'parent', 'child', 'translation', 'adult_content'
  
  PRIMARY KEY(page_url, related_url, relation_type)
);

CREATE TABLE attributions (
  page_url VARCHAR(500) REFERENCES pages(url),
  user_name VARCHAR(100),
  attribution_type VARCHAR(20), -- 'AUTHOR', 'REWRITE', 'TRANSLATOR', etc.
  date TIMESTAMP,
  order_index INTEGER,
  is_current BOOLEAN,
  
  PRIMARY KEY(page_url, user_name, attribution_type)
);
```

### Redis (缓存层)
```javascript
// 缓存策略
const cacheKeys = {
  userRankings: 'rankings:users:*',
  pageStats: 'stats:pages:*', 
  voteNetworks: 'networks:votes:*',
  dailyStats: 'stats:daily:*'
};
```

## 📦 ORM 选择: Prisma

### 优势
- TypeScript 原生支持
- 类型安全的查询
- 优秀的开发体验
- 自动迁移管理

### Prisma Schema 示例
```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Page {
  url            String   @id @db.VarChar(500)
  title          String?
  wikidotId      Int?     @map("wikidot_id")
  category       String?  @db.VarChar(100)
  rating         Int?
  voteCount      Int?     @map("vote_count")
  createdAt      DateTime? @map("created_at")
  revisionCount  Int?     @map("revision_count")
  source         String?
  textContent    String?  @map("text_content")
  tags           Json?
  isPrivate      Boolean  @default(false) @map("is_private")
  isDeleted      Boolean  @default(false) @map("is_deleted")
  createdByUser  String?  @map("created_by_user") @db.VarChar(100)
  parentUrl      String?  @map("parent_url") @db.VarChar(500)
  thumbnailUrl   String?  @map("thumbnail_url")
  lastSyncedAt   DateTime @default(now()) @map("last_synced_at")

  // Relations
  voteRecords    VoteRecord[]
  revisions      Revision[]
  relations      PageRelation[] @relation("PageRelations")
  attributions   Attribution[]

  @@index([rating])
  @@index([createdAt])
  @@map("pages")
}

model User {
  name              String  @id @db.VarChar(100)
  displayName       String? @map("display_name") @db.VarChar(100)
  wikidotId         Int?    @unique @map("wikidot_id")
  unixName          String? @map("unix_name") @db.VarChar(100)
  rank              Int?
  totalRating       Int?    @map("total_rating")
  meanRating        Decimal? @map("mean_rating") @db.Decimal(5,2)
  pageCount         Int?    @map("page_count")
  pageCountScp      Int?    @map("page_count_scp")
  pageCountTale     Int?    @map("page_count_tale")
  pageCountGoiFormat Int?   @map("page_count_goi_format")
  pageCountArtwork  Int?    @map("page_count_artwork")
  lastSyncedAt      DateTime @default(now()) @map("last_synced_at")

  @@map("users")
}

model VoteRecord {
  id            Int      @id @default(autoincrement())
  pageUrl       String   @map("page_url") @db.VarChar(500)
  userWikidotId Int      @map("user_wikidot_id")
  userName      String?  @map("user_name") @db.VarChar(100)
  timestamp     DateTime
  direction     Int      @db.SmallInt

  page Page @relation(fields: [pageUrl], references: [url])

  @@unique([pageUrl, userWikidotId, timestamp])
  @@index([userWikidotId])
  @@index([timestamp])
  @@map("vote_records")
}

model Revision {
  id            Int      @id @default(autoincrement())
  pageUrl       String   @map("page_url") @db.VarChar(500)
  revisionIndex Int      @map("revision_index")
  wikidotId     Int      @map("wikidot_id")
  timestamp     DateTime
  type          String?  @db.VarChar(50)
  userWikidotId Int?     @map("user_wikidot_id")
  userName      String?  @map("user_name") @db.VarChar(100)
  comment       String?

  page Page @relation(fields: [pageUrl], references: [url])

  @@unique([pageUrl, revisionIndex])
  @@map("revisions")
}

model PageRelation {
  pageUrl      String @map("page_url") @db.VarChar(500)
  relatedUrl   String @map("related_url") @db.VarChar(500)
  relationType String @map("relation_type") @db.VarChar(20)

  page Page @relation("PageRelations", fields: [pageUrl], references: [url])

  @@id([pageUrl, relatedUrl, relationType])
  @@map("page_relations")
}

model Attribution {
  pageUrl         String   @map("page_url") @db.VarChar(500)
  userName        String   @map("user_name") @db.VarChar(100)
  attributionType String   @map("attribution_type") @db.VarChar(20)
  date            DateTime?
  orderIndex      Int?     @map("order_index")
  isCurrent       Boolean? @map("is_current")

  page Page @relation(fields: [pageUrl], references: [url])

  @@id([pageUrl, userName, attributionType])
  @@map("attributions")
}
```

## 🔍 查询性能优化

### 索引策略
```sql
-- 核心索引
CREATE INDEX CONCURRENTLY idx_vote_records_user_page ON vote_records(user_wikidot_id, page_url);
CREATE INDEX CONCURRENTLY idx_vote_records_page_time ON vote_records(page_url, timestamp DESC);
CREATE INDEX CONCURRENTLY idx_pages_rating_desc ON pages(rating DESC) WHERE NOT is_deleted;
CREATE INDEX CONCURRENTLY idx_pages_fts ON pages USING GIN(to_tsvector('simple', title || ' ' || COALESCE(text_content, '')));

-- 复合索引用于常见查询
CREATE INDEX CONCURRENTLY idx_pages_created_rating ON pages(created_at DESC, rating DESC) WHERE NOT is_deleted;
```

### 分区策略 (未来扩展)
```sql
-- 按时间分区投票记录表
CREATE TABLE vote_records_2024 PARTITION OF vote_records
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
```

## 📈 预期性能

### 存储空间
- **Pages**: ~500MB (含content)
- **Users**: ~5MB
- **Vote Records**: ~50MB
- **Revisions**: ~20MB
- **Relations + Attributions**: ~10MB
- **索引**: ~200MB
- **总计**: ~800MB-1GB

### 查询性能 (预估)
- **页面检索**: <10ms
- **用户排名**: <50ms (有索引)
- **投票网络查询**: <100ms
- **全文搜索**: <200ms

## 🔧 部署建议

### Docker Compose
```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: scpper_cn
      POSTGRES_USER: scpper
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

## 🚀 下一步

1. **设置本地开发环境**
2. **初始化Prisma项目**
3. **实现数据同步脚本**
4. **进行全量数据拉取测试**