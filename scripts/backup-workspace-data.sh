#!/usr/bin/env bash
set -euo pipefail

# Creates a timestamped tar.gz archive of Tourbillon filesystem data (./data/).
# Usage: ./scripts/backup-workspace-data.sh [destination-dir]
#
# Example:
#   ./scripts/backup-workspace-data.sh ~/backups/tourbillon
#
# Cron (daily at 2am):
#   0 2 * * * /path/to/tourbillon/scripts/backup-workspace-data.sh /path/to/backups/tourbillon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${REPO_ROOT}/data"
DEST_DIR="${1:-${REPO_ROOT}/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_NAME="tourbillon-data-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${DEST_DIR}/${ARCHIVE_NAME}"

if [[ ! -d "${DATA_DIR}" ]]; then
  echo "error: data directory not found at ${DATA_DIR}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

tar -czf "${ARCHIVE_PATH}" -C "${REPO_ROOT}" data

echo "Backup written to ${ARCHIVE_PATH}"
du -h "${ARCHIVE_PATH}"
