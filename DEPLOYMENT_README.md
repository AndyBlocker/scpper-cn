# SCPPER-CN

SCP Foundation Chinese Wiki 数据分析与同步系统

## 🎯 项目概述

SCPPER-CN 是一个综合性的数据分析平台，专门用于 SCP Foundation 中文维基的数据同步、分析和可视化。系统通过 CROM GraphQL API 获取完整的站点数据，并提供深度的用户行为分析和社区洞察。

### 核心功能

- 🔄 **智能数据同步**: 支持增量同步和断点续传，基于revision检测变更
- 📊 **用户分析系统**: 27,499用户的综合行为分析和排行榜
- 🗃️ **版本历史管理**: 页面变更追踪和删除页面检测  
- 📈 **投票关系分析**: 深度挖掘用户间的投票模式和社交网络
- 🎨 **可视化准备**: 时间序列、热图、网络图数据预处理
- 🛡️ **生产就绪**: 完整的错误处理、日志记录和监控系统

## 📁 项目结构

```
scpper-cn/
├── backend/                    # 后端核心代码
│   ├── src/
│   │   ├── sync/              # 数据同步脚本
│   │   │   ├── database-sync.js    # 🌟 主要同步脚本
│   │   │   ├── final-sync.js       # JSON格式备用脚本
│   │   │   └── schema-explorer.js  # API结构探索
│   │   └── analysis/          # 数据分析工具
│   │       ├── user-analytics.js   # 用户分析系统
│   │       ├── database-user-query.js # 数据查询接口
│   │       └── timeseries-visualization-prep.js # 可视化数据准备
│   ├── prisma/                # 数据库架构
│   │   └── schema.prisma      # PostgreSQL数据模型
│   ├── deploy.sh              # 一键部署脚本
│   ├── docker-compose.prod.yml # 生产环境Docker配置
│   └── Dockerfile             # 容器镜像定义
└── README.md                  # 项目文档
```

## 🚀 快速开始

### 环境要求

- Node.js 18+
- PostgreSQL 12+ (推荐) 或 SQLite (开发环境)
- Git

### 本地开发部署

```bash
# 1. 克隆项目
git clone https://github.com/AndyBlocker/scpper-cn.git
cd scpper-cn/backend

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，设置数据库连接等参数

# 4. 初始化数据库
npx prisma migrate dev --name init
npx prisma generate

# 5. 开始数据同步
node src/sync/database-sync.js
```

### 生产环境部署

#### 方式1: 自动部署脚本

```bash
# 在服务器上运行一键部署
./deploy.sh
```

#### 方式2: Docker部署

```bash
# 1. 复制生产配置
cp docker-compose.prod.yml docker-compose.yml

# 2. 设置环境变量
export POSTGRES_PASSWORD=your_secure_password

# 3. 启动服务
docker-compose up -d

# 4. 初始化数据库
docker-compose exec scpper-sync npx prisma migrate deploy
```

#### 方式3: PM2进程管理

```bash
# 1. 安装PM2
npm install -g pm2

# 2. 启动服务
pm2 start ecosystem.config.js

# 3. 设置开机自启
pm2 startup
pm2 save
```

## 🔧 配置说明

### 环境变量 (.env)

```env
# CROM API配置
CROM_API_URL=https://apiv1.crom.avn.sh/graphql
TARGET_SITE_URL=http://scp-wiki-cn.wikidot.com

# 数据库配置
DATABASE_URL=postgresql://user:password@localhost:5432/scpper_cn

# 同步参数
MAX_REQUESTS_PER_SECOND=1.8
BATCH_SIZE=10
ENABLE_RESUME=true

# 日志配置
LOG_LEVEL=info
LOG_DIR=./sync-logs
```

### 频率限制

- **CROM API限制**: 300,000 points per 5-minute window
- **推荐频率**: ≤2 requests/second  
- **实际处理速度**: ~2 pages/second
- **支持断点续传**: 自动保存进度，支持中断恢复

