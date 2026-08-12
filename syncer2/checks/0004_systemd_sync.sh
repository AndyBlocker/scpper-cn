#!/usr/bin/env bash
# 仓库中的 systemd 定义必须与实际安装的一致。
#
# 这条缺口今天咬了两次：
#   · image-ingest 的 timer 写好了定义却从未安装 —— 24,642 个任务落地后无人处理
#   · forum-consume 的定义早已改为每分钟一轮，实际仍是每天 05:43 一轮
#     —— 增量发现每 5 分钟到位，却要等次日凌晨才被消费
# 全量比对后发现 6 个 timer 不一致或未安装，其中包括我自建的 oldest-pending 巡检。
#
# 根因是 deploy/systemd/ 与 ~/.config/systemd/user/ 靠人工同步，
# 而「改了没装」不会产生任何错误信号 —— 它只是安静地不生效。
set -uo pipefail
W="$(cd "$(dirname "${BASH_SOURCE[0]}")/../deploy/systemd" && pwd)"
U="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
bad=0
for f in "$W"/syncer2-*.timer "$W"/syncer2-job@.service; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  if [ ! -f "$U/$b" ]; then
    echo "未安装: $b"; bad=1
  elif ! diff -q "$f" "$U/$b" >/dev/null 2>&1; then
    echo "不一致: $b"; bad=1
  fi
done
for d in "$W"/syncer2-job@*.service.d; do
  [ -d "$d" ] || continue
  b="$(basename "$d")"
  for c in "$d"/*.conf; do
    [ -e "$c" ] || continue
    cb="$(basename "$c")"
    if [ ! -f "$U/$b/$cb" ]; then
      echo "未安装: $b/$cb"; bad=1
    elif ! diff -q "$c" "$U/$b/$cb" >/dev/null 2>&1; then
      echo "不一致: $b/$cb"; bad=1
    fi
  done
done
[ "$bad" -eq 0 ] && echo "systemd 定义与安装一致"
exit "$bad"
