# SCPPER-CN 部署指南

## 🎯 部署方式对比

| 部署方式 | 适用场景 | 复杂度 | 维护成本 | 推荐度 |
|---------|----------|--------|----------|--------|
| **自动脚本** | 快速部署、小团队 | 低 | 低 | ⭐⭐⭐⭐⭐ |
| **Docker** | 容器化环境、微服务 | 中 | 中 | ⭐⭐⭐⭐ |
| **PM2** | Node.js生产环境 | 中 | 中 | ⭐⭐⭐⭐ |
| **手动部署** | 定制化需求 | 高 | 高 | ⭐⭐⭐ |

## 🚀 推荐部署流程

### 1. 自动部署脚本 (推荐)

**适合**: 新服务器、快速部署、运维简化

```bash
# 1. 克隆项目到服务器
git clone https://github.com/AndyBlocker/scpper-cn.git
cd scpper-cn/backend

# 2. 运行自动部署脚本
./deploy.sh

# 3. 根据提示配置环境
# - 修改 .env 文件
# - 初始化数据库
# - 启动服务

# 4. 验证部署
./monitor.sh
```

**部署脚本功能**:
- ✅ 环境检查 (Node.js, PostgreSQL, Git)
- ✅ 依赖安装和目录创建
- ✅ 配置文件生成 (.env, PM2, systemd)
- ✅ 数据库初始化提示
- ✅ 监控和备份脚本生成

---

### 2. Docker部署

**适合**: 容器化环境、隔离部署、CI/CD集成

```bash
# 1. 准备Docker环境
git clone https://github.com/AndyBlocker/scpper-cn.git
cd scpper-cn/backend

# 2. 配置环境变量
export POSTGRES_PASSWORD=your_secure_password_here

# 3. 启动服务栈
docker-compose -f docker-compose.prod.yml up -d

# 4. 初始化数据库
docker-compose exec scpper-sync npx prisma migrate deploy
docker-compose exec scpper-sync npx prisma generate

# 5. 验证服务状态
docker-compose ps
docker-compose logs scpper-sync
```

**Docker服务组件**:
- `postgres`: PostgreSQL 15数据库
- `scpper-sync`: 主同步服务
- `scpper-analysis`: 分析服务 (按需启动)
- `nginx`: 反向代理 (可选)

---

### 3. PM2进程管理

**适合**: Node.js生产环境、精细化进程控制

```bash
# 1. 环境准备
npm install -g pm2
git clone https://github.com/AndyBlocker/scpper-cn.git
cd scpper-cn/backend

# 2. 安装依赖和初始化
npm install
npx prisma migrate deploy
npx prisma generate

# 3. 启动PM2服务
pm2 start ecosystem.config.js

# 4. 设置开机自启
pm2 startup
pm2 save

# 5. 监控服务
pm2 monit
pm2 logs scpper-cn-sync
```

**PM2服务配置**:
- `scpper-cn-sync`: 每日凌晨3点重启同步
- `scpper-cn-analysis`: 每日凌晨4点运行分析

---

## 🔧 详细配置步骤

### 数据库配置

#### PostgreSQL (生产推荐)

```bash
# 1. 安装PostgreSQL
# Ubuntu/Debian
sudo apt update && sudo apt install postgresql postgresql-contrib

# CentOS/RHEL
sudo yum install postgresql-server postgresql-contrib
sudo postgresql-setup initdb

# 2. 创建数据库和用户
sudo -u postgres psql

-- 在PostgreSQL命令行中执行
CREATE DATABASE scpper_cn;
CREATE USER scpper_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE scpper_cn TO scpper_user;
\\q

# 3. 配置 .env 文件
DATABASE_URL=postgresql://scpper_user:your_secure_password@localhost:5432/scpper_cn
```

#### SQLite (开发环境)

```bash
# 1. 创建数据目录
mkdir -p data

# 2. 配置 .env 文件
DATABASE_URL=file:./data/scpper.db

# 3. SQLite会自动创建数据库文件
```

### 环境变量配置

