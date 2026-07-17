{
  description = "cms-agent — chat-agent CMS for Astro sites (Astro SSR app + pingora proxy sidecar)";

  inputs = {
    # nixpkgs-unstable, pinned to a rev known to carry prisma-engines_7 7.8.0
    # (matches the project's prisma 7.8.0) and pnpm 11.
    nixpkgs.url = "github:NixOS/nixpkgs/e3bb86f35c3a7ef6132e84d7724fb1a5aa492111";

    # CI runner image (NixOS-in-Incus, same setup as plan-ai/hugger).
    gitlab-incus-image.url = "git+https://git.mkg20001.io/mkg20001/gitlab-incus-image.git";
    xzar.url = "github:mkg20001/xzar";
    xzar.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, gitlab-incus-image, xzar }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs:
        let
          cms-agent = pkgs.callPackage ./package.nix { };

          # Rust pingora reverse-proxy sidecar (public entrypoint).
          proxy = pkgs.rustPlatform.buildRustPackage {
            pname = "cms-agent-proxy";
            version = "0.1.0";

            src = ./proxy;
            cargoLock.lockFile = ./proxy/Cargo.lock; # no git deps in the lockfile

            # pingora pulls in zstd-sys / sfv / boring-ish native deps: needs
            # cmake + a C compiler (see proxy/README.md), perl + pkg-config for
            # the usual -sys crates.
            nativeBuildInputs = with pkgs; [ cmake perl pkg-config ];

            # `cargo test` runs as the default checkPhase.

            meta = {
              description = "Reverse-proxy sidecar for the CMS: routes by Host header, gates previews, injects the preview overlay";
              mainProgram = "cms-agent-proxy";
            };
          };

          # ── Sandbox environments (one per supported node major) ─────────────
          # Each is a buildEnv (node + coreutils/bash + grep/awk/ripgrep) whose full
          # closure is packed into a squashfs. At runtime the jail mounts (or
          # extracts) the squashfs and binds its /nix/store over the real one,
          # so shell commands see ONLY these tools — never the app's store.
          # Selected via SANDBOX_NODE_MAJOR; built on the fly in dev by
          # scripts/launch-with-sandbox.sh, baked into the image in prod.
          sandboxNodes = {
            "22" = pkgs.nodejs_22;
            "24" = pkgs.nodejs_24;
            "26" = pkgs.nodejs_26;
          };

          # Tools every sandbox env carries, regardless of node major. cacert:
          # self-contained TLS trust (the app's store is overshadowed, so the
          # jail must carry its own CA bundle for `npm install`).
          sandboxCommonPkgs = with pkgs; [
            coreutils
            bashInteractive
            cacert
            gawk
            gnugrep
            ripgrep
            python3
          ];

          mkSandboxEnv = major: node: pkgs.buildEnv {
            name = "cms-sandbox-env-node${major}";
            paths = [ node ] ++ sandboxCommonPkgs;
          };

          # Squashfs of the env's closure (contents live at their /nix/store
          # paths). The output file has no runtime references, so shipping it
          # in the image does NOT drag the uncompressed closure along.
          mkSandboxSquashfs = major: node:
            pkgs.callPackage "${nixpkgs}/nixos/lib/make-squashfs.nix" {
              storeContents = [ (mkSandboxEnv major node) ];
              comp = "zstd";
            };

          # A directory the runtime points SANDBOX_DIR_<major> at: the squashfs
          # plus a tiny manifest. Deliberately does NOT embed the env store
          # path (the runtime discovers it by glob after materializing), to
          # keep the image free of the uncompressed closure.
          mkSandboxDir = major: node:
            pkgs.runCommand "cms-sandbox-node${major}" { } ''
              mkdir -p "$out"
              ln -s ${mkSandboxSquashfs major node} "$out/env.squashfs"
              printf '{"major":"%s"}\n' "${major}" > "$out/manifest.json"
            '';

          sandboxDirs = lib.mapAttrs mkSandboxDir sandboxNodes;

          # Single-container entrypoint: run migrations, then both processes;
          # exit (and let the runtime restart the container) when either dies.
          # git + node must be on PATH: the CMS shells into the managed repo
          # via simple-git and spawns REPO_DEV_COMMAND (default `npx astro
          # dev`) for branch previews.
          dockerEntrypoint = pkgs.writeShellApplication {
            name = "cms-agent-container";
            runtimeInputs = [ cms-agent proxy pkgs.git pkgs.nodejs_22 pkgs.coreutils ];
            text = ''
              for required in DATABASE_URL BASE_DOMAIN; do
                if [ -z "''${!required:-}" ]; then
                  echo "cms-agent: $required must be set (docker run -e $required=…)" >&2
                  exit 1
                fi
              done

              mkdir -p "$VAR_DIR"

              cms-agent-prisma migrate deploy

              cms-agent &
              cms_pid=$!
              cms-agent-proxy &
              proxy_pid=$!

              trap 'kill -TERM "$cms_pid" "$proxy_pid" 2>/dev/null || true' TERM INT

              # First exit wins; take the whole container down with its status.
              status=0
              wait -n "$cms_pid" "$proxy_pid" || status=$?
              kill -TERM "$cms_pid" "$proxy_pid" 2>/dev/null || true
              wait "$cms_pid" "$proxy_pid" 2>/dev/null || true
              exit "$status"
            '';
          };
        in
        {
          default = cms-agent;
          proxy = proxy;
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Sandbox env dirs, one per node major — `nix build .#sandbox-node22`.
          # scripts/launch-with-sandbox.sh builds the selected one on the fly.
          sandbox-node22 = sandboxDirs."22";
          sandbox-node24 = sandboxDirs."24";
          sandbox-node26 = sandboxDirs."26";

          # OCI image with BOTH the CMS and the proxy, built with nix's native
          # dockerTools — no Dockerfile/daemon. Everything is configured over
          # env vars (see module.nix's environmentFile docs for the full list);
          # the Env defaults below are overridable with `docker run -e`.
          docker = pkgs.dockerTools.buildLayeredImage {
            name = "cms-agent";
            tag = "latest";
            contents = [
              cms-agent
              proxy
              dockerEntrypoint
              pkgs.git
              pkgs.nodejs_22
              pkgs.cacert
              pkgs.dockerTools.fakeNss
              pkgs.dockerTools.binSh
              pkgs.dockerTools.usrBinEnv
              # Sandbox: jail + squashfs mount/extract tools, and all three
              # per-major env dirs (their squashfs, selectable at runtime).
              pkgs.bubblewrap
              pkgs.squashfuse
              pkgs.squashfsTools
              sandboxDirs."22"
              sandboxDirs."24"
              sandboxDirs."26"
            ];
            extraCommands = ''
              mkdir -p tmp data && chmod 1777 tmp
            '';
            config = {
              Entrypoint = [ (lib.getExe dockerEntrypoint) ];
              WorkingDir = "/data";
              Env = [
                # Required (no sane defaults): DATABASE_URL, BASE_DOMAIN,
                # BETTER_AUTH_SECRET/URL, OIDC_*, OPENAI_*,
                # PREVIEW_COOKIE_SECRET.
                "HOST=127.0.0.1"
                "PORT=4321"
                "CMS_UPSTREAM=127.0.0.1:4321"
                "PROXY_LISTEN=0.0.0.0:8080"
                "VAR_DIR=/data/var"
                "REPO_PATH=/data/site"
                "NODE_ENV=production"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                # Sandbox: baked env dirs (no nix at runtime); pick with
                # SANDBOX_NODE_MAJOR (default 22). SANDBOX_ALLOW_NETWORK=1 keeps
                # network in the jail so `npm install` works.
                "SANDBOX_NODE_MAJOR=22"
                "SANDBOX_ALLOW_NETWORK=1"
                "SANDBOX_DIR_22=${sandboxDirs."22"}"
                "SANDBOX_DIR_24=${sandboxDirs."24"}"
                "SANDBOX_DIR_26=${sandboxDirs."26"}"
              ];
              ExposedPorts = { "8080/tcp" = { }; };
              Volumes = { "/data" = { }; };
            };
          };

          # NixOS-in-Incus image for gitlab CI runners (same as plan-ai/hugger).
          image = (nixpkgs.lib.nixosSystem {
            system = "x86_64-linux";
            modules = [
              "${nixpkgs}/nixos/modules/virtualisation/lxc-container.nix"
              gitlab-incus-image.nixosModules.gitlab-incus-image
              ({ pkgs, ... }: {
                environment.systemPackages = with pkgs; [
                  openssh
                  rsync
                  pkgs.xzar-client
                  pixz
                ];

                nixpkgs.overlays = [
                  xzar.overlays.default
                ];

                programs.git.config.advice.detachedHead = false;
                system.stateVersion = "26.11";

                nix.settings = {
                  substituters = [
                    "https://xzar.plan.ai"
                  ];
                  trusted-public-keys = [
                    "xzar.plan.ai:KUE66pjr6UX5HHCn9kedN1DJ2J5nSlBrKmE7tUjXewE="
                  ];
                };
              })
            ];
          }).config.system.build.gitlab-incus-image;
        });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            pnpm
            cargo
            cargo-watch
            rustc
            gcc
            cmake
            pkg-config
            perl
            git
            postgresql
            overmind
            skopeo # for docker-push.sh (copy the image to the registry)
            # Sandbox: jail + squashfs mount/extract (launch-with-sandbox.sh
            # builds the env squashfs on the fly via nix in dev/test).
            bubblewrap
            squashfuse
            squashfsTools
          ];

          shellHook = ''
            # Prisma on NixOS: use nixpkgs engines, never download binaries.
            # Prisma 7 is engine-less at query time; prisma-engines_7 only
            # ships schema-engine (no query-engine/libquery_engine/prisma-fmt).
            export PRISMA_SCHEMA_ENGINE_BINARY=${pkgs.prisma-engines_7}/bin/schema-engine
            export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

            export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
          '';
        };
      });

      checks = forAllSystems (pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
        in
        {
          package = self.packages.${system}.default;
          proxy = self.packages.${system}.proxy;
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Evaluate the NixOS module with a minimal config.
          module-eval =
            let
              eval = lib.nixosSystem {
                inherit system;
                modules = [
                  self.nixosModules.default
                  {
                    boot.isContainer = true;
                    system.stateVersion = "25.11";
                    nixpkgs.hostPlatform = system;
                    services.cms-agent = {
                      enable = true;
                      baseDomain = "cms.example.com";
                      repoPath = "/srv/site";
                    };
                  }
                ];
              };
              cms = eval.config.systemd.services.cms-agent.serviceConfig;
              proxy = eval.config.systemd.services.cms-agent-proxy.serviceConfig;
            in
            pkgs.runCommand "cms-agent-module-eval"
              {
                cmsExecStart = cms.ExecStart;
                cmsExecStartPre = cms.ExecStartPre;
                proxyExecStart = proxy.ExecStart;
              } ''
              test -n "$cmsExecStart"
              test -n "$cmsExecStartPre"
              test -n "$proxyExecStart"
              touch $out
            '';
        });

      overlays.default = final: prev: {
        cms-agent = final.callPackage ./package.nix { };
      };

      nixosModules.default = { pkgs, lib, ... }: {
        imports = [ ./module.nix ];
        services.cms-agent = {
          package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          proxyPackage = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.proxy;
        };
      };
    };
}
