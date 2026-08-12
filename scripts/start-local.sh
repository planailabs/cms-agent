#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Run this command inside the cms-agent repository." >&2
  exit 2
}
cd "$repo_root"

expected_shell=$(./scripts/update-local.sh --print-nix-fingerprint)
if [[ "${CMS_AGENT_DEV_SHELL_FINGERPRINT:-}" != "$expected_shell" ]]; then
  echo "Start with nix develop --command overmind s." >&2
  exit 2
fi

internal_port=${PORT:-4321}
case "$internal_port" in
  ''|*[!0-9]*) echo "PORT must be a number." >&2; exit 2 ;;
esac
command -v lsof >/dev/null 2>&1 || {
  echo "The project dev shell is missing lsof; refresh its flake inputs." >&2
  exit 2
}

listeners() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

clear_stale_astro() {
  local pid command
  for pid in $(listeners "$internal_port"); do
    command=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if [[ "$command" =~ /astro.*[[:space:]]dev([[:space:]]|$) ]]; then
      kill "$pid"
    else
      echo "Port $internal_port is occupied by a non-Astro process (PID $pid)." >&2
      exit 1
    fi
  done
}

wait_for_free_port() {
  local port=$1
  local attempt
  for attempt in {1..50}; do
    [[ -z "$(listeners "$port")" ]] && return
    sleep .1
  done
  echo "Port $port is still occupied." >&2
  exit 1
}

clear_stale_astro
wait_for_free_port "$internal_port"
wait_for_free_port 8080

./scripts/update-local.sh
expected_runtime=$(./scripts/update-local.sh --print-runtime-fingerprint)
pnpm exec prisma migrate deploy

# Inputs may have changed while preparation ran; never borrow a late listener.
clear_stale_astro
wait_for_free_port "$internal_port"
wait_for_free_port 8080
rm -f var/proxy-routes.json
rm -rf "${TMPDIR:-/tmp}/cms-agent-diffs"

export SKIP_AUTH=true
export HOST=::1
# OpenTelemetry auto-instrumentation. otel-hook.mjs registers the ESM hook
# (--experimental-loader does the same and warns on every boot that it may be
# removed); the register import starts the SDK. Both resolve against the cwd,
# which is the repo root here — the nix wrapper uses store paths instead.
# --disable-warning: node 26 deprecates module.register() in favour of
# registerHooks(), which takes SYNCHRONOUS hooks — import-in-the-middle's are
# async, so register() is still the only API that fits. Silence that one code
# rather than the whole channel (needs node >= 21.3).
export NODE_OPTIONS="--disable-warning=DEP0205 --import ./otel-hook.mjs --import @opentelemetry/auto-instrumentations-node/register${NODE_OPTIONS:+ $NODE_OPTIONS}"
# The SDK exports over OTLP to localhost:4318 unless told otherwise, and logs
# every failed export. Opt in with a collector: OTEL_SDK_DISABLED=false plus
# OTEL_EXPORTER_OTLP_ENDPOINT.
export OTEL_SDK_DISABLED="${OTEL_SDK_DISABLED:-true}"
export PROXY_LISTEN=127.0.0.1:8080
export DEV_PORT_CARRY=1

child=
cleanup() {
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bash scripts/launch-with-sandbox.sh pnpm dev -- --host ::1 --port "$internal_port" &
child=$!

ready_deadline=$((SECONDS + 600))
until INTERNAL_PORT="$internal_port" node scripts/wait-for-proxy.mjs; do
  kill -0 "$child" 2>/dev/null || {
    wait "$child" || true
    echo "The development server exited before becoming ready." >&2
    exit 1
  }
  if (( SECONDS >= ready_deadline )); then
    echo "The development server did not become ready within 10 minutes." >&2
    exit 1
  fi
  sleep .25
done

kill -0 "$child"
./scripts/update-local.sh --mark-started "$expected_runtime"
kill -0 "$child"

if wait "$child"; then status=0; else status=$?; fi
child=
exit "$status"
