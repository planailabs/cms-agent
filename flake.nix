{
  description = "cms-agent — chat-agent CMS for Astro sites (Astro SSR app + pingora proxy sidecar)";

  inputs = {
    # nixpkgs-unstable, pinned to a rev known to carry prisma-engines_7 7.8.0
    # (matches the project's prisma 7.8.0) and pnpm 11.
    nixpkgs.url = "github:NixOS/nixpkgs/e3bb86f35c3a7ef6132e84d7724fb1a5aa492111";
  };

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./package.nix { };

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
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            pnpm
            cargo
            rustc
            gcc
            cmake
            pkg-config
            perl
            git
            postgresql
            overmind
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
