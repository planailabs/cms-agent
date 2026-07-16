/**
 * SKIP_AUTH development mode — no sign-in; requests run as a seeded local
 * user (admin@localhost by default). A cookie switches identity between the
 * seeded users for multi-user testing. Never enable outside development.
 */
import { prisma } from './db';
import type { AuthUser } from './auth';

export const DEV_IMPERSONATE_COOKIE = 'cms_dev_user';

export const DEV_USERS = [
  { id: 'dev-admin', email: 'admin@localhost', name: 'Dev Admin', role: 'admin' },
  { id: 'dev-user', email: 'user@localhost', name: 'Dev User', role: 'editor' },
  { id: 'dev-user2', email: 'user2@localhost', name: 'Dev User 2', role: 'editor' },
] as const;

let seeded: Promise<void> | null = null;

export function seedDevUsers(): Promise<void> {
  if (!seeded) {
    console.warn('⚠ SKIP_AUTH is enabled — no authentication, dev users seeded. Development only!');
    seeded = (async () => {
      for (const u of DEV_USERS) {
        await prisma.user.upsert({
          where: { id: u.id },
          create: { ...u, emailVerified: true },
          update: { role: u.role },
        });
      }
    })();
  }
  return seeded;
}

/** Resolve the active dev user (impersonation cookie → seeded user). */
export async function getDevUser(impersonateEmail?: string): Promise<AuthUser> {
  await seedDevUsers();
  const email =
    impersonateEmail && DEV_USERS.some((u) => u.email === impersonateEmail)
      ? impersonateEmail
      : DEV_USERS[0].email;
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return user as unknown as AuthUser;
}
