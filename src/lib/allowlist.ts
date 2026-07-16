/**
 * Email authorization allowlist. When neither ALLOWED_EMAILS nor
 * ALLOWED_EMAIL_DOMAIN is configured, any account from the OIDC provider is
 * accepted (the IdP is the gate).
 */
import { env } from './env';

export function isEmailAllowed(email: string): boolean {
  const { ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAIN } = env();
  if (!ALLOWED_EMAILS && !ALLOWED_EMAIL_DOMAIN) return true;

  const normalized = email.trim().toLowerCase();
  if (ALLOWED_EMAILS) {
    const list = ALLOWED_EMAILS.split(',').map((e) => e.trim().toLowerCase());
    if (list.includes(normalized)) return true;
  }
  if (ALLOWED_EMAIL_DOMAIN) {
    const domain = ALLOWED_EMAIL_DOMAIN.trim().toLowerCase().replace(/^@/, '');
    if (normalized.endsWith(`@${domain}`)) return true;
  }
  return false;
}
