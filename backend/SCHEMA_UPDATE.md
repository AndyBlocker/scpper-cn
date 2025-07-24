# 数据库架构更新记录

## 2025-07-24: 基于Revision信息的页面变更检测

### 更新原因
根据用户反馈，页面内容存储不必要，因为revision相关信息已经足够追踪页面变更。

### 主要变更

#### 1. Prisma Schema 更新 (`prisma/schema.prisma`)

**移除的字段：**
- `PageHistory.source` - 页面源代码
- `PageHistory.textContent` - 页面文本内容  
- `PageHistory.sourceHash` - SHA256哈希值
- `Page.sourceHash` - 页面源代码哈希

**新增的字段：**
- `Page.lastRevisionCount` - 最后同步的revision数量
- `PageHistory.revisionCount` 索引 - 用于检测revision变化

#### 2. 数据库同步脚本更新 (`src/sync/database-sync.js`)

**变更内容：**
- 移除 `calculateSourceHash()` 方法
- 移除 `crypto` 依赖
- 使用 `revisionCount` 而非 `sourceHash` 检测页面变更
- 更新页面历史记录不再存储源代码内容
- 页面变更原因更详细描述revision数量变化

**新的变更检测逻辑：**
```javascript
// 旧方式：基于源代码哈希
const sourceHash = calculateSourceHash(page.source);
if (existingPage.sourceHash !== sourceHash) {
  // 页面有变化
}

// 新方式：基于revision数量
const currentRevisionCount = page.wikidotInfo?.revisionCount || 0;
if (existingPage.lastRevisionCount !== currentRevisionCount) {
  // 页面有新的revision
}
```

#### 3. 用户查询脚本更新 (`src/analysis/database-user-query.js`)

**变更内容：**
- 页面历史查询显示 `revision数量` 而非 `内容长度`
- 移除对源代码长度的统计

### 优势

1. **存储空间优化**: 不再存储大量的页面源代码，大幅减少数据库大小
2. **性能提升**: 减少I/O操作，提高查询速度
3. **逻辑简化**: 基于revision数量的变更检测更直接可靠
4. **数据一致性**: 利用现有的revision系统，避免重复存储

### 兼容性

- 现有的页面历史功能完全保留
- 查询接口保持不变，仅显示内容调整
- 数据库migration需要清理旧的sourceHash相关数据

### 后续工作

1. 运行数据库migration清理旧字段
2. 测试新的变更检测逻辑
3. 验证页面历史查询功能正常