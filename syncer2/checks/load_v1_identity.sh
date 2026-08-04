#!/usr/bin/env bash
# =====================================================================================
# load_v1_identity.sh —— 把 v1 身份 id 集合单向搬进 scpper-v2 的 meta.v1_identity
# =====================================================================================
# 它是 checks/backfill_finalize.sql 的**输入生产者**。
#
# 为什么需要它（而不是在 gate 里直接跨库查）
#   dblink / postgres_fdw 都不是 trusted extension，`CREATE EXTENSION dblink` 实测：
#       ERROR:  permission denied to create extension "dblink"
#       HINT:   Must be superuser to create this extension.
#   当前账号 user_dxzbdi rolsuper=f。所以跨库断言的证据只能靠「在 v1 上 SELECT，
#   把结果 COPY 进 v2」这条单向管道落地。
#
# 对 v1 的写保护（四道）
#   1. 源连接 startup packet 强制 `default_transaction_read_only=on`；
#   2. 对 v1 只发 `COPY (SELECT ...) TO STDOUT` 与 `SELECT count(*)`，没有任何 DML/DDL；
#   3. 目标库名黑名单：拒绝把 scpper-cn / scpper_cn / scpper-syncer / scpper_user 当**目标**；
#   4. 源库名白名单：源必须是 scpper-cn / scpper_cn（page/user）或 scpper_user（gacha），
#      且源 ≠ 目标（自己灌自己等于零信息量，gate 的 A0.4 也会拒）。
#
# 用法
#   ./load_v1_identity.sh                                    # 四族全灌，连接串从环境变量取
#   ./load_v1_identity.sh --entities page,user               # 只灌指定族
#   ./load_v1_identity.sh --v1-database-url ... \
#                         --user-database-url ... \
#                         --target-database-url ...
#   ./load_v1_identity.sh --dry-run                          # 只做连通性与计数，不写目标库
#
# 环境变量回落顺序
#   目标：--target-database-url → $SYNCER2_DATABASE_URL
#   v1  ：--v1-database-url     → $V1_DATABASE_URL → $DATABASE_URL
#   用户库：--user-database-url → $USER_DATABASE_URL
#
# 幂等：每族先 DELETE 后 COPY，元数据行走 ON CONFLICT (entity) DO UPDATE，
#       整族在**一个事务**里完成 —— 半截的暂存表会让 gate 的 A0.5 判失败，
#       但更希望它根本不出现，所以这里用事务而不是靠 gate 兜。
# =====================================================================================
set -Eeuo pipefail

TARGET_URL="${SYNCER2_DATABASE_URL:-}"
V1_URL="${V1_DATABASE_URL:-${DATABASE_URL:-}}"
USER_URL="${USER_DATABASE_URL:-}"
ENTITIES="page,user,gacha_page_ref,vote_anon"
DRY_RUN=0

PROTECTED_AS_TARGET=("scpper-cn" "scpper_cn" "scpper-syncer" "scpper_user")

die()  { printf '\033[31m[load_v1_identity] %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m[load_v1_identity]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[load_v1_identity]\033[0m %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-database-url) TARGET_URL="${2:-}"; shift 2 ;;
    --target-database-url=*) TARGET_URL="${1#*=}"; shift ;;
    --v1-database-url) V1_URL="${2:-}"; shift 2 ;;
    --v1-database-url=*) V1_URL="${1#*=}"; shift ;;
    --user-database-url) USER_URL="${2:-}"; shift 2 ;;
    --user-database-url=*) USER_URL="${1#*=}"; shift ;;
    --entities) ENTITIES="${2:-}"; shift 2 ;;
    --entities=*) ENTITIES="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "未知参数 $1（--help 看用法）" ;;
  esac
done

# 从连接串尾部取库名，URL 解码 %XX（防 'scpper%2Dcn' 绕过黑名单）
dbname_of() {
  local raw="${1##*/}"; raw="${raw%%\?*}"
  printf '%b' "${raw//%/\\x}"
}

