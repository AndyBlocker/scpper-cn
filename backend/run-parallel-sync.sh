#!/bin/bash

# SCPPER-CN 并行数据同步脚本
# 利用多核服务器同时运行多个同步进程

echo "🚀 SCPPER-CN 并行数据同步"
echo "=========================="

# 配置
TOTAL_PAGES=30849
PARALLEL_JOBS=3  # 并行任务数量
PAGES_PER_JOB=$((TOTAL_PAGES / PARALLEL_JOBS))

echo "📊 总页面数: $TOTAL_PAGES"
echo "🔄 并行任务: $PARALLEL_JOBS"  
echo "📄 每任务页面数: $PAGES_PER_JOB"
echo ""

# 创建并行任务目录
mkdir -p parallel-sync-jobs

# 启动并行任务
for i in $(seq 1 $PARALLEL_JOBS); do
    START_PAGE=$(((i-1) * PAGES_PER_JOB))
    END_PAGE=$((i * PAGES_PER_JOB))
    
    if [ $i -eq $PARALLEL_JOBS ]; then
        END_PAGE=$TOTAL_PAGES  # 最后一个任务处理剩余页面
    fi
    
    echo "🚀 启动任务 $i: 页面 $START_PAGE - $END_PAGE"
    
    # 创建任务专用配置
    cat > parallel-sync-jobs/job$i.env << EOF
JOB_ID=$i
START_PAGE=$START_PAGE
END_PAGE=$END_PAGE
MAX_REQUESTS_PER_SECOND=0.6
DATA_DIR=./parallel-sync-jobs/job$i-data
CHECKPOINT_DIR=./parallel-sync-jobs/job$i-checkpoints
EOF
    
    # 后台启动任务
    nohup node src/sync/parallel-job-sync.js parallel-sync-jobs/job$i.env > parallel-sync-jobs/job$i.log 2>&1 &
    
    echo "   PID: $!"
    sleep 2  # 短暂延迟避免同时启动
done

echo ""
echo "✅ 所有并行任务已启动"
echo "📝 查看日志: tail -f parallel-sync-jobs/job*.log"
echo "📊 监控进度: watch 'grep 进度 parallel-sync-jobs/job*.log | tail -3'"
echo "⏹️  停止所有任务: pkill -f parallel-job-sync"