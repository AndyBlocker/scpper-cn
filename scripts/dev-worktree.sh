#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
worktree_parent="${SCPPER_WORKTREE_PARENT:-$(dirname "$repo_root")/scpper-cn-worktrees}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/dev-worktree.sh create <branch> [path]
  bash scripts/dev-worktree.sh list
  bash scripts/dev-worktree.sh path <branch>

Examples:
  bash scripts/dev-worktree.sh create feat/forum-alerts
  bash scripts/dev-worktree.sh list
EOF
}

sanitize_branch_path() {
  printf '%s\n' "${1//\//__}"
}

copy_env_files() {
  local target_root="$1"
  local rel
  for rel in \
    frontend/.env \
    bff/.env \
    backend/.env \
    user-backend/.env \
    avatar-agent/.env \
    mail-agent/.env
  do
    local source_path="$repo_root/$rel"
    local target_path="$target_root/$rel"
    if [[ -f "$source_path" && ! -e "$target_path" ]]; then
      mkdir -p "$(dirname "$target_path")"
      cp "$source_path" "$target_path"
    fi
  done
}

command_name="${1:-help}"

case "$command_name" in
  create)
    branch="${2:-}"
    if [[ -z "$branch" ]]; then
      usage
      exit 1
    fi
    if [[ "$branch" == "main" || "$branch" == "master" ]]; then
      echo "Refusing to create a development worktree for protected branch: $branch" >&2
      exit 1
    fi

    mkdir -p "$worktree_parent"
    target_path="${3:-$worktree_parent/$(sanitize_branch_path "$branch")}"

    if [[ -e "$target_path" ]]; then
      echo "Target path already exists: $target_path" >&2
      exit 1
    fi

    git -C "$repo_root" fetch origin

    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$repo_root" worktree add "$target_path" "$branch"
    elif git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
      git -C "$repo_root" worktree add --track -b "$branch" "$target_path" "origin/$branch"
    else
      git -C "$repo_root" worktree add -b "$branch" "$target_path" origin/main
    fi

    copy_env_files "$target_path"

    cat <<EOF
Created worktree:
  $target_path

Next steps:
  cd "$target_path"
  bash scripts/install-hooks.sh
  # Commands wired through the repo wrappers can temporarily reuse the protected checkout's installed dependencies.
  # If a service changes dependencies, install them inside the worktree, e.g.:
  #   cd frontend && npm install
EOF
    ;;
  list)
    git -C "$repo_root" worktree list
    ;;
  path)
    branch="${2:-}"
    if [[ -z "$branch" ]]; then
      usage
      exit 1
    fi
    printf '%s\n' "$worktree_parent/$(sanitize_branch_path "$branch")"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
