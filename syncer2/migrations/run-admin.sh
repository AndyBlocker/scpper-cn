#!/usr/bin/env bash
# scpper-v2 的 DBA 一次性动作：装扩展 + 建角色。
#
# 为什么需要它：应用账号 user_dxzbdi 有 CREATEDB，但 rolsuper=f、rolcreaterole=f，
# 所以 CREATE EXTENSION 与 CREATE ROLE 都做不了。
#
# 认证方式：本机 postgres 集群（17/main，端口 5434）走 peer 认证，
# 所以**不需要数据库密码**，只需要你自己的 sudo 密码。
# 必须在真正的终端里运行（sudo 要 tty 才能弹密码提示）。
#
# 安全性：只作用于 scpper-v2 新库；生产库 scpper-cn / scpper-syncer / scpper_user 一个字节都不碰。
# 建的 5 个角色是 NOLOGIN 组角色（不带密码、本身连不上库），不新增任何可登录入口。
# 全部幂等，可反复重跑。
set -euo pipefail

DB="scpper-v2"
PORT=5434
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLES_SQL="$HERE/9001_create_roles.sql.ADMIN"

[[ -r "$ROLES_SQL" ]] || { echo "找不到角色脚本: $ROLES_SQL" >&2; exit 1; }

echo "即将在 $DB (port $PORT) 上执行："
echo "  1) CREATE EXTENSION pgroonga  —— 消掉「切流当天全文搜索直接 500」的风险"
echo "  2) CREATE EXTENSION vector    —— serve.chunk_embedding 表依赖它"
echo "  3) 5 个 NOLOGIN 组角色（bff/ingestor/projector/avatar_worker/migration）"
echo
echo "下面会要求输入【你自己的 sudo 密码】，不是 postgres 数据库密码。"
echo

# 用管道而不是 psql -f：/home/andyblocker 是 750，postgres 用户无法进入，
# 但 cat 是以当前用户身份读的，所以这样可行。
{
  echo "CREATE EXTENSION IF NOT EXISTS pgroonga;"
  echo "CREATE EXTENSION IF NOT EXISTS vector;"
  cat "$ROLES_SQL"
  echo "\\echo ''"
  echo "\\echo '=== 验收：扩展（应有 pgroonga / vector 两行）==='"
  echo "SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgroonga','vector') ORDER BY 1;"
  echo "\\echo '=== 验收：角色（应有 5 行）==='"
  echo "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('bff_role','ingestor_role','projector_role','avatar_worker_role','migration_role') ORDER BY 1;"
} | sudo -u postgres psql -p "$PORT" -d "$DB" -v ON_ERROR_STOP=1

echo
echo "✅ 完成。回到 Claude Code 说一声，我会接着做："
echo "   · 重跑 apply.sh（幂等，一次补齐之前跳过的四处 GRANT 段）"
echo "   · 把 6 条 skip 的权限测试转成真断言（重点验 bff_role 写事实表被 42501 拒）"
echo "   · 用 pgroonga 索引替换降级的 7 条 *_trgm 索引，并补建 serve.chunk_embedding"
