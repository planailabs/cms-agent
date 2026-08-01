---
layout: ../../components/architecture/Shell.astro
title: Runbooks and operations
lead: Correlating logs, the runbook for each failure mode, and the checklist to walk before going live.
---

## Correlation

Log lines carry chat id, branch name, and shas (`[agent] chat=… round …`,
`[preview:branch] …`, publish logs per publication). Publications store the
full deploy log.

## Runbooks

### Preview won't start / branch shows the boot page forever
The boot page shows the failure and a **Retry** link; retrying forces a fresh
dependency install in that worktree, which is the fix for most of them.
`journalctl -u cms-agent` → `[preview:<branch>]` has the dev server's own
output, and the agent can read it in-chat with `preview_logs` / restart the
server with `restart_preview`.

The manager installs dependencies per worktree itself, so a missing
`node_modules` is not something to fix by hand. If a worktree is genuinely
wedged, deleting it is still safe (`rm -rf $VAR_DIR/worktrees/<branch>`) — it
is re-created from git and re-installed on the next start, at the cost of that
install.

### Branch worktree and DB disagree / worktree corrupted
Worktrees are disposable. Stop the preview (idle-stop, `restart_preview`, or
restart the service), delete `$VAR_DIR/worktrees/<branch>`, reload — state is
recreated from the git branch and the dependencies reinstalled. Committed
work is never in VAR_DIR only.

### Publish failed after merge ("main ahead of published")
The Publication is `failed` but main contains the merge. Fix the external
cause and press **Retry** on the publish card — the same sha and sealed
artifact are reused. Flows that talk to external APIs (cloudflare-pages)
reconcile by commit sha before uploading, so a lost response never causes a
double deploy.

### Deploy status unknown (github-ci timeout)
`verify()` polls check runs for 20 minutes. On timeout the publication is
failed-retryable; the push itself is idempotent. Check the run URL from the
publish log.

### Build permanently broken
The `validate` step (and `sealArtifact`) log the full build output into the
publish log. Reproduce with the site backend's build command
(`REPO_BUILD_COMMAND`, or the backend default) in a clean checkout. A failure
in `validate` means nothing merged: fix the site in the work branch and press
Retry — the step re-derives the merged tree, so the fix is picked up.

### Restore a known-good version
Branch history panel → pick the commit → **Restore** (new commit applying the
old tree), preview, publish. Or revert individual executions via Undo.

### Database restore
Standard `pg_dump`/`pg_restore`. Back up: PostgreSQL, the target git repo
(all branches), `$VAR_DIR/artifacts` and `$VAR_DIR/uploads`. Worktrees,
diffs, and routes files are disposable. A backup only counts once a restore
has been tested.

## Security checklist (verify before going live)

- [ ] OIDC allowlist (`ALLOWED_EMAILS`/`ALLOWED_EMAIL_DOMAIN`) configured
- [ ] Astro is bound to localhost; only the embedded proxy port is public;
      `*.BASE_DOMAIN` DNS points at it
- [ ] `PREVIEW_REQUIRE_AUTH=true` in production (preview hosts require a valid
      Better Auth database session)
- [ ] Deploy credentials (`GITHUB_TOKEN`, `CLOUDFLARE_*`, publish script
      secrets) only in the service environment — the agent's tools have no
      access to env vars, and the model never sees them
- [ ] Secret-scan validator active (blocks committing key material)
- [ ] Upload limits verified (extension + MIME + magic bytes, 25 MB)
- [ ] Prompt-injection stance: uploads and site content are data; phase
      gating + POST-only transitions mean injected text cannot approve,
      publish, or escape the worktree jail (see test suite)
- [ ] Postgres backups scheduled and restore-tested
