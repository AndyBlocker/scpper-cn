#!/usr/bin/env bash
# 防 GIT_DIR 污染：本脚本会被 pre-push 钩子调用（见 .githooks/pre-push 注释）。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
# deploy 与 pre-push 共用的唯一门禁入口。只读检查，不应用任何 migration。
set -Eeuo pipefail

SYNCER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKS_DIR="$SYNCER_ROOT/checks"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
用法: deploy/run-gates.sh

依次运行 npx tsc --noEmit、npm test、全部 numbered SQL checks 与 shell checks。
测试和 SQL checks 依赖部署机 localhost:5434 的 scpper-v2 活库。
本命令不会执行 migrations；任一步失败立即非零退出。
EOF
  exit 0
fi
[[ $# -eq 0 ]] || { echo "未知参数: $1" >&2; exit 2; }

load_database_url() {
  if [[ -n "${SYNCER2_DATABASE_URL:-}" ]]; then
    printf '%s' "$SYNCER2_DATABASE_URL"
    return
  fi
  local line value
  line="$(grep -m1 -E '^SYNCER2_DATABASE_URL=' "$SYNCER_ROOT/.env" 2>/dev/null || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

DB_URL="$(load_database_url)" || {
  echo "缺少 SYNCER2_DATABASE_URL（环境或 syncer2/.env）" >&2
  exit 2
}
db_name="${DB_URL##*/}"; db_name="${db_name%%\?*}"
port="$(sed -E 's#^[^:]+://[^@/]+@[^:/]+:([0-9]+)/.*#\1#' <<<"$DB_URL")"
if [[ "$db_name" != "scpper-v2" || "$port" != "5434" ]]; then
  echo "拒绝门禁：目标必须是 localhost:5434/scpper-v2（当前 ${port:-?}/${db_name:-?}）" >&2
  exit 2
fi
export SYNCER2_DATABASE_URL="$DB_URL"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[gate] start=%s db=%s port=%s\n' "$started_at" "$db_name" "$port"

cd "$SYNCER_ROOT"
printf '[gate] npx tsc --noEmit\n'
npx tsc --noEmit

printf '[gate] npm test\n'
npm test

printf '[gate] numbered SQL checks\n'
"$CHECKS_DIR/run_checks.sh" --database-url "$DB_URL"

printf '[gate] numbered shell checks\n'
while IFS= read -r check; do
  printf '[gate] %s\n' "$(basename "$check")"
  bash "$check"
done < <(find "$CHECKS_DIR" -maxdepth 1 -type f -name '[0-9]*.sh' -print | LC_ALL=C sort)

printf '[gate] PASS start=%s finish=%s\n' "$started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
