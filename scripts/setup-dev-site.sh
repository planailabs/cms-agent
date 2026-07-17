#!/usr/bin/env bash
# Create a real, git-inited working copy of an example site for development
# and print the .env values to point the CMS at it.
#
#   scripts/setup-dev-site.sh [example] [dest]
#   example: basic-site | blog-site   (default: blog-site)
#   dest:    target directory          (default: ./local/dev-site)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="${1:-blog-site}"
DEST="${2:-$ROOT/local/dev-site}"

if [ ! -d "$ROOT/examples/$EXAMPLE" ]; then
  echo "Unknown example: $EXAMPLE (available: $(ls "$ROOT/examples" | tr '\n' ' '))" >&2
  exit 1
fi
if [ -e "$DEST" ]; then
  echo "$DEST already exists — remove it first or pass another destination." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp -r "$ROOT/examples/$EXAMPLE" "$DEST"
cd "$DEST"
git init -b main -q
git add -A
git -c user.name="Dev Setup" -c user.email="dev@localhost" commit -qm "Initial site ($EXAMPLE)"

echo
echo "Dev site ready at: $DEST"
echo
echo "Point the CMS at it in .env:"
echo "  REPO_PATH=$DEST"
if [ "$EXAMPLE" = "blog-site" ]; then
  echo '  ROUTE_MAPPINGS=[{"files":"src/content/blog/*.md","route":"/blog/:slug/"}]'
fi
