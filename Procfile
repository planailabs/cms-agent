# Development process file — run with `overmind start` (in `nix develop`).
# Reads .env automatically (overmind sources it into every process).
# PREVIEW_REQUIRE_AUTH=false because domain cookies don't work on localhost.
cms: pnpm dev
proxy: PROXY_LISTEN=127.0.0.1:8080 CMS_UPSTREAM=127.0.0.1:4321 PREVIEW_REQUIRE_AUTH=false cargo run --manifest-path proxy/Cargo.toml | cat
