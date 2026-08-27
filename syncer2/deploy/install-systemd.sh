#!/usr/bin/env bash
# 安装仓库内 user units；不停止/重启 timer，也不执行 migration。
set -Eeuo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SOURCE="$DEPLOY_DIR/systemd"
UNIT_TARGET="${SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
RELEASE_ROOT="${SYNCER2_RELEASE_ROOT:-$HOME/syncer2-releases}"

[[ -e "$RELEASE_ROOT/current" ]] || {
  echo "拒绝安装：$RELEASE_ROOT/current 不存在；先将它临时指向当前 syncer2 工作树" >&2
  exit 1
}

mkdir -p "$UNIT_TARGET" "$RELEASE_ROOT/ops-backups"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

# 旧本机 override 是工作树直跑入口；保存到不会被 systemd 读取的位置。
for legacy_override in \
  "$UNIT_TARGET/syncer2-job@.service.d/10-local.conf" \
  "$UNIT_TARGET/syncer2-job@.service.d/99-emergency-worktree.conf"; do
  if [[ -f "$legacy_override" ]]; then
    mv "$legacy_override" \
      "$RELEASE_ROOT/ops-backups/$stamp-$(basename "$legacy_override")"
  fi
done

install -m 0644 "$UNIT_SOURCE/syncer2-job@.service" "$UNIT_SOURCE"/*.timer "$UNIT_TARGET/"
for source_dropin in "$UNIT_SOURCE"/syncer2-job@*.service.d/*.conf; do
  target_dir="$UNIT_TARGET/$(basename "$(dirname "$source_dropin")")"
  mkdir -p "$target_dir"
  install -m 0644 "$source_dropin" "$target_dir/$(basename "$source_dropin")"
done

systemctl --user daemon-reload
bash "$DEPLOY_DIR/../checks/0004_systemd_sync.sh"
echo "systemd units 已安装并 daemon-reload；现有 oneshot 未重启"
