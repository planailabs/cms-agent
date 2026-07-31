#!/usr/bin/env bash
# NixOS helper: point Prisma at nixpkgs-provided engines (no binary downloads).
# Usage: source scripts/prisma-env.sh   (the flake devShell sets these itself)
set -euo pipefail

ENGINES=$(nix build nixpkgs#prisma-engines_7 --no-link --print-out-paths)

export PRISMA_SCHEMA_ENGINE_BINARY="$ENGINES/bin/schema-engine"
export PRISMA_QUERY_ENGINE_BINARY="$ENGINES/bin/query-engine"
export PRISMA_QUERY_ENGINE_LIBRARY="$ENGINES/lib/libquery_engine.node"
export PRISMA_FMT_BINARY="$ENGINES/bin/prisma-fmt"
export CHECKPOINT_DISABLE=1

echo "prisma engines: $ENGINES"
