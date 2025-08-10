# SCPPER-CN BFF (Backend for Frontend)

基于设计文档构建的高性能、可扩展的BFF服务层，为SCPPER-CN前端提供统一的API接口。

## 功能特性

- ✅ **智能缓存架构**: Redis分布式缓存 + 内存降级机制，确保服务高可用
- ✅ **分层限流保护**: API分级限流（通用100/min，搜索30/min，重型10/min）
- ✅ **全面监控体系**: Prometheus指标 + Winston日志 + 健康检查端点
- ✅ **安全防护**: Helmet安全头 + CORS + CSP内容安全策略
- ✅ **高性能优化**: 响应压缩 + 连接池 + 查询优化 + 缓存预热
- ✅ **生产就绪**: PM2集群 + Nginx代理 + 优雅关闭 + 错误恢复
- ✅ **开发体验**: TypeScript类型安全 + ESM模块 + 热重载 + API文档
- ✅ **数据库兼容**: Prisma ORM + 连接池管理 + 迁移脚本

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，确保数据库连接信息正确
# Redis配置是可选的，如果不可用会自动降级到内存缓存
```

### 3. 生成Prisma Client

```bash
npm run prisma:generate
```

### 4. 启动开发服务器

```bash
npm run dev
```

服务将在 http://localhost:4396 启动。

## API 端点

### 核心端点

- `GET /api` - API根信息
- `GET /health` - 健康检查
- `GET /ready` - 就绪检查  
- `GET /version` - 版本信息
- `GET /metrics` - 监控指标

### 页面相关

- `GET /api/pages` - 获取页面列表
- `GET /api/pages/:identifier` - 获取页面详情
- `GET /api/pages/:identifier/versions` - 获取页面版本历史
- `GET /api/pages/:identifier/votes` - 获取页面投票记录
- `GET /api/pages/:identifier/revisions` - 获取页面修订记录
- `GET /api/pages/:identifier/stats` - 获取页面统计

### 搜索相关

- `GET /api/search?q={query}` - 全文搜索
- `GET /api/search/suggest?q={query}` - 搜索建议
- `GET /api/search/tags?tags={tags}` - 按标签搜索
- `GET /api/search/advanced` - 高级搜索

### 统计相关

- `GET /api/stats/site` - 站点统计
- `GET /api/stats/series` - 系列统计
- `GET /api/stats/series/:number` - 特定系列详情
- `GET /api/stats/interesting` - 有趣统计
- `GET /api/stats/trending` - 趋势统计
- `GET /api/stats/leaderboard` - 排行榜
- `GET /api/stats/tags` - 标签统计

### 用户相关

- `GET /api/users` - 获取用户列表
- `GET /api/users/:identifier` - 获取用户详情
- `GET /api/users/:identifier/stats` - 获取用户统计
- `GET /api/users/:identifier/attributions` - 获取用户贡献
- `GET /api/users/:identifier/votes` - 获取用户投票记录
- `GET /api/users/:identifier/activity` - 获取用户活动记录

### 元数据相关

- `GET /api/meta/tags` - 所有标签
- `GET /api/meta/categories` - 分类信息
- `GET /api/meta/config` - 站点配置

## 生产部署

### 构建项目

```bash
npm run build
```

### 使用PM2启动

```bash
npm run pm2:start
```

### 查看日志

```bash
npm run pm2:logs
```

### 重启服务

```bash
npm run pm2:restart
```

## 性能特性

### 缓存策略

- **短期缓存** (1-5分钟): 热点数据、搜索结果
- **中期缓存** (5-30分钟): 页面详情、用户资料
- **长期缓存** (1-24小时): 统计数据
- **永久缓存**: 静态配置、标签元数据

### 智能缓存架构

系统采用多层缓存策略，确保高可用性和最佳性能：

#### 缓存层级
1. **L1 - Redis分布式缓存**: 生产环境主要缓存，支持集群
2. **L2 - 内存缓存**: Redis不可用时自动降级，进程内缓存
3. **L3 - 数据库**: 缓存全部失效时的最终数据源

#### 降级机制
- **自动检测**: 定期ping检测Redis连接状态
- **无感切换**: Redis故障时自动切换到内存缓存
- **限流同步**: 限流器同样支持Redis/内存双模式
- **状态监控**: 实时监控缓存健康状态

#### 监控端点
- `GET /health` - 整体服务健康状态（包含所有依赖）
- `GET /ready` - 服务就绪检查（包含缓存状态）
- `GET /cache-status` - 详细缓存指标（仅开发环境）
- `GET /metrics` - Prometheus监控指标

### 限流配置

- **通用API**: 100次/分钟
- **搜索API**: 30次/分钟
- **统计API**: 20次/分钟
- **重度操作**: 10次/分钟

### 监控指标

- HTTP请求持续时间
- HTTP请求总数
- 缓存命中/未命中
- 活跃连接数
- 内存使用情况

## 开发

### 项目架构

#### 分层设计
```
┌─────────────────────────────────────────┐
│                前端应用                  │
└─────────────┬───────────────────────────┘
              │ HTTPS/HTTP
              ▼
