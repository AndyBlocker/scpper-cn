#!/usr/bin/env bash
# =====================================================================================
# extract-fetch.sh —— 为 extract-vs-crom.ts 准备离线输入（TODO #8 的实测数据采集）
# =====================================================================================
# 产出（全部落在 experiments/data/extract/，该目录已被 .gitignore）：
#   sample.txt    pv|bucket|textlen|slug   —— 分层抽样的 100 页
#   v1text.csv    id,textContent           —— 主库导出（**只读**）
#   chunks.tsv    pv \t ci \t cs \t ce     —— 主库 PageEmbedding 真实分块边界
#   html/<pv>.html                          —— 整页 HTML（走代理 + UA + Referer）
#
# 请求预算：抽样 100 页 ⇒ 100 次 GET（脚本会跳过已存在的文件，可断点续跑）。
#
# 用法：
#   V1_DATABASE_URL=postgresql://…/scpper-cn ./extract-fetch.sh            # 全流程
#   V1_DATABASE_URL=… ./extract-fetch.sh sample|export|fetch               # 单步
#
# 主库只读保证：本脚本只发 SELECT / \copy … TO，不含任何写语句。
# =====================================================================================
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/data/extract"
mkdir -p "$OUT/html"

: "${V1_DATABASE_URL:?需要主库（scpper-cn）连接串，只读使用}"
# 出口与请求头：与 src/http/client.ts 的硬契约一致（空 UA → 503；缺 Referer → TCP reset）
PROXY="${SYNCER2_HTTP_PROXY:-http://127.0.0.1:7891}"
UA="${SYNCER2_USER_AGENT:-scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)}"
REFERER="${SYNCER2_REFERER:-https://scp-wiki-cn.wikidot.com/}"
BASE="${SYNCER2_SITE_BASE_URL:-https://scp-wiki-cn.wikidot.com}"

step_sample() {
  # 分层抽样：按正文长度 5 层各 20 页；只取「当前态 + 未删除 + 有 textContent + 有 embedding」，
  # 排除 deleted:/fragment: 前缀（前者取不到页面，后者不是独立页）。
  # 层内用 md5(slug) 排序而不是 random()，保证可复现。
  psql "$V1_DATABASE_URL" -At -F'|' -c "
    WITH live AS (
      SELECT v.id pv, length(v.\"textContent\") tlen,
             replace(replace(p.\"currentUrl\",'http://scp-wiki-cn.wikidot.com/',''),
                     'https://scp-wiki-cn.wikidot.com/','') slug
        FROM \"PageVersion\" v JOIN \"Page\" p ON p.id = v.\"pageId\"
       WHERE v.\"validTo\" IS NULL AND v.\"isDeleted\" = false
         AND v.\"textContent\" IS NOT NULL
         AND p.\"currentUrl\" NOT LIKE '%deleted:%'
         AND p.\"currentUrl\" NOT LIKE '%fragment:%'
         AND EXISTS (SELECT 1 FROM \"PageEmbedding\" e WHERE e.\"pageVersionId\" = v.id)
    ), b AS (
      SELECT *,
             CASE WHEN tlen<1500 THEN 'b1_lt1500' WHEN tlen<4000  THEN 'b2_1500_4k'
                  WHEN tlen<10000 THEN 'b3_4k_10k' WHEN tlen<21000 THEN 'b4_10k_21k'
                  ELSE 'b5_gt21k' END bkt,
             row_number() OVER (
               PARTITION BY CASE WHEN tlen<1500 THEN 1 WHEN tlen<4000 THEN 2
                                 WHEN tlen<10000 THEN 3 WHEN tlen<21000 THEN 4 ELSE 5 END
               ORDER BY md5(slug)) rn
        FROM live
    )
    SELECT pv, bkt, tlen, slug FROM b WHERE rn <= 20 ORDER BY bkt, rn;
  " > "$OUT/sample.txt"
  echo "sample: $(wc -l < "$OUT/sample.txt") 页 → $OUT/sample.txt"
}

step_export() {
  local ids
  ids="$(awk -F'|' '{printf "%s,", $1}' "$OUT/sample.txt" | sed 's/,$//')"
  psql "$V1_DATABASE_URL" -q -c "\copy (
      SELECT v.id, v.\"textContent\" FROM \"PageVersion\" v
       WHERE v.id IN (SELECT unnest(string_to_array('$ids', ','))::int)
    ) TO '$OUT/v1text.csv' WITH (FORMAT csv)"
  psql "$V1_DATABASE_URL" -At -F$'\t' -c "
      SELECT e.\"pageVersionId\", e.\"chunkIndex\", e.\"chunkCharStart\", e.\"chunkCharEnd\"
        FROM \"PageEmbedding\" e
       WHERE e.\"pageVersionId\" IN (SELECT unnest(string_to_array('$ids', ','))::int)
       ORDER BY 1, 2;" > "$OUT/chunks.tsv"
  echo "export: v1text.csv $(wc -c < "$OUT/v1text.csv") 字节 / chunks.tsv $(wc -l < "$OUT/chunks.tsv") 行"
}

step_fetch() {
  local n=0 fail=0
  while IFS='|' read -r pv bkt tlen slug; do
    [[ -s "$OUT/html/$pv.html" ]] && continue
    code="$(curl -s -m 45 --compressed -x "$PROXY" -A "$UA" -e "$REFERER" \
                 "$BASE/$slug" -o "$OUT/html/$pv.html" -w '%{http_code}')"
    n=$((n+1))
    if [[ "$code" != "200" ]]; then
      echo "FAIL $code $slug"; rm -f "$OUT/html/$pv.html"; fail=$((fail+1))
    fi
    sleep 0.3   # 温和一点：这是共享订阅出口，不是我们自己的带宽
  done < "$OUT/sample.txt"
  echo "fetch: 本次 $n 次请求，失败 $fail，累计 $(ls "$OUT/html" | wc -l) 份 HTML"
}

case "${1:-all}" in
  sample) step_sample ;;
  export) step_export ;;
  fetch)  step_fetch ;;
  all)    step_sample; step_export; step_fetch
          echo
          echo "下一步："
          echo "  node --import tsx/esm experiments/extract-vs-crom.ts \\"
          echo "    --v1 experiments/data/extract/v1text.csv \\"
          echo "    --html experiments/data/extract/html \\"
          echo "    --chunks experiments/data/extract/chunks.tsv \\"
          echo "    --out experiments/data/extract/report.json" ;;
  *) echo "用法: $0 [all|sample|export|fetch]" >&2; exit 1 ;;
esac
