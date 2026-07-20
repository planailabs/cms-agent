#!/usr/bin/env bash
# Universal sandbox launcher: ensure the sandbox squashfs is available, then
# exec the given command. Used by the Procfile (dev), the docker entrypoint
# (prod), and the test scripts.
#
# If SANDBOX_DIR is already set (baked into the docker image), it is used
# as-is. Otherwise the combined sandbox squashfs is built on the fly with nix
# (`nix build .#sandbox`) — nix is a hard requirement in dev/test. The node
# major is selected at runtime via SANDBOX_NODE_MAJOR (default 26); one
# squashfs holds all three.
set -euo pipefail

# macOS has no bubblewrap — fall back to SANDBOX_MODE=none: the runtime
# resolves the matching `nix develop .#sandbox-node<major>` shell and runs
# site commands with its PATH (no jail; development only).
if [ "$(uname -s)" = "Darwin" ]; then
  export SANDBOX_MODE="${SANDBOX_MODE:-none}"
fi
if [ "${SANDBOX_MODE:-bwrap}" = "none" ]; then
  echo "launch-with-sandbox: SANDBOX_MODE=none — no jail; using the nix dev shell PATH" >&2
  exec "$@"
fi

if [ -z "${SANDBOX_DIR:-}" ]; then
  if ! command -v nix >/dev/null 2>&1; then
    echo "launch-with-sandbox: SANDBOX_DIR unset and nix not found — cannot build the sandbox" >&2
    exit 1
  fi
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "launch-with-sandbox: building sandbox squashfs …" >&2
  SANDBOX_DIR="$(nix build --no-link --print-out-paths "${here}#sandbox")"
  export SANDBOX_DIR
fi

exec "$@"
