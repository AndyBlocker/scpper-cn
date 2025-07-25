# 已删除页面Rating处理策略

## 问题背景

在维护用户统计信息时，需要明确如何处理已删除页面的rating和相关数据，这直接影响到用户评分、排名和统计数据的准确性。

## 🎯 核心原则：排除已删除页面

**决定**：用户统计中**完全排除**已删除页面的rating和相关数据。

**理由**：
1. **数据一致性**：已删除页面不再代表用户的当前创作成果
2. **公平性**：避免因历史删除影响当前排名
3. **准确性**：反映用户当前的实际影响力

## 📊 具体实施策略

### 1. 用户页面统计

```sql
-- ✅ 正确做法：排除已删除页面
SELECT 
  p.created_by_user as user_name,
  COUNT(*) as page_count,
  SUM(p.rating) as total_rating,
  AVG(p.rating::float) as mean_rating
FROM pages p 
WHERE p.created_by_user IS NOT NULL 
  AND p.is_deleted = false  -- 关键：排除已删除页面
GROUP BY p.created_by_user
```

### 2. 分类页面计数

```javascript
// SCP、故事等分类统计也排除已删除页面
const scpCount = await prisma.page.count({
  where: { 
    createdByUser: user.name, 
    isDeleted: false,  // ✅ 排除已删除页面
    OR: [
      { category: 'scp' },
      { url: { contains: '/scp-' } }
    ]
  }
});
```

### 3. 投票记录处理

**策略**：保留所有投票记录，但在统计时只计算活跃页面的投票

```javascript
// 计算用户获得的投票总数（只计算活跃页面）
const totalVotes = await prisma.voteRecord.aggregate({
  where: {
    page: { 
      createdByUser: user.name,
      isDeleted: false  // ✅ 只计算活跃页面的投票
    }
  },
  _count: { id: true }
});
```

## 🔄 历史数据处理

### 页面删除时的处理流程

1. **软删除标记**
   ```javascript
   await prisma.page.update({
     where: { url: pageUrl },
     data: {
       isDeleted: true,
       deletedAt: new Date(),
       deletionReason: '页面在源站点中不再存在'
     }
   });
   ```

2. **创建删除历史记录**
   ```javascript
   await prisma.pageHistory.create({
     data: {
       pageUrl: pageUrl,
       versionNumber: nextVersion,
       changeType: 'deleted',
       changeReason: '页面在源站点中被删除',
       capturedAt: new Date()
     }
   });
   ```

3. **自动重新计算用户统计**
   - 所有依赖该页面的用户统计自动更新
   - 排名重新计算

## 📈 统计字段说明

### User表中受影响的字段

| 字段名 | 计算方式 | 是否排除已删除页面 |
|--------|----------|-------------------|
| `pageCount` | COUNT(pages) | ✅ 是 |
| `totalRating` | SUM(rating) | ✅ 是 |
| `meanRating` | AVG(rating) | ✅ 是 |
| `pageCountScp` | COUNT(scp类型页面) | ✅ 是 |
| `pageCountTale` | COUNT(故事类型页面) | ✅ 是 |
| `pageCountGoiFormat` | COUNT(GOI格式页面) | ✅ 是 |
| `rank` | 基于totalRating排名 | ✅ 是 |

## 🛡️ 数据完整性保障

### 1. 保留历史记录
- **投票记录**：完整保留，便于历史分析
- **修订记录**：完整保留，便于追踪变更
- **页面历史**：完整保留，包含删除记录

### 2. 可追溯性
```sql
-- 查看用户历史总评分（包含已删除页面）
SELECT 
  SUM(rating) as historical_total_rating
FROM page_histories ph
WHERE ph.page_url IN (
  SELECT url FROM pages WHERE created_by_user = 'user_name'
)
AND ph.change_type != 'deleted';
```

### 3. 审计功能
```sql
-- 查看用户因页面删除损失的评分
SELECT 
  COUNT(*) as deleted_pages,
  SUM(rating) as lost_rating
FROM pages 
WHERE created_by_user = 'user_name' 
  AND is_deleted = true;
```

## 🔧 实施状态

### ✅ 已修复的脚本
- **v1 数据库同步** (`database-sync.js`): ✅ 正确实施
- **v2 数据库同步** (`apiv2-database-sync-final.js`): ✅ 已修复

### ❌ 需要修复的脚本
- **v2 数据库同步** (`apiv2-database-sync-fixed.js`): ❌ 有缺陷，已被final版本替代

## 📋 验证清单

在任何用户统计查询中，确保包含以下条件：

```sql
-- ✅ 检查清单
WHERE p.is_deleted = false  -- 必须包含
```

**具体应用场景**：
- [x] 用户页面计数
- [x] 用户总评分计算
- [x] 用户平均评分计算
- [x] 分类页面统计
- [x] 用户排名计算
- [x] 投票数据统计

## 💡 最佳实践建议

1. **一致性原则**：所有用户相关统计都应排除已删除页面
2. **透明度**：在界面上明确说明统计基于活跃页面
3. **历史分析**：提供单独的历史分析功能，可选择包含已删除页面
4. **定期审计**：定期检查数据一致性，确保统计准确

## 🔮 未来考虑

### 可能的扩展功能
1. **用户历史影响力图表**：展示用户评分随时间变化（包括删除事件）
2. **删除页面档案**：为感兴趣的用户提供历史页面查看
3. **影响力恢复**：如果删除页面被恢复，自动恢复相关统计

### 配置选项
未来可考虑提供配置选项，允许管理员选择不同的统计策略：
- `EXCLUDE_DELETED`: 默认，排除已删除页面
- `INCLUDE_DELETED`: 包含已删除页面（用于历史分析）
- `WEIGHTED_DELETED`: 给已删除页面降权重