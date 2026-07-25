# cms-agent proxy

The complete Pingora public server is built as a napi-rs addon and started by
the Node process. It routes the CMS host to Astro, preview subdomains to their
dev servers, serves the preview boot flow, forwards WebSocket upgrades, injects
the preview overlay, and records preview access times.

Live routes and active Better Auth sessions are replaced directly through
N-API. `VAR_DIR/proxy-routes.json` remains a startup fallback and
`VAR_DIR/proxy-access.json` carries idle-detection timestamps.

Preview requests use Better Auth's normal cross-subdomain session cookie. The
proxy verifies the cookie signature with `BETTER_AUTH_SECRET`, then requires
the database session token mirrored by Node to be present and unexpired.

Runtime variables: `PROXY_LISTEN` (default `0.0.0.0:8080`), `BASE_DOMAIN`,
`VAR_DIR`, `BETTER_AUTH_SECRET`, optional `PREVIEW_REQUIRE_AUTH`,
`PUBLIC_SCHEME`, and `CMS_UPSTREAM`.

```sh
cargo test
nix build .#proxy-native
```
