import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateDist, validateWorktree, hasErrors } from '@/lib/validate';
import { storeUpload, UploadError } from '@/lib/uploads';
import { resetEnvCache } from '@/lib/env';

let repo: string;

beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-validate-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = simpleGit(repo);
  await git.init(['--initial-branch=main'] as never);
  await git.addConfig('user.name', 'T');
  await git.addConfig('user.email', 't@t');
  fs.writeFileSync(path.join(repo, 'ok.md'), '# fine\n');
  await git.add(['-A']);
  await git.commit('init');

  process.env.VAR_DIR = path.join(base, 'var');
  resetEnvCache();
});

describe('pre-commit validation', () => {
  it('flags secrets, symlinks, unexpected binaries, and lockfile changes', async () => {
    fs.writeFileSync(path.join(repo, 'leak.ts'), `const apiKey = "sk-abcdefghijklmnopqrstuvwx";\n`);
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(repo, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    fs.symlinkSync('/etc', path.join(repo, 'evil'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');

    const issues = await validateWorktree(repo);
    const byValidator = (v: string) => issues.filter((i) => i.validator === v);

    expect(byValidator('secret-scan').length).toBeGreaterThan(0);
    expect(byValidator('no-symlinks')).toHaveLength(1);
    expect(byValidator('unexpected-binary').map((i) => i.file)).toEqual(['blob.bin']); // png allowed
    expect(byValidator('dependency-change')).toHaveLength(1);
    expect(hasErrors(issues)).toBe(true);
  });
});

describe('pre-publish dist validation', () => {
  it('rejects CMS code in output and flags broken links', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-dist-'));
    fs.writeFileSync(
      path.join(dist, 'index.html'),
      `<html><head><script src="https://cms/injected-cms-agent.js"></script></head>
       <body><a href="/missing/">x</a><a href="/other/">y</a></body></html>`,
    );
    fs.mkdirSync(path.join(dist, 'other'));
    fs.writeFileSync(path.join(dist, 'other', 'index.html'), '<html></html>');

    const issues = validateDist(dist);
    expect(issues.find((i) => i.validator === 'no-cms-code')?.severity).toBe('error');
    expect(issues.filter((i) => i.validator === 'link-smoke').map((i) => i.message)).toEqual([
      expect.stringContaining('/missing/'),
    ]);
  });
});

describe('upload pipeline', () => {
  it('accepts valid files and stores them with random names', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const stored = storeUpload('logo.png', 'image/png', png);
    expect(fs.existsSync(stored.storedPath)).toBe(true);
    expect(path.basename(stored.storedPath)).not.toContain('logo');
    expect(stored.sha256).toHaveLength(64);
  });

  it('rejects extension/MIME/magic mismatches and oversize files', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]);
    // exe disguised as png (bad magic)
    expect(() => storeUpload('x.png', 'image/png', Buffer.from('MZ90')) ).toThrow(UploadError);
    // disallowed extension
    expect(() => storeUpload('x.exe', 'application/x-msdownload', png)).toThrow(/not allowed/);
    // MIME mismatch
    expect(() => storeUpload('x.png', 'application/pdf', png)).toThrow(/does not match extension/);
    // markdown with NUL bytes is not text
    expect(() => storeUpload('x.md', 'text/markdown', Buffer.from([0, 1, 2]))).toThrow(/does not match its declared type/);
    // pdf magic
    expect(() => storeUpload('x.pdf', 'application/pdf', Buffer.from('%PDF-1.4 ...'))).not.toThrow();
  });

  it('accepts every Firecrawl document type as a chat attachment', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const zip = (marker: string) => Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), Buffer.from(marker),
    ]);
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => storeUpload('logo.png', 'image/png', png, ['image'])).not.toThrow();
    expect(() => storeUpload('doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4 ...'), ['pdf'])).not.toThrow();
    expect(() => storeUpload('old.doc', 'application/msword', ole, ['document'])).not.toThrow();
    expect(() => storeUpload('new.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip('word/document.xml'), ['document'])).not.toThrow();
    expect(() => storeUpload('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip('xl/workbook.xml'), ['document'])).not.toThrow();
    expect(() => storeUpload('text.odt', 'application/vnd.oasis.opendocument.text', zip('application/vnd.oasis.opendocument.text'), ['document'])).not.toThrow();
    expect(() => storeUpload('fake.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip('xl/workbook.xml'), ['document'])).toThrow(/does not match/);
    expect(() => storeUpload('rich.rtf', 'application/rtf', Buffer.from('{\\rtf1 hello}'), ['document'])).not.toThrow();
  });
});
