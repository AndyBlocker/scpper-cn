#!/bin/bash

# SCPPER-CN 代码清理脚本
# 安全清理废弃的archive脚本和临时文件

echo "🧹 SCPPER-CN 代码清理开始"
echo "=================================="

# 检查当前目录
if [ ! -f "package.json" ]; then
    echo "❌ 错误: 请在backend根目录运行此脚本"
    exit 1
fi

# 显示当前archive目录状态
echo "📁 当前archive目录状态:"
if [ -d "src/sync/archive" ]; then
    echo "   文件数量: $(ls src/sync/archive/*.js 2>/dev/null | wc -l)"
    echo "   目录大小: $(du -sh src/sync/archive/ 2>/dev/null | cut -f1)"
    ls -la src/sync/archive/
else
    echo "   ❌ archive目录不存在"
    exit 0
fi

echo ""
echo "🗂️  将要清理的废弃脚本:"
echo "   ├── diagnose-users.js (用户问题诊断 - 已解决)"
echo "   ├── fixed-resume-pull.js (断点续传修复版本)"  
echo "   ├── optimized-full-pull.js (被full-data-pull.js替代)"
echo "   ├── optimized-sync.js (被database-sync.js替代)"
echo "   ├── rate-limited-pull.js (频率控制已集成到主脚本)"
echo "   ├── resume-pull.js (断点续传已集成到主脚本)"
echo "   └── test-full-sync.js (被final-sync.js替代)"

echo ""
read -p "🤔 是否继续清理? (y/N): " confirm

if [[ $confirm != [yY] && $confirm != [yY][eE][sS] ]]; then
    echo "❌ 取消清理操作"
    exit 0
fi

# 创建备份
backup_dir="/tmp/scpper-archive-backup-$(date +%Y%m%d-%H%M%S)"
echo ""
echo "💾 创建备份: $backup_dir"
cp -r src/sync/archive "$backup_dir"

if [ $? -eq 0 ]; then
    echo "✅ 备份创建成功"
else
    echo "❌ 备份创建失败，停止清理"
    exit 1
fi

# 删除archive目录
echo ""
echo "🗑️  删除archive目录..."
rm -rf src/sync/archive/

if [ $? -eq 0 ]; then
    echo "✅ archive目录已删除"
else
    echo "❌ 删除失败"
    exit 1
fi

# 清理其他临时文件
echo ""
echo "🧹 清理其他临时文件..."

# 清理旧的同步报告 (保留最新的5个)
if [ -d "user-analysis" ]; then
    echo "   清理旧的用户分析文件..."
    cd user-analysis
    ls -t user-analysis-*.json 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
    ls -t rankings-*.json 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null
    cd ..
fi

# 清理旧的checkpoint文件 (保留最新的10个)
if [ -d "resume-sync-data" ]; then
    echo "   清理旧的checkpoint文件..."
    cd resume-sync-data
    ls -t checkpoint-*.json 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null
    ls -t raw-batch-*.json 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null
    cd ..
fi

echo ""
echo "🎉 清理完成!"
echo "=================================="
echo "✅ 删除的文件:"
echo "   - src/sync/archive/ (7个废弃脚本)"
echo "   - 旧的用户分析文件 (保留最新5个)"  
echo "   - 旧的checkpoint文件 (保留最新10个)"
echo ""
echo "💾 备份位置: $backup_dir"
echo "📝 如需恢复: cp -r $backup_dir ./src/sync/archive"
echo ""
echo "📊 磁盘空间节省:"
du -sh "$backup_dir" 2>/dev/null | cut -f1 | xargs echo "   大约:"

echo ""
echo "🚀 建议下一步:"
echo "   1. 验证核心脚本正常运行:"
echo "      node src/sync/database-sync.js --dry-run"
echo "   2. 查看清理后的目录结构:"
echo "      tree src/sync/"
echo "   3. 更新文档:"
echo "      git add -A && git commit -m 'Clean up archived sync scripts'"