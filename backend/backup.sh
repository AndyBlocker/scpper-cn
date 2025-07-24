#!/bin/bash

# SCPPER-CN 数据备份脚本

BACKUP_DIR="./data-backups"
DATE=$(date +%Y%m%d_%H%M%S)

echo "🗄️ 开始数据备份 - $DATE"

# 创建备份目录
mkdir -p "$BACKUP_DIR"

# 备份数据库 (如果使用PostgreSQL)
if command -v pg_dump &> /dev/null && [ -n "$DATABASE_URL" ]; then
    echo "备份PostgreSQL数据库..."
    pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/database_$DATE.sql.gz"
fi

# 备份配置文件
echo "备份配置文件..."
cp .env "$BACKUP_DIR/env_$DATE.backup" 2>/dev/null || true
cp ecosystem.config.js "$BACKUP_DIR/pm2_config_$DATE.backup" 2>/dev/null || true

# 备份日志文件 (最近7天)
echo "备份日志文件..."
find sync-logs -name "*.log" -mtime -7 -exec cp {} "$BACKUP_DIR/" \; 2>/dev/null || true

# 清理30天前的备份
echo "清理旧备份文件..."
find "$BACKUP_DIR" -name "*" -mtime +30 -delete 2>/dev/null || true

echo "✅ 备份完成 - $DATE"
ls -lah "$BACKUP_DIR" | tail -5
