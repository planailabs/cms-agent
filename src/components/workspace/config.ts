/**
 * Workspace Config — BASE_DOMAIN + scheme, inlined by index.astro as
 * data attributes on the #app element (import.meta.env.PUBLIC_* is not set).
 */

export interface WorkspaceConfig {
  baseDomain: string;
  scheme: 'http' | 'https';
}

let cached: WorkspaceConfig | null = null;

export const getWorkspaceConfig = (): WorkspaceConfig => {
  if (!cached) {
    const el = typeof document !== 'undefined' ? document.getElementById('app') : null;
    const scheme = el?.dataset.scheme === 'https' ? 'https' : 'http';
    cached = {
      baseDomain: el?.dataset.baseDomain || 'localhost',
      scheme,
    };
  }
  return cached;
};

/** `http(s)://<branch>.<BASE_DOMAIN><route>` */
export const branchPreviewUrl = (branch: string, route = '/'): string => {
  const { baseDomain, scheme } = getWorkspaceConfig();
  return `${scheme}://${branch}.${baseDomain}${route}`;
};
