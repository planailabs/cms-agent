# Development process file — run inside `nix develop` with `overmind start`.
# The Node process owns both Astro and the native Pingora listener. Site
# commands still run through the sandbox launcher.
cms: rm -rf var/proxy-routes.json $TMPDIR/cms-agent-diffs; SKIP_AUTH=true HOST=::1 PROXY_LISTEN=127.0.0.1:8080 bash scripts/launch-with-sandbox.sh pnpm dev -- --host '::1' | cat
