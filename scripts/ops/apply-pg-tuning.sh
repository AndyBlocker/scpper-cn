#!/usr/bin/env bash
# Apply PostgreSQL performance tuning drop-in file to both the main and
# replica clusters, then reload (not restart) the servers.
#
# Requires sudo because the target /etc/postgresql/17/*/conf.d/ directories
# are owned by postgres:postgres.
#
# Usage:
#   sudo bash scripts/ops/apply-pg-tuning.sh
#
# Rollback: see docs/ops/postgresql-tuning.md.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
source_conf="$repo_root/docs/ops/postgresql-50-performance-tuning.conf"

if [[ ! -f "$source_conf" ]]; then
  echo "Source config not found: $source_conf" >&2
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This script must be run as root (e.g. via sudo)." >&2
  exit 1
fi

clusters=(main replica)
for cluster in "${clusters[@]}"; do
  target_dir="/etc/postgresql/17/${cluster}/conf.d"
  target_file="$target_dir/50-performance-tuning.conf"

  if [[ ! -d "$target_dir" ]]; then
    echo "Skipping missing cluster directory: $target_dir" >&2
    continue
  fi

  install -o postgres -g postgres -m 0644 "$source_conf" "$target_file"
  echo "Installed: $target_file"
done

for cluster in "${clusters[@]}"; do
  service="postgresql@17-${cluster}"
  if systemctl list-unit-files --type=service | grep -q "^${service}\.service"; then
    systemctl reload "$service"
    echo "Reloaded: $service"
  else
    echo "Service not registered: $service (skipping)" >&2
  fi
done

echo
echo "Verify on the live cluster(s):"
echo "  psql -h 127.0.0.1 -p 5434 -U user_dxzbdi -d scpper-cn -c \\"
echo "    \"SELECT name, setting, unit, source FROM pg_settings \\"
echo "     WHERE name IN ('random_page_cost','effective_cache_size','effective_io_concurrency','max_wal_size','min_wal_size') \\"
echo "     ORDER BY name;\""