[[ -n "$TARGET_URL" ]] || die "缺目标连接串：给 --target-database-url 或设 SYNCER2_DATABASE_URL"
TARGET_DB="$(dbname_of "$TARGET_URL")"
[[ -n "$TARGET_DB" ]] || die "无法从目标连接串解析出库名"
for p in "${PROTECTED_AS_TARGET[@]}"; do
  [[ "$TARGET_DB" == "$p" ]] && die "拒绝把受保护库 '$TARGET_DB' 当作写入目标（v1 生产库/用户库只读）"
done
info "目标库: $TARGET_DB"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# -------------------------------------------------------------------------------------
# load_one <entity> <源连接串> <允许的源库名(空格分隔)> <COPY 的 SELECT> <count 的 SELECT>
# -------------------------------------------------------------------------------------
load_one() {
  local entity="$1" src_url="$2" allowed="$3" sel="$4" cnt_sql="$5"
  local src_db expected actual

  [[ -n "$src_url" ]] || die "entity=$entity 缺源连接串"
  src_db="$(dbname_of "$src_url")"
  [[ "$src_db" != "$TARGET_DB" ]] || die "entity=$entity 的源库与目标库同名（$src_db）—— 自己灌自己等于零信息量"

  local hit=0
  for a in $allowed; do [[ "$src_db" == "$a" ]] && hit=1; done
  [[ "$hit" == "1" ]] || die "entity=$entity 的源库 '$src_db' 不在白名单（$allowed）"

  # ① v1 侧独立 count（gate 的 A0.5 拿它跟实际行数对账，所以必须是独立的一次查询，
  #    不能用 COPY 的返回行数 —— 那样「COPY 被截断」这件事就自证清白了）
  expected="$(
    PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=0' \
      psql "$src_url" --no-psqlrc -Atc "$cnt_sql"
  )"
  [[ "$expected" =~ ^[0-9]+$ ]] || die "entity=$entity 在 $src_db 上的 count 返回了非数字：$expected"
  info "entity=$entity  源=$src_db  v1 侧 count=$expected"

  # ② 只读导出（CSV：slug 里可能带逗号/引号，CSV 的 quoting 比 text 格式的反斜杠转义稳）
  PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=0' \
    psql "$src_url" --no-psqlrc --set=ON_ERROR_STOP=1 \
       -c "COPY ($sel) TO STDOUT WITH (FORMAT csv)" > "$WORK/$entity.csv"
  actual="$(wc -l < "$WORK/$entity.csv" | tr -d ' ')"
  info "entity=$entity  导出 $actual 行 → $WORK/$entity.csv"

  if [[ "$DRY_RUN" == "1" ]]; then
    ok "entity=$entity dry-run：未写目标库"
    return 0
  fi

  # ③ 目标库单事务：DELETE → \copy → upsert 元数据
  psql "$TARGET_URL" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 <<SQL
BEGIN;
DELETE FROM meta.v1_identity WHERE entity = '$entity';
\copy meta.v1_identity(entity, v1_id, wikidot_id, detail) FROM '$WORK/$entity.csv' WITH (FORMAT csv)
INSERT INTO meta.v1_identity_load(entity, source_database, expected_rows, loaded_at, note)
VALUES ('$entity', '$src_db', $expected, now(),
        'load_v1_identity.sh / CSV 单向 COPY（dblink 需 superuser，见 0100_backfill_gate.sql 文件头）')
ON CONFLICT (entity) DO UPDATE
   SET source_database = EXCLUDED.source_database,
       expected_rows   = EXCLUDED.expected_rows,
       loaded_at       = EXCLUDED.loaded_at,
       loader          = current_user,
       note            = EXCLUDED.note;
COMMIT;
SQL
  ok "entity=$entity 已载入（expected_rows=$expected）"
}

has_entity() { [[ ",$ENTITIES," == *",$1,"* ]]; }

