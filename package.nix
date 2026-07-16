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
    hash = "sha256-6SigCcG32F3Y9rdcbv6qbiM++m9BOpXHPOIlCAmtJPw=";
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
  };

  buildPhase = ''
    runHook preBuild

    # Generate src/generated/prisma (gitignored; imported by src/lib/db.ts).
    pnpm exec prisma generate --config prisma.config.ts

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