```bash
# 1. 复制配置模板
cp env.example .env

# 2. 编辑配置文件
nano .env

# 3. 关键配置项
CROM_API_URL=https://apiv1.crom.avn.sh/graphql
TARGET_SITE_URL=http://scp-wiki-cn.wikidot.com
DATABASE_URL=postgresql://user:pass@localhost:5432/scpper_cn
MAX_REQUESTS_PER_SECOND=1.8
LOG_LEVEL=info
```

### 服务启动配置

#### 方式1: 直接运行
```bash
# 主同步服务
node src/sync/database-sync.js

# 用户分析服务
node src/analysis/user-analytics.js
```

#### 方式2: 后台运行
```bash
# 使用nohup
nohup node src/sync/database-sync.js > sync.log 2>&1 &

# 使用screen
screen -S scpper-sync
node src/sync/database-sync.js
# Ctrl+A, D 分离会话
```

#### 方式3: systemd服务
```bash
# 1. 自动部署脚本会生成服务文件
./deploy.sh

# 2. 手动安装服务
sudo cp /tmp/scpper-cn.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable scpper-cn
sudo systemctl start scpper-cn

# 3. 查看服务状态
sudo systemctl status scpper-cn
journalctl -u scpper-cn -f
```

---

## 🛠️ 运维管理

### 日常监控

```bash
# 1. 服务状态检查
./monitor.sh

# 2. 查看日志
tail -f sync-logs/database-sync-$(date +%Y-%m-%d).log

# 3. 数据库状态
psql $DATABASE_URL -c "SELECT COUNT(*) FROM pages;"

# 4. 系统资源
htop
df -h
```

### 定时任务设置

```bash
# 编辑crontab
crontab -e

# 添加以下任务
# 每日凌晨3点同步数据
0 3 * * * cd /path/to/scpper-cn/backend && node src/sync/database-sync.js >> sync-logs/cron.log 2>&1

# 每日凌晨2点备份数据
0 2 * * * cd /path/to/scpper-cn/backend && ./backup.sh >> sync-logs/backup.log 2>&1

# 每周日清理日志
0 1 * * 0 cd /path/to/scpper-cn/backend && find sync-logs -name "*.log" -mtime +7 -delete
```

### 数据备份策略

```bash
# 1. 自动备份脚本
./backup.sh

# 2. 手动备份数据库
pg_dump $DATABASE_URL | gzip > backup-$(date +%Y%m%d).sql.gz

# 3. 备份配置文件
tar -czf config-backup-$(date +%Y%m%d).tar.gz .env ecosystem.config.js

# 4. 设置备份保留策略
find data-backups -name "*.sql.gz" -mtime +30 -delete
```

---

## 🚨 故障排除

### 常见问题解决

#### 1. API配额耗尽
```bash
# 症状: "Rate limit exceeded" 错误
# 解决: 等待5分钟配额重置，或调整请求频率

# 检查当前配额状态
grep "rateLimit" sync-logs/*.log | tail -5

# 临时降低请求频率
export MAX_REQUESTS_PER_SECOND=1.0
```

#### 2. 数据库连接失败
```bash
# 症状: "ECONNREFUSED" 或认证失败
# 解决步骤:

# 1. 检查数据库服务状态
sudo systemctl status postgresql

# 2. 测试连接
psql $DATABASE_URL -c "SELECT 1;"

# 3. 检查防火墙设置
sudo ufw status
sudo iptables -L

# 4. 验证用户权限
sudo -u postgres psql -c "\\du"
```

#### 3. 内存不足
```bash
# 症状: "JavaScript heap out of memory"
# 解决方案:

# 1. 增加Node.js内存限制
export NODE_OPTIONS="--max-old-space-size=4096"

# 2. 使用数据库同步而非JSON同步
node src/sync/database-sync.js  # 推荐
# 而不是 node src/sync/final-sync.js

# 3. 监控内存使用
watch -n 1 'ps aux | grep node'
```

#### 4. 磁盘空间不足
```bash
# 症状: "ENOSPC: no space left on device"
# 解决步骤:

# 1. 检查磁盘使用
df -h

# 2. 清理旧数据
./src/sync/CLEANUP_SCRIPT.sh

# 3. 清理日志文件
find sync-logs -name "*.log" -mtime +7 -delete

# 4. 清理Docker镜像 (如果使用Docker)
docker system prune -a
```

### 性能优化