# -------------------------------------------------------------------------------------
# page —— v1 public."Page"
# -------------------------------------------------------------------------------------
# detail 里带 currentUrl 只为报错时能定位到具体页面；断言本身不读它。
# 列名用双引号：v1 是 Prisma 生成的 camelCase 标识符。
if has_entity page; then
  load_one page "$V1_URL" "scpper-cn scpper_cn" \
    "SELECT 'page', p.id, p.\"wikidotId\",
            jsonb_build_object('url', p.\"currentUrl\", 'deleted', p.\"isDeleted\")
       FROM public.\"Page\" p ORDER BY p.id" \
    "SELECT count(*) FROM public.\"Page\""
fi

# -------------------------------------------------------------------------------------
# user —— v1 public."User"
# -------------------------------------------------------------------------------------
# 【2026-07-27 实测】37,455 行；1,097 行 wikidotId IS NULL；0 行 id = wikidotId
# （User.id 是独立自增，不是 wikidotId 的别名）；max(id)=282,240,277。
# detail 带 isGuest：gate 的 A2.4 判 kind 归类时，人工排查要靠它对上 v1 的原始形态。
if has_entity user; then
  load_one user "$V1_URL" "scpper-cn scpper_cn" \
    "SELECT 'user', u.id, u.\"wikidotId\",
            jsonb_build_object('display', u.\"displayName\", 'guest', u.\"isGuest\")
       FROM public.\"User\" u ORDER BY u.id" \
    "SELECT count(*) FROM public.\"User\""
fi

# -------------------------------------------------------------------------------------
# vote_anon —— S1 的第三条硬断言
# -------------------------------------------------------------------------------------
# 正常基线是 0 行。仍然走与身份集合相同的「独立 count + COPY + load metadata」：
# expected_rows=0 明确表示“在 v1 查过且结果为零”，而不是没载入造成的真空通过。
if has_entity vote_anon; then
  load_one vote_anon "$V1_URL" "scpper-cn scpper_cn" \
    "SELECT 'vote_anon', v.id, NULL::int,
            jsonb_build_object('pageVersionId', v.\"pageVersionId\",
                               'userId', v.\"userId\",
                               'anonKey', v.\"anonKey\")
       FROM public.\"Vote\" v
      WHERE v.\"anonKey\" IS NOT NULL
      ORDER BY v.id" \
    "SELECT count(*) FROM public.\"Vote\" WHERE \"anonKey\" IS NOT NULL"
fi

# -------------------------------------------------------------------------------------
# gacha_page_ref —— scpper_user public."GachaCardDefinition"."pageId" 的 distinct 集合
# -------------------------------------------------------------------------------------
# 这一族是「ingest.page.id 一一对应」承诺的债主：卡片定义按 v1 Page.id 软引用页面，
# 一旦 v2 少一个 id 或错位，卡片就指向别的页面（或空气）。
# 【2026-07-27 实测】82,184 张卡定义 / 36,957 个 distinct pageId / [301, 106804]。
if has_entity gacha_page_ref; then
  if [[ -z "$USER_URL" ]]; then
    die "entity=gacha_page_ref 是 strict 必需输入；请给 --user-database-url 或 USER_DATABASE_URL"
  else
    load_one gacha_page_ref "$USER_URL" "scpper_user" \
      "SELECT 'gacha_page_ref', d.\"pageId\", NULL::int,
              jsonb_build_object('cards', count(*))
         FROM public.\"GachaCardDefinition\" d
        WHERE d.\"pageId\" IS NOT NULL
        GROUP BY d.\"pageId\" ORDER BY d.\"pageId\"" \
      "SELECT count(DISTINCT \"pageId\") FROM public.\"GachaCardDefinition\" WHERE \"pageId\" IS NOT NULL"
  fi
fi

# -------------------------------------------------------------------------------------
if [[ "$DRY_RUN" == "1" ]]; then
  ok "dry-run 完成，目标库未被写入"
  exit 0
fi

info "载入结果："
psql "$TARGET_URL" --no-psqlrc -c \
  "SELECT l.entity, l.source_database, l.expected_rows,
          (SELECT count(*) FROM meta.v1_identity i WHERE i.entity = l.entity) AS actual_rows,
          l.loaded_at
     FROM meta.v1_identity_load l ORDER BY l.entity;"

ok "完成。下一步：psql \"\$SYNCER2_DATABASE_URL\" -f checks/backfill_finalize.sql"
