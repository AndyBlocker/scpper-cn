#!/usr/bin/env bash
# =====================================================================================
# apply.sh —— scpper-v2 迁移执行器
# =====================================================================================
# 按编号顺序把 syncer2/migrations/ 下的迁移应用到目标库,遇错即停并打印
# 「出错文件 + 行号 + 原始 psql 错误」。
#
# 用法:
#   ./apply.sh --database-url postgresql://user:pass@host:port/scpper-v2
#   ./apply.sh                                  # 用 $SYNCER2_DATABASE_URL 或 $DATABASE_URL
#   ./apply.sh --dry-run                        # 只打印将要执行的文件顺序
#   ./apply.sh --only 0006_functions.sql        # 只跑一个文件(可重复给)
#   ./apply.sh --skip 0005_indexes_pgroonga.sql # 跳过某个文件(可重复给)
#   ./apply.sh --smoke                          # 迁移后追加执行 smoke_test.sql
#   ./apply.sh --quiet                          # 只打印摘要与错误
#
# 执行顺序(数字前缀即顺序;`*.ADMIN` 一律不执行):
#   0001_ingest   → 0002_serve → 0003_meta → 0004_app
#   → 0005_indexes_pgroonga → 0006_functions
# 依赖关系:
#   0002 断言 0001 已跑;0004 的外键锚在 ingest.*;0005 用 to_regclass 守卫可乱序;
#   0006 断言 0001+0002 已跑,并且**必须**在 0003 之后 —— 它写 meta.* 的若干表,
#   而 CREATE TABLE IF NOT EXISTS 不会给已存在的表补列(顺序颠倒会永久缺列)。
#
# 9000_roles_grants.sql.ADMIN 需要 superuser / CREATEROLE,由 DBA 单独执行,
# 本脚本刻意不碰它(扩展名 .ADMIN 就是这个约定的物理载体)。
# =====================================================================================
set -Eeuo pipefail

MIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_URL=""
DRY_RUN=0
SMOKE=0
QUIET=0
declare -a ONLY=()
declare -a SKIP=()

# v1 生产库 + 用户库:绝不允许被当成目标(第二道闸;第一道在各 SQL 文件头部的 DO 块里)
PROTECTED_DBS=("scpper-cn" "scpper_cn" "scpper-syncer" "scpper_user")

die() { printf '\033[31m[apply.sh] %s\033[0m\n' "$*" >&2; exit 1; }
info() { [[ "$QUIET" == "1" ]] || printf '\033[36m[apply.sh]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[apply.sh]\033[0m %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url) DB_URL="${2:-}"; shift 2 ;;
    --database-url=*) DB_URL="${1#*=}"; shift ;;
    --only) ONLY+=("${2:-}"); shift 2 ;;
    --only=*) ONLY+=("${1#*=}"); shift ;;
    --skip) SKIP+=("${2:-}"); shift 2 ;;
    --skip=*) SKIP+=("${1#*=}"); shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --smoke) SMOKE=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "未知参数 $1(--help 看用法)" ;;
  esac
done

[[ -n "$DB_URL" ]] || DB_URL="${SYNCER2_DATABASE_URL:-${DATABASE_URL:-}}"
[[ -n "$DB_URL" ]] || die "缺少连接串:给 --database-url,或设 SYNCER2_DATABASE_URL / DATABASE_URL"

