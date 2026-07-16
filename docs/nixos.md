# NixOS deployment

The flake provides `packages.default` (the CMS), `packages.proxy` (the
Pingora sidecar), and `nixosModules.default`.

```nix
{
  inputs.cms-agent.url = "github:you/cms-agent";

  # configuration.nix
  imports = [ inputs.cms-agent.nixosModules.default ];

  services.cms-agent = {
    enable = true;
    baseDomain = "cms.example.com";
    listen = "0.0.0.0:443";        # front with your usual TLS termination,
                                   # or terminate before the sidecar
    repoPath = "/var/lib/sites/my-astro-site";
    environmentFile = "/run/secrets/cms-agent.env";  # OIDC_*, OPENAI_*,
                                                     # BETTER_AUTH_SECRET,
                                                     # PREVIEW_COOKIE_SECRET, …
    database.createLocally = true; # local postgres + unix-socket DATABASE_URL
  };
}
```

Two systemd units run: `cms-agent.service` (node app, runs
`prisma migrate deploy` before start) and `cms-agent-proxy.service` (public
listener). They share `/var/lib/cms-agent` for the routes/access files,
worktrees, artifacts, and uploads.

Requirements on the host:

- DNS: `baseDomain` **and** `*.baseDomain` → this machine.
- The managed site repo must exist at `repoPath` with its `node_modules`
  installed (the CMS spawns `npx astro dev` inside it) and be writable by
  the `cms-agent` user.
- Playwright (visual diff) downloads no browsers at runtime; the module wires
  `PLAYWRIGHT_BROWSERS_PATH` to the nixpkgs browsers.

For development, `nix develop` provides node, pnpm, cargo, postgres, the
Prisma engines (env vars set), and Playwright browsers.
