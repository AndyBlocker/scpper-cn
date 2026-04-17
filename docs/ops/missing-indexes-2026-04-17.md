# 缺失索引补齐 2026-04-17

本 PR 补齐 SQL 审计发现的 9 个热路径索引，分布在 backend 与 user-backend
共享的 `scpper-cn` 数据库。所有索引都通过 `CREATE INDEX CONCURRENTLY`
创建，不阻塞生产写入。

## 为什么放在 `scripts/ops/` 而不是 Prisma migration

1. **Prisma 不支持 partial index 的 `WHERE` 子句**（长期未解决的上游限制）。
   本次 9 个索引里有 6 个是 partial，无法通过 `@@index` 声明。
2. **Prisma migrate 会把 SQL 放进事务**，而 `CONCURRENTLY` 不能在事务中执行。
3. 未来 Prisma 如果重新基线，`prisma migrate diff` 会把这些索引视为
   drift。我们接受这个代价，因为索引不是 schema 数据模型的一部分。

## 索引清单

### user-backend（gacha 相关）

| 索引名 | 表 | 键 | 条件 | 场景 |
|---|---|---|---|---|
| `idx_gacha_trade_open_live` | `GachaTradeListing` | `(createdAt DESC, cardId)` | `status='OPEN'` | 求购面板「正在售卖」列表 ⭐ |
| `idx_gacha_buyreq_open_live` | `GachaBuyRequest` | `(createdAt DESC, targetCardId)` | `status='OPEN'` | 求购单「公开求购」列表 ⭐ |
| `idx_gacha_card_instance_unlocked` | `GachaCardInstance` | `(userId, cardId)` | `isLocked=false` | 用户可交易/可挂单卡片选择器 ⭐ |
| `idx_gacha_inventory_active` | `GachaInventory` | `(userId, count DESC)` | `count>0` | 我的库存面板 |
| `idx_gacha_draw_user_pool_created` | `GachaDraw` | `(userId, poolId, createdAt DESC)` | — | 按卡池过滤的抽卡历史 |

### backend（SCP 主数据）

| 索引名 | 表 | 键 | 条件 | 场景 |
|---|---|---|---|---|
| `idx_page_active` | `Page` | `(firstPublishedAt DESC)` | `isDeleted=false` | 公开页面列表（几乎所有前端列表接口） |
| `idx_vote_direction_timestamp` | `Vote` | `(direction, timestamp DESC)` | — | 全站投票热度/方向聚合 |
| `idx_rating_record_type_rating` | `RatingRecords` | `(recordType, rating DESC NULLS LAST)` | — | 排行榜 Top-N |
| `idx_metric_alert_unread` | `PageMetricAlert` | `(detectedAt DESC)` | `acknowledgedAt IS NULL` | 未读告警面板 |

## 设计说明

### 为什么 partial 条件不带 `expiresAt > NOW()`

`NOW()` 是 `STABLE` 而不是 `IMMUTABLE`，PG 拒绝在 partial index 的 `WHERE`
子句中使用。所以 `GachaBuyRequest` 只按 `status='OPEN'` 过滤，剩余的
`expiresAt` 检查由查询层处理（索引扫完开 N 条后再 filter 很快）。

### 为什么 `idx_rating_record_type_rating` 不包含 `timeframe`

审计考虑过 `(recordType, timeframe, rating DESC)`，但已有 unique
`(recordType, timeframe, pageId)` 提供了 `(recordType, timeframe)` 的 B-tree
前缀定位能力。当前查询形态是 "给定 `recordType` 求 rating 排序 TopN"，
`(recordType, rating DESC)` 更契合。后续如果出现 "给定 recordType+timeframe
求排行" 的热路径再加另一条复合索引。

### 为什么全部 `CONCURRENTLY`

主要表（Page、Vote、GachaTradeListing、GachaCardInstance）体量大，非并发
`CREATE INDEX` 会持有 `SHARE` 锁阻塞写入。`CONCURRENTLY` 多次扫表但只用
弱锁，生产可以带流量执行。

## 生效方式

```bash
# 1. 切到生产 main checkout
cd /home/andyblocker/scpper-cn
git pull origin main

# 2. 读取 DB 凭据（bff/.env 里有）并执行
set -a; source bff/.env; set +a
PGPASSWORD=... psql -h 127.0.0.1 -p 5434 -U user_dxzbdi -d scpper-cn \
  -v ON_ERROR_STOP=0 -f scripts/ops/indexes-2026-04-17-user-backend.sql

PGPASSWORD=... psql -h 127.0.0.1 -p 5434 -U user_dxzbdi -d scpper-cn \
  -v ON_ERROR_STOP=0 -f scripts/ops/indexes-2026-04-17-backend.sql

# 3. 让 planner 感知新索引的选择性
PGPASSWORD=... psql -h 127.0.0.1 -p 5434 -U user_dxzbdi -d scpper-cn -c \
  "ANALYZE \"GachaTradeListing\", \"GachaBuyRequest\", \"GachaCardInstance\",
           \"GachaInventory\", \"GachaDraw\", \"Page\", \"Vote\",
           \"RatingRecords\", \"PageMetricAlert\";"
```

`ON_ERROR_STOP=0` 因为 `CONCURRENTLY` 在并发 DDL 冲突时会单条失败但不应
中止整个脚本。脚本末尾的 validation SELECT 可以看到哪些索引 `is_valid`。

## 回滚

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_gacha_trade_open_live;
DROP INDEX CONCURRENTLY IF EXISTS idx_gacha_buyreq_open_live;
DROP INDEX CONCURRENTLY IF EXISTS idx_gacha_card_instance_unlocked;
DROP INDEX CONCURRENTLY IF EXISTS idx_gacha_inventory_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_gacha_draw_user_pool_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_page_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_vote_direction_timestamp;
DROP INDEX CONCURRENTLY IF EXISTS idx_rating_record_type_rating;
DROP INDEX CONCURRENTLY IF EXISTS idx_metric_alert_unread;
```

## 验证

应用后运行几条代表性查询并 `EXPLAIN ANALYZE` 验证使用了新索引：

```sql
EXPLAIN ANALYZE SELECT * FROM "GachaTradeListing"
  WHERE status='OPEN' AND remaining>0 ORDER BY "createdAt" DESC LIMIT 60;

EXPLAIN ANALYZE SELECT * FROM "Page"
  WHERE "isDeleted"=false ORDER BY "firstPublishedAt" DESC LIMIT 100;
```

期望看到 `Index Scan using idx_gacha_trade_open_live` / `idx_page_active`
而不是 `Seq Scan`。
