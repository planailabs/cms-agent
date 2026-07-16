/**
 * Environment variable abstraction to support both Vite and Astro.
 * Astro uses PUBLIC_ prefix for client-side env vars, while Vite uses VITE_.
 * This helper checks both.
 */

export const getEnv = (key: string): string | undefined => {
  // Check for VITE_ prefix (standard Vite)
  const viteKey = `VITE_${key}`;
  if (import.meta.env[viteKey] !== undefined) {
    return import.meta.env[viteKey];
  }

  // Check for PUBLIC_ prefix (Astro)
  const publicKey = `PUBLIC_${key}`;
  if (import.meta.env[publicKey] !== undefined) {
    return import.meta.env[publicKey];
  }

  return undefined;
};

export const getEnvOrThrow = (key: string): string => {
  const value = getEnv(key);
  if (value === undefined) {
    throw new Error(
      `Missing environment variable: ${key} (checked VITE_${key} and PUBLIC_${key})`,
    );
  }
  return value;
};