# ---- 目标库名安全闸 -----------------------------------------------------------------
# 从连接串尾部取 dbname(去掉 ?query),URL 解码 %XX 以防 'scpper%2Dcn' 绕过。
raw_db="${DB_URL##*/}"; raw_db="${raw_db%%\?*}"
target_db="$(printf '%b' "${raw_db//%/\\x}")"
for p in "${PROTECTED_DBS[@]}"; do
  [[ "$target_db" == "$p" ]] && die "拒绝对受保护库 '$target_db' 执行迁移(v1 生产库/用户库只读)"
done
[[ -n "$target_db" ]] || die "无法从连接串解析出数据库名"

# ---- 收集迁移文件 -------------------------------------------------------------------
mapfile -t ALL < <(cd "$MIG_DIR" && ls -1 [0-9]*.sql 2>/dev/null | LC_ALL=C sort)
[[ ${#ALL[@]} -gt 0 ]] || die "$MIG_DIR 下没有 [0-9]*.sql"

declare -a FILES=()
for f in "${ALL[@]}"; do
  if [[ ${#ONLY[@]} -gt 0 ]]; then
    hit=0; for o in "${ONLY[@]}"; do [[ "$f" == "$o" ]] && hit=1; done
    [[ "$hit" == "1" ]] || continue
  fi
  skip=0; for s in "${SKIP[@]}"; do [[ "$f" == "$s" ]] && skip=1; done
  [[ "$skip" == "1" ]] && { info "跳过 $f(--skip)"; continue; }
  FILES+=("$f")
done
[[ ${#FILES[@]} -gt 0 ]] || die "过滤后没有要执行的文件"

info "目标库: $target_db"
info "执行顺序: ${FILES[*]}"
if [[ "$DRY_RUN" == "1" ]]; then ok "dry-run,未执行任何 SQL"; exit 0; fi

# ---- 逐个执行 -----------------------------------------------------------------------
# ON_ERROR_STOP=1 → 首个错误即退出且非零;psql 的错误行前缀形如
#   psql:/abs/path/0006_functions.sql:1234: ERROR:  ...
# 就是「出错文件 + 行号」。
run_one() {
  local path="$1" label="$2" echo_all="${3:-0}" log rc
  log="$(mktemp)"
  set +e
  psql "$DB_URL" \
       --set=ON_ERROR_STOP=1 \
       --no-psqlrc --quiet \
       --echo-errors \
       --file "$path" >"$log" 2>&1
  rc=$?
  set -e

  if [[ $rc -ne 0 ]]; then
    printf '\033[31m[apply.sh] ✗ %s 失败(psql exit=%d)\033[0m\n' "$label" "$rc" >&2
    # 先把 ERROR/DETAIL/HINT 单独拎出来 —— --echo-errors 会把整条失败语句(可能是上百行的
    # 函数体)也打出来,直接 tail 会把真正的错误行冲掉。
    local first loc
    first="$(grep -m1 -E '^psql:[^:]*:[0-9]+: ERROR' "$log" || true)"
    if [[ -n "$first" ]]; then
      loc="$(sed -E 's/^psql:(.*):([0-9]+): ERROR.*/\1 第 \2 行/' <<<"$first")"
      printf '\033[31m[apply.sh]   出错位置: %s\033[0m\n' "$loc" >&2
    fi
    printf -- '---------------- 错误摘要 ----------------\n' >&2
    grep -E ': (ERROR|FATAL|PANIC|DETAIL|HINT|CONTEXT):' "$log" | head -n 20 >&2 || true
    printf -- '---------------- psql 输出(尾 30 行)----------------\n' >&2
    tail -n 30 "$log" >&2
    printf -- '-----------------------------------------------------\n' >&2
    printf '\033[31m[apply.sh] 完整日志已保留: %s\033[0m\n' "$log" >&2
    exit 1
  fi

  if [[ "$echo_all" == "1" ]]; then
    # 冒烟报告必须原样打出来 —— 「全绿」这句话不能只存在于一个被丢掉的临时文件里
    cat "$log"
  elif [[ "$QUIET" != "1" ]]; then
    # 成功路径:把 WARNING/NOTICE 透出来(0005 的降级、0006 的 GRANT 跳过都靠它可见)
    grep -E '^(WARNING|NOTICE|psql:.*(WARNING|NOTICE))' "$log" | sed 's/^/    /' || true
  fi
  rm -f "$log"
  ok "✓ $label"
}

for f in "${FILES[@]}"; do
  info "→ $f"
  run_one "$MIG_DIR/$f" "$f"
done

if [[ "$SMOKE" == "1" ]]; then
  [[ -f "$MIG_DIR/smoke_test.sql" ]] || die "找不到 $MIG_DIR/smoke_test.sql"
  info "→ smoke_test.sql(全部写入在文件末 ROLLBACK,不留测试数据)"
  run_one "$MIG_DIR/smoke_test.sql" "smoke_test.sql" 1
fi

# ---- 收尾自检 -----------------------------------------------------------------------
psql "$DB_URL" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 <<'SQL'
\pset footer off
\echo '--- schema / 对象计数 ---'
SELECT n.nspname AS schema,
       count(*) FILTER (WHERE c.relkind IN ('r','p')) AS tables,
       count(*) FILTER (WHERE c.relkind = 'i')        AS indexes
  FROM pg_namespace n
  LEFT JOIN pg_class c ON c.relnamespace = n.oid
 WHERE n.nspname IN ('ingest','serve','meta','app')
 GROUP BY 1 ORDER BY 1;
\echo '--- 函数数(ingest+meta)---'
SELECT n.nspname AS schema, count(*) AS functions,
       count(*) FILTER (WHERE p.prosecdef) AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('ingest','serve','meta') GROUP BY 1 ORDER BY 1;
\echo '--- 负向断言:SECURITY DEFINER 函数不得对 PUBLIC 可执行(期望 0)---'
SELECT count(*) AS public_executable
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('ingest','meta') AND p.prosecdef
   AND has_function_privilege('public', p.oid, 'EXECUTE');
SQL

ok "全部迁移已应用到 $target_db"
