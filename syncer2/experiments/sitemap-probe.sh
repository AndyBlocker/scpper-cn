#!/usr/bin/env bash
# ============================================================================
# sitemap-probe.sh —— scp-wiki-cn sitemap 刷新周期 / 覆盖特性 实测脚本（可重跑）
#
# 任务 F（syncer2 v2 采集架构）：验证 sitemap.xml 能否作为一等采集通道，
# 特别是能否替代 SiteChanges 做新页/编辑发现。
#
# 用法：
#   ./sitemap-probe.sh snap  <label>   # 抓一轮快照（sitemap_page_1 + ListPages 两条）
#   ./sitemap-probe.sh full  <label>   # 抓全量 4 个 page sitemap
#   ./sitemap-probe.sh forum <label>   # 抓 9 个 thread sitemap + 1 个 category sitemap
#   ./sitemap-probe.sh cattotal        # 逐 category 用 %%total%% 取精确计数
#   ./sitemap-probe.sh series          # 时间序列：T+0 / T+10min / T+30min 三轮 snap
#   INTERVAL=180 ROUNDS=14 ./sitemap-probe.sh chase   # 交替轮询 ListPages+sitemap，夹逼滞后
#   INTERVAL=240 ROUNDS=18 ./sitemap-probe.sh regen   # 只测 sitemap 重新生成的时刻（md5 一变即停）
#   ./sitemap-probe.sh parse-sitemap <xml>   # sitemap -> tsv(slug, lastmod, ordinal)
#   ./sitemap-probe.sh parse-lp      <json>  # ListPages AMC 响应 -> tsv
#
# 约束（本项目硬规则）：
#   - 所有 wikidot 请求走 http://127.0.0.1:7891 代理
#   - 必须带 User-Agent（空 UA → 503）与 Referer（AMC POST 缺 Referer → TCP reset）
#   - 共享 IP 池，请求要克制：本脚本一次 full run 约 40 个请求
# ============================================================================
set -uo pipefail

SITE="https://scp-wiki-cn.wikidot.com"
PROXY="${PROXY:-http://127.0.0.1:7891}"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
TOK="scpperv2probe"
OUT="${OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/data}"
mkdir -p "$OUT"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

# ---- 原始 GET（sitemap 是普通静态 GET，只需 UA） ---------------------------
get() { # $1=path  $2=outfile
  curl -sS --max-time 90 --retry 3 --retry-delay 5 --retry-all-errors --compressed \
       -x "$PROXY" -A "$UA" \
       -H "Referer: $SITE/" -o "$2" -w "%{http_code} %{time_total}s %{size_download}B" "$SITE/$1"
}

# ---- AMC POST（ListPagesModule） -------------------------------------------
amc() { # 其余参数直接透传为 --data-urlencode
  curl -sS --max-time 90 --retry 3 --retry-delay 5 --retry-all-errors --compressed \
    -x "$PROXY" -A "$UA" \
    -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" \
    -H "Referer: $SITE/" -b "wikidot_token7=$TOK" \
    --data-urlencode "wikidot_token7=$TOK" \
    "$@" "$SITE/ajax-module-connector.php"
}

# ListPages：$1=order  $2=perPage  $3=outfile
listpages() {
  local body='[[div class="pp"]]F=%%fullname%%|U=%%updated_at%%|C=%%created_at%%|CB=%%created_by_unix%%|T=%%total%%[[/div]]'
  amc --data-urlencode "moduleName=list/ListPagesModule" \
      --data-urlencode "category=*" \
      --data-urlencode "order=$1" \
      --data-urlencode "perPage=$2" \
      --data-urlencode "module_body=$body" > "$3"
}

# ============================================================================
cmd_snap() {
  local L="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  log "snap $L : sitemap_page_1"
  echo "  $(get sitemap_page_1.xml "$OUT/sm1.$L.xml")"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/sm1.$L.fetched"
  log "snap $L : ListPages updated_at desc x50"
  listpages "updated_at desc" 50 "$OUT/lp_upd.$L.json"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/lp_upd.$L.fetched"
  log "snap $L : ListPages created_at desc x50"
  listpages "created_at desc" 50 "$OUT/lp_new.$L.json"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/lp_new.$L.fetched"
  log "snap $L done (3 requests)"
}

cmd_full() {
  local L="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  for n in 1 2 3 4; do
    log "full $L : sitemap_page_$n"
    echo "  page_$n $(get "sitemap_page_$n.xml" "$OUT/smp$n.$L.xml")"
  done
}

cmd_forum() {
  local L="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  for n in 1 2 3 4 5 6 7 8 9; do
    log "forum $L : sitemap_thread_$n"
    echo "  thread_$n $(get "sitemap_thread_$n.xml" "$OUT/smt$n.$L.xml")"
  done
  echo "  category $(get sitemap_category_1.xml "$OUT/smc.$L.xml")"
}

