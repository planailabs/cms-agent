# NixOS module: services.cms-agent
#
# Two units:
#   - cms-agent.service        — the Astro SSR app (internal, 127.0.0.1:cmsPort)
#   - cms-agent-proxy.service  — the pingora sidecar, the public entrypoint
#
# They share `varDir` (0770, setgid, group cms-agent): the CMS writes
# proxy-routes.json, the proxy writes proxy-access.json.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.cms-agent;

  defaultVarDir = "/var/lib/cms-agent";

  cmsEnvironment = {
    HOST = "127.0.0.1";
    PORT = toString cfg.cmsPort;
    BASE_DOMAIN = cfg.baseDomain;
    VAR_DIR = cfg.varDir;
    REPO_PATH = toString cfg.repoPath;
  } // lib.optionalAttrs cfg.database.createLocally {
    DATABASE_URL = "postgresql:///cms-agent?host=/run/postgresql";
  } // cfg.extraEnvironment;

  proxyEnvironment = {
    PROXY_LISTEN = cfg.listen;
    BASE_DOMAIN = cfg.baseDomain;
    VAR_DIR = cfg.varDir;
    CMS_UPSTREAM = "127.0.0.1:${toString cfg.cmsPort}";
  } // cfg.extraEnvironment;
in
{
  options.services.cms-agent = {
    enable = lib.mkEnableOption "cms-agent, the chat-agent CMS for Astro sites";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The cms-agent package to use.";
    };

    proxyPackage = lib.mkOption {
      type = lib.types.package;
      description = "The cms-agent-proxy (pingora sidecar) package to use.";
    };

    baseDomain = lib.mkOption {
      type = lib.types.str;
      example = "cms.example.com";
      description = "Public base domain. Previews are served on <branch>.<baseDomain>.";
    };

    listen = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0:8080";
      description = "Public listen address of the proxy sidecar (PROXY_LISTEN).";
    };

    cmsPort = lib.mkOption {
      type = lib.types.port;
      default = 4321;
      description = "Internal port the CMS app listens on (127.0.0.1 only).";
    };

    repoPath = lib.mkOption {
      type = lib.types.path;
      example = "/srv/my-astro-site";
      description = ''
        Path to the managed Astro site repository. The repo must have its own
        dependencies installed (`node_modules`): REPO_DEV_COMMAND defaults to
        `npx astro dev`, which resolves astro from the target repo's own
        node_modules. The cms-agent user needs read/write access to it.
      '';
    };

    varDir = lib.mkOption {
      type = lib.types.str;
      default = defaultVarDir;
      description = ''
        Writable state directory (VAR_DIR), shared between the CMS and the
        proxy (proxy-routes.json / proxy-access.json contract files).
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Environment file with secrets, passed to both units. Should define:
        DATABASE_URL (when database.createLocally is false), BETTER_AUTH_SECRET,
        BETTER_AUTH_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
        OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, PREVIEW_COOKIE_SECRET
        (used by both the CMS and the proxy), optionally PREVIEW_REQUIRE_AUTH,
        and deploy-flow credentials (GITHUB_TOKEN, CLOUDFLARE_API_TOKEN, ...).
      '';
    };

    database.createLocally = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Provision a local PostgreSQL database `cms-agent` and connect over the
        unix socket (peer auth). When false, provide DATABASE_URL via
        environmentFile.
      '';
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { DEPLOY_FLOW = "github-ci"; PUBLIC_SCHEME = "https"; };
      description = "Extra environment variables merged into both units.";
    };
  };

  config = lib.mkIf cfg.enable {
    # Stable system user (NOT DynamicUser): the CMS spawns preview dev servers,
    # needs a persistent writable VAR_DIR and a stable git identity.
    users.users.cms-agent = {
      isSystemUser = true;
      group = "cms-agent";
      home = cfg.varDir;
      description = "cms-agent service user";
    };
    # The proxy runs as its own user but in the shared group so it can
    # read proxy-routes.json and write proxy-access.json in varDir.
    users.users.cms-agent-proxy = {
      isSystemUser = true;
      group = "cms-agent";
      description = "cms-agent proxy sidecar user";
    };
    users.groups.cms-agent = { };

    services.postgresql = lib.mkIf cfg.database.createLocally {
      enable = true;
      ensureDatabases = [ "cms-agent" ];
      ensureUsers = [
        {
          name = "cms-agent";
          ensureDBOwnership = true;
        }
      ];
    };

    # Setgid so files created by either unit stay in the shared group.
    systemd.tmpfiles.rules = [
      "d '${cfg.varDir}' 2770 cms-agent cms-agent -"
    ];

    systemd.services.cms-agent = {
      description = "cms-agent — chat-agent CMS for Astro sites";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ]
        ++ lib.optional cfg.database.createLocally "postgresql.service";
      requires = lib.optional cfg.database.createLocally "postgresql.service";

      # git + node/npx for the managed repo (REPO_DEV_COMMAND = `npx astro dev`
      # is spawned from repoPath and resolves the repo's own node_modules).
      path = [ pkgs.nodejs_22 pkgs.git pkgs.bash ];

      environment = cmsEnvironment;

      serviceConfig = {
        Type = "simple";
        User = "cms-agent";
        Group = "cms-agent";
        UMask = "0002"; # proxy-routes.json must be group-readable for the proxy
        WorkingDirectory = cfg.varDir;
        # Schema/migrations/config are baked into the package; the wrapper
        # carries the PRISMA_SCHEMA_ENGINE_BINARY needed by migrate deploy.
        ExecStartPre = "${cfg.package}/bin/cms-agent-prisma migrate deploy";
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;
      } // lib.optionalAttrs (cfg.varDir == defaultVarDir) {
        StateDirectory = "cms-agent";
        StateDirectoryMode = "2770";
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };

    systemd.services.cms-agent-proxy = {
      description = "cms-agent proxy — pingora reverse-proxy sidecar (public entrypoint)";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      # PREVIEW_COOKIE_SECRET / PREVIEW_REQUIRE_AUTH come from environmentFile.
      environment = proxyEnvironment;

      serviceConfig = {
        Type = "simple";
        User = "cms-agent-proxy";
        Group = "cms-agent";
        UMask = "0002"; # proxy-access.json must be group-readable for the CMS
        WorkingDirectory = cfg.varDir;
        ExecStart = lib.getExe' cfg.proxyPackage "cms-agent-proxy";
        Restart = "on-failure";
        RestartSec = 5;

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ReadWritePaths = [ cfg.varDir ];
        ProtectHome = true;
        PrivateTmp = true;
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
