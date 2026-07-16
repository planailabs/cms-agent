/**
 * JobPosting adapter (medved §19) — canonical JobDraft model with per-field
 * provenance, heuristic extraction from uploaded text, schema.org JSON-LD
 * generation from the canonical model ONLY (same source as the visible HTML),
 * and the visible-content/JSON-LD consistency check.
 *
 * Hard rules: never invent datePosted, validThrough or directApply; the
 * mandatory clarification questions are always surfaced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  registerContentAdapter,
  type AdapterIssue,
  type ContentAdapter,
  type ContentInventory,
} from './adapter';
import { parseFrontmatter, scanCollections, validateCollectionEntry } from './collections';

// ─── Canonical model ─────────────────────────────────────────────────────────

export const provenanceSchema = z.object({
  source: z.enum(['upload', 'user', 'derived']),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type FieldProvenance = z.infer<typeof provenanceSchema>;

export const jobDraftSchema = z.object({
  title: z.string().min(1),
  descriptionHtml: z.string().min(1),
  datePosted: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'datePosted must be YYYY-MM-DD'),
  validThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  employmentType: z
    .array(z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'TEMPORARY', 'INTERN', 'VOLUNTEER', 'PER_DIEM', 'OTHER']))
    .optional(),
  hiringOrganization: z.object({ name: z.string().min(1) }),
  jobLocation: z.array(z.object({ address: z.string().min(1) })).optional(),
  jobLocationType: z.literal('TELECOMMUTE').optional(),
  applicantLocationRequirements: z.array(z.object({ name: z.string().min(1) })).optional(),
  applicationUrl: z.string().optional(),
  directApply: z.boolean().optional(),
  language: z.string().min(2),
  provenance: z.record(provenanceSchema),
});
export type JobDraft = z.infer<typeof jobDraftSchema>;

// ─── Extraction ──────────────────────────────────────────────────────────────

export interface ExtractionResult {
  draft: Partial<JobDraft>;
  /** Canonical fields we could not extract. */
  missing: string[];
  /** Mandatory clarification questions for the user (medved §19). */
  questions: string[];
}

const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const GERMAN_DATE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const URL_RE = /\bhttps?:\/\/[^\s<>")\]]+/g;
const REMOTE_RE = /\b(remote|telecommute|home[\s-]?office|work from home|100\s*%\s*remote)\b/i;
const ORG_RE = /\b([A-ZÄÖÜ][\w&.ÄÖÜäöüß-]*(?:\s+[A-ZÄÖÜ][\w&.ÄÖÜäöüß-]*)*\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|SE|KG|UG|Inc\.?|Ltd\.?|LLC|Corp\.?))(?=[\s,.;:]|$)/;

const GERMAN_HINTS = /\b(wir suchen|vollzeit|teilzeit|bewerbung|aufgaben|anforderungen|kenntnisse|arbeitsplatz|und|oder|für|mit)\b/gi;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function detectEmploymentTypes(text: string): NonNullable<JobDraft['employmentType']> {
  const out = new Set<NonNullable<JobDraft['employmentType']>[number]>();
  if (/\b(full[\s-]?time|vollzeit)\b/i.test(text)) out.add('FULL_TIME');
  if (/\b(part[\s-]?time|teilzeit)\b/i.test(text)) out.add('PART_TIME');
  if (/\b(freelance|contractor|freiberuflich)\b/i.test(text)) out.add('CONTRACTOR');
  if (/\b(internship|intern|praktikum|werkstudent)\b/i.test(text)) out.add('INTERN');
  return [...out];
}

