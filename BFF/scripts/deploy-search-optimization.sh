#!/bin/bash

# 搜索性能优化部署脚本
# 用法: ./scripts/deploy-search-optimization.sh [--skip-db]

set -e

echo "🚀 开始部署搜索性能优化..."

# 检查参数
SKIP_DB=false
if [ "$1" = "--skip-db" ]; then
    SKIP_DB=true
    echo "⚠️  跳过数据库优化，仅部署应用代码"
fi

# 1. 构建优化版本
echo "📦 构建优化版本..."
npm run build

# 2. 数据库优化 (除非跳过)
if [ "$SKIP_DB" = false ]; then
    echo "🗄️  执行数据库优化..."
    
    # 检查数据库连接
    if ! psql "$DATABASE_URL" -c "SELECT 1;" > /dev/null 2>&1; then
        echo "❌ 数据库连接失败，请检查 DATABASE_URL"
        exit 1
    fi
    
    # 执行优化脚本
    echo "⚡ 创建搜索优化索引..."
    psql "$DATABASE_URL" -f scripts/optimize-search-index.sql
    
    echo "✅ 数据库优化完成"
else
    echo "⏭️  跳过数据库优化"
fi

# 3. 重启服务
echo "🔄 重启BFF服务..."

# 检查PM2是否在运行
if pm2 list | grep -q "scpper-bff"; then
    echo "📋 发现现有PM2进程，执行重启..."
    npm run pm2:restart
else
    echo "🆕 启动新的PM2进程..."
    npm run pm2:start
fi

# 4. 健康检查
echo "🔍 执行健康检查..."
sleep 5

# 检查服务是否启动
if curl -f -s http://localhost:4396/health > /dev/null; then
    echo "✅ 服务启动成功"
else
    echo "❌ 服务启动失败，检查日志:"
    npm run pm2:logs --lines 20
    exit 1
fi

# 5. 测试搜索性能
echo "🧪 测试搜索性能..."
echo "测试查询: 雕像"

START_TIME=$(date +%s%3N)
curl -s "http://localhost:4396/search?q=雕像&limit=20" > /dev/null
END_TIME=$(date +%s%3N)
DURATION=$((END_TIME - START_TIME))

echo "📊 搜索响应时间: ${DURATION}ms"

if [ $DURATION -lt 1000 ]; then
    echo "🎉 性能优化成功! 响应时间 < 1秒"
elif [ $DURATION -lt 2000 ]; then
    echo "⚡ 性能有改善，响应时间 < 2秒"  
else
    echo "⚠️  性能仍需优化，响应时间 > 2秒"
fi

# 6. 显示监控信息
echo ""
echo "📈 监控和日志:"
echo "- 健康检查: http://localhost:4396/health"
echo "- 性能指标: http://localhost:4396/metrics"
echo "- 实时日志: npm run pm2:logs"
echo ""

echo "✨ 搜索性能优化部署完成!"
echo ""
echo "📋 优化内容:"
echo "  ✅ 数据库全文搜索索引优化"
echo "  ✅ 查询语句性能优化"  
echo "  ✅ 缓存策略改进"
echo "  ✅ 查询结果限制保护"
echo ""
echo "🔗 测试优化后的搜索: http://localhost:4396/search?q=雕像&limit=20"