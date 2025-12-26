#!/bin/bash
# 刷新物化视图脚本
# 建议通过 cron 每小时执行一次: 0 * * * * /path/to/refresh-materialized-views.sh

set -e

# 从 .env 文件读取数据库连接
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../.env" 2>/dev/null || true

# 如果 DATABASE_URL 未设置，使用默认值
DB_URL="${DATABASE_URL:-postgresql://user_dxzbdi:password_NxStQy@localhost:5434/scpper-cn}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Refreshing materialized views..."

psql "$DB_URL" << 'SQL'
-- 刷新站点概览物化视图
REFRESH MATERIALIZED VIEW mv_site_overview;
SELECT 'mv_site_overview refreshed at ' || NOW();
SQL

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Materialized views refreshed successfully."
