# cms-agent — Astro 6 SSR app (pnpm 11, nodejs 22, Prisma 7).
# Modeled on chat/package.nix; adds Prisma client generation (the app imports
# src/generated/prisma which is gitignored) and a prisma-CLI wrapper for
# `prisma migrate deploy` at deploy time (used by module.nix).
{
  lib,
  stdenv,
  nodejs_22,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  makeWrapper,
  prisma-engines_7,
  # Short git commit to embed in the UI next to the version. Passed by the
  # flake (self.shortRev) — the store source has no .git to resolve it from.
  gitCommit ? null,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "cms-agent";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.difference ./. (
      lib.fileset.unions (
        map lib.fileset.maybeMissing [
          ./dist
          ./.astro
          ./node_modules
          ./src/generated
          ./chat
          ./flake.lock
          ./.env
          ./.env.local
        ] ++ [
          ./flake.nix
          ./package.nix
          ./module.nix
          ./proxy # packaged separately (flake.nix packages.proxy)
        ]
      )
    );
  };

  nativeBuildInputs = [
    nodejs_22
    pnpm
    pnpmConfigHook
    makeWrapper
  ];

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 3;
    # NOTE: fetchPnpmDeps runs `pnpm install --force`, which is supposed to
    # fetch optional deps for *all* platforms — but pnpm silently drops
    # optional packages whose tarball download fails (flaky network), so a
    # freshly generated hash can pin an *incomplete* store; the build then
    # dies much later with e.g. lightningcss/esbuild "Cannot find module
    # '<platform binary>'". Mitigate on both ends:
    #  - be generous with retries/timeouts during the fetch,
    #  - verify the fetched store against pnpm-lock.yaml and fail the fetch
    #    (before a hash gets pinned) if any package is missing.
    prePnpmInstall = ''
      pnpm config set fetch-retries 10
      pnpm config set fetch-retry-mintimeout 20000
      pnpm config set fetch-timeout 600000
    '';
    postInstall = ''
      echo "Verifying pnpm store completeness against pnpm-lock.yaml"
      yq -r '.packages | keys | .[]' pnpm-lock.yaml | sort -u > /tmp/expected-packages
      sqlite3 "$storePath/v11/index.db" 'select key from package_index' \
        | sed 's/^.*\t//' | sort -u > /tmp/fetched-packages
      missing=$(comm -23 /tmp/expected-packages /tmp/fetched-packages)
      if [ -n "$missing" ]; then
        echo "ERROR: fetched pnpm store is missing these lockfile packages" >&2
        echo "(pnpm silently skips optional deps whose download fails):" >&2
        echo "$missing" >&2
        echo "Re-run the build to retry the fetch." >&2
        exit 1
      fi
    '';
    hash = "sha256-AHgHMYK/TvkrnjnCoesaR6c02XIB6uZ1Ql0NpeH7iV8=";
  };

  env = {
    # Prisma on NixOS: point the CLI at the nixpkgs-provided engine so it never
    # tries to download binaries in the sandbox. Prisma 7 is engine-less at
    # query time (query compiler + driver adapters), so prisma-engines_7 only
    # ships bin/schema-engine — there is no query-engine / libquery_engine.node
    # / prisma-fmt to point at anymore.
    PRISMA_SCHEMA_ENGINE_BINARY = "${prisma-engines_7}/bin/schema-engine";
    PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = "1";
    # `prisma generate --config prisma.config.ts` requires DATABASE_URL to be
    # set (the config calls env('DATABASE_URL')) but never connects.
    DATABASE_URL = "postgresql://x:x@localhost/x";
    ASTRO_TELEMETRY_DISABLED = "1";
    # `astro build` prerenders /injected-cms-agent.js + /injected-agent-module.js,
    # which loads the middleware chunk; its import graph (better-auth setup)
    # validates env() at module scope. Dummy values — the prerendered bundles
    # don't embed any of them, and the real runtime provides its own.
    BETTER_AUTH_SECRET = "build-only-build-only-build-only";
    BETTER_AUTH_URL = "http://localhost:4321";
    OIDC_ISSUER = "https://idp.invalid";
    OIDC_CLIENT_ID = "build";
    OIDC_CLIENT_SECRET = "build";
    OPENAI_BASE_URL = "https://api.openai.invalid/v1";
    OPENAI_API_KEY = "build-only";
    OPENAI_MODEL = "build-only";
    BASE_DOMAIN = "build.invalid";
    PREVIEW_COOKIE_SECRET = "build-only-build-only-build-only";
    REPO_PATH = "/build/source";
    VAR_DIR = "/build/build-var";
  } // lib.optionalAttrs (gitCommit != null) {
    PUBLIC_GIT_COMMIT = gitCommit;
  };

  buildPhase = ''
    runHook preBuild

    # Sanity check: the platform-native lightningcss addon (optional dep of
    # lightningcss, pulled in by Tailwind v4) must have been installed from
    # the pnpm store. If pnpmDeps was fetched over a flaky network, pnpm
    # silently skips failed optional-dep downloads and `astro build` later
    # dies with "Cannot find module '../lightningcss.<platform>.node'".
    # Fail early with an actionable message instead (see pnpmDeps above).
    node -e "require(require('path').resolve(process.argv[1]))" node_modules/.pnpm/lightningcss@*/node_modules/lightningcss || {
      echo "ERROR: lightningcss native addon missing from node_modules." >&2
      echo "The pnpmDeps store is likely incomplete: set pnpmDeps.hash = \"\" in package.nix and rebuild to re-fetch." >&2
      exit 1
    }

    # Generate src/generated/prisma (gitignored; imported by src/lib/db.ts).
    pnpm exec prisma generate --config prisma.config.ts

    # Generate prisma/test-client (gitignored; src/lib/db.ts imports it with a
    # literal path, so rollup must be able to resolve it during `astro build`).
    # Offline-safe: sqlite db push via PRISMA_SCHEMA_ENGINE_BINARY + generate.
    node scripts/prepare-test-db.mjs

    pnpm build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/cms-agent

    # Server entry + chunks and static client assets (Astro copies public/
    # into dist/client itself; this project has no public/ dir).
    cp -r dist $out/share/cms-agent/dist

    # Runtime deps. Not pruned to prod-only: `prisma` (CLI, a devDependency)
    # must stay available for `prisma migrate deploy` at deploy time.
    cp -r node_modules $out/share/cms-agent/node_modules

    # Production server wrapper (imports ./dist/server/entry.mjs relative to itself).
    cp server.mjs package.json $out/share/cms-agent/

    # Prisma schema + migrations + config for `prisma migrate deploy` at runtime.
    mkdir -p $out/share/cms-agent/prisma
    cp prisma/schema.prisma $out/share/cms-agent/prisma/
    cp -r prisma/migrations $out/share/cms-agent/prisma/migrations
    cp prisma.config.ts $out/share/cms-agent/

    mkdir -p $out/bin

    makeWrapper ${lib.getExe nodejs_22} $out/bin/cms-agent \
      --add-flags "$out/share/cms-agent/server.mjs" \
      --set-default PRISMA_SCHEMA_ENGINE_BINARY "${prisma-engines_7}/bin/schema-engine"

    # Prisma CLI against the packaged schema/migrations, e.g.:
    #   cms-agent-prisma migrate deploy
    # (needs DATABASE_URL in the environment; module.nix uses this as ExecStartPre)
    makeWrapper ${lib.getExe nodejs_22} $out/bin/cms-agent-prisma \
      --chdir "$out/share/cms-agent" \
      --add-flags "$out/share/cms-agent/node_modules/prisma/build/index.js" \
      --set-default PRISMA_SCHEMA_ENGINE_BINARY "${prisma-engines_7}/bin/schema-engine" \
      --set-default PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING "1"

    runHook postInstall
  '';

  meta = {
    description = "Chat-agent CMS for Astro sites (Astro + Node SSR + Prisma)";
    mainProgram = "cms-agent";
  };
})
