/**
 * Validation pipeline (plan §12 / medved §21).
 * Pre-commit validators run on the dirty worktree before an execution commit;
 * pre-publish validators run on the sealed dist. Failures carry a failure
 * class driving retry/notify behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export type FailureClass =
  | 'USER_FIXABLE'
  | 'AGENT_FIXABLE'
  | 'RETRYABLE_INFRA'
  | 'ADMIN_REQUIRED'
  | 'EXTERNAL_UNKNOWN';

export interface ValidationIssue {
  validator: string;
  severity: 'error' | 'warning';
  message: string;
  failureClass: FailureClass;
  file?: string;
}

// ─── Secret scan patterns (diff-level) ───────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'generic API key assignment', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-/+]{20,}['"]/i },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9_-]{20,}/ },
];

const ALLOWED_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3', '.pdf',
]);

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];

/**
 * Pre-commit validation of the dirty worktree (added/changed files).
 * Path containment itself is enforced earlier at the tool layer; this is the
 * defense-in-depth pass over whatever ended up in the tree.
 */
export async function validateWorktree(worktreePath: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const git = simpleGit(worktreePath);
  const status = await git.status();

  for (const file of status.files) {
    const rel = file.path;
    const abs = path.join(worktreePath, rel);
    if (!fs.existsSync(abs)) continue; // deletion

    // Symlinks must not enter the tree (escape vector on other checkouts)
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink()) {
      issues.push({
        validator: 'no-symlinks',
        severity: 'error',
        failureClass: 'AGENT_FIXABLE',
        message: `Symlink not allowed: ${rel}`,
        file: rel,
      });
      continue;
    }
    if (!lst.isFile()) continue;

    const buf = fs.readFileSync(abs);
    const isBinary = buf.includes(0);

    if (isBinary && !ALLOWED_BINARY_EXT.has(path.extname(rel).toLowerCase())) {
      issues.push({
        validator: 'unexpected-binary',
        severity: 'error',
        failureClass: 'AGENT_FIXABLE',
        message: `Unexpected binary file: ${rel}`,
        file: rel,
      });
    }

    if (!isBinary) {
      const text = buf.toString('utf8');
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) {
          issues.push({
            validator: 'secret-scan',
            severity: 'error',
            failureClass: 'USER_FIXABLE',
            message: `Possible secret (${name}) in ${rel}`,
            file: rel,
          });
        }
      }
    }

    if (LOCKFILES.includes(path.basename(rel)) || path.basename(rel) === 'package.json') {
      issues.push({
        validator: 'dependency-change',
        severity: 'warning',
        failureClass: 'ADMIN_REQUIRED',
        message: `Dependency/lockfile change (${rel}) — high-risk, review carefully`,
        file: rel,
      });
    }
  }

  return issues;
}

/**
 * Pre-publish validation of a sealed dist directory: production output must
 * not contain CMS/overlay code, and local links must resolve.
 */
export function validateDist(distDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const htmlFiles: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(distDir);

  for (const file of htmlFiles) {
    const rel = path.relative(distDir, file);
    const html = fs.readFileSync(file, 'utf8');

    if (
      html.includes('injected-cms-agent.js') ||
      html.includes('preview-overlay.js') || // legacy overlay name
      html.includes('__preview/boot')
    ) {
      issues.push({
        validator: 'no-cms-code',
        severity: 'error',
        failureClass: 'ADMIN_REQUIRED',
        message: `Production output contains CMS/overlay references: ${rel}`,
        file: rel,
      });
    }

    // Local link smoke: every root-relative href/src must exist in dist
    for (const match of html.matchAll(/(?:href|src)="(\/[^"#?]*)[#?"]/g)) {
      const target = match[1];
      if (target.startsWith('//')) continue;
      const candidates = [
        path.join(distDir, target),
        path.join(distDir, target, 'index.html'),
        path.join(distDir, `${target.replace(/\/$/, '')}.html`),
      ];
      if (!candidates.some((c) => fs.existsSync(c))) {
        issues.push({
          validator: 'link-smoke',
          severity: 'warning',
          failureClass: 'AGENT_FIXABLE',
          message: `Broken local link ${target} in ${rel}`,
          file: rel,
        });
      }
    }
  }

  return issues;
}

export const hasErrors = (issues: ValidationIssue[]) => issues.some((i) => i.severity === 'error');
