---
name: update
description: Reconcile cms-agent local prerequisites after pulls, merges, rebases, branch switches, or local environment changes without testing or starting services.
---

# Update cms-agent

This is an optional prewarm; the normal start performs the same cached
preflight. After Git or local environment changes, run
`./scripts/update-local.sh` from the repository root to move any slow work
ahead of the next start. Treat the script as the sole source of truth: do not
duplicate its rules or edit `local/state/update`.

Never run tests, start services, access the database, or rewrite `.env` as part
of this update. Report what the script changed, any required user fix, and
whether the next start must be fresh.
