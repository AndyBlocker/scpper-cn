#!/usr/bin/env bash
# pre-push 必须真实接到与 deploy 相同的门禁，不能只把脚本放进仓库。
set -uo pipefail

# 同样防 GIT_DIR 污染：本检查也会被钩子递归调用。
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "不在 git worktree 中" >&2
  exit 1
}
HOOKS_PATH="$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || true)"
bad=0

if [ "$HOOKS_PATH" != ".githooks" ]; then
  echo "core.hooksPath 未安装为 .githooks（当前: ${HOOKS_PATH:-<空>}）"; bad=1
fi

hook="$ROOT/.githooks/pre-push"
if [ ! -x "$hook" ]; then
  echo "pre-push 未安装或不可执行: $hook"; bad=1
elif ! grep -Fq 'syncer2/deploy/run-gates.sh' "$hook"; then
  echo "pre-push 未接到 syncer2/deploy/run-gates.sh"; bad=1
fi

[ "$bad" -eq 0 ] && echo "pre-push 已安装并接到完整门禁"
exit "$bad"
