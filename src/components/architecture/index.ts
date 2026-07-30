/**
 * Architecture page content. Public page — everything here is checked-in
 * prose about the design, never runtime state: no version or commit, no
 * environment values, nothing that describes one particular deployment.
 * test/architecture-page.test.ts pins that, and renders every diagram.
 */
import { topologySections } from './topology';
import { machineSections } from './machines';
import { runtimeSections } from './runtime';
import { dataSections } from './data';
import type { ArchChapter, ArchSection } from './types';

export type { ArchChapter, ArchDiagram, ArchSection } from './types';

export const CHAPTERS: ArchChapter[] = [
  { title: 'The shape of it', sections: topologySections },
  { title: 'State machines', sections: machineSections },
  { title: 'Runtime', sections: runtimeSections },
  { title: 'Data and extension points', sections: dataSections },
];

export const SECTIONS: ArchSection[] = CHAPTERS.flatMap((c) => c.sections);
