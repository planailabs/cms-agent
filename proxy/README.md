# cms-agent-proxy

Rust reverse-proxy sidecar (built on [Cloudflare pingora](https://github.com/cloudflare/pingora) 0.6) that is the stable
public entrypoint for the CMS. It routes by Host header, gates preview hosts with
an HMAC cookie, injects the preview overlay script into HTML, and records
last-access timestamps so the CMS can stop idle previews.

## Routing (by Host header, port stripped)

| Host | Behavior |
| --- | --- |
| `BASE_DOMAIN` | Proxy to the CMS upstream (routes file `cms`, fallback `CMS_UPSTREAM`). The CMS does its own auth. |
| `<branch>.BASE_DOMAIN`, `<branch>` in `previews` | Proxy to that preview upstream. HTTP/1.1 Upgrade (WebSocket) passthrough works, so Vite HMR is supported. CSP headers are stripped and the overlay script is injected into HTML responses. |
| `<branch>.BASE_DOMAIN`, valid DNS label but unknown | Rewritten to the CMS upstream at `/__preview/boot/<branch>` (the CMS serves a "starting preview…" page and boots the instance). |
| anything else | `404` |

A valid branch label matches `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` (matching is
case-insensitive; hosts are lowercased first).

## Auth at the edge

For both preview cases, when `PREVIEW_REQUIRE_AUTH` is not `"false"` the request
must carry a cookie `cms_preview` with value:

```
<userId>.<expiresAtMs>.<sigBase64url>
```

where `sig = HMAC-SHA256(secret = PREVIEW_COOKIE_SECRET, message = "<userId>.<expiresAtMs>")`,
base64url-encoded without padding. Missing, expired, malformed, or badly signed
cookies get a `302` redirect to `PUBLIC_SCHEME://BASE_DOMAIN/signin/`.

## HTML overlay injection

For responses from running preview upstreams with `Content-Type: text/html`, the
proxy injects

```html
<script src="PUBLIC_SCHEME://BASE_DOMAIN/preview-overlay.js" defer></script>
```

before `</head>` (case-insensitive), falling back to `</body>`; if neither exists
the body passes through untouched. Bodies are buffered up to 4 MB for the rewrite
(Content-Length is replaced with chunked transfer encoding); larger bodies pass
through unmodified. `Content-Security-Policy` headers are stripped from preview
responses so the injected script can run (previews are auth-gated).

## Environment variables (read at startup)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PROXY_LISTEN` | no | `0.0.0.0:8080` | TCP listen address |
| `BASE_DOMAIN` | **yes** | — | Public base domain, e.g. `cms.example.com` |
| `VAR_DIR` | **yes** | — | Directory for the two contract files below |
| `PREVIEW_COOKIE_SECRET` | unless auth disabled | — | HMAC-SHA256 secret for the `cms_preview` cookie |
| `PREVIEW_REQUIRE_AUTH` | no | `true` | Set to exactly `false` to disable edge auth for previews |
| `PUBLIC_SCHEME` | no | `http` | Scheme used in the signin redirect and overlay URL |
| `CMS_UPSTREAM` | no | `127.0.0.1:4321` | CMS upstream used until the routes file loads |

## File contracts with the TypeScript CMS

### `${VAR_DIR}/proxy-routes.json` (CMS writes, proxy reads)

```json
{
  "cms": "127.0.0.1:4321",
  "previews": {
    "my-branch": "127.0.0.1:43211"
  }
}
```

The proxy polls the file's mtime every second and hot-reloads it. A missing or
broken file keeps the last good config; before the first successful load, `cms`
falls back to `CMS_UPSTREAM` and `previews` is empty.

### `${VAR_DIR}/proxy-access.json` (proxy writes, CMS reads)

```json
{
  "my-branch": 1784215173165
}
```

Maps branch name to the unix-milliseconds timestamp of its last request (both
running previews and boot requests count). Updated in memory on every preview
request and flushed to disk at most every 10 seconds via atomic write
(`proxy-access.json.tmp` + rename).

## Build, test, run

```sh
cargo build --release   # needs cmake + a C compiler (pingora builds zlib-ng/zstd)
cargo test
BASE_DOMAIN=cms.example.com VAR_DIR=/var/lib/cms PREVIEW_COOKIE_SECRET=... \
  ./target/release/cms-agent-proxy
```

On NixOS without global tooling:

```sh
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc nixpkgs#cmake --command cargo build --release
```

Logging via `RUST_LOG` (default `info`).
