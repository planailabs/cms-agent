# Development process file — run with `overmind start` (in `nix develop`).
# Reads .env automatically (overmind sources it into every process).
# - SKIP_AUTH: no sign-in; you are admin@localhost (switch via
#   POST /api/dev/impersonate). Development only.
# - Bind the CMS dev server to ::1 (--host ::1) so it matches HOST=::1 — which
#   is what the routes file's `cms` upstream and the proxy's CMS_UPSTREAM point
#   at. (astro/vite ignores the HOST env var; the flag is what actually binds
#   it.) Sandboxed preview dev servers bind HOST too, so they stay consistent.
# - The cms line clears a possibly-stale var/proxy-routes.json first: a routes
#   file left from an earlier run with cms=127.0.0.1 would make the proxy dial
#   v4 and 502 while the CMS listens on ::1. Cleared, the proxy uses the fresh
#   [::1] upstream (CMS_UPSTREAM fallback, then the CMS-written file).
# - launch-with-sandbox.sh builds the node sandbox squashfs on the fly (nix)
#   and exports SANDBOX_DIR_* so the CMS can jail all site shell commands.
# - VAR_DIR=$PWD/var: the proxy must see the SAME var dir as the CMS; $PWD
#   expands to the repo root when overmind parses the line, so the value is
#   absolute and survives sudo/cargo-watch working-directory changes.
# - PREVIEW_REQUIRE_AUTH=false because domain cookies don't work on localhost.
cms: rm -f var/proxy-routes.json; SKIP_AUTH=true HOST=::1 bash scripts/launch-with-sandbox.sh pnpm dev -- --host '::1' | cat
# cargo-watch needs the crate as its workdir (-C proxy); $PWD still expands
# to the repo root when the shell parses the line, keeping VAR_DIR absolute.
proxy: PREVIEW_REQUIRE_AUTH=false cargo-watch -C proxy -w src -w Cargo.toml -- sudo -E env PROXY_LISTEN=127.0.0.1:80 CMS_UPSTREAM=[::1]:4321 VAR_DIR=$PWD/var CARGO_TARGET_DIR=/tmp/cms-proxy cargo run | cat
