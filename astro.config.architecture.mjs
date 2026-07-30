/**
 * Standalone build of the /architecture tree — `pnpm build:architecture`.
 *
 * The docs are checked-in prose with no runtime state, so they can be shipped
 * as flat HTML anywhere (the CI deploy job keeps the output as an artifact
 * next to the container image). This config exists so that build carries none
 * of the app: no adapter, no database, no environment.
 *
 * `srcDir` is site-architecture/, whose pages/architecture is a symlink to the
 * real pages. That is the whole trick — Astro finds no src/middleware.ts
 * there, so the auth middleware (and through it Prisma, better-auth and the
 * proxy addon) never enters the build. Output paths stay /architecture/… so
 * every link works identically in both builds.
 */
import { defineConfig } from 'astro/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pages are server-rendered in the app; here they are flat files. */
const prerenderEverything = () => ({
  name: 'architecture-prerender',
  hooks: {
    'astro:route:setup': ({ route }) => {
      route.prerender = true;
    },
  },
});

/** The site lives under /architecture; give the artifact root a way in. */
const rootRedirect = () => ({
  name: 'architecture-root-redirect',
  hooks: {
    'astro:build:done': ({ dir }) => {
      fs.writeFileSync(
        path.join(fileURLToPath(dir), 'index.html'),
        '<!doctype html><meta charset="utf-8">' +
          '<meta http-equiv="refresh" content="0; url=/architecture">' +
          '<title>CMS Agent — architecture</title>' +
          '<a href="/architecture">Architecture reference</a>\n',
      );
    },
  },
});

export default defineConfig({
  output: 'static',
  srcDir: './site-architecture',
  publicDir: './site-architecture/public',
  outDir: './dist-architecture',
  integrations: [prerenderEverything(), rootRedirect()],
  vite: {
    resolve: { alias: { '@': path.resolve('./src') } },
  },
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
});
