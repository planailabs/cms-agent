import fs from 'node:fs';
import path from 'node:path';

const CONFIG_NAME = 'cms-preview.config.mjs';
const GRAPH_NAME = 'cms-route-graph.json';
export const ASTRO_CONFIGS = [
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.mts',
  'astro.config.cjs',
  'astro.config.cts',
];

export interface PreviewRouteGraph {
  routes: Array<{ route: string; entrypoint: string; sources: string[] }>;
}

const integrationSource = (originalConfig: string | undefined): string => `
import fs from 'node:fs';
import path from 'node:path';
${originalConfig ? `import originalConfig from ${JSON.stringify(`../${originalConfig}`)};` : ''}

const root = '/work';
const graphFile = '/work/.astro/${GRAPH_NAME}';
let resolvedRoutes = [];
let server;
let timer;

const relativeSource = (value) => {
  const clean = String(value || '').split('?')[0].replaceAll('\\\\', '/');
  if (clean.startsWith(root + '/')) return clean.slice(root.length + 1);
  if (clean.startsWith('/src/')) return clean.slice(1);
  return null;
};

const collectSources = (start, entrypoint) => {
  const sources = new Set([entrypoint]);
  const seen = new Set();
  const pending = [...start];
  while (pending.length) {
    const mod = pending.pop();
    if (!mod || seen.has(mod)) continue;
    seen.add(mod);
    const source = relativeSource(mod.file || mod.id);
    if (source && !source.includes('/node_modules/')) sources.add(source);
    pending.push(...mod.importedModules);
  }
  return [...sources].sort();
};

const refresh = async () => {
  if (!server) return;
  const dependencies = new Map();
  for (const route of resolvedRoutes) {
    if (!route.pathname || dependencies.has(route.entrypoint)) continue;
    const url = '/' + route.entrypoint.replace(/^\\/+/, '');
    try { await server.ssrLoadModule(url); } catch {}
    const modules = server.moduleGraph.getModulesByFile(path.resolve(root, route.entrypoint));
    let start = modules ? [...modules] : [];
    if (!start.length) {
      const module = await server.moduleGraph.getModuleByUrl(url);
      if (module) start = [module];
    }
    dependencies.set(route.entrypoint, collectSources(start, route.entrypoint));
  }

  const graph = {
    routes: resolvedRoutes
      .filter((route) => route.pathname)
      .map((route) => ({
        route: route.pathname,
        entrypoint: route.entrypoint,
        sources: dependencies.get(route.entrypoint) || [route.entrypoint],
      })),
  };
  const tmp = graphFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(graph));
  fs.renameSync(tmp, graphFile);
};

const schedule = (changed) => {
  if (String(changed || '').includes('/.astro/')) return;
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), 50);
};

const cmsRouteGraph = {
  name: 'cms-agent-route-graph',
  hooks: {
    'astro:routes:resolved': ({ routes }) => {
      resolvedRoutes = routes.filter((route) => route.origin === 'project');
    },
    'astro:server:setup': ({ server: viteServer }) => {
      server = viteServer;
      server.watcher.on('add', schedule);
      server.watcher.on('change', schedule);
      server.watcher.on('unlink', schedule);
    },
    'astro:server:start': refresh,
  },
};

const base = ${originalConfig ? 'await originalConfig' : '{}'};
export default {
  ...base,
  integrations: [...(base.integrations || []), cmsRouteGraph],
};
`;

export function prepareRouteGraphConfig(worktree: string): string {
  const runtimeDir = path.join(worktree, '.astro');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const originalConfig = ASTRO_CONFIGS.find((name) => fs.existsSync(path.join(worktree, name)));
  const configPath = path.join(runtimeDir, CONFIG_NAME);
  fs.writeFileSync(configPath, integrationSource(originalConfig));
  return path.posix.join('.astro', CONFIG_NAME);
}

export function readRouteGraph(worktree: string): PreviewRouteGraph | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(worktree, '.astro', GRAPH_NAME), 'utf8'));
    if (!Array.isArray(parsed?.routes)) return null;
    return parsed as PreviewRouteGraph;
  } catch {
    return null;
  }
}

export function affectedGraphRoutes(
  changedFiles: string[],
  graphs: Array<PreviewRouteGraph | null>,
): Array<{ route: string; file: string }> {
  const changed = new Set(changedFiles);
  const pages = new Map<string, { route: string; file: string }>();
  for (const graph of graphs) {
    for (const route of graph?.routes ?? []) {
      const file = route.sources.find((source) => changed.has(source));
      if (!file) continue;
      const normalized = route.route === '/' ? '/' : `/${route.route.replace(/^\/+|\/+$/g, '')}/`;
      if (!pages.has(normalized)) pages.set(normalized, { route: normalized, file });
    }
  }
  return [...pages.values()];
}
