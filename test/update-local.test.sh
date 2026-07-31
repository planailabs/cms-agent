#!/bin/sh
set -eu

source_root=$(git rev-parse --show-toplevel)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/cms-update-test.XXXXXX")
trap 'rm -rf "$test_root"' 0
repo=$test_root/repo
mkdir -p "$repo/scripts" "$repo/src/lib" "$repo/src/generated/prisma" \
  "$repo/prisma/migrations/001" "$repo/nix" "$repo/proxy" "$test_root/bin"
cp "$source_root/scripts/update-local.sh" "$repo/scripts/update-local.sh"

for path in .env .env.example Procfile pnpm-lock.yaml pnpm-workspace.yaml \
  prisma/schema.prisma prisma.config.ts flake.nix flake.lock \
  nix/firecrawl-native.Cargo.lock proxy/source.rs \
  prisma/migrations/001/migration.sql scripts/launch-with-sandbox.sh server.mjs; do
  mkdir -p "$repo/$(dirname "$path")"
  printf '%s\n' "$path" > "$repo/$path"
done
printf '{}\n' > "$repo/package.json"
printf 'export function env() { return { PORT: 4321 }; }\n' > "$repo/src/lib/env.ts"
printf 'stale\n' > "$repo/src/generated/prisma/client.ts"

(
  cd "$repo"
  git init -q
  git add .
)

cat > "$test_root/bin/nix" <<'EOF'
#!/bin/sh
: "${NIX_LOG:?}"
printf 'nix\n' >> "$NIX_LOG"
[ "${FAIL_NIX-}" != 1 ] || exit 99
[ "$1" = develop ] && [ "$2" = --command ] || exit 64
shift 2
exec "$@"
EOF
cat > "$test_root/bin/node" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$test_root/bin/pnpm" <<'EOF'
#!/bin/sh
case "$1:$2" in
  install:--frozen-lockfile)
    mkdir -p node_modules/.pnpm
    cp pnpm-lock.yaml node_modules/.pnpm/lock.yaml
    if [ "${MUTATE_DURING_INSTALL-}" = 1 ]; then printf '{"changed":true}\n' > package.json; fi
    ;;
  run:prisma:generate)
    mkdir -p src/generated/prisma
    cp prisma/schema.prisma src/generated/prisma/client.ts
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$test_root/bin/nix" "$test_root/bin/node" "$test_root/bin/pnpm"

expect_status() {
  expected=$1
  shift
  if "$@"; then actual=0; else actual=$?; fi
  [ "$actual" -eq "$expected" ] || {
    printf 'expected status %s, got %s: %s\n' "$expected" "$actual" "$*" >&2
    exit 1
  }
}

cd "$repo"
PATH=$test_root/bin:$PATH
NIX_LOG=$test_root/nix.log
export PATH NIX_LOG
fingerprint=$(./scripts/update-local.sh --print-nix-fingerprint)
case "$fingerprint" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ ! -e local/state/update ]
expect_status 10 ./scripts/update-local.sh --check
./scripts/update-local.sh
[ "$(wc -l < "$NIX_LOG")" -eq 1 ]
[ "$(wc -l < local/state/update)" -eq 6 ]
expect_status 11 ./scripts/update-local.sh --check
runtime_fingerprint=$(./scripts/update-local.sh --print-runtime-fingerprint)
./scripts/update-local.sh --mark-started "$runtime_fingerprint"
expect_status 0 ./scripts/update-local.sh --check

printf 'changed runtime\n' > server.mjs
expect_status 2 ./scripts/update-local.sh --mark-started "$runtime_fingerprint"
expect_status 11 ./scripts/update-local.sh --check

printf 'changed schema\n' > prisma/schema.prisma
expect_status 10 ./scripts/update-local.sh --check
env CMS_AGENT_DEV_SHELL_FINGERPRINT="$fingerprint" FAIL_NIX=1 ./scripts/update-local.sh
[ "$(wc -l < "$NIX_LOG")" -eq 1 ]
expect_status 11 ./scripts/update-local.sh --check

cp local/state/update "$test_root/state-before-race"
printf 'changed lock\n' > pnpm-lock.yaml
expect_status 2 env MUTATE_DURING_INSTALL=1 ./scripts/update-local.sh
cmp -s local/state/update "$test_root/state-before-race"
printf 'update-local smoke test passed\n'
