# cms-agent

Chat-agent CMS for Astro sites. An AI agent manages a target Astro repository
through git branches: every draft branch gets a live dev-server preview at
`<branch>.your-domain.tld` (behind a Rust reverse proxy this app controls),
and every change cycles through **plan → execute → preview → publish** with
explicit approvals, one self-contained commit per execution, visual page
diffs, and pluggable deployment flows.

- **Chat-first**: the whole workflow is driven from a chat sidebar (multiple
  chats per branch, shared between all users, persistent, streaming).
- **Safe by construction**: the plan phase is read-only (enforced server-side,
  not just prompted), publishing binds the exact reviewed commit, undo is a
  `git revert`, and validators block secrets/binaries/symlinks before any
  commit.
- **Bring your own model**: any OpenAI-compatible endpoint
  (`OPENAI_BASE_URL` + `OPENAI_API_KEY` + `OPENAI_MODEL`).

## Quick start (development)

```bash
nix develop               # dev shell: node, pnpm, cargo, postgres, overmind,
                          # Prisma engines + Playwright browsers wired up
pnpm install
cp .env.example .env             # fill in DATABASE_URL, OPENAI_*, …
scripts/setup-dev-site.sh        # real git-inited site copy at ./local/dev-site
npx prisma migrate deploy        # against your postgres
overmind start                   # Procfile: CMS (SKIP_AUTH dev mode) + proxy
```

Without Nix you need Node 22, pnpm 11, and a Rust toolchain, then run the two
Procfile processes yourself (`pnpm dev` and
`cargo run --manifest-path proxy/Cargo.toml`). See **docs/setup.md** for every
environment variable, **docs/walkthrough.md** for an end-to-end tour with
`examples/blog-site`, and **docs/nixos.md** for the NixOS module.

## Tests

```bash
pnpm test              # self-contained: throwaway SQLite, no services
pnpm test:integration  # boots real astro dev servers + deploy flows;
                       # the live agent-loop test runs only with a real OPENAI_API_KEY
cargo test --manifest-path proxy/Cargo.toml
```

## Repository layout

```
src/lib/agent/     session loop (OpenAI streaming), tools + in-process MCP,
                   workflow phases, locks, persistence
src/lib/git/       branches, worktrees, single-commit executions, revert/restore
src/lib/preview/   on-demand astro dev instances + sidecar routes file
src/lib/diff/      changed-page mapping + Playwright/pixelmatch screenshot diffs
src/lib/publish/   DeployFlow registry (git-push, web-agency, github-ci,
                   cloudflare-pages) + sealed artifacts
src/lib/content/   ContentAdapter port (collections + JobPosting adapters)
src/lib/validate/  pre-commit + pre-publish validators
src/components/    vanilla-TS UI (chat extracted from plan.ai-chat + workspace)
proxy/             Rust Pingora reverse-proxy sidecar
examples/          sample target sites used by tests and docs
```
