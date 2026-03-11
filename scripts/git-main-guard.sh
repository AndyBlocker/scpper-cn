#!/usr/bin/env bash
set -euo pipefail

hook_name="${1:-git-hook}"
repo_root="$(git rev-parse --show-toplevel)"
branch="$(git -C "$repo_root" branch --show-current 2>/dev/null || true)"

if [[ -z "$branch" ]]; then
  exit 0
fi

if [[ "${SCPPER_ALLOW_MAIN:-}" == "1" ]]; then
  exit 0
fi

if [[ "$branch" == "main" || "$branch" == "master" ]]; then
  cat >&2 <<EOF
[$hook_name] Direct commits and pushes on '$branch' are blocked in this repo.

Create a feature worktree first:
  bash scripts/dev-worktree.sh create feat/<topic>

Emergency override:
  SCPPER_ALLOW_MAIN=1 git <command>
EOF
  exit 1
fi
