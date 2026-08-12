# NixOS module: services.cms-agent
#
# One Node service owns both Astro and the embedded Pingora public listener.
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
    PROXY_LISTEN = cfg.listen;
    CMS_UPSTREAM = "127.0.0.1:${toString cfg.cmsPort}";
  } // lib.optionalAttrs cfg.database.createLocally {
    DATABASE_URL = "postgresql:///cms-agent?host=/run/postgresql";
  } // cfg.extraEnvironment;

in
{
  options.services.cms-agent = {
    enable = lib.mkEnableOption "cms-agent, the chat-agent CMS for Astro sites";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The cms-agent package to use.";
    };

    baseDomain = lib.mkOption {
      type = lib.types.str;
      example = "cms.example.com";
      description = "Public base domain. Previews are served on <branch>.<baseDomain>.";
    };

    listen = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0:8080";
      description = "Public listen address of the embedded proxy (PROXY_LISTEN).";
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
        Writable state directory (VAR_DIR), including proxy route/access files.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Environment file with secrets. Should define:
        DATABASE_URL (when database.createLocally is false), BETTER_AUTH_SECRET,
        BETTER_AUTH_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
        OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, optionally PREVIEW_REQUIRE_AUTH,
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
      description = ''
        Extra environment variables merged into both units.

        Notifications ("tell me when this chat is done") are opt-in and live
        here: NOTIFY_SMS_PROVIDER / NOTIFY_SMS_FROM and the matching
        NOTIFY_EMAIL_* (see docs/setup.md). The *_CONFIG blobs hold vendor
        credentials, so put those in environmentFile instead.

        OpenTelemetry: the package wrapper already carries the NODE_OPTIONS
        ESM hook + register flags, so auto-instrumentation only needs an exporter
        pointed somewhere — OTEL_SDK_DISABLED = "false" plus
        OTEL_EXPORTER_OTLP_ENDPOINT. It ships disabled because the SDK
        otherwise exports to localhost:4318 and logs every failed attempt.
      '';
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
        UMask = "0002";
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
  };
}
