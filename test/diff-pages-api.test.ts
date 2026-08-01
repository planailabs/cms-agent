import { beforeEach, describe, expect, it, vi } from 'vitest';

const { changedFiles, findUnique, findAutomatism } = vi.hoisted(() => ({
  changedFiles: vi.fn(async () => ['src/pages/index.astro']),
  findUnique: vi.fn(),
  findAutomatism: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    chat: { findUnique },
    automatism: { findFirst: findAutomatism },
  },
}));
vi.mock('@/lib/chatAccess', () => ({ chatAccessDenied: vi.fn(async () => null) }));
vi.mock('@/lib/git/engine', () => ({ changedFiles, ensureWorktree: vi.fn() }));
vi.mock('@/lib/preview/manager', () => ({ ensureInstance: vi.fn() }));
vi.mock('@/lib/preview/routeGraph', () => ({ affectedGraphRoutes: vi.fn() }));
vi.mock('@/lib/site', () => ({
  activeBackend: () => ({ routeGraph: undefined, pageRoute: () => undefined }),
}));
vi.mock('@/lib/diff/routes', () => ({ resolveChangedPages: () => ({ pages: [], unresolved: [] }) }));
vi.mock('@/lib/diff/screenshot', () => ({ compareGeneration: () => 0 }));

import { GET } from '@/pages/api/diff/[chatId]/pages';

describe('diff pages API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the source work branch for deployment chats', async () => {
    findUnique.mockResolvedValue({
      id: 'deploy-chat',
      kind: 'deployment',
      workBranch: 'c-placeholder',
      planJson: null,
      branch: { name: 'main' },
    });
    findAutomatism.mockResolvedValue({ data: { workBranch: 'c-source' } });

    const response = await GET({
      params: { chatId: 'deploy-chat' },
      locals: { user: { id: 'admin', role: 'admin' } },
    } as never);
    const body = (await response.json()) as { branch: string };

    expect(response.status).toBe(200);
    expect(changedFiles).toHaveBeenCalledWith('c-source', 'main');
    expect(body.branch).toBe('c-source');
  });
});
