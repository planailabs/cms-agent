/**
 * Cross-scenario journey state — 03-e2e runs ONE full plan→publish journey
 * and records its ids here (a file, because scenario files run in separate
 * vitest workers); 04/05 reuse the data instead of burning more agent turns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { benchRun } from './env';

export interface JourneyData {
  chatId: string;
  branchId: string;
  workBranch: string;
  previewSha: string;
  publicationId: string;
  deployChatId: string;
  /** Journey B: executed but unpublished — rests in the PREVIEW phase
   *  (05 drives the diff-viewer UI on it). */
  chatB?: string;
}

const file = (): string => path.join(benchRun().work, 'journey.json');

export const saveJourney = (j: JourneyData): void =>
  fs.writeFileSync(file(), JSON.stringify(j, null, 2));

/** Null when the e2e group hasn't run in this bench run. */
export const loadJourney = (): JourneyData | null =>
  fs.existsSync(file()) ? (JSON.parse(fs.readFileSync(file(), 'utf8')) as JourneyData) : null;
