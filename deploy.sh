#!/bin/sh
# Deploys web/ to the production server. nginx serves these files directly,
# so a deploy is just a file sync — no service restart needed.
#
# Usage: ./deploy.sh [--dry-run]
set -eu

REMOTE_HOST="max@192.168.50.31"
REMOTE_PATH="/home/max/apps/wiggle/"
LOCAL_PATH="$(CDPATH= cd -- "$(dirname -- "$0")/web" && pwd)/"

RSYNC_OPTS="-avz --delete"
if [ "${1:-}" = "--dry-run" ]; then
  RSYNC_OPTS="$RSYNC_OPTS --dry-run"
  echo "Dry run — no files will actually change."
fi

ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'"
# shellcheck disable=SC2086
rsync $RSYNC_OPTS "$LOCAL_PATH" "$REMOTE_HOST:$REMOTE_PATH"

# rsync preserves local file permissions, which may not be world-readable;
# nginx (www-data) needs read access to files and read+execute on
# directories to serve them. "o+rX" adds execute only to directories (and
# anything already executable), never to plain files.
ssh "$REMOTE_HOST" "chmod -R o+rX '$REMOTE_PATH'"

echo "Deployed to $REMOTE_HOST:$REMOTE_PATH"
