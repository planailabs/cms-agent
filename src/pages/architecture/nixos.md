---
layout: ../../components/architecture/Shell.astro
title: NixOS deployment
lead: The flake outputs, the NixOS module options, and what the host has to provide.
---

The flake provides `packages.default` (CMS plus embedded Pingora),
`packages.proxy-native`, and `nixosModules.default`.

```nix
{
  inputs.cms-agent.url = "github:you/cms-agent";

  # configuration.nix
  imports = [ inputs.cms-agent.nixosModules.default ];

  services.cms-agent = {
    enable = true;
    baseDomain = "cms.example.com";
    listen = "0.0.0.0:8080";       # terminate TLS in front of this listener
    repoPath = "/var/lib/sites/my-astro-site";
    environmentFile = "/run/secrets/cms-agent.env";  # OIDC_*, OPENAI_*,
                                                     # BETTER_AUTH_SECRET, …
    database.createLocally = true; # local postgres + unix-socket DATABASE_URL
  };
}
```

One `cms-agent.service` runs migrations, Astro, and the embedded public proxy.
`/var/lib/cms-agent` contains the routes fallback file, worktrees, artifacts,
and uploads.

Requirements on the host:

- DNS: `baseDomain` **and** `*.baseDomain` → this machine.
- The managed site repo must exist at `repoPath` and be writable by the
  `cms-agent` user. Dependencies are NOT a prerequisite: the preview manager
  installs them per worktree (with the site's own package manager) before it
  starts a dev server.
- Playwright (visual diff) downloads no browsers at runtime; the module wires
  `PLAYWRIGHT_BROWSERS_PATH` to the nixpkgs browsers.

For development, `nix develop` provides node, pnpm, cargo, postgres, the
Prisma engines (env vars set), and Playwright browsers.
