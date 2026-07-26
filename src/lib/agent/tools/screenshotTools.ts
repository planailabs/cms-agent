/**
 * screenshot_page — full-page PNG of a route of the chat branch's live
 * preview, into the .scratch/ area (promote with move_file during EXECUTE).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { captureRoute } from '@/lib/diff/screenshot';
import { isScratchPath, jail } from './fsTools';
import { registerTool, type ToolDef } from './registry';

const screenshotPageTool: ToolDef = {
  name: 'screenshot_page',
  description:
    "Screenshot a route of this chat branch's live preview as a full-page PNG under .scratch/. The first call may take a while — the preview server boots on demand. Promote a shot into the site with move_file during EXECUTE.",
  schema: z.object({
    route: z.string().describe('Route to capture, e.g. "/" or "/blog/post-1"'),
    browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    mobile: z
      .boolean()
      .default(false)
      .describe('390x844 mobile viewport instead of 1280x900 desktop'),
    outputPath: z
      .string()
      .optional()
      .describe('PNG destination — must be under .scratch/ (default .scratch/screenshots/<route>.png)'),
  }),
  phases: ['plan', 'execute', 'preview', 'published'],
  async execute(input, ctx) {
    const slug = input.route.replace(/^\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'index';
    const out = input.outputPath ?? `.scratch/screenshots/${slug}${input.mobile ? '-mobile' : ''}.png`;
    if (!isScratchPath(out)) {
      throw new Error(
        'screenshot_page output must be under .scratch/ — use move_file during EXECUTE to place it in the site',
      );
    }
    const abs = jail(ctx, out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const { status } = await captureRoute(ctx.branchName, input.route, abs, {
      browser: input.browser,
      mobile: input.mobile,
    });
    if (status !== null && status >= 400) {
      fs.rmSync(abs, { force: true });
      return JSON.stringify({
        error: `Route ${input.route} returned HTTP ${status} — does the page exist?`,
      });
    }
    return JSON.stringify({ success: true, path: out, status, bytes: fs.statSync(abs).size });
  },
};

export function registerScreenshotTools(): void {
  registerTool(screenshotPageTool);
}
