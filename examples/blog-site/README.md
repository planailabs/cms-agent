# Example: blog-site

Astro site with a `blog` content collection (list + detail pages) — the
richer CMS target used in the end-to-end walkthrough (docs/walkthrough.md).

## Use it with the CMS

```bash
cp -r examples/blog-site /tmp/blog-site
cd /tmp/blog-site && git init -b main && git add -A && git commit -m init
npm install

# .env of the CMS:
REPO_PATH=/tmp/blog-site
ROUTE_MAPPINGS=[{"files":"src/content/blog/*.md","route":"/blog/:slug/"}]
```

`ROUTE_MAPPINGS` lets the visual diff map changed blog markdown files to
their rendered detail pages.
