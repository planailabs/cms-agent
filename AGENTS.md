# cms-agent — agent notes

Chat-agent CMS for Astro sites. Full docs in `docs/` (architecture, phases,
setup, runbooks); start with `docs/architecture.md`.

## Ground rules

- `chat/` is the **read-only reference app** the UI/loop was extracted from —
  never modify it; it is not part of this build.
- TypeScript strict everywhere; vanilla-TS UI with a pub/sub store
  (`src/components/chat/app/store.ts`) — no UI frameworks.
- DB changes ONLY via Prisma migrations (`npx prisma migrate dev`); the
  schema must stay provider-portable (no enums, no pg-native types) because
  tests run it on SQLite (`scripts/prepare-test-db.mjs`).
- On NixOS the Prisma CLI needs engine env vars:
  `source scripts/prisma-env.sh` (or `nix develop`).
- Workflow-phase transitions are POST endpoints, never chat text; tool
  availability is enforced in `src/lib/agent/tools/registry.ts` — keep it
  that way when adding tools (zod schema + `phases` + registered in
  `src/lib/agent/handler.ts`).
- New deploy targets: implement `DeployFlow` in `src/lib/publish/` and
  register it — don't special-case the publisher.
- New site-type behaviors: implement `ContentAdapter` in `src/lib/content/`.

## Verify

```bash
pnpm test                                 # unit — must stay dependency-free
pnpm test:integration                     # real dev servers + deploy flows
cargo test --manifest-path proxy/Cargo.toml
npx tsc --noEmit && npx astro build
```
