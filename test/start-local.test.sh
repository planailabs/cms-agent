#!/bin/sh
set -eu

source_root=$(git rev-parse --show-toplevel)
grep -qx 'OVERMIND_NO_PORT=1' "$source_root/.overmind.env"
if guard_output=$(env -u PRISMA_SCHEMA_ENGINE_BINARY node "$source_root/scripts/prepare-test-db.mjs" 2>&1); then
  echo "prepare-test-db unexpectedly ran without the pinned Prisma engine" >&2
  exit 1
fi
case "$guard_output" in
  *'downloads are disabled'*) ;;
  *) printf '%s\n' "$guard_output" >&2; exit 1 ;;
esac
test_root=$(mktemp -d "${TMPDIR:-/tmp}/cms-start-test.XXXXXX")
trap 'rm -rf "$test_root"' 0
repo=$test_root/repo
mkdir -p "$repo/scripts" "$repo/var" "$test_root/bin" "$test_root/tmp"
cp "$source_root/scripts/start-local.sh" "$repo/scripts/start-local.sh"

cat > "$repo/scripts/update-local.sh" <<'EOF'
#!/bin/sh
case "${1-}" in
  --print-nix-fingerprint) printf 'test-fingerprint\n' ;;
  --print-runtime-fingerprint) printf '1111111111111111111111111111111111111111\n' ;;
  --mark-started) printf 'mark\n' >> "$START_LOG" ;;
  '') printf 'update\n' >> "$START_LOG" ;;
  *) exit 64 ;;
esac
EOF
cat > "$repo/scripts/launch-with-sandbox.sh" <<'EOF'
#!/bin/sh
exec "$@"
EOF
cat > "$test_root/bin/lsof" <<'EOF'
#!/bin/sh
exit 1
EOF
cat > "$test_root/bin/node" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$test_root/bin/pnpm" <<'EOF'
#!/bin/sh
case "$*" in
  'exec prisma migrate deploy') printf 'migrate\n' >> "$START_LOG" ;;
  'dev -- --host ::1 --port 4321')
    [ "$SKIP_AUTH:$HOST:$PROXY_LISTEN:$DEV_PORT_CARRY" = 'true:::1:127.0.0.1:8080:1' ]
    printf 'dev\n' >> "$START_LOG"
    sleep 2
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$repo/scripts/"*.sh "$test_root/bin/"*

(
  cd "$repo"
  git init -q
  START_LOG=$test_root/start.log
  TMPDIR=$test_root/tmp
  PATH=$test_root/bin:$PATH
  BASE_DOMAIN=localhost
  CMS_AGENT_DEV_SHELL_FINGERPRINT=test-fingerprint
  export START_LOG TMPDIR PATH BASE_DOMAIN CMS_AGENT_DEV_SHELL_FINGERPRINT
  ./scripts/start-local.sh
)

expected='update
migrate
dev
mark'
[ "$(cat "$test_root/start.log")" = "$expected" ]
printf 'start-local smoke test passed\n'