## 📊 数据分析功能

### 用户分析系统

```bash
# 生成用户排行榜和关系分析
node src/analysis/user-analytics.js

# 查询特定用户信息
node src/analysis/database-user-query.js user "MScarlet"

# 查看删除页面统计
node src/analysis/database-user-query.js deleted 20
```

### 可视化数据准备

```bash
# 生成时间序列可视化数据
node src/analysis/timeseries-visualization-prep.js
```

**生成的可视化数据包括**:
- 📈 页面rating时间线
- 🔥 用户活跃度热图  
- 📊 社区成长趋势
- 🕸️ 投票网络关系图

## 🛠️ 运维工具

### 监控脚本

```bash
# 检查服务状态
./monitor.sh

# 数据备份
./backup.sh

# 清理旧文件
./src/sync/CLEANUP_SCRIPT.sh
```

### 定时任务设置

```bash
# 编辑crontab
crontab -e

# 添加定时同步 (每日凌晨3点)
0 3 * * * cd /path/to/scpper-cn/backend && node src/sync/database-sync.js

# 添加定时备份 (每日凌晨2点)  
0 2 * * * cd /path/to/scpper-cn/backend && ./backup.sh
```

## 📈 性能特征

| 组件 | 内存占用 | 处理速度 | 数据完整性 | 可靠性 |
|------|----------|----------|------------|--------|
| database-sync.js | ~1GB | 2 pages/sec | ✅ | 高 |
| user-analytics.js | ~4GB | - | ✅ | 高 |
| final-sync.js | ~4GB | 2 pages/sec | ✅ | 高 |

### 数据规模

- **页面数**: 30,849
- **用户数**: 27,499 
- **投票记录**: 876,838
- **修订记录**: 1,200,000+
- **数据库大小**: ~2-3GB

## 🏗️ 技术架构

### 核心技术栈

- **Runtime**: Node.js 18+
- **数据库**: PostgreSQL 15+ / Prisma ORM
- **API**: GraphQL (CROM)
- **容器化**: Docker + Docker Compose
- **进程管理**: PM2
- **监控**: 自定义脚本 + 日志系统

### 架构设计

```
CROM GraphQL API
       ↓
[database-sync.js] → PostgreSQL → [database-user-query.js]
       ↓                            ↓
页面历史版本管理              查询接口
       ↓                            ↓
[user-analytics.js] → 分析结果 → 可视化数据
```

## 📚 开发指南

### 添加新的分析功能

1. 在 `src/analysis/` 创建新脚本
2. 使用 `database-user-query.js` 作为查询模板
3. 参考 `user-analytics.js` 的数据处理模式
4. 更新相关文档

### 修改同步逻辑

1. 主要逻辑在 `src/sync/database-sync.js`
2. 数据库模型在 `prisma/schema.prisma`
3. 运行 `npx prisma migrate dev` 应用变更
4. 更新对应的分析脚本

### 调试和测试

```bash
# 运行API结构探索
node src/sync/schema-explorer.js

# 测试数据库连接
node src/sync/sqlite-test.js

# 诊断用户数据
node src/analysis/vote-relationship-diagnostic.js
```

## 🤝 贡献指南

1. Fork项目并创建feature分支
2. 遵循现有代码风格和注释规范
3. 添加必要的测试和文档
4. 提交前运行完整的数据同步测试
5. 创建Pull Request并详细描述变更

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🙏 致谢

- [CROM](https://crom.avn.sh/) - 提供强大的GraphQL API
- SCP Foundation CN社区 - 数据来源和灵感
- 所有贡献者和用户的支持

## 📞 联系方式

- GitHub Issues: [问题反馈](https://github.com/AndyBlocker/scpper-cn/issues)
- 项目作者: AndyBlocker

---

*SCPPER-CN - 让数据洞察SCP Foundation中文社区的无限可能* 🔬✨