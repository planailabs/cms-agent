---
name: sync-version
description: Keep the displayed cms-agent app version current. Use whenever committing or pushing in this repository, including requests such as commit, merge, push, publish changes, or prepare a release. Increment and verify the header-facing APP_VERSION in src/lib/buildInfo.ts before the Git write without touching dependency manifests.
---

# Sync Version

Keep the UI-facing `APP_VERSION` in `src/lib/buildInfo.ts` current. Do not change `package.json` or `package.nix`; their package versions affect the Nix dependency derivation and are independent of the displayed build version.

## Before a commit

1. Compare `src/lib/buildInfo.ts` with `HEAD`. If the current change already contains one version bump, keep it.
2. Otherwise run `node .agents/skills/sync-version/scripts/version.mjs bump`.
3. Run `node .agents/skills/sync-version/scripts/version.mjs check`.
4. Stage `src/lib/buildInfo.ts` with the requested changes, then commit normally.

Every new commit must carry one patch-version increment. Do not create tags.

## Before a push

1. Fetch or inspect the configured upstream when available.
2. Run the check command.
3. Verify the commits being pushed contain an `APP_VERSION` change relative to the upstream. If they do not, run the bump command and create `chore: bump version to vX.Y.Z` before pushing.
4. Push only after the working tree and commit history contain the displayed version.

If the branch has no upstream, compare against its merge base with the repository's default branch. Never rewrite existing commits merely to add a version bump.
