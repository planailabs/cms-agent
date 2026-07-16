/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user: import('./lib/auth').AuthUser | null;
    session: import('./lib/auth').AuthSession | null;
  }
}
