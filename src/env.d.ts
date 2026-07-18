/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Short git commit (with -dirty suffix if applicable). Set by the nix
   *  build (flake self.shortRev) or resolved from git in dev. */
  readonly PUBLIC_GIT_COMMIT?: string;
}

declare namespace App {
  interface Locals {
    user: import('./lib/auth').AuthUser | null;
    session: import('./lib/auth').AuthSession | null;
  }
}
