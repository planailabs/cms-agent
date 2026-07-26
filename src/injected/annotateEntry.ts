/**
 * Screenshot-replay entry — bundled as an IIFE with globalName __cmsAnnotate
 * (src/lib/injected/bundle.ts) and evaluated by Playwright in a fresh preview
 * page (captureAnnotatedRoute) to re-apply the user's element-edit annotations
 * before the handoff screenshot.
 */
import { applyAnnotations, type EditAnnotations } from './annotate';

export const apply = (annotations: EditAnnotations): void =>
  applyAnnotations(document, annotations);
