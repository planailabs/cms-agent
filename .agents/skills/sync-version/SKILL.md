---
name: sync-version
description: Keep the cms-agent app version current and visible. Use whenever committing or pushing in this repository, including requests such as commit, merge, push, publish changes, or prepare a release. Synchronize package.json with the header-facing APP_VERSION in src/lib/buildInfo.ts before the Git write.
---

# Sync Version

Keep `package.json` and `src/lib/buildInfo.ts` on the same semantic version. The UI already displays `APP_VERSION`; do not add another display path.

## Before a commit

1. Compare both version files with `HEAD`. If the current change already contains one synchronized version bump, keep it.
2. Otherwise run `node .agents/skills/sync-version/scripts/version.mjs bump`.
3. Run `node .agents/skills/sync-version/scripts/version.mjs check`.
4. Stage both version files with the requested changes, then commit normally.

Every new commit must carry one patch-version increment. Do not create tags.

## Before a push

1. Fetch or inspect the configured upstream when available.
2. Run the check command.
3. Verify the commits being pushed contain a version change relative to the upstream. If they do not, run the bump command and create `chore: bump version to vX.Y.Z` before pushing.
4. Push only after the working tree and commit history contain the synchronized version.

If the branch has no upstream, compare against its merge base with the repository's default branch. Never rewrite existing commits merely to add a version bump.
