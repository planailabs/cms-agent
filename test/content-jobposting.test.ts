import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  extractJobDraft,
  jobDraftSchema,
  jobPostingAdapter,
  jobPostingJsonLd,
  validateJobPage,
  type JobDraft,
} from '@/lib/content/jobposting';

const GERMAN_POSTING = [
  '# Senior TypeScript Entwickler',
  '',
  'Wir suchen eine erfahrene Entwicklerin für unser CMS-Team bei der Medved GmbH.',
  'Die Stelle ist in Vollzeit und zu 100 % remote möglich.',
  '',
  'Veröffentlicht am 15.03.2026.',
  '',
  'Bewerbung bitte per E-Mail an bewerbung@medved.example mit Lebenslauf und Referenzen.',
].join('\n');

describe('extractJobDraft', () => {
  it('extracts title, date, employment type, remote flag and application channel', () => {
    const { draft, missing } = extractJobDraft(GERMAN_POSTING, 'senior-ts.md');
    expect(draft.title).toBe('Senior TypeScript Entwickler');
    expect(draft.provenance?.title).toEqual({ source: 'upload', confidence: 'high' });
    expect(draft.datePosted).toBe('2026-03-15');
    expect(draft.employmentType).toEqual(['FULL_TIME']);
    expect(draft.jobLocationType).toBe('TELECOMMUTE');
    expect(draft.applicationUrl).toBe('mailto:bewerbung@medved.example');
    expect(draft.hiringOrganization?.name).toBe('Medved GmbH');
    expect(draft.language).toBe('de');
    expect(draft.descriptionHtml).toContain('<p>');
    expect(missing).not.toContain('datePosted');
  });

  it('never invents datePosted, validThrough or directApply', () => {
    const { draft, missing, questions } = extractJobDraft(
      '# Developer\nJoin our team. Apply at https://example.com/careers/apply',
      'developer.md',
    );
    expect(draft.datePosted).toBeUndefined();
    expect(draft.validThrough).toBeUndefined();
    expect(draft.directApply).toBeUndefined();
    expect(missing).toContain('datePosted');
    // date question required when no date was found
    expect(questions.some((q) => /posting date/i.test(q) && /today/i.test(q))).toBe(true);
    // apply URL was detected from the careers link
    expect(draft.applicationUrl).toBe('https://example.com/careers/apply');
  });

  it('ALWAYS asks the translation question', () => {
    for (const text of [GERMAN_POSTING, '# Dev\nPlain English posting.']) {
      const { questions } = extractJobDraft(text, 'x.md');
      expect(questions.some((q) => /translat/i.test(q))).toBe(true);
    }
  });

  it('asks the date question even when a date was found (correct/today?)', () => {
    const { questions } = extractJobDraft(GERMAN_POSTING, 'x.md');
    expect(questions.some((q) => /2026-03-15/.test(q) && /original posting date/i.test(q))).toBe(true);
  });

  it('asks about applicant regions for remote jobs, how-to-apply when unclear', () => {
    const remote = extractJobDraft('# Dev\nFully remote position.', 'dev.md');
    expect(remote.questions.some((q) => /countries or regions/i.test(q))).toBe(true);
    expect(remote.questions.some((q) => /how should candidates apply/i.test(q))).toBe(true);

    const onsite = extractJobDraft('# Dev\nOffice in Berlin. Apply: jobs@x.example', 'dev.md');
    expect(onsite.questions.some((q) => /countries or regions/i.test(q))).toBe(false);
    expect(onsite.questions.some((q) => /how should candidates apply/i.test(q))).toBe(false);
  });

  it('falls back to a humanized filename when no h1 exists', () => {
    const { draft } = extractJobDraft('Just a plain text posting.', 'backend-engineer-berlin.md');
    expect(draft.title).toBe('backend engineer berlin');
    expect(draft.provenance?.title).toEqual({ source: 'derived', confidence: 'low' });
  });
});

