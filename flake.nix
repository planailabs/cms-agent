{
  description = "cms-agent — chat-agent CMS for Astro sites with embedded Pingora";

  inputs = {
    # nixpkgs-unstable, pinned to a rev known to carry prisma-engines_7 7.8.0
    # (matches the project's prisma 7.8.0) and pnpm 11.
    nixpkgs.url = "github:NixOS/nixpkgs/e3bb86f35c3a7ef6132e84d7724fb1a5aa492111";

    # CI runner image (NixOS-in-Incus, same setup as plan-ai/hugger).
    gitlab-incus-image.url = "git+https://git.mkg20001.io/mkg20001/gitlab-incus-image.git";
    xzar.url = "github:mkg20001/xzar";
    xzar.inputs.nixpkgs.follows = "nixpkgs";

    # Agent plugins/tools. ponytail has no flake.nix — consume it as a plain
    # source tree; codebase-memory-mcp is a proper flake (static C binary).
    ponytail = { url = "github:DietrichGebert/ponytail"; flake = false; };
    codebase-memory-mcp.url = "github:DeusData/codebase-memory-mcp";

    # Firecrawl's Node addon is not published independently from its pnpm
    # workspace. Pin its source and build the napi-rs crate directly.
    firecrawl = {
      url = "github:firecrawl/firecrawl/4f8c82f0762ccd9614ef45de80c74457b21b24f8";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, gitlab-incus-image, xzar, ponytail, codebase-memory-mcp, firecrawl }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # ── Agent plugins (marketplace dirs under $CMS_PLUGINS_ROOT/plugins) ──
      # The codebase-memory skill is embedded in the MCP's C sources (the CLI
      # installer's single source of truth) — extract the string constant at
      # build time so it tracks the pinned input.
      extractSkillPy = builtins.toFile "extract-skill.py" ''
        import re, sys
        src = open(sys.argv[1]).read()
        m = re.search(r'static const char skill_content\[\] =\s*(.*?);\n', src, re.S)
        assert m, 'skill_content constant not found in cli.c'
        segs = re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(1))
        text = re.sub(r'\\([nt"\\])',
                      lambda g: {'n': '\n', 't': '\t'}.get(g.group(1), g.group(1)),
                      "".join(segs))
        open(sys.argv[2], 'w').write(text)
      '';
      cbmPluginJson = builtins.toFile "cbm-plugin.json" (builtins.toJSON {
        name = "codebase-memory";
        version = codebase-memory-mcp.shortRev or "dev";
        description = "Codebase knowledge-graph memory — skill for the sandboxed MCP tools";
        skills = "./skills/";
      });
      # ── Sandbox toolset — single source for BOTH the bwrap jail envs and
      #    the per-major `sandbox-node*` dev shells (the SANDBOX_MODE=none
      #    dev mode, e.g. on macOS, runs site commands in those shells). ──
      sandboxNodesFor = pkgs: {
        "22" = pkgs.nodejs_22;
        "24" = pkgs.nodejs_24;
        "26" = pkgs.nodejs_26;
      };
      cbmFor = pkgs:
        codebase-memory-mcp.packages.${pkgs.stdenv.hostPlatform.system}.default;
      sandboxCommonPkgsFor = pkgs: (with pkgs; [
        coreutils
        bashInteractive
        cacert
        gawk
        gnugrep
        ripgrep
        python3
        uv
        # Alternative package managers for managed sites (npm ships with node)
        pnpm
        yarn
      ]) ++ [
        # Codebase graph memory: MCP server + CLI, attached to the agent
        # through the jail (index + queries see only /work).
        (cbmFor pkgs)
      ];

      agentPluginsFor = pkgs: rec {
        codebaseMemoryPlugin = pkgs.runCommand "cms-plugin-codebase-memory"
          { nativeBuildInputs = [ pkgs.python3 ]; } ''
            mkdir -p $out/.codex-plugin $out/skills/codebase-memory
            python3 ${extractSkillPy} ${codebase-memory-mcp}/src/cli/cli.c \
              $out/skills/codebase-memory/SKILL.md
            grep -q "^name: codebase-memory" $out/skills/codebase-memory/SKILL.md
            cp ${cbmPluginJson} $out/.codex-plugin/plugin.json
          '';
        dir = pkgs.linkFarm "cms-agent-plugins" [
          { name = "ponytail"; path = ponytail; }
          { name = "codebase-memory"; path = codebaseMemoryPlugin; }
        ];
      };
    in
    {
      packages = forAllSystems (pkgs:
        let
          firecrawl-native = pkgs.rustPlatform.buildRustPackage {
            pname = "firecrawl-native";
            version = "0.1.0-${builtins.substring 0 8 (firecrawl.rev or "source")}";
            src = pkgs.runCommand "firecrawl-native-source" { } ''
              cp -r ${firecrawl}/apps/api/native $out
              chmod -R u+w $out
              cp ${./nix/firecrawl-native.Cargo.lock} $out/Cargo.lock
            '';

            cargoLock = {
              lockFile = ./nix/firecrawl-native.Cargo.lock;
              outputHashes = {
                "calamine-0.34.0" = "sha256-LdO0GtnBN2aJlw/Coy0/aYkzOGtt9vnJf0Vj3EyUvO0=";
                "nodesig-1.0.0" = "sha256-5n3SSEVqtRU5IyISk82jrQ9R1vRZFeBjfhP/GPL+5G4=";
              };
            };

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib
              cp $(find target -type f -name 'libfirecrawl_rs.*' | head -n1) \
                $out/lib/firecrawl-rs.node
              runHook postInstall
            '';
          };

          # Pass the commit in explicitly — the fileset source in the store has
          # no .git for the build to ask. dirtyShortRev carries a -dirty suffix.
          # Complete Pingora server as a Node native addon.
          proxy-native = pkgs.rustPlatform.buildRustPackage {
            pname = "cms-agent-proxy-native";
            version = "0.1.0";

            src = ./proxy;
            cargoLock.lockFile = ./proxy/Cargo.lock; # no git deps in the lockfile

            # pingora pulls in zstd-sys / sfv / boring-ish native deps: needs
            # cmake + a C compiler (see proxy/README.md), perl + pkg-config for
            # the usual -sys crates.
            nativeBuildInputs = with pkgs; [ cmake perl pkg-config ];

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib
              cp $(find target -type f \( -name 'libcms_agent_proxy.so' -o -name 'libcms_agent_proxy.dylib' \) | head -n1) \
                $out/lib/cms-agent-proxy.node
              runHook postInstall
            '';

            meta = {
              description = "Embedded Pingora reverse proxy for cms-agent";
            };
          };

          cms-agent = pkgs.callPackage ./package.nix {
            gitCommit = self.shortRev or self.dirtyShortRev or null;
            agentPlugins = (agentPluginsFor pkgs).dir;
            firecrawlNative = firecrawl-native;
            proxyNative = proxy-native;
          };

          # Codebase-memory MCP binary — lives in the SANDBOX env (the agent's
          # MCP server runs jailed with only the worktree visible).
          cbm = cbmFor pkgs;

          # ── Sandbox environments (one per supported node major) ─────────────
          # Each is a buildEnv (node + coreutils/bash + grep/awk/ripgrep) whose full
          # closure is packed into a squashfs. At runtime the jail mounts (or
          # extracts) the squashfs and binds its /nix/store over the real one,
          # so shell commands see ONLY these tools — never the app's store.
          # Selected via SANDBOX_NODE_MAJOR; built on the fly in dev by
          # scripts/launch-with-sandbox.sh, baked into the image in prod.
          sandboxNodes = sandboxNodesFor pkgs;

          # Tools every sandbox env carries, regardless of node major. cacert:
          # self-contained TLS trust (the app's store is overshadowed, so the
          # jail must carry its own CA bundle for `npm install`).
          sandboxCommonPkgs = sandboxCommonPkgsFor pkgs;

          mkSandboxEnv = major: node: pkgs.buildEnv {
            name = "cms-sandbox-env-node${major}";
            paths = [ node ] ++ sandboxCommonPkgs;
          };

          # A tree with one self-contained store per node major:
          #   node22/nix/store/…  node24/nix/store/…  node26/nix/store/…
          # Each folder holds that major's FULL closure as real files, so the
          # runtime can materialize just one folder (extract `node<major>` /
          # mount + bind its nix/store) with no closure-list or symlink chasing.
          sandboxTree = pkgs.runCommand "cms-sandbox-tree" { } (
            lib.concatStrings (lib.mapAttrsToList (major: node:
              let ci = pkgs.closureInfo { rootPaths = [ (mkSandboxEnv major node) ]; };
              in ''
                mkdir -p "$out/node${major}/nix/store"
                while read -r p; do
                  cp -a "$p" "$out/node${major}/nix/store/"
                done < "${ci}/store-paths"
              '') sandboxNodes));

          # One squashfs holding all three folders. mksquashfs dedupes identical
          # files across the folders (default), so the shared closure (glibc,
          # python3, coreutils, ripgrep, …) is stored once — ~3x smaller than
          # three independent squashfs while each folder stays self-contained.
          sandboxSquashfs = pkgs.runCommand "cms-sandbox.squashfs"
            { nativeBuildInputs = [ pkgs.squashfsTools ]; } ''
              mksquashfs ${sandboxTree} "$out" -comp zstd -all-root -no-progress -quiet
            '';

          # Directory the runtime points SANDBOX_DIR at: the combined squashfs
          # (its root has node22/ node24/ node26/). SANDBOX_NODE_MAJOR selects
          # which folder to materialize.
          sandboxDir = pkgs.runCommand "cms-sandbox" { } ''
            mkdir -p "$out"
            ln -s ${sandboxSquashfs} "$out/sandbox.squashfs"
            printf '{"majors":["22","24","26"]}\n' > "$out/manifest.json"
          '';

          # fontconfig config + fonts for the diff-screenshot chromium — without
          # a fonts.conf and at least one font it FATALs in Skia's font manager.
          # A standard system-like set so previewed sites render with the fonts
          # a stock Linux desktop would have: metric-compatible Arial/Times
          # (liberation), broad Unicode + CJK + emoji (noto), GNU FreeFont,
          # Unifont as the everything-else fallback, and the common UI
          # families (Ubuntu, Cantarell, Roboto).
          screenshotFontsConf = pkgs.makeFontsConf {
            fontDirectories = [
              pkgs.dejavu_fonts
              pkgs.liberation_ttf
              pkgs.noto-fonts
              pkgs.noto-fonts-cjk-sans
              pkgs.noto-fonts-color-emoji
              pkgs.freefont_ttf
              pkgs.unifont
              pkgs.ubuntu-classic
              pkgs.cantarell-fonts
              pkgs.roboto
            ];
          };

          # Single-container entrypoint: migrations, then the Node process that
          # owns both Astro and the embedded Pingora listener.
          # git + node must be on PATH: the CMS shells into the managed repo
          # via simple-git and spawns REPO_DEV_COMMAND (default `npx astro
          # dev`) for branch previews.
          dockerEntrypoint = pkgs.writeShellApplication {
            name = "cms-agent-container";
            runtimeInputs = [ cms-agent pkgs.git pkgs.nodejs_26 pkgs.coreutils pkgs.openssh ];
            text = ''
              for required in DATABASE_URL BASE_DOMAIN; do
                if [ -z "''${!required:-}" ]; then
                  echo "cms-agent: $required must be set (docker run -e $required=…)" >&2
                  exit 1
                fi
              done

              mkdir -p "$VAR_DIR"

              # Deploy key for git ssh remotes (git-push/github-ci flows):
              # generated on first boot; add the logged public key to the site
              # repo with write access. Path matches the GIT_SSH_COMMAND default.
              if [ ! -f "$VAR_DIR/ssh/id_ed25519" ]; then
                mkdir -p "$VAR_DIR/ssh"
                chmod 700 "$VAR_DIR/ssh"
                ssh-keygen -t ed25519 -N "" -C cms-agent-deploy -f "$VAR_DIR/ssh/id_ed25519" >/dev/null
              fi
              echo "cms-agent: git deploy key: $(cat "$VAR_DIR/ssh/id_ed25519.pub")"

              cms-agent-prisma migrate deploy

              exec cms-agent
            '';
          };
        in
        {
          default = cms-agent;
          proxy-native = proxy-native;
          firecrawl-native = firecrawl-native;
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          # Combined sandbox squashfs dir — `nix build .#sandbox`.
          # scripts/launch-with-sandbox.sh builds it on the fly in dev/test.
          sandbox = sandboxDir;

          # OCI image with BOTH the CMS and the proxy, built with nix's native
          # dockerTools — no Dockerfile/daemon. Everything is configured over
          # env vars (see module.nix's environmentFile docs for the full list);
          # the Env defaults below are overridable with `docker run -e`.
          docker = pkgs.dockerTools.buildLayeredImage {
            name = "cms-agent";
            tag = "latest";
            contents = [
              cms-agent
              proxy-native
              dockerEntrypoint
              pkgs.git
              # ssh for git remotes (git-push/github-ci deploy flows)
              pkgs.openssh
              pkgs.nodejs_26
              pkgs.cacert
              pkgs.dockerTools.fakeNss
              pkgs.dockerTools.binSh
              pkgs.dockerTools.usrBinEnv
              # Sandbox: jail + squashfs mount/extract tools, and all three
              # per-major env dirs (their squashfs, selectable at runtime).
              pkgs.bubblewrap
              pkgs.squashfuse
              pkgs.squashfsTools
              sandboxDir
              # Headless chromium for diff screenshots (playwright). Version
              # matches the project's playwright (1.60) — see PLAYWRIGHT_* env.
              pkgs.playwright-driver.browsers
            ];
            extraCommands = ''
              mkdir -p tmp data && chmod 1777 tmp
            '';
            config = {
              Entrypoint = [ (lib.getExe dockerEntrypoint) ];
              WorkingDir = "/data";
              Env = [
                # Required (no sane defaults): DATABASE_URL, BASE_DOMAIN,
                # BETTER_AUTH_SECRET/URL, OIDC_*, OPENAI_*.
                "HOST=127.0.0.1"
                "PORT=4321"
                "CMS_UPSTREAM=127.0.0.1:4321"
                "PROXY_LISTEN=0.0.0.0:8080"
                "VAR_DIR=/data/var"
                "REPO_PATH=/data/site"
                "NODE_ENV=production"
                "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
                # SSH for git deploy flows: key + known_hosts live on the data
                # volume (mount or generate /data/var/ssh/id_ed25519 and add it
                # as a deploy key with write access). Override with -e as usual.
                "GIT_SSH_COMMAND=ssh -i /data/var/ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/data/var/ssh/known_hosts"
                # Sandbox: baked env dirs (no nix at runtime); pick with
                # SANDBOX_NODE_MAJOR (default 26). SANDBOX_ALLOW_NETWORK=1 keeps
                # network in the jail so `npm install` works.
                "SANDBOX_NODE_MAJOR=26"
                "SANDBOX_ALLOW_NETWORK=1"
                "SANDBOX_DIR=${sandboxDir}"
                # Diff screenshots: use the bundled playwright browsers.
                "PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}"
                "PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true"
                "FONTCONFIG_FILE=${screenshotFontsConf}"
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
          packages = (with pkgs; [
            nodejs_26
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
            lsof
            skopeo # for docker-push.sh (copy the image to the registry)
            squashfsTools
          ]) ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux (with pkgs; [
            bubblewrap
            squashfuse
          ]);

          shellHook = ''
            # Lets the local preflight reuse this shell only while it matches
            # the current project inputs. An unrelated/stale Nix shell re-enters.
            unset CMS_AGENT_DEV_SHELL_FINGERPRINT
            if [ -x ./scripts/update-local.sh ]; then
              export CMS_AGENT_DEV_SHELL_FINGERPRINT="$(./scripts/update-local.sh --print-nix-fingerprint 2>/dev/null || true)"
            fi

            # Prisma on NixOS: use nixpkgs engines, never download binaries.
            # Prisma 7 is engine-less at query time; prisma-engines_7 only
            # ships schema-engine (no query-engine/libquery_engine/prisma-fmt).
            export PRISMA_SCHEMA_ENGINE_BINARY=${pkgs.prisma-engines_7}/bin/schema-engine
            export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1
            export CHECKPOINT_DISABLE=1

            export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            export FIRECRAWL_NATIVE_PATH=${self.packages.${pkgs.stdenv.hostPlatform.system}.firecrawl-native}/lib/firecrawl-rs.node
            export PROXY_NATIVE_PATH=${self.packages.${pkgs.stdenv.hostPlatform.system}.proxy-native}/lib/cms-agent-proxy.node

            # Agent plugins for dev: same store dirs the image ships (plugins/
            # is gitignored; ponytail + codebase-memory come from flake inputs).
            mkdir -p plugins
            ln -sfn ${ponytail} plugins/ponytail
            ln -sfn ${(agentPluginsFor pkgs).codebaseMemoryPlugin} plugins/codebase-memory
          '';
        };
      } // lib.mapAttrs' (major: node:
        # One shell per sandbox node major — the same toolset as the bwrap
        # jail env. The SANDBOX_MODE=none dev mode (default on macOS, where
        # bwrap does not exist) resolves this shell's PATH once and runs all
        # site commands with it instead of entering a jail.
        lib.nameValuePair "sandbox-node${major}" (pkgs.mkShell {
          packages = [ node ] ++ sandboxCommonPkgsFor pkgs;
        })) (sandboxNodesFor pkgs)
      );

      checks = forAllSystems (pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
        in
        {
          package = self.packages.${system}.default;
          proxy-native = self.packages.${system}.proxy-native;
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
            in
            pkgs.runCommand "cms-agent-module-eval"
              {
                cmsExecStart = cms.ExecStart;
                cmsExecStartPre = cms.ExecStartPre;
              } ''
              test -n "$cmsExecStart"
              test -n "$cmsExecStartPre"
              touch $out
            '';
        });

      overlays.default = final: prev: {
        cms-agent = final.callPackage ./package.nix { };
      };

      nixosModules.default = { pkgs, lib, ... }: {
        imports = [ ./module.nix ];
        services.cms-agent.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };
    };
}
