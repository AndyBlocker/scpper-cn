#!/usr/bin/env bash
# meta 下的"维护类"SQL 函数必须真的被调用。
#
# 事故：meta.ingest_gate_sweep() 早已存在且逻辑完全正确，却没有任何调用点，
# 于是 meta.ingest_gate 24 小时累积 39,443 行（其中 39,264 行无对应活事务），
# 巡检的 ingest_gate 集合长期报 critical。
#
# 这是本仓库反复出现的形态：机制写了但没接线——同类还有装饰性的
# VOTE_SWEEP_INTERVAL_DAYS、只加在全站路径而没加到 L1 真实调用链的零星失败容忍。
# 「写了」和「被用到」是两件事，只有机械检查能守住。
#
# 判据要经得起「删掉真实调用后必须失败」这一验证，本检查前两版都没做到：
#   v1 裸函数名匹配 —— 被 query 标签字符串
#      'page_scan_maintenance:ingest_gate_sweep' 骗过；
#   v2 改认调用形式 meta.fn( —— 被讲述该函数的**注释行**骗过。
# 因此现在既认调用形式，又剔除注释行。一个不会失败的检查等于没有检查。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bad=0

PATTERNS='sweep|reap|prune|maintain|cleanup|retire'

while read -r fn; do
  [ -z "$fn" ] && continue
  # 只认真实调用：meta.fn( —— 允许中间有空白。
  # -h 去掉文件名前缀，否则注释判定会被路径干扰；再剔除 * // -- /* 开头的注释行。
  if ! grep -rhE "meta\.${fn}[[:space:]]*\(" "$ROOT/src" "$ROOT/package.json" 2>/dev/null \
       | grep -vE '^[[:space:]]*(\*|//|--|/\*)' | grep -q .; then
    echo "声明了却无人调用: meta.${fn}()（维护类函数不被调用等于不存在）"
    bad=1
  fi
done < <(grep -rhoE 'CREATE (OR REPLACE )?FUNCTION meta\.[a-z0-9_]+' "$ROOT/migrations" 2>/dev/null \
         | sed -E 's/.*meta\.//' | sort -u | grep -E "$PATTERNS" || true)

if [ "$bad" -ne 0 ]; then
  echo "——「写了」不等于「被用到」；请接线或删除。"
  exit 1
fi
echo "维护类 SQL 函数均有调用点"
