# Development process file — run with `overmind start` (in `nix develop`).
# Reads .env automatically (overmind sources it into every process).
# - SKIP_AUTH: no sign-in; you are admin@localhost (switch via
#   POST /api/dev/impersonate). Development only.
# - astro dev binds ::1 (localhost) — HOST=::1 makes the routes file and the
#   proxy's CMS_UPSTREAM fallback point at the same IPv6 address.
# - PREVIEW_REQUIRE_AUTH=false because domain cookies don't work on localhost.
cms: SKIP_AUTH=true HOST=::1 pnpm dev
proxy: PROXY_LISTEN=127.0.0.1:8080 CMS_UPSTREAM=[::1]:4321 PREVIEW_REQUIRE_AUTH=false cargo run --manifest-path proxy/Cargo.toml | cat