# 逐 category 精确计数：ListPages 的 %%total%% 在 category=<x> 下给该分类总数
cmd_cattotal() {
  local L="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  local cats="${CATS:-_default deleted old fragment component theme forum nav system search admin draft criticism sandbox test archive}"
  : > "$OUT/cattotal.$L.tsv"
  for c in $cats; do
    local r
    r=$(amc --data-urlencode "moduleName=list/ListPagesModule" \
            --data-urlencode "category=$c" \
            --data-urlencode "perPage=1" \
            --data-urlencode "order=created_at desc" \
            --data-urlencode 'module_body=[[div class="pp"]]T=%%total%%[[/div]]' \
        | grep -o 'T=[0-9]*' | head -1 | cut -d= -f2)
    printf '%s\t%s\n' "$c" "${r:-0}" | tee -a "$OUT/cattotal.$L.tsv"
  done
}

# ---- 解析 -------------------------------------------------------------------
# sitemap xml -> tsv(slug, lastmod, ordinal)
cmd_parse_sitemap() { # $1=xmlfile
  perl -0777 -ne '
    my $i=0;
    while (/<url><loc>http:\/\/scp-wiki-cn\.wikidot\.com\/([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g) {
      $i++; my $s=$1; my $m=$2//""; print "$s\t$m\t$i\n";
    }' "$1"
}

# ListPages html -> tsv(fullname, updated_unix, created_unix, created_by, total)
# odate 里的 class="odate time_<unix>" 才是秒级真值，可见文本只到分钟
cmd_parse_lp() { # $1=jsonfile
  python3 - "$1" <<'PY'
import json,sys,re,html
raw=open(sys.argv[1],encoding='utf-8',errors='replace').read()
try: body=json.loads(raw).get('body','')
except Exception: body=raw
body=html.unescape(body)
def unix(s):
    m=re.search(r'time_(\d+)',s)
    return m.group(1) if m else s.strip()
for m in re.finditer(r'F=(.*?)\|U=(.*?)\|C=(.*?)\|CB=(.*?)\|T=(\d*)', body, re.S):
    f,u,c,cb,t=m.groups()
    print('\t'.join([f.strip(),unix(u),unix(c),cb.strip(),t.strip()]))
PY
}

# 追踪模式：高频交替轮询 ListPages(最新编辑) 与 sitemap_page_1，
# 把「站内编辑发生」到「sitemap 反映该编辑」的滞后压到 INTERVAL 的精度。
# 用法： INTERVAL=180 ROUNDS=15 ./sitemap-probe.sh chase
cmd_chase() {
  local iv="${INTERVAL:-180}" rounds="${ROUNDS:-15}"
  local body='[[div class="pp"]]F=%%fullname%%|U=%%updated_at%%|C=%%created_at%%|CB=%%created_by_unix%%|T=%%total%%[[/div]]'
  : > "$OUT/chase.tsv"
  for ((k=0;k<rounds;k++)); do
    local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    amc --data-urlencode "moduleName=list/ListPagesModule" \
        --data-urlencode "category=* -deleted -forum -adult -wanderers-adult" \
        --data-urlencode "order=updated_at desc" --data-urlencode "perPage=5" \
        --data-urlencode "module_body=$body" > "$OUT/chase_lp.$k.json"
    local ts2; ts2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    get sitemap_page_1.xml "$OUT/chase_sm.$k.xml" >/dev/null
    local ts3; ts3=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '%d\t%s\t%s\t%s\n' "$k" "$ts" "$ts2" "$ts3" >> "$OUT/chase.tsv"
    log "chase round $k  lp@$ts sm@$ts2..$ts3"
    [[ $k -lt $((rounds-1)) ]] && sleep "$iv"
  done
}

# 只测「sitemap 什么时候被重新生成」：低频轮询 sitemap_page_1 的 md5，一变即停。
# 用法： INTERVAL=300 ROUNDS=16 ./sitemap-probe.sh regen
cmd_regen() {
  local iv="${INTERVAL:-300}" rounds="${ROUNDS:-16}" base="" h ts
  : > "$OUT/regen.tsv"
  for ((k=0;k<rounds;k++)); do
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    get sitemap_page_1.xml "$OUT/regen.cur.xml" >/dev/null
    h=$(md5sum "$OUT/regen.cur.xml" | cut -d' ' -f1)
    [[ -z $base ]] && base=$h
    printf '%d\t%s\t%s\n' "$k" "$ts" "$h" >> "$OUT/regen.tsv"
    log "regen r$k @$ts md5=$h"
    if [[ $h != "$base" ]]; then
      cp "$OUT/regen.cur.xml" "$OUT/regen.new.xml"
      log "*** sitemap 已重新生成，快照存为 regen.new.xml ***"
      break
    fi
    sleep "$iv"
  done
}

cmd_series() {
  cmd_snap "t0"
  log "sleep 600s -> t10"; sleep 600
  cmd_snap "t10"
  log "sleep 1200s -> t30"; sleep 1200
  cmd_snap "t30"
  log "series done"
}

case "${1:-}" in
  snap)      shift; cmd_snap "$@" ;;
  full)      shift; cmd_full "$@" ;;
  forum)     shift; cmd_forum "$@" ;;
  cattotal)  shift; cmd_cattotal "$@" ;;
  series)    shift; cmd_series "$@" ;;
  chase)     shift; cmd_chase "$@" ;;
  regen)     shift; cmd_regen "$@" ;;
  parse-sitemap) shift; cmd_parse_sitemap "$@" ;;
  parse-lp)      shift; cmd_parse_lp "$@" ;;
  *) sed -n '1,30p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
