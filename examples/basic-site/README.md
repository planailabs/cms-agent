# Example: basic-site

Minimal two-page Astro site used as a CMS target for tests and demos.

## Use it with the CMS

```bash
# 1. Make a working copy that is its own git repo (the CMS manages branches in it)
cp -r examples/basic-site /tmp/basic-site
cd /tmp/basic-site && git init -b main && git add -A && git commit -m init
npm install    # the site needs its own astro for `astro dev`

# 2. Point the CMS at it (.env)
REPO_PATH=/tmp/basic-site
```

The integration tests use this site in place with
`REPO_DEV_COMMAND="node <cms-repo>/node_modules/astro/astro.js dev"`, so no
per-example install is needed there.
