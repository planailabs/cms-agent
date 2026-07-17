#!/usr/bin/env bash
# Universal sandbox launcher: ensure the selected node-major sandbox env is
# available, then exec the given command. Used by the Procfile (dev), the
# docker entrypoint (prod), and the test scripts.
#
# Selection: SANDBOX_NODE_MAJOR (default 22).
# If SANDBOX_DIR_<major> is already set (baked into the docker image), it is
# used as-is. Otherwise the env squashfs is built on the fly with nix
# (`nix build .#sandbox-node<major>`) — nix is a hard requirement in dev/test.
set -euo pipefail

major="${SANDBOX_NODE_MAJOR:-22}"
case "$major" in
  22 | 24 | 26) ;;
  *)
    echo "launch-with-sandbox: unsupported SANDBOX_NODE_MAJOR=$major (want 22|24|26)" >&2
    exit 1
    ;;
esac

var="SANDBOX_DIR_${major}"
if [ -z "${!var:-}" ]; then
  if ! command -v nix >/dev/null 2>&1; then
    echo "launch-with-sandbox: $var unset and nix not found — cannot build the sandbox" >&2
    exit 1
  fi
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "launch-with-sandbox: building sandbox env for node $major …" >&2
  dir="$(nix build --no-link --print-out-paths "${here}#sandbox-node${major}")"
  export "SANDBOX_DIR_${major}=${dir}"
fi

exec "$@"
