/**
 * Generic Astro content-collections adapter — scans src/content/<collection>/
 * directories, learns frontmatter conventions from existing entries, and
 * validates new/changed entries against them. No YAML dependency: a small
 * tolerant frontmatter parser covers scalars, quoted strings, ISO dates and
 * string arrays (inline `[a, b]` and block `- item`).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  registerContentAdapter,
  type AdapterIssue,
  type ContentAdapter,
  type ContentCollection,
  type ContentInventory,
} from './adapter';

const ENTRY_EXTENSIONS = new Set(['.md', '.mdx']);
const CONTENT_DIR = path.join('src', 'content');

// ─── Frontmatter parser ──────────────────────────────────────────────────────

export type FrontmatterValue = string | number | boolean | null | string[];

export interface ParsedFrontmatter {
  /** null = no frontmatter block found (or unterminated). */
  data: Record<string, FrontmatterValue> | null;
  body: string;
}

function parseScalar(raw: string): FrontmatterValue {
  const s = raw.trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
      (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s; // includes ISO dates, kept as strings
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => String(parseScalar(item)));
}

/**
 * Tolerant YAML-frontmatter subset parser. Unparseable lines are skipped
 * rather than failing the whole document.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { data: null, body: source };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: null, body: source };

  const data: Record<string, FrontmatterValue> = {};
  let pendingArrayKey: string | null = null;

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    // block-array item under the last `key:` line
    const itemMatch = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (itemMatch && pendingArrayKey) {
      (data[pendingArrayKey] as string[]).push(String(parseScalar(itemMatch[1])));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue; // tolerate garbage lines
    const [, key, rawValue] = kv;
    const value = rawValue.trim();

    if (value === '') {
      // possibly a block array (`key:` followed by `- item` lines)
      data[key] = [];
      pendingArrayKey = key;
      continue;
    }
    pendingArrayKey = null;
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = parseInlineArray(value);
    } else {
      data[key] = parseScalar(value);
    }
  }

  // `key:` with no items is more likely an empty scalar than an array
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v) && v.length === 0) data[k] = '';
  }

  return { data, body: lines.slice(end + 1).join('\n') };
}

// ─── Scanning ────────────────────────────────────────────────────────────────

function listEntries(collectionDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && ENTRY_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
    }
  };
  walk(collectionDir);
  return out.sort();
}

function formatExample(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

function scanCollection(repoRoot: string, name: string): ContentCollection {
  const dirRel = path.join(CONTENT_DIR, name);
  const entries = listEntries(path.join(repoRoot, dirRel));
  const seen = new Map<string, string>(); // key → example value
  let requiredKeys: Set<string> | null = null;

  for (const file of entries) {
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const keys = data ? Object.keys(data) : [];
    for (const key of keys) {
      if (!seen.has(key) && data![key] !== '' && data![key] !== null) {
        seen.set(key, formatExample(data![key]));
      }
    }
    requiredKeys =
      requiredKeys === null
        ? new Set(keys)
        : new Set(keys.filter((k) => requiredKeys!.has(k)));
  }

  const required = requiredKeys ?? new Set<string>();
  return {
    name,
    dir: dirRel,
    entryCount: entries.length,
    fields: [...seen.keys()].sort().map((n) => ({
      name: n,
      required: required.has(n),
      example: seen.get(n),
    })),
    exampleEntry: entries[0] ? path.relative(repoRoot, entries[0]) : undefined,
  };
}

export function scanCollections(repoRoot: string): ContentCollection[] {
  const contentRoot = path.join(repoRoot, CONTENT_DIR);
  if (!fs.existsSync(contentRoot)) return [];
  return fs
    .readdirSync(contentRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => scanCollection(repoRoot, e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The collection a repo-relative file path belongs to, if any. */
export function collectionOf(filePath: string): string | null {
  const normalized = filePath.split(path.sep).join('/');
  const match = normalized.match(/^src\/content\/([^/]+)\/.+\.(md|mdx)$/);
  return match ? match[1] : null;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const DATE_KEY = /date|publishedAt|updatedAt|createdAt/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isValidIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

export function validateCollectionEntry(repoRoot: string, filePath: string): AdapterIssue[] {
  const collection = collectionOf(filePath);
  if (!collection) return [];
  const abs = path.join(repoRoot, filePath);
  if (!fs.existsSync(abs)) {
    return [{ severity: 'error', message: 'File does not exist', file: filePath }];
  }

  const issues: AdapterIssue[] = [];
  const { data } = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
  if (data === null) {
    return [
      {
        severity: 'error',
        message: 'Frontmatter is missing or unterminated (expected a `---` … `---` block)',
        file: filePath,
      },
    ];
  }

  // required-by-convention keys, learned from the sibling entries
  const absNorm = path.relative(repoRoot, abs);
  const siblings = listEntries(path.join(repoRoot, path.join(CONTENT_DIR, collection))).filter(
    (f) => path.relative(repoRoot, f) !== absNorm,
  );
  if (siblings.length > 0) {
    let required: Set<string> | null = null;
    for (const file of siblings) {
      const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const keys = parsed.data ? Object.keys(parsed.data) : [];
      required = required === null ? new Set(keys) : new Set(keys.filter((k) => required!.has(k)));
    }
    for (const key of required ?? []) {
      if (!(key in data)) {
        issues.push({
          severity: 'error',
          message: `Missing frontmatter field "${key}" (present in every other "${collection}" entry)`,
          file: filePath,
        });
      }
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (DATE_KEY.test(key) && typeof value === 'string' && value !== '' && !isValidIsoDate(value)) {
      issues.push({
        severity: 'error',
        message: `Field "${key}" is not a valid ISO date: ${value}`,
        file: filePath,
      });
    }
  }

  const slug = path.basename(filePath).replace(/\.(md|mdx)$/, '');
  if (!KEBAB.test(slug)) {
    issues.push({
      severity: 'warning',
      message: `Filename "${slug}" is not kebab-case (expected e.g. "my-new-post")`,
      file: filePath,
    });
  }

  return issues;
}

// ─── Related posts ───────────────────────────────────────────────────────────

export interface RelatedEntry {
  /** Repo-relative path — identity for exclusion and stable ordering. */
  path: string;
  title?: string;
  description?: string;
  tags?: string[];
  categories?: string[];
  /** locale/lang, if the collection has one — entries in other locales are filtered out. */
  locale?: string;
  /** ISO date used as recency tiebreak. */
  date?: string;
}

export interface RelatedSuggestion {
  path: string;
  score: number;
  reasons: string[];
}

function tokens(...texts: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const t of text.toLowerCase().split(/[^a-z0-9äöüß]+/i)) {
      if (t.length > 2) out.add(t);
    }
  }
  return out;
}

