#!/usr/bin/env bash
# 首次切换失败时的无中断逃生：恢复工作树直跑，不 stop/restart timer。
set -Eeuo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="${1:-$(cd "$DEPLOY_DIR/.." && pwd)}"
UNIT_TARGET="${SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
OVERRIDE_DIR="$UNIT_TARGET/syncer2-job@.service.d"
OVERRIDE="$OVERRIDE_DIR/99-emergency-worktree.conf"

[[ -f "$WORKTREE_ROOT/package.json" && -f "$WORKTREE_ROOT/.env" ]] || {
  echo "不是可直跑的 syncer2 工作树: $WORKTREE_ROOT" >&2; exit 1;
}
if [[ "$WORKTREE_ROOT" =~ [[:space:]%] ]]; then
  echo "逃生路径不能含空白或 %: $WORKTREE_ROOT" >&2; exit 2
fi

# 保持仓库 base unit 已安装，只用显式 emergency override 恢复旧执行形态。
install -m 0644 "$DEPLOY_DIR/systemd/syncer2-job@.service" "$UNIT_TARGET/syncer2-job@.service"
mkdir -p "$OVERRIDE_DIR"
tmp="$(mktemp "$OVERRIDE_DIR/.99-emergency-worktree.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<EOF
[Service]
WorkingDirectory=$WORKTREE_ROOT
EnvironmentFile=
EnvironmentFile=$WORKTREE_ROOT/.env
Environment=PATH=$HOME/.nvm/versions/node/v22.17.1/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=
ExecStart=/usr/bin/env npm run schedule:%i
EOF
chmod 0644 "$tmp"
mv -Tf "$tmp" "$OVERRIDE"
trap - EXIT

systemctl --user daemon-reload
systemctl --user show syncer2-job@l1.service \
  -p ExecStart -p WorkingDirectory -p EnvironmentFiles --no-pager
echo "已恢复工作树直跑；timer 未停止，修复门禁后重新执行 install-systemd.sh + deploy"
