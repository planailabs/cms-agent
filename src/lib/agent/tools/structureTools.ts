/**
 * Code-structure tools — dependency-free, regex-based views of the target
 * Astro site so the agent orients itself without reading every file:
 * site_structure (routes/components/layouts/content + dependency list),
 * code_outline (imports/exports/props/headings of one file),
 * find_symbol (definitions + usages of a name across the repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { jail } from './fsTools';
import { registerTool, type ToolDef } from './registry';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', '.cms']);
const CODE_EXT = new Set(['.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.mdx']);

function* walk(dir: string, root: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name), root);
    } else if (entry.isFile()) {
      yield path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
    }
  }
}

// ─── Outline extraction ──────────────────────────────────────────────────────

export interface Outline {
  file: string;
  frontmatterKeys?: string[];
  imports: Array<{ from: string; names: string }>;
  exports: string[];
  functions: string[];
  props?: string[];
  headings?: string[];
  componentsUsed?: string[];
}

export function outlineFile(root: string, rel: string): Outline {
  const content = fs.readFileSync(path.join(root, rel), 'utf8');
  const ext = path.extname(rel);
  const outline: Outline = { file: rel, imports: [], exports: [], functions: [] };

  // Frontmatter keys for markdown; astro frontmatter script handled below
  if (ext === '.md' || ext === '.mdx') {
    const fm = /^---\n([\s\S]*?)\n---/.exec(content);
    if (fm) {
      outline.frontmatterKeys = [...fm[1].matchAll(/^([A-Za-z0-9_-]+)\s*:/gm)].map((m) => m[1]);
    }
    outline.headings = [...content.matchAll(/^(#{1,4})\s+(.+)$/gm)].map(
      (m) => `${'  '.repeat(m[1].length - 1)}${m[2].trim()}`,
    );
    return outline;
  }

  for (const m of content.matchAll(
    /^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/gm,
  )) {
    outline.imports.push({ names: m[1].replace(/\s+/g, ' ').slice(0, 120), from: m[2] });
  }
  for (const m of content.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    outline.exports.push(m[1]);
  }
  for (const m of content.matchAll(
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/gm,
  )) {
    outline.functions.push(m[1] ?? m[2]);
  }

  if (ext === '.astro') {
    // Props: `const { a, b } = Astro.props` or interface Props
    const props =
      /(?:const|let)\s*\{([^}]*)\}\s*=\s*Astro\.props/.exec(content)?.[1] ??
      /interface\s+Props\s*\{([^}]*)\}/s.exec(content)?.[1];
    if (props) {
      outline.props = props
        .split(/[,;\n]/)
        .map((p) => p.split(/[=:?]/)[0].trim())
        .filter(Boolean);
    }
    // Capitalized JSX-style component tags used in the template
    outline.componentsUsed = [
      ...new Set([...content.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1])),
    ];
    outline.headings = [...content.matchAll(/<h([1-4])[^>]*>([^<]{1,120})</g)].map(
      (m) => `h${m[1]}: ${m[2].trim()}`,
    );
  }

  return outline;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const ALL_PHASES = ['plan', 'execute', 'preview', 'published'] as const;

const siteStructureTool: ToolDef = {
  name: 'site_structure',
  description:
    'Overview of the Astro site: pages with their routes, layouts, components (and where each is used), content collections, and dependencies. Start here to orient yourself.',
  schema: z.object({}),
  phases: [...ALL_PHASES],
  async execute(_input, ctx) {
    const root = jail(ctx, '.');
    const files = [...walk(root, root)].filter((f) => CODE_EXT.has(path.extname(f)));

    const pages: Array<{ file: string; route: string }> = [];
    const componentUsage = new Map<string, string[]>();

    for (const f of files) {
      if (f.startsWith('src/pages/')) {
        const rel = f.replace(/^src\/pages\//, '').replace(/\.(astro|md|mdx|html)$/, '');
        const route = rel === 'index' ? '/' : `/${rel.replace(/\/index$/, '')}/`;
        pages.push({ file: f, route: route.includes('[') ? `${route} (dynamic)` : route });
      }
      if (f.endsWith('.astro') || f.endsWith('.tsx') || f.endsWith('.jsx')) {
        try {
          for (const used of outlineFile(root, f).componentsUsed ?? []) {
            const list = componentUsage.get(used) ?? [];
            list.push(f);
            componentUsage.set(used, list);
          }
        } catch {
          // unreadable file — skip
        }
      }
    }

    let dependencies: Record<string, string> = {};
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // no package.json
    }

    return JSON.stringify(
      {
        pages,
        layouts: files.filter((f) => f.startsWith('src/layouts/')),
        components: files.filter((f) => f.startsWith('src/components/')),
        contentCollections: [
          ...new Set(
            files
              .filter((f) => f.startsWith('src/content/') && f.split('/').length > 3)
              .map((f) => f.split('/')[2]),
          ),
        ],
        componentUsage: Object.fromEntries(componentUsage),
        dependencies,
      },
      null,
      2,
    );
  },
};

const codeOutlineTool: ToolDef = {
  name: 'code_outline',
  description:
    'Structural outline of one file: imports, exports, functions, Astro props, components used, headings, frontmatter keys — cheaper than reading the whole file.',
  schema: z.object({ path: z.string() }),
  phases: [...ALL_PHASES],
  async execute(input, ctx) {
    const root = jail(ctx, '.');
    jail(ctx, input.path); // containment check
    return JSON.stringify(outlineFile(root, input.path), null, 2);
  },
};

const findSymbolTool: ToolDef = {
  name: 'find_symbol',
  description:
    'Find where a symbol (component, function, variable, type) is defined and everywhere it is used across the repo.',
  schema: z.object({ name: z.string().min(2) }),
  phases: [...ALL_PHASES],
  async execute(input, ctx) {
    const root = jail(ctx, '.');
    const name = input.name.replace(/[^A-Za-z0-9_$]/g, '');
    if (!name) return JSON.stringify({ error: 'Invalid symbol name' });

    const defRe = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?(?:const|let|var|function|class|interface|type|enum)\\s+${name}\\b`,
    );
    const useRe = new RegExp(`\\b${name}\\b`);
    const importRe = new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s+['"]([^'"]+)['"]`);

    const definitions: string[] = [];
    const usages: string[] = [];
    for (const f of walk(root, root)) {
      if (!CODE_EXT.has(path.extname(f))) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, f), 'utf8');
      } catch {
        continue;
      }
      if (!useRe.test(content)) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!useRe.test(lines[i])) continue;
        const entry = `${f}:${i + 1}: ${lines[i].trim().slice(0, 160)}`;
        if (defRe.test(lines[i])) definitions.push(entry);
        else if (importRe.test(lines[i]) || usages.length < 100) usages.push(entry);
      }
    }
    // File named after the symbol counts as a definition candidate too
    for (const f of walk(root, root)) {
      if (path.basename(f, path.extname(f)) === name && !definitions.some((d) => d.startsWith(f))) {
        definitions.push(`${f} (file)`);
      }
    }
    return JSON.stringify({ symbol: name, definitions, usages: usages.slice(0, 100) }, null, 2);
  },
};

export function registerStructureTools(): void {
  registerTool(siteStructureTool);
  registerTool(codeOutlineTool);
  registerTool(findSymbolTool);
}
