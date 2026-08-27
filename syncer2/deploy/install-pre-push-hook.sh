#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.githooks/pre-push"

[[ -f "$HOOK" ]] || { echo "缺少 $HOOK" >&2; exit 1; }
chmod +x "$HOOK" "$REPO_ROOT/syncer2/deploy/run-gates.sh"

configured="$(git -C "$REPO_ROOT" config --get core.hooksPath 2>/dev/null || true)"
if [[ "$configured" != ".githooks" ]]; then
  git -C "$REPO_ROOT" config --local core.hooksPath .githooks
fi

bash "$REPO_ROOT/syncer2/checks/0008_pre_push_hook.sh"
echo "pre-push 安装完成；git push --no-verify 仅限生产紧急逃生"
