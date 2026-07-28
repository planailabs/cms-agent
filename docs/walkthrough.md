# End-to-end walkthrough (examples/blog-site)

## 1. Prepare the target site

```bash
scripts/setup-dev-site.sh blog-site   # git-inited copy at ./local/dev-site
```

## 2. Configure and start the CMS

`.env` (see docs/setup.md for the rest):

```ini
REPO_PATH=./local/dev-site
ROUTE_MAPPINGS=[{"files":"src/content/blog/*.md","route":"/blog/:slug/"}]
BASE_DOMAIN=cms.localtest.me       # *.localtest.me resolves to 127.0.0.1
DEPLOY_FLOW=web-agency
PUBLISH_COMMAND=./scripts/demo-publish.sh   # e.g. `cp "$TARBALL_PATH" /tmp/published.tar.gz`
```

```bash
nix develop
overmind start    # Procfile: CMS on :4321 + proxy entrypoint on :8080
```

Open `http://cms.localtest.me:8080`, sign in via your OIDC provider.

## 3. Plan

Create a branch (`summer-posts`) and a chat on it. Ask:

> Add a new blog post announcing our summer office hours (shorter Fridays in
> July and August). Link it from the front page list as usual.

The agent reads the site (watch the tool activity), possibly asks a question,
then presents a **plan card** (files, pages, risk). Try asking it to change a
file now — the write tool is rejected: plan phase is read-only.

## 4. Execute

Click **Approve plan** (or, for a plan the agent judged unambiguous, it never
stopped to ask — `start_execution` records the plan and continues). The agent
writes
`src/content/blog/summer-office-hours.md` in the branch worktree — the
preview at `summer-posts.cms.localtest.me:8080` updates live via HMR. When
the agent calls `finish_execution`, confirm it: whatever is left becomes one
commit (card with sha + **Undo**).

## 5. Review the visual diff

Click the eye in the tool rail (the agent can also open it for you) — the main
area switches to the compare window: the changed pages (`/` and
`/blog/summer-office-hours/` via ROUTE_MAPPINGS) as side-by-side live frames,
a screenshot overlay with changed regions highlighted, and the draggable
onion slider. Select text in the preview → **Chat about this** quotes it into
the chat as a context chip. Not happy? **Request changes** loops back to a
new plan round.

## 6. Publish

Click **Publish**. The CMS refuses if the branch moved since your review;
otherwise it merges to main, builds the exact sha in a clean checkout, seals
the artifact (tarball + per-file sha256 manifest under `var/artifacts/`),
runs your `PUBLISH_COMMAND`, and streams the log into the chat. On success
the branch resets onto the new main and the chat starts the next PLAN round.

## 7. Multi-user

Open a second browser (second OIDC user): the same branches and chats are
visible, live. Two chats can plan in parallel on one branch; only one at a
time can execute (branch mutation lock).
