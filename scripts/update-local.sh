#!/bin/sh
set -eu

# Bump when the state format, fingerprints, or validation semantics change.
STATE_VERSION=3
STATE_FILE=local/state/update
STALE=10
RESTART=11
state_tmp=

die() {
  printf '%s\n' "$*" >&2
  exit 2
}

cleanup() {
  [ -z "$state_tmp" ] || rm -f "$state_tmp"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 131' 3
trap 'exit 143' 15

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die "Run this command inside the cms-agent repository."
cd "$repo_root"

fingerprint() {
  fp_records=
  for fp_spec do
    case "$fp_spec" in
      */)
        fp_files=$(LC_ALL=C git ls-files -- "$fp_spec") || return 1
        fp_records="${fp_records}directory $fp_spec
"
        while IFS= read -r fp_path; do
          [ -n "$fp_path" ] || continue
          if [ -e "$fp_path" ] || [ -L "$fp_path" ]; then
            fp_oid=$(git hash-object --no-filters -- "$fp_path") || return 1
            fp_records="${fp_records}file $fp_path $fp_oid
"
          else
            fp_records="${fp_records}missing $fp_path
"
          fi
        done <<EOF
$fp_files
EOF
        ;;
      *)
        if [ -e "$fp_spec" ] || [ -L "$fp_spec" ]; then
          fp_oid=$(git hash-object --no-filters -- "$fp_spec") || return 1
          fp_records="${fp_records}file $fp_spec $fp_oid
"
        else
          fp_records="${fp_records}missing $fp_spec
"
        fi
        ;;
    esac
  done
  printf '%s' "$fp_records" | git hash-object --stdin
}

combine() {
  printf '%s\n' "$@" | git hash-object --stdin
}

compute_current() {
  current_env=$(fingerprint .env .env.example .overmind.env src/lib/env.ts Procfile) || die "Could not fingerprint the environment contract."
  current_deps=$(fingerprint package.json pnpm-lock.yaml pnpm-workspace.yaml) || die "Could not fingerprint dependencies."
  prisma_files=$(fingerprint prisma/schema.prisma prisma.config.ts) || die "Could not fingerprint Prisma inputs."
  current_prisma_inputs=$(combine "$current_deps" "$prisma_files") || die "Could not fingerprint Prisma inputs."
  current_prisma=$current_prisma_inputs
  current_nix=$(fingerprint flake.nix flake.lock nix/firecrawl-native.Cargo.lock proxy/ scripts/update-local.sh) || die "Could not fingerprint the Nix shell."
  migration_files=$(fingerprint prisma/migrations/) || die "Could not fingerprint migrations."
  runtime_files=$(fingerprint .env.local .env.development .env.development.local scripts/launch-with-sandbox.sh scripts/start-local.sh server.mjs) || die "Could not fingerprint the runtime."
  current_runtime=$(combine "$current_env" "$current_deps" "$current_prisma" "$current_nix" "$migration_files" "$runtime_files") || die "Could not fingerprint the runtime."
}

valid_hash() {
  hash_value=$1
  case "$hash_value" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#hash_value}" -eq 40 ] || [ "${#hash_value}" -eq 64 ]
}

load_state() {
  [ -f "$STATE_FILE" ] || return 1
  stored_env=
  stored_deps=
  stored_prisma=
  stored_nix=
  stored_started=
  state_line_no=0
  while IFS= read -r state_line || [ -n "$state_line" ]; do
    state_line_no=$((state_line_no + 1))
    case "$state_line_no" in
      1) [ "$state_line" = "v=$STATE_VERSION" ] || return 1 ;;
      2) case "$state_line" in env=*) stored_env=${state_line#env=} ;; *) return 1 ;; esac ;;
      3) case "$state_line" in deps=*) stored_deps=${state_line#deps=} ;; *) return 1 ;; esac ;;
      4) case "$state_line" in prisma=*) stored_prisma=${state_line#prisma=} ;; *) return 1 ;; esac ;;
      5) case "$state_line" in nix=*) stored_nix=${state_line#nix=} ;; *) return 1 ;; esac ;;
      6) case "$state_line" in started=*) stored_started=${state_line#started=} ;; *) return 1 ;; esac ;;
      *) return 1 ;;
    esac
  done < "$STATE_FILE"
  [ "$state_line_no" -eq 6 ] || return 1
  valid_hash "$stored_env" && valid_hash "$stored_deps" && valid_hash "$stored_prisma" && valid_hash "$stored_nix" || return 1
  [ -z "$stored_started" ] || valid_hash "$stored_started"
}

dependencies_current() {
  [ -f node_modules/.pnpm/lock.yaml ] && cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml
}

prisma_current() {
  [ -f src/generated/prisma/client.ts ]
}

check_current() {
  compute_current
  load_state || return "$STALE"
  [ "$stored_env" = "$current_env" ] &&
    [ "$stored_deps" = "$current_deps" ] &&
    [ "$stored_prisma" = "$current_prisma" ] &&
    [ "$stored_nix" = "$current_nix" ] &&
    dependencies_current && prisma_current || return "$STALE"
  [ "$stored_started" = "$current_runtime" ] || return "$RESTART"
}

write_state() {
  state_started=$1
  mkdir -p "${STATE_FILE%/*}"
  state_tmp=$(mktemp "${STATE_FILE%/*}/.update.XXXXXX") || die "Could not create local update state."
  {
    printf 'v=%s\n' "$STATE_VERSION"
    printf 'env=%s\n' "$current_env"
    printf 'deps=%s\n' "$current_deps"
    printf 'prisma=%s\n' "$current_prisma"
    printf 'nix=%s\n' "$current_nix"
    printf 'started=%s\n' "$state_started"
  } > "$state_tmp"
  mv "$state_tmp" "$STATE_FILE"
  state_tmp=
}

