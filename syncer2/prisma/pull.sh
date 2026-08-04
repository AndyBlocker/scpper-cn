#!/usr/bin/env bash
# =====================================================================================
# prisma/pull.sh —— scpper-v2 的 Prisma schema 重新introspect（TODO #9 的唯一入口）
# =====================================================================================
# 为什么不能直接跑 `npx prisma db pull`：
#   2026-07-27 实测的一条不对称行为 ——
#     ✓ re-introspection 保留人工改过的**关系字段名**（24 处重命名重跑后全部存活）；
#     ✗ 但会把 schema.prisma 顶部的 `//` 注释块**整块删掉**（顶部 `//` 不属于 Prisma AST
#       的任何节点，重写文件时不落盘；只有挂在 model/field 上的 `///` 会保留）。
#   那个注释块里装着 7 条「Prisma 表达不了什么」的降级说明和「本文件不可用于 migrate」的红线。
#   静默丢掉它 = 下一个人照着 schema.prisma 跑 prisma migrate，把分区表和 8 条部分唯一索引
#   一起做掉。所以：注释块的权威副本放在 prisma/schema.header.prisma，本脚本每次拼回去。
#
# 用法
#   cd syncer2 && ./prisma/pull.sh                     # 用 $SYNCER2_DATABASE_URL
#   cd syncer2 && ./prisma/pull.sh --check             # 只校验，不 pull（CI 用）
#
# 做的四件事：
#   1. prisma db pull
#   2. 把 schema.header.prisma 拼回文件头（db pull 会把 generator/datasource 提到最前，
#      所以是「header + pull 出来的全文」这个顺序，不需要重排块）
#   3. format + validate + generate
#   4. 报告新出现的 `...To<Model>` 丑关系名（新表的多重外键会再次生成，需要人工命名）
# =====================================================================================
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SCHEMA="$HERE/schema.prisma"
HEADER="$HERE/schema.header.prisma"
CHECK_ONLY=0

[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

die()  { printf '\033[31m[prisma/pull]\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m[prisma/pull]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[prisma/pull]\033[0m %s\n' "$*"; }

[[ -f "$HEADER" ]] || die "缺 $HEADER（注释块的权威副本，丢了就等于丢了全部降级说明）"
cd "$ROOT"

# 目标库安全闸：Prisma 的 db pull 只读，但 generate/migrate 不是，别让连接串指错库
DB="${SYNCER2_DATABASE_URL:-}"
[[ -n "$DB" ]] || die "缺 SYNCER2_DATABASE_URL"
raw="${DB##*/}"; raw="${raw%%\?*}"; target="$(printf '%b' "${raw//%/\\x}")"
for p in scpper-cn scpper_cn scpper-syncer scpper_user; do
  [[ "$target" == "$p" ]] && die "SYNCER2_DATABASE_URL 指向受保护库 '$target'，拒绝执行"
done
info "目标库: $target"

if [[ "$CHECK_ONLY" == "0" ]]; then
  info "① prisma db pull"
  npx prisma db pull --schema "$SCHEMA"

  info "② 拼回注释块（db pull 刚把它删掉了）"
  if ! grep -q '绝不可用于 prisma migrate' "$SCHEMA"; then
    tmp="$(mktemp)"
    cat "$HEADER" "$SCHEMA" > "$tmp"
    mv "$tmp" "$SCHEMA"
    ok "   注释块已拼回"
  else
    ok "   注释块仍在（db pull 行为变了？那就顺手把本脚本 §② 删掉）"
  fi

  info "③ format"
  npx prisma format --schema "$SCHEMA" >/dev/null
fi

info "④ validate + generate"
npx prisma validate --schema "$SCHEMA"
npx prisma generate --schema "$SCHEMA"

# ---- 一致性自检 ---------------------------------------------------------------------
info "⑤ 自检"

# 5.1 注释块必须在（红线说明不能丢）
grep -q '绝不可用于 prisma migrate' "$SCHEMA" \
  || die "schema.prisma 里找不到红线注释块 —— 直接跑过 db pull 了？重跑本脚本"

# 5.2 model 数 == 库里非分区表数（少了就是 pull 漏表，多了就是库里删了表而 schema 没跟上）
n_model="$(grep -c '^model ' "$SCHEMA")"
n_table="$(psql "$DB" --no-psqlrc -Atc "
  select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('ingest','serve','meta','app')
     and c.relkind in ('r','p') and not c.relispartition")"
if [[ "$n_model" != "$n_table" ]]; then
  die "model 数 $n_model ≠ 库里非分区表数 $n_table（pull 漏表 / 库里有表被删）"
fi
ok "   model 数 = 非分区表数 = $n_model"

# 5.3 分区子表绝不能出现在 schema 里（vote_event_p0000 这类进来会让 Prisma 以为是独立实体）
# relispartition 对分区**索引**也为真，所以必须加 relkind='r'，否则这里会打印一屏索引名
parts="$(psql "$DB" --no-psqlrc -Atc "
  select string_agg(c.relname, ' ') from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('ingest','serve','meta','app')
     and c.relispartition and c.relkind = 'r'")"
for p in ${parts:-}; do
  grep -q "^model ${p} " "$SCHEMA" && die "分区子表 $p 混进了 schema.prisma"
done
ok "   分区子表未混入（${parts:-无}）"

# 5.4 新出现的丑关系名
ugly="$(grep -oE '^\s+[a-z0-9_]*_[a-z0-9_]+To[A-Za-z_]+' "$SCHEMA" | sed 's/^ *//' || true)"
if [[ -n "$ugly" ]]; then
  printf '\033[33m[prisma/pull] ⚠ 新的 db pull 默认关系名（建议改成语义名）：\033[0m\n'
  printf '  %s\n' $ugly
else
  ok "   无 db pull 默认丑关系名"
fi

ok "完成：$SCHEMA"
