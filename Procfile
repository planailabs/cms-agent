# Development process file — run with `overmind start` (in `nix develop`).
# Reads .env automatically (overmind sources it into every process).
# - SKIP_AUTH: no sign-in; you are admin@localhost (switch via
#   POST /api/dev/impersonate). Development only.
# - astro dev binds ::1 (localhost) — HOST=::1 makes the routes file and the
#   proxy's CMS_UPSTREAM fallback point at the same IPv6 address.
# - VAR_DIR=$PWD/var: the proxy must see the SAME var dir as the CMS; $PWD
#   expands to the repo root when overmind parses the line, so the value is
#   absolute and survives sudo/cargo-watch working-directory changes.
# - PREVIEW_REQUIRE_AUTH=false because domain cookies don't work on localhost.
cms: SKIP_AUTH=true HOST=::1 bash scripts/launch-with-sandbox.sh pnpm dev | cat
# cargo-watch needs the crate as its workdir (-C proxy); $PWD still expands
# to the repo root when the shell parses the line, keeping VAR_DIR absolute.
proxy: PREVIEW_REQUIRE_AUTH=false cargo-watch -C proxy -w src -w Cargo.toml -- sudo -E env PROXY_LISTEN=127.0.0.1:80 CMS_UPSTREAM=[::1]:4321 VAR_DIR=$PWD/var CARGO_TARGET_DIR=/tmp/cms-proxy cargo run | cat