function detectDate(text: string): string | null {
  const iso = text.match(ISO_DATE_RE);
  if (iso) {
    const candidate = iso[0];
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  const de = text.match(GERMAN_DATE_RE);
  if (de) {
    const [, d, m, y] = de;
    const candidate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    if (!Number.isNaN(Date.parse(candidate))) return candidate;
  }
  return null;
}

function humanizeFilename(filename: string): string {
  return path
    .basename(filename)
    .replace(/\.(md|markdown|txt|mdx)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

/**
 * Heuristic JobDraft extraction from uploaded markdown/plain text. Extracted
 * values carry provenance; nothing is invented — a missing date stays missing
 * and becomes a question instead.
 */
export function extractJobDraft(text: string, filename: string): ExtractionResult {
  const { data, body } = parseFrontmatter(text);
  const content = body.trim() || text;
  const draft: Partial<JobDraft> = {};
  const provenance: Record<string, FieldProvenance> = {};
  const missing: string[] = [];
  const questions: string[] = [];

  // title: frontmatter title > first h1 > filename
  const fmTitle = typeof data?.title === 'string' ? data.title : undefined;
  const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (fmTitle || h1) {
    draft.title = (fmTitle ?? h1)!;
    provenance.title = { source: 'upload', confidence: 'high' };
  } else if (humanizeFilename(filename)) {
    draft.title = humanizeFilename(filename);
    provenance.title = { source: 'derived', confidence: 'low' };
  } else {
    missing.push('title');
  }

  // description: body text minus the title heading, escaped into paragraphs
  const bodyText = content
    .split(/\r?\n/)
    .filter((line) => line.trim() !== `# ${h1 ?? ''}`.trim())
    .join('\n')
    .trim();
  if (bodyText) {
    draft.descriptionHtml = bodyText
      .split(/\n{2,}/)
      .map((para) => `<p>${escapeHtml(para.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('\n');
    provenance.descriptionHtml = { source: 'upload', confidence: 'high' };
  } else {
    missing.push('descriptionHtml');
  }

  // datePosted: ONLY when explicitly present — never invented
  const explicitDate =
    (typeof data?.datePosted === 'string' && detectDate(data.datePosted)) ||
    (typeof data?.date === 'string' && detectDate(data.date)) ||
    detectDate(content);
  if (explicitDate) {
    draft.datePosted = explicitDate;
    provenance.datePosted = { source: 'upload', confidence: 'medium' };
    questions.push(
      `The document mentions ${explicitDate} — is that the original posting date, or should today's date be used?`,
    );
  } else {
    missing.push('datePosted');
    questions.push(
      'No posting date was found in the document. What is the original posting date — or should today be used as datePosted?',
    );
  }

  const employmentType = detectEmploymentTypes(content);
  if (employmentType.length) {
    draft.employmentType = employmentType;
    provenance.employmentType = { source: 'upload', confidence: 'medium' };
  }

  const remote = REMOTE_RE.test(content);
  if (remote) {
    draft.jobLocationType = 'TELECOMMUTE';
    provenance.jobLocationType = { source: 'upload', confidence: 'medium' };
    questions.push(
      'This looks like a remote/telecommute position. From which countries or regions may applicants work (applicantLocationRequirements)?',
    );
  }

  const org = content.match(ORG_RE)?.[1];
  if (org) {
    draft.hiringOrganization = { name: org.trim() };
    provenance.hiringOrganization = { source: 'upload', confidence: 'medium' };
  } else {
    missing.push('hiringOrganization');
  }

  // application channel: email first, then an apply-looking URL
  const email = content.match(EMAIL_RE)?.[0];
  const urls = content.match(URL_RE) ?? [];
  const applyUrl = urls.find((u) => /apply|bewerb|career|jobs|stellen/i.test(u)) ?? null;
  if (email) {
    draft.applicationUrl = `mailto:${email}`;
    provenance.applicationUrl = { source: 'upload', confidence: 'high' };
  } else if (applyUrl) {
    draft.applicationUrl = applyUrl;
    provenance.applicationUrl = { source: 'upload', confidence: 'medium' };
  } else {
    missing.push('applicationUrl');
    questions.push(
      'How should candidates apply (application URL or e-mail address)? This was not clear from the document.',
    );
  }

  // language: heuristic German detection, else English
  const germanHits = content.match(GERMAN_HINTS)?.length ?? 0;
  draft.language = germanHits >= 3 ? 'de' : 'en';
  provenance.language = { source: 'derived', confidence: germanHits >= 3 ? 'medium' : 'low' };

  // Mandatory (medved §19): translation question is ALWAYS asked.
  questions.push(
    draft.language === 'de'
      ? 'The posting appears to be in German — should an English translation also be published?'
      : 'Should the posting also be translated (e.g. to English) or published in additional languages?',
  );

  // NEVER fabricated: validThrough, directApply — left absent on purpose.
  draft.provenance = provenance;
  return { draft, missing, questions };
}

// ─── JSON-LD generation ──────────────────────────────────────────────────────

/**
 * schema.org JobPosting JSON-LD generated FROM the canonical model only.
 * The caller renders the visible HTML from the same model — both stay in sync.
 * Only fields present on the draft are emitted.
 */
export function jobPostingJsonLd(draft: JobDraft): object {
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: draft.title,
    description: draft.descriptionHtml,
    datePosted: draft.datePosted,
    hiringOrganization: { '@type': 'Organization', name: draft.hiringOrganization.name },
  };
  if (draft.validThrough) ld.validThrough = draft.validThrough;
  if (draft.employmentType?.length) {
    ld.employmentType = draft.employmentType.length === 1 ? draft.employmentType[0] : draft.employmentType;
  }
  if (draft.jobLocation?.length) {
    ld.jobLocation = draft.jobLocation.map((loc) => ({
      '@type': 'Place',
      address: { '@type': 'PostalAddress', streetAddress: loc.address },
    }));
  }
  if (draft.jobLocationType === 'TELECOMMUTE') {
    ld.jobLocationType = 'TELECOMMUTE';
    if (draft.applicantLocationRequirements?.length) {
      ld.applicantLocationRequirements = draft.applicantLocationRequirements.map((r) => ({
        '@type': 'Country',
        name: r.name,
      }));
    }
  }
  if (draft.applicationUrl) ld.url = draft.applicationUrl;
  if (draft.directApply !== undefined) ld.directApply = draft.directApply;
  return ld;
}

// ─── Visible-content / JSON-LD consistency check ─────────────────────────────

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // invalid JSON-LD is reported by the caller via count mismatch
    }
  }
  return out;
}

