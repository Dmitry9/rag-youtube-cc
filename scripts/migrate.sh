#!/usr/bin/env bash
# Apply every migrations/*.sql against the pg container in lexical filename order.
set -euo pipefail

shopt -s nullglob
files=(migrations/*.sql)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No migrations found in migrations/" >&2
  exit 1
fi

for f in "${files[@]}"; do
  echo "==> $f"
  docker exec -i pg psql -U rag -d rag -v ON_ERROR_STOP=1 < "$f"
done