describe('jobPostingJsonLd', () => {
  const remoteDraft: JobDraft = {
    title: 'Senior TypeScript Developer',
    descriptionHtml: '<p>Build the CMS agent with us.</p>',
    datePosted: '2026-03-15',
    employmentType: ['FULL_TIME'],
    hiringOrganization: { name: 'Medved GmbH' },
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: [{ name: 'Germany' }, { name: 'Austria' }],
    applicationUrl: 'mailto:jobs@medved.example',
    language: 'en',
    provenance: { title: { source: 'user', confidence: 'high' } },
  };

  it('produces a remote JobPosting with TELECOMMUTE + applicant location requirements', () => {
    expect(jobDraftSchema.safeParse(remoteDraft).success).toBe(true);
    const ld = jobPostingJsonLd(remoteDraft) as Record<string, unknown>;
    expect(ld['@context']).toBe('https://schema.org/');
    expect(ld['@type']).toBe('JobPosting');
    expect(ld.title).toBe('Senior TypeScript Developer');
    expect(ld.datePosted).toBe('2026-03-15');
    expect(ld.employmentType).toBe('FULL_TIME');
    expect(ld.hiringOrganization).toEqual({ '@type': 'Organization', name: 'Medved GmbH' });
    expect(ld.jobLocationType).toBe('TELECOMMUTE');
    expect(ld.applicantLocationRequirements).toEqual([
      { '@type': 'Country', name: 'Germany' },
      { '@type': 'Country', name: 'Austria' },
    ]);
    expect(ld.url).toBe('mailto:jobs@medved.example');
    // absent fields stay absent — never fabricated
    expect('validThrough' in ld).toBe(false);
    expect('directApply' in ld).toBe(false);
    expect('jobLocation' in ld).toBe(false);
  });

  it('rejects drafts that do not match the shape', () => {
    expect(jobDraftSchema.safeParse({ ...remoteDraft, datePosted: '15.03.2026' }).success).toBe(false);
    expect(jobDraftSchema.safeParse({ ...remoteDraft, title: '' }).success).toBe(false);
  });
});

describe('validateJobPage', () => {
  const jsonLd = {
    '@type': 'JobPosting',
    title: 'Senior TypeScript Developer',
    datePosted: '2026-03-15',
    description: '<p>Build the CMS agent with us.</p>',
  };
  const goodHtml = [
    '<html><body>',
    '<h1>Senior TypeScript Developer</h1>',
    '<p>Posted 2026-03-15</p>',
    '<p>Build the CMS agent with us.</p>',
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    '</body></html>',
  ].join('\n');

  it('passes a consistent page', () => {
    expect(validateJobPage(goodHtml, jsonLd)).toEqual([]);
  });

  it('catches a title that is not visible on the page', () => {
    const issues = validateJobPage(goodHtml, { ...jsonLd, title: 'Chief Meme Officer' });
    expect(issues.some((i) => i.severity === 'error' && /title/.test(i.message))).toBe(true);
  });

  it('catches a datePosted that is not visible on the page', () => {
    const issues = validateJobPage(goodHtml, { ...jsonLd, datePosted: '2026-04-01' });
    expect(issues.some((i) => i.severity === 'error' && /datePosted/.test(i.message))).toBe(true);
  });

  it('catches description that is just the title', () => {
    const issues = validateJobPage(goodHtml, { ...jsonLd, description: jsonLd.title });
    expect(issues.some((i) => i.severity === 'error' && /description/.test(i.message))).toBe(true);
  });

  it('rejects more than one JobPosting per page', () => {
    const twice = goodHtml.replace(
      '</body>',
      `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script></body>`,
    );
    const issues = validateJobPage(twice, jsonLd);
    expect(issues.some((i) => i.severity === 'error' && /exactly one/.test(i.message))).toBe(true);
  });
});

describe('jobPostingAdapter.validate', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-jobs-test-'));
    fs.mkdirSync(path.join(repo, 'src', 'pages', 'jobs'), { recursive: true });
  });

  it('ignores files outside jobs directories', async () => {
    const rel = path.join('src', 'pages', 'about.html');
    fs.writeFileSync(path.join(repo, rel), '<h1>About</h1>');
    expect(await jobPostingAdapter.validate(repo, rel)).toEqual([]);
  });

  it('runs the consistency check on embedded JobPosting JSON-LD', async () => {
    const bad = {
      '@type': 'JobPosting',
      title: 'Hidden Title',
      datePosted: '2026-03-15',
      description: 'Hidden Title',
    };
    const rel = path.join('src', 'pages', 'jobs', 'dev.html');
    fs.writeFileSync(
      path.join(repo, rel),
      `<html><body><h1>Different Heading</h1><p>2026-03-15</p><script type="application/ld+json">${JSON.stringify(bad)}</script></body></html>`,
    );
    const issues = await jobPostingAdapter.validate(repo, rel);
    expect(issues.some((i) => /title/.test(i.message))).toBe(true);
    expect(issues.some((i) => /description/.test(i.message))).toBe(true);
    expect(issues.every((i) => i.file === rel)).toBe(true);
  });
});
