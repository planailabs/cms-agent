/**
 * The prose guides under /architecture/<slug>, rendered by Astro from the
 * markdown in src/pages/architecture/. Listed here so the shared navigation
 * and the test suite both derive from one place — a guide added without an
 * entry here is a page nothing links to.
 */
export interface ArchGuide {
  /** File name without .md, and the URL segment. */
  slug: string;
  title: string;
  /** One line for the navigation and the index. */
  blurb: string;
}

export const GUIDES: ArchGuide[] = [
  {
    slug: 'phases',
    title: 'Workflow phases and approvals',
    blurb: 'What each phase allows, and how a plan becomes an approval.',
  },
  {
    slug: 'setup',
    title: 'Setup',
    blurb: 'Prerequisites, every environment variable, DNS, first admin.',
  },
  {
    slug: 'walkthrough',
    title: 'End-to-end walkthrough',
    blurb: 'Plan, execute, review the diff, publish — against an example site.',
  },
  {
    slug: 'runbooks',
    title: 'Runbooks and operations',
    blurb: 'When something breaks: previews, publishes, restores, backups.',
  },
  {
    slug: 'nixos',
    title: 'NixOS deployment',
    blurb: 'The flake outputs and the module options.',
  },
];
