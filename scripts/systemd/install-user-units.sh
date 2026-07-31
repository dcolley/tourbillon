#!/usr/bin/env bash
# Install Tourbillon user systemd units on the test server (192.168.10.170).
# Run from the repo on that host after git pull — not for local Mac development.
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1; then
  echo "error: systemctl not found (this script is for the Linux test server)" >&2
  exit 1
fi

if ! systemctl --user status >/dev/null 2>&1; then
  echo "error: systemctl --user is unavailable (is the user session active?)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC_DIR="${REPO_ROOT}/deploy/systemd/user"
DEST_DIR="${HOME}/.config/systemd/user"

UNITS=(tourbillon-web.service tourbillon-workers.service)

for unit in "${UNITS[@]}"; do
  if [[ ! -f "${SRC_DIR}/${unit}" ]]; then
    echo "error: missing unit file ${SRC_DIR}/${unit}" >&2
    exit 1
  fi
done

mkdir -p "${DEST_DIR}"

for unit in "${UNITS[@]}"; do
  cp "${SRC_DIR}/${unit}" "${DEST_DIR}/${unit}"
  echo "installed ${DEST_DIR}/${unit}"
done

systemctl --user daemon-reload
systemctl --user enable --now tourbillon-web.service tourbillon-workers.service

echo
systemctl --user --no-pager --full status tourbillon-web.service tourbillon-workers.service || true

if command -v loginctl >/dev/null 2>&1; then
  linger="$(loginctl show-user "${USER}" -p Linger --value 2>/dev/null || true)"
  if [[ "${linger}" != "yes" ]]; then
    echo
    echo "note: user linger is not enabled; units may stop after logout."
    echo "      enable with: loginctl enable-linger ${USER}"
  fi
fi

echo
echo "done: tourbillon-web and tourbillon-workers enabled and started"