/**
 * Deterministic related-posts scoring: shared tags/categories weight 3,
 * same-locale filter, title+description token overlap weight 1, recency
 * tiebreak, stable path ordering, current entry excluded.
 */
export function suggestRelated(
  entries: RelatedEntry[],
  current: RelatedEntry,
  max = 3,
): RelatedSuggestion[] {
  const curTags = new Set((current.tags ?? []).map((t) => t.toLowerCase()));
  const curCats = new Set((current.categories ?? []).map((c) => c.toLowerCase()));
  const curTokens = tokens(current.title, current.description);

  const scored: (RelatedSuggestion & { date: string })[] = [];
  for (const entry of entries) {
    if (entry.path === current.path) continue;
    if (current.locale && entry.locale && entry.locale !== current.locale) continue;

    const reasons: string[] = [];
    let score = 0;

    const sharedTags = (entry.tags ?? []).filter((t) => curTags.has(t.toLowerCase()));
    if (sharedTags.length) {
      score += 3 * sharedTags.length;
      reasons.push(`shared tags (${sharedTags.join(', ')}): +${3 * sharedTags.length}`);
    }
    const sharedCats = (entry.categories ?? []).filter((c) => curCats.has(c.toLowerCase()));
    if (sharedCats.length) {
      score += 3 * sharedCats.length;
      reasons.push(`shared categories (${sharedCats.join(', ')}): +${3 * sharedCats.length}`);
    }
    const overlap = [...tokens(entry.title, entry.description)].filter((t) => curTokens.has(t));
    if (overlap.length) {
      score += overlap.length;
      reasons.push(`title/description overlap (${overlap.join(', ')}): +${overlap.length}`);
    }

    if (score > 0) scored.push({ path: entry.path, score, reasons, date: entry.date ?? '' });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || b.date.localeCompare(a.date) || a.path.localeCompare(b.path),
  );
  return scored.slice(0, max).map(({ path: p, score, reasons }) => ({ path: p, score, reasons }));
}

/** Load a collection's entries as RelatedEntry records (for the tool). */
export function loadRelatedEntries(repoRoot: string, collection: string): RelatedEntry[] {
  const dir = path.join(repoRoot, CONTENT_DIR, collection);
  if (!fs.existsSync(dir)) return [];
  return listEntries(dir).map((file) => {
    const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const d = data ?? {};
    const str = (v: FrontmatterValue | undefined) => (typeof v === 'string' ? v : undefined);
    const arr = (v: FrontmatterValue | undefined) =>
      Array.isArray(v) ? v : typeof v === 'string' && v !== '' ? [v] : undefined;
    return {
      path: path.relative(repoRoot, file),
      title: str(d.title),
      description: str(d.description),
      tags: arr(d.tags),
      categories: arr(d.categories) ?? arr(d.category),
      locale: str(d.locale) ?? str(d.lang) ?? str(d.language),
      date: str(d.date) ?? str(d.pubDate) ?? str(d.publishedAt),
    };
  });
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const collectionsAdapter: ContentAdapter = {
  id: 'content-collections',

  async inventory(repoRoot: string): Promise<ContentInventory> {
    return { adapter: this.id, collections: scanCollections(repoRoot) };
  },

  async validate(repoRoot: string, filePath: string): Promise<AdapterIssue[]> {
    return validateCollectionEntry(repoRoot, filePath);
  },

  async buildContext(repoRoot: string): Promise<string> {
    const collections = scanCollections(repoRoot);
    if (collections.length === 0) return '';
    const parts: string[] = ['Content collections in this site (src/content/):'];
    for (const c of collections) {
      parts.push(`\n- "${c.name}" (${c.dir}, ${c.entryCount} entries)`);
      const fields = c.fields
        .slice(0, 10)
        .map(
          (f) =>
            `  - ${f.name}${f.required ? ' (required by convention)' : ''}${f.example ? ` — e.g. ${f.example.slice(0, 60)}` : ''}`,
        );
      parts.push(...fields);
      if (c.exampleEntry) parts.push(`  Example entry: ${c.exampleEntry}`);
    }
    parts.push(
      '\nConventions: entry filenames are kebab-case; date fields use ISO dates (YYYY-MM-DD); new entries must include every required-by-convention field.',
    );
    let out = parts.join('\n');
    if (out.length > 2000) out = out.slice(0, 1997) + '…';
    return out;
  },
};

export function registerCollectionsAdapter(): void {
  registerContentAdapter(collectionsAdapter);
}