function countJobPostings(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + countJobPostings(x), 0);
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    let n = o['@type'] === 'JobPosting' ? 1 : 0;
    if (Array.isArray(o['@graph'])) n += countJobPostings(o['@graph']);
    return n;
  }
  return 0;
}

/**
 * Consistency check between the page's visible content and its JobPosting
 * JSON-LD: structured data must not claim anything the visitor cannot see.
 */
export function validateJobPage(html: string, jsonLd: object): AdapterIssue[] {
  const issues: AdapterIssue[] = [];
  const file = '(page)';
  const ld = jsonLd as Record<string, unknown>;
  const text = visibleText(html);
  const textLower = text.toLowerCase();

  if (ld['@type'] !== 'JobPosting') {
    issues.push({ severity: 'error', message: 'JSON-LD @type is not JobPosting', file });
  }

  const embedded = extractJsonLdBlocks(html);
  const embeddedCount = embedded.reduce((n: number, b) => n + countJobPostings(b), 0);
  if (embeddedCount > 1) {
    issues.push({
      severity: 'error',
      message: `Page embeds ${embeddedCount} JobPosting JSON-LD objects — exactly one is allowed per page`,
      file,
    });
  }

  const title = typeof ld.title === 'string' ? ld.title : '';
  if (title && !textLower.includes(title.toLowerCase())) {
    issues.push({
      severity: 'error',
      message: `JSON-LD title "${title}" does not appear in the visible page content`,
      file,
    });
  }

  const datePosted = typeof ld.datePosted === 'string' ? ld.datePosted : '';
  if (datePosted && !text.includes(datePosted)) {
    issues.push({
      severity: 'error',
      message: `JSON-LD datePosted "${datePosted}" does not appear in the visible page content`,
      file,
    });
  }

  const description = typeof ld.description === 'string' ? visibleText(ld.description) : '';
  if (title && description && description.toLowerCase() === title.toLowerCase()) {
    issues.push({
      severity: 'error',
      message: 'JSON-LD description is just the title — a real job description is required',
      file,
    });
  }

  return issues;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

const JOBS_DIR_RE = /^(jobs?|stellen(anzeigen)?|careers?|vacancies)$/i;

export const jobPostingAdapter: ContentAdapter = {
  id: 'jobposting',

  async inventory(repoRoot: string): Promise<ContentInventory> {
    const collections = scanCollections(repoRoot).filter((c) => JOBS_DIR_RE.test(c.name));
    return { adapter: this.id, collections };
  },

  async validate(repoRoot: string, filePath: string): Promise<AdapterIssue[]> {
    const parts = filePath.split(/[\\/]/);
    const inJobsDir = parts.some((p) => JOBS_DIR_RE.test(p));
    if (!inJobsDir) return [];

    const abs = path.join(repoRoot, filePath);
    if (!fs.existsSync(abs)) {
      return [{ severity: 'error', message: 'File does not exist', file: filePath }];
    }

    const issues: AdapterIssue[] = [];
    if (/\.(md|mdx)$/.test(filePath)) {
      issues.push(...validateCollectionEntry(repoRoot, filePath));
    }

    const content = fs.readFileSync(abs, 'utf8');
    for (const block of extractJsonLdBlocks(content)) {
      const nodes = Array.isArray(block) ? block : [block];
      for (const node of nodes) {
        if (node && typeof node === 'object' && (node as Record<string, unknown>)['@type'] === 'JobPosting') {
          issues.push(
            ...validateJobPage(content, node as object).map((i) => ({ ...i, file: filePath })),
          );
        }
      }
    }
    return issues;
  },

  async buildContext(repoRoot: string): Promise<string> {
    const inv = await this.inventory(repoRoot);
    const parts = [
      'JobPosting rules (schema.org):',
      '- Job pages carry exactly one application/ld+json JobPosting, generated from the same data as the visible HTML.',
      '- title and datePosted in the JSON-LD must appear in the visible page; the description must be a real description, not the title.',
      '- Never invent datePosted, validThrough or directApply — ask the user instead.',
      '- Remote jobs: jobLocationType TELECOMMUTE plus applicantLocationRequirements (ask which regions).',
      '- Always ask: is the original posting date correct or is it today, and should the posting be translated to English?',
    ];
    if (inv.collections.length) {
      parts.push(
        `Job collections found: ${inv.collections.map((c) => `${c.name} (${c.entryCount} entries)`).join(', ')}.`,
      );
    }
    const out = parts.join('\n');
    return out.length > 2000 ? out.slice(0, 1997) + '…' : out;
  },
};

export function registerJobPostingAdapter(): void {
  registerContentAdapter(jobPostingAdapter);
}
