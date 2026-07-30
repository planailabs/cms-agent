/**
 * Shape of the architecture page's content. Sections are plain data so the
 * page renders them in a loop and the test suite can walk them: every diagram
 * gets fed to mermaid, every `source` path is checked to still exist.
 *
 * `intro` and `notes` are authored HTML (rendered with set:html) — this is
 * checked-in prose, never user input.
 */

export interface ArchDiagram {
  /** Shown above the diagram when a section carries more than one. */
  caption?: string;
  /** Mermaid source. */
  code: string;
}

export interface ArchSection {
  /** Anchor + table-of-contents key; must be unique across all sections. */
  id: string;
  title: string;
  /** One paragraph of HTML: what the diagram shows. */
  intro: string;
  diagrams: ArchDiagram[];
  /** The detail: guards, failure paths, recovery. HTML. */
  notes: string;
  /** Repo-relative files this section describes. Rendered as a footer, and
   *  pinned by the test — a rename that leaves this stale fails the suite. */
  source: string[];
}

export interface ArchChapter {
  title: string;
  sections: ArchSection[];
}
