#!/bin/sh
set -eu

config="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
database="${WORKFLOW_SQLITE_PATH:-/data/workflow.db}"
export VARLOCK_TELEMETRY_DISABLED=1

mkdir -p "$(dirname "$database")" "${WORKFLOW_REPORT_DIR:-/data/reports}"
litestream restore \
  -config "$config" \
  -if-db-not-exists \
  -if-replica-exists \
  -integrity-check full \
  "$database"

exec litestream replicate \
  -config "$config" \
  -exec "/app/node_modules/.bin/varlock run --inject vars -- node src/.output/server/index.mjs"