┌─────────────────────────────────────────┐
│            Nginx 反向代理                │
└─────────────┬───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│           PM2 集群管理                   │
├─────────────┬─────────────┬─────────────┤
│   Worker 1  │   Worker 2  │   Worker N  │
└─────────────┴─────────────┴─────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│            BFF 服务层                   │
├─────────────┬─────────────┬─────────────┤
│  Controller │   Service   │ Middleware  │
└─────────────┴─────────────┴─────────────┘
              │             │
              ▼             ▼
    ┌─────────────┐  ┌─────────────┐
    │Redis 分布式 │  │ PostgreSQL  │
    │    缓存     │  │   数据库    │
    └─────────────┘  └─────────────┘
```

#### 目录结构
```
src/
├── app.ts                      # Express应用初始化与中间件配置
├── server.ts                   # 服务器启动入口与优雅关闭
├── config/
│   ├── index.ts               # 环境变量配置管理
│   ├── database.ts            # Prisma数据库连接配置
│   └── redis.ts               # Redis连接与降级配置
├── controllers/               # HTTP请求控制器
│   ├── page.controller.ts     # 页面相关API控制器
│   ├── user.controller.ts     # 用户相关API控制器
│   ├── search.controller.ts   # 搜索功能API控制器
│   └── stats.controller.ts    # 统计数据API控制器
├── services/                  # 业务逻辑服务层
│   ├── page.service.ts        # 页面业务逻辑处理
│   ├── user.service.ts        # 用户业务逻辑处理
│   ├── search.service.ts      # 搜索业务逻辑处理
│   ├── stats.service.ts       # 统计业务逻辑处理
│   └── cache.service.ts       # 缓存服务与降级逻辑
├── middleware/                # Express中间件
│   ├── cache.middleware.ts    # 缓存控制中间件
│   ├── error.middleware.ts    # 统一错误处理中间件
│   ├── logging.middleware.ts  # 请求日志记录中间件
│   ├── rateLimit.middleware.ts# 分层限流中间件
│   └── validation.middleware.ts# 请求参数验证中间件
├── routes/                    # API路由定义
│   ├── index.ts              # 路由汇总与注册
│   ├── page.routes.ts        # 页面API路由
│   ├── user.routes.ts        # 用户API路由
│   ├── search.routes.ts      # 搜索API路由
│   └── stats.routes.ts       # 统计API路由
├── types/                    # TypeScript类型定义
│   ├── api.ts               # API响应格式类型
│   ├── dto.ts               # 数据传输对象类型
│   └── cache.ts             # 缓存相关类型
└── utils/                   # 工具函数库
    ├── logger.ts           # Winston日志配置
    └── metrics.ts          # Prometheus监控指标
```

### 开发命令

```bash
npm run dev        # 开发模式
npm run build      # 构建生产版本
npm run start      # 启动生产版本
npm run lint       # 代码检查
npm run format     # 代码格式化
npm test           # 运行测试
```

## 环境变量

| 变量名 | 默认值 | 描述 |
|--------|--------|------|
| NODE_ENV | development | 运行环境 |
| PORT | 4396 | 服务端口 |
| DATABASE_URL | - | 数据库连接字符串 |
| REDIS_HOST | localhost | Redis主机 |
| REDIS_PORT | 6379 | Redis端口 |
| API_PREFIX | /api | API路径前缀 |
| CACHE_ENABLED | true | 是否启用缓存 |
| METRICS_ENABLED | true | 是否启用监控 |

## 故障排除

### 常见问题

1. **数据库连接失败**: 检查 `DATABASE_URL` 配置
2. **Redis连接失败**: 检查Redis服务是否运行
3. **缓存未生效**: 检查 `CACHE_ENABLED` 设置
4. **监控数据异常**: 访问 `/metrics` 端点检查

### 日志查看

开发环境:
```bash
# 控制台输出
npm run dev
```

生产环境:
```bash
# PM2日志
npm run pm2:logs

# 文件日志
tail -f logs/application-*.log
tail -f logs/error-*.log
```

## 许可证

MIT License