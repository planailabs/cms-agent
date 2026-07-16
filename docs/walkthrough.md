# End-to-end walkthrough (examples/blog-site)

## 1. Prepare the target site

```bash
cp -r examples/blog-site /tmp/blog-site
cd /tmp/blog-site && git init -b main && git add -A && git commit -m init && npm install
```

## 2. Configure and start the CMS

`.env` (see docs/setup.md for the rest):

```ini
REPO_PATH=/tmp/blog-site
ROUTE_MAPPINGS=[{"files":"src/content/blog/*.md","route":"/blog/:slug/"}]
BASE_DOMAIN=cms.localtest.me       # *.localtest.me resolves to 127.0.0.1
DEPLOY_FLOW=web-agency
PUBLISH_COMMAND=./scripts/demo-publish.sh   # e.g. `cp "$TARBALL_PATH" /tmp/published.tar.gz`
```

```bash
pnpm dev &                                        # CMS on :4321
PROXY_LISTEN=0.0.0.0:8080 CMS_UPSTREAM=127.0.0.1:4321 \
  cargo run --manifest-path proxy/Cargo.toml &    # public entrypoint
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

Click **Approve plan**. The agent writes
`src/content/blog/summer-office-hours.md` in the branch worktree — the
preview at `summer-posts.cms.localtest.me:8080` updates live via HMR. When
the agent calls `finish_execution`, click **Create preview**: all changes
become one commit (card with sha + **Undo**).

## 5. Preview & visual diff

The main area switches to the diff viewer: the changed pages (`/` and
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
