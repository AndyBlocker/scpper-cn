#!/usr/bin/env bash
# 每条链路的单轮时间预算必须显著小于 systemd 的 TimeoutStartSec。
#
# 这对关系全靠人工对齐，已经踩过两次：
#   · work-queue：0.10 QPS 下 50 任务纯等待就 500 秒，超 10 分钟硬超时被 SIGTERM 杀死，
#     每轮只消耗 5 秒 CPU 就退出——任务被认领却无人做完，「配额生效队列反而越积越多」
#   · image-ingest：420 秒预算 / 600 秒超时，余量 180 秒，
#     而单张站外图的超时就可能几十秒，一张慢图即拖过硬超时（result=timeout）
#
# 被信号杀死时无法优雅收尾：未完成任务只能等锁陈旧回收，本轮进度全部作废。
# 因此预算必须留出足够收尾余量，且这条约束应当可被自动检查而非靠记忆。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
U="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
MIN_MARGIN_RATIO="${MIN_MARGIN_RATIO:-0.4}"   # 预算最多占硬超时的 60%
bad=0

# 覆盖**所有** schedule:* 链路，而不只是已声明预算的那些。
# 教训：forum-consume 没传 --max-runtime-sec（CLI 默认 420s），
# 于是上一版检查直接跳过了它 —— 而没有显式预算等于预算不受控，
# 结果它跑满 600 秒硬超时被 SIGTERM 杀死。
# 「未声明」比「声明得过大」更危险，因为它连检查都躲过了。
while IFS= read -r line; do
  job="$(sed -E 's/^ *"schedule:([^"]+)".*/\1/' <<<"$line")"
  budget="$(grep -oE '\-\-max-runtime-sec [0-9]+' <<<"$line" | grep -oE '[0-9]+' || true)"
  if [ -z "$budget" ]; then
    echo "缺显式预算: $job（每条 schedule:* 都必须传 --max-runtime-sec）"
    bad=1
    continue
  fi
  cli="$(grep -oE 'src/cli/[a-z0-9-]+\.ts' <<<"$line" | head -1)"
  if [ -z "$cli" ] || [ ! -f "$ROOT/$cli" ] || ! grep -qE 'addRuntimeBudgetOption|max-runtime-sec' "$ROOT/$cli"; then
    echo "CLI 不支持预算: $job（${cli:-?}）"
    bad=1
    continue
  fi
  conf="$U/syncer2-job@${job}.service.d"
  timeout_raw="$(grep -h -oE '^TimeoutStartSec=.*' "$conf"/*.conf 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  [ -n "$timeout_raw" ] || { echo "缺 TimeoutStartSec: $job"; bad=1; continue; }
  case "$timeout_raw" in
    *min) tmo=$(( ${timeout_raw%min} * 60 ));;
    *s)   tmo=${timeout_raw%s};;
    *)    tmo=$timeout_raw;;
  esac
  max_budget=$(awk -v t="$tmo" -v r="$MIN_MARGIN_RATIO" 'BEGIN{printf "%d", t*(1-r)}')
  if [ "$budget" -gt "$max_budget" ]; then
    echo "预算过大: $job 预算 ${budget}s > 上限 ${max_budget}s（硬超时 ${tmo}s，需留 $(awk -v r=$MIN_MARGIN_RATIO 'BEGIN{printf "%d", r*100}')% 余量）"
    bad=1
  fi
done < <(grep -E '^ *"schedule:[^"]+":' "$ROOT/package.json")

[ "$bad" -eq 0 ] && echo "各链路单轮预算与硬超时余量充足"
exit "$bad"
