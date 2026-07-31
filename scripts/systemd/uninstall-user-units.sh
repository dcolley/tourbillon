#!/usr/bin/env bash
# Remove Tourbillon user systemd units from the test server.
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl not found (this script is for the Linux test server)" >&2
  exit 1
fi

DEST_DIR="${HOME}/.config/systemd/user"
UNITS=(tourbillon-web.service tourbillon-workers.service)

if systemctl --user status >/dev/null 2>&1; then
  systemctl --user disable --now tourbillon-web.service tourbillon-workers.service 2>/dev/null || true
fi

for unit in "${UNITS[@]}"; do
  path="${DEST_DIR}/${unit}"
  if [[ -f "${path}" ]]; then
    rm -f "${path}"
    echo "removed ${path}"
  fi
done

if systemctl --user status >/dev/null 2>&1; then
  systemctl --user daemon-reload
fi

echo "done: tourbillon user units uninstalled"
