#!/bin/bash

# SCPPER-CN 服务监控脚本

echo "🔍 SCPPER-CN 服务状态监控"
echo "=========================="

# 检查进程状态
echo "📊 进程状态:"
if command -v pm2 &> /dev/null; then
    pm2 list
else
    echo "PM2未安装，检查Node.js进程:"
    ps aux | grep -E "(database-sync|user-analytics)" | grep -v grep
fi

echo ""
echo "💾 内存使用:"
free -h

echo ""
echo "💿 磁盘使用:"
df -h .

echo ""
echo "📋 最新日志 (最近10行):"
if [ -d "sync-logs" ]; then
    find sync-logs -name "*.log" -type f -exec ls -t {} + | head -1 | xargs tail -10
else
    echo "未找到日志目录"
fi

echo ""
echo "🗄️ 数据库连接测试:"
if command -v psql &> /dev/null && [ -n "$DATABASE_URL" ]; then
    psql "$DATABASE_URL" -c "SELECT COUNT(*) as page_count FROM pages;" 2>/dev/null || echo "数据库连接失败"
else
    echo "PostgreSQL未配置或未安装"
fi

echo ""
echo "🌐 网络连接测试:"
curl -s -o /dev/null -w "CROM API: %{http_code} (%{time_total}s)\n" "https://apiv1.crom.avn.sh/graphql" || echo "CROM API连接失败"
