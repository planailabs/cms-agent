# Development process file — run inside `nix develop` with `overmind start`.
# The Node process owns both Astro and the native Pingora listener. Site
# commands still run through the sandbox launcher.
cms: rm -rf var/proxy-routes.json $TMPDIR/cms-agent-diffs; SKIP_AUTH=true HOST=::1 PROXY_LISTEN=127.0.0.1:8080 DEV_PORT_CARRY=1 bash scripts/launch-with-sandbox.sh bash -c 'set -e; pnpm dev -- --host ::1 & pid=$!; trap "kill $pid 2>/dev/null || true" EXIT INT TERM; until node -e "fetch(\"http://[::1]:4321/\", { redirect: \"manual\" }).catch(() => process.exit(1))"; do kill -0 "$pid"; sleep .1; done; wait "$pid"' | cat
