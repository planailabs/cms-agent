/**
 * ContentAdapter port (plan §12, medved §5.1/§18) — adapters teach the agent
 * what content exists in a target site repo, how to validate proposed files,
 * and what conventions to inject into the system prompt.
 *
 * Registry mirrors src/lib/agent/tools/registry.ts.
 */

/** One frontmatter field observed across a collection's entries. */
export interface CollectionField {
  name: string;
  /** Present in every entry — required by convention. */
  required: boolean;
  /** Example value (stringified) from a real entry. */
  example?: string;
}

/** One content collection (e.g. a directory under src/content/). */
export interface ContentCollection {
  name: string;
  /** Directory relative to the repo root. */
  dir: string;
  entryCount: number;
  /** Union of frontmatter keys seen across entries. */
  fields: CollectionField[];
  /** Path (relative to repo root) of one example entry. */
  exampleEntry?: string;
}

export interface ContentInventory {
  adapter: string;
  collections: ContentCollection[];
}

export interface AdapterIssue {
  severity: 'error' | 'warning';
  message: string;
  /** File the issue refers to, relative to the repo root. */
  file: string;
}

export interface ContentAdapter {
  id: string;
  /** Inventory of content the adapter understands in the repo. */
  inventory(repoRoot: string): Promise<ContentInventory>;
  /** Validate a proposed/changed file (path relative to repoRoot) against the adapter's rules. */
  validate(repoRoot: string, filePath: string): Promise<AdapterIssue[]>;
  /** Extra context for the agent's system prompt (conventions, examples). */
  buildContext(repoRoot: string): Promise<string>;
}

const registry = new Map<string, ContentAdapter>();

export function registerContentAdapter(adapter: ContentAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getContentAdapters(): ContentAdapter[] {
  return [...registry.values()];
}

