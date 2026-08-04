#!/usr/bin/env bash
# =====================================================================================
# checks/run_checks.sh —— 只读一致性断言(CI 红灯)
# =====================================================================================
# 与 migrations/smoke_test.sql 的分工:
#   smoke_test.sql  写路径的**行为**对不对(要写数据、末尾 ROLLBACK)
#   checks/*.sql    落地后的**结构/登记/接线**有没有漂移(纯只读,可对生产库跑)
#
# 用法:
#   ./checks/run_checks.sh --database-url postgresql://.../scpper-v2
#   ./checks/run_checks.sh                     # 用 $SYNCER2_DATABASE_URL 或 $DATABASE_URL
#   ./checks/run_checks.sh --only 0001_projection_cursor_drift.sql
#
# 任一断言失败即非零退出,并打印出错文件与 psql 原始错误。
# =====================================================================================
set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_URL=""
declare -a ONLY=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DB_URL="${2:-}"; shift 2 ;;
    --database-url=*) DB_URL="${1#*=}"; shift ;;
    --only) ONLY+=("${2:-}"); shift 2 ;;
    --only=*) ONLY+=("${1#*=}"); shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf '未知参数 %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$DB_URL" ]] || DB_URL="${SYNCER2_DATABASE_URL:-${DATABASE_URL:-}}"
[[ -n "$DB_URL" ]] || { echo "缺少连接串:--database-url 或 \$SYNCER2_DATABASE_URL" >&2; exit 2; }

# checks/ 全是只读断言,对 v1 生产库执行是安全的,因此这里**不设**库名黑名单
# (migrations/apply.sh 的黑名单是因为它写)。但仍打印目标库,避免看错报告。
target_db="${DB_URL##*/}"; target_db="${target_db%%\?*}"
printf '\033[36m[checks]\033[0m 目标库:%s\n' "$target_db"

mapfile -t FILES < <(cd "$DIR" && ls -1 [0-9]*.sql 2>/dev/null | LC_ALL=C sort)
[[ ${#FILES[@]} -gt 0 ]] || { echo "$DIR 下没有 [0-9]*.sql" >&2; exit 2; }

fail=0
for f in "${FILES[@]}"; do
  if [[ ${#ONLY[@]} -gt 0 ]]; then
    hit=0; for o in "${ONLY[@]}"; do [[ "$f" == "$o" ]] && hit=1; done
    [[ "$hit" == "1" ]] || continue
  fi
  printf '\033[36m[checks]\033[0m %s ... ' "$f"
  if out="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$DIR/$f" 2>&1)"; then
    printf '\033[32mOK\033[0m\n'
    # psql 给 -f 的诊断带 'psql:文件:行:' 前缀,所以不能锚定 ^NOTICE
    grep -E '(NOTICE|WARNING):' <<<"$out" | sed 's/^.*\((NOTICE|WARNING)\)/\1/;s/^/    /' || true
  else
    printf '\033[31mFAIL\033[0m\n'
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=1
  fi
done

if [[ "$fail" != "0" ]]; then
  printf '\033[31m[checks] 有断言失败\033[0m\n' >&2
  exit 1
fi
printf '\033[32m[checks] 全部通过\033[0m\n'
