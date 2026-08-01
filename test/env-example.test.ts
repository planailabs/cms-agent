/**
 * .env.example is the reference for what this deployment can be configured
 * with, so it has to be complete.
 *
 * A hand-maintained list drifts silently: a new variable is read in code,
 * works on the machine that added it, and nobody discovers it is missing
 * until someone else needs to set it. The schema in lib/env.ts is the truth;
 * this makes the file follow it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Names on the left of an `=`, commented out or not. */
const documented = (): Set<string> => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
};

/** Keys of the zod object in lib/env.ts — read as text on purpose: importing
 *  it would validate the current environment instead of describing it. */
const schemaKeys = (): string[] => {
  const text = fs.readFileSync(path.join(ROOT, 'src/lib/env.ts'), 'utf8');
  const body = text.slice(text.indexOf('z.object({'), text.lastIndexOf('});'));
  return [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
};

describe('.env.example', () => {
  it('documents every variable the app reads', () => {
    const known = documented();
    const missing = schemaKeys().filter((key) => !known.has(key));
    expect(missing).toEqual([]);
  });

  it('finds a schema to compare against (guards the parser)', () => {
    // Both assertions above pass vacuously if this regex ever stops matching.
    const keys = schemaKeys();
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('SANDBOX_MODE');
  });
});
