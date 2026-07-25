# Runbooks & operations

## Correlation

Log lines carry chat id, branch name, and shas (`[agent] chat=… round …`,
`[preview:branch] …`, publish logs per publication). Publications store the
full deploy log.

## Runbooks

### Preview won't start / branch shows the boot page forever
`journalctl -u cms-agent` → look for `[preview:<branch>]` output. Common:
the target repo's `node_modules` missing (install them in `REPO_PATH`), or
the port probe failing. `rm -rf $VAR_DIR/worktrees/<branch>` is safe — the
worktree is re-created from git (`git worktree prune` runs automatically).

### Branch worktree and DB disagree / worktree corrupted
Worktrees are disposable. Stop the preview (idle-stop or restart the
service), delete `$VAR_DIR/worktrees/<branch>`, reload — state is recreated
from the git branch. Committed work is never in VAR_DIR only.

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
`sealArtifact` logs the full build output into the publish log. Reproduce
with `REPO_BUILD_COMMAND` in a clean checkout of the recorded sha.

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