apply_updates() {
  [ "$#" -eq 3 ] || die "Internal update invocation is invalid."
  for apply_flag do
    case "$apply_flag" in 0|1) ;; *) die "Internal update invocation is invalid." ;; esac
  done
  need_deps=$1
  need_env=$2
  need_prisma=$3

  [ "$need_deps" -eq 0 ] || pnpm install --frozen-lockfile
  if [ "$need_env" -eq 1 ]; then
    node --experimental-strip-types --input-type=module -e '
      const { env } = await import("./src/lib/env.ts");
      const config = env();
      const upstream = process.env.CMS_UPSTREAM;
      if (upstream) {
        const match = /:(\d+)$/.exec(upstream);
        if (!match || Number(match[1]) !== config.PORT) {
          throw new Error("PORT and CMS_UPSTREAM must use the same internal port");
        }
      }
    '
  fi
  [ "$need_prisma" -eq 0 ] || pnpm run prisma:generate
}

update_local() {
  compute_current
  initial_env=$current_env
  initial_deps=$current_deps
  initial_prisma_inputs=$current_prisma_inputs
  initial_nix=$current_nix
  state_ok=0
  if load_state; then state_ok=1; fi

  need_deps=1
  if [ "$state_ok" -eq 1 ] && [ "$stored_deps" = "$current_deps" ] && dependencies_current; then need_deps=0; fi

  need_env=1
  need_prisma=1
  need_nix=1
  if [ "$state_ok" -eq 1 ]; then
    [ "$stored_env" != "$current_env" ] || need_env=0
    if [ "$stored_prisma" = "$current_prisma" ] && prisma_current; then need_prisma=0; fi
    [ "$stored_nix" != "$current_nix" ] || need_nix=0
  fi
  [ "$need_nix" -eq 0 ] || need_env=1
  [ "$need_deps" -eq 0 ] || need_env=1

  if [ "$need_deps" -eq 0 ] && [ "$need_env" -eq 0 ] && [ "$need_prisma" -eq 0 ] && [ "$need_nix" -eq 0 ]; then
    if [ "$stored_started" = "$current_runtime" ]; then
      printf 'Local prerequisites are current.\n'
    else
      printf 'Local prerequisites are current; the next start must be fresh.\n'
    fi
    return
  fi

  if [ "${CMS_AGENT_DEV_SHELL_FINGERPRINT-}" = "$current_nix" ]; then
    apply_updates "$need_deps" "$need_env" "$need_prisma"
  else
    UPDATE_LOCAL_INTERNAL=1 nix develop --command sh scripts/update-local.sh --apply "$need_deps" "$need_env" "$need_prisma"
  fi

  compute_current
  [ "$current_env" = "$initial_env" ] &&
    [ "$current_deps" = "$initial_deps" ] &&
    [ "$current_prisma_inputs" = "$initial_prisma_inputs" ] &&
    [ "$current_nix" = "$initial_nix" ] || die "Local inputs changed during the update; run it again."
  dependencies_current || die "Dependency installation did not match pnpm-lock.yaml."
  prisma_current || die "Prisma client generation did not produce src/generated/prisma/client.ts."
  write_state ""

  updated=
  [ "$need_deps" -eq 0 ] || updated="$updated dependencies"
  [ "$need_env" -eq 0 ] || updated="$updated environment"
  [ "$need_prisma" -eq 0 ] || updated="$updated prisma"
  [ "$need_nix" -eq 0 ] || updated="$updated nix"
  printf 'Updated local prerequisites:%s. The next start must be fresh.\n' "$updated"
}

mark_started() {
  expected_runtime=$1
  valid_hash "$expected_runtime" || die "The expected runtime fingerprint is invalid."
  if check_current; then
    check_status=0
  else
    check_status=$?
  fi
  case "$check_status" in
    0|"$RESTART") ;;
    "$STALE") die "Local prerequisites are stale; run ./scripts/update-local.sh first." ;;
    *) exit "$check_status" ;;
  esac
  [ "$current_runtime" = "$expected_runtime" ] || die "Local inputs changed during startup; start again."
  write_state "$current_runtime"
  printf 'Recorded the successful local start.\n'
}

case "${1-}" in
  '') update_local ;;
  --check)
    [ "$#" -eq 1 ] || die "Usage: $0 [--check|--mark-started HASH]"
    if check_current; then exit 0; else exit "$?"; fi
    ;;
  --mark-started)
    [ "$#" -eq 2 ] || die "Usage: $0 --mark-started HASH"
    mark_started "$2"
    ;;
  --print-nix-fingerprint)
    [ "$#" -eq 1 ] || die "Usage: $0 [--check|--mark-started|--print-nix-fingerprint]"
    fingerprint flake.nix flake.lock nix/firecrawl-native.Cargo.lock proxy/ scripts/update-local.sh
    ;;
  --print-runtime-fingerprint)
    [ "$#" -eq 1 ] || die "Usage: $0 --print-runtime-fingerprint"
    compute_current
    printf '%s\n' "$current_runtime"
    ;;
  --apply)
    [ "${UPDATE_LOCAL_INTERNAL-}" = 1 ] || die "--apply is internal; run $0 instead."
    shift
    apply_updates "$@"
    ;;
  *) die "Usage: $0 [--check|--mark-started HASH]" ;;
esac
