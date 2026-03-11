#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

chmod +x \
  "$repo_root/.githooks/pre-commit" \
  "$repo_root/.githooks/pre-push" \
  "$repo_root/scripts/git-main-guard.sh"

git -C "$repo_root" config --local core.hooksPath .githooks

echo "Installed repository hooks with core.hooksPath=.githooks"