#### 1. 数据库优化
```sql
-- 添加索引以提高查询性能
CREATE INDEX CONCURRENTLY idx_pages_rating ON pages(rating DESC) WHERE is_deleted = false;
CREATE INDEX CONCURRENTLY idx_votes_timestamp ON vote_records(timestamp DESC);
CREATE INDEX CONCURRENTLY idx_revisions_page_time ON revisions(page_url, timestamp DESC);

-- 定期分析表统计信息
ANALYZE pages;
ANALYZE vote_records;
ANALYZE revisions;
```

#### 2. 系统优化
```bash
# 1. 调整系统限制
echo '* soft nofile 65536' >> /etc/security/limits.conf
echo '* hard nofile 65536' >> /etc/security/limits.conf

# 2. 优化TCP参数
echo 'net.core.somaxconn = 65535' >> /etc/sysctl.conf
echo 'net.ipv4.tcp_max_syn_backlog = 65535' >> /etc/sysctl.conf
sysctl -p

# 3. 配置swap (如果内存不足)
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

---

## 📊 监控指标

### 关键指标监控

```bash
# 1. 同步进度监控
grep "已处理" sync-logs/*.log | tail -1

# 2. 错误率监控
grep "ERROR" sync-logs/*.log | wc -l

# 3. API配额使用率
grep "remaining" sync-logs/*.log | tail -5

# 4. 数据库大小监控
psql $DATABASE_URL -c "
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
"
```

### 健康检查脚本

```bash
#!/bin/bash
# health-check.sh

echo "🏥 SCPPER-CN 健康检查"
echo "===================="

# 检查进程状态
if pgrep -f "database-sync.js" > /dev/null; then
    echo "✅ 同步进程运行正常"
else
    echo "❌ 同步进程未运行"
fi

# 检查数据库连接
if psql $DATABASE_URL -c "SELECT 1;" &>/dev/null; then
    echo "✅ 数据库连接正常"
else
    echo "❌ 数据库连接失败"
fi

# 检查API连接
if curl -s "https://apiv1.crom.avn.sh/graphql" &>/dev/null; then
    echo "✅ CROM API连接正常"
else
    echo "❌ CROM API连接失败"
fi

# 检查磁盘空间
DISK_USAGE=$(df -h . | awk 'NR==2 {print $5}' | sed 's/%//')
if [ $DISK_USAGE -lt 90 ]; then
    echo "✅ 磁盘空间充足 ($DISK_USAGE%)"
else
    echo "⚠️ 磁盘空间不足 ($DISK_USAGE%)"
fi

echo "===================="
```

---

## 🔄 更新和维护

### 代码更新流程

```bash
# 1. 备份当前版本
./backup.sh

# 2. 停止服务
pm2 stop scpper-cn-sync  # 或其他停止命令

# 3. 拉取最新代码
git pull origin main

# 4. 更新依赖
npm install

# 5. 运行数据库迁移 (如果有)
npx prisma migrate deploy

# 6. 重新生成Prisma客户端
npx prisma generate

# 7. 重启服务
pm2 restart scpper-cn-sync

# 8. 验证更新
./monitor.sh
```

### 版本回滚

```bash
# 1. 查看Git提交历史
git log --oneline -10

# 2. 回滚到指定版本
git reset --hard <commit-hash>

# 3. 恢复数据库 (如果需要)
psql $DATABASE_URL < data-backups/database_YYYYMMDD.sql

# 4. 重启服务
pm2 restart all
```

---

## 📞 技术支持

### 获取帮助

1. **查看文档**: 
   - [代码整理文档](CROM_CODE_ORGANIZATION.md)
   - [脚本使用指南](src/sync/README.md)

2. **GitHub Issues**: 
   - [提交问题](https://github.com/AndyBlocker/scpper-cn/issues)

3. **日志分析**:
   ```bash
   # 查看错误日志
   grep -i error sync-logs/*.log
   
   # 查看警告信息
   grep -i warning sync-logs/*.log
   
   # 分析性能问题
   grep -E "(memory|slow|timeout)" sync-logs/*.log
   ```

4. **社区支持**:
   - SCP Foundation CN社区
   - Node.js/PostgreSQL技术社区

---

*部署遇到问题？查看日志文件或提交GitHub Issue获取帮助！* 🆘