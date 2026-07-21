import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { DIFF_SCROLL_SYNC_CODE } from "@/components/workspace/diffScroll";

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";

let browser: Browser;

beforeAll(async () => {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ chromiumSandbox: false });
});

afterAll(async () => browser?.close());

describe("side-by-side scroll bridge", () => {
  it("overrides site smooth scrolling and applies relayed positions instantly", async () => {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    try {
      await page.setContent(`
        <style>html.site-scroll { scroll-behavior: smooth !important; }</style>
        <script>document.documentElement.className = "site-scroll";</script>
        <main style="height: 5000px">Tall page</main>
      `);

      const result = await page.evaluate((code) => {
        const handlers = new Map<string, (data: unknown) => void>();
        const agent = {
          post: () => undefined,
          on: (type: string, handler: (data: unknown) => void) => {
            handlers.set(type, handler);
          },
        };
        new Function("agent", code)(agent);
        document.documentElement.style.setProperty(
          "scroll-behavior",
          "smooth",
          "important",
        );
        handlers.get("cms:scroll-to")?.({ top: 1800 });
        return {
          behavior: getComputedStyle(document.documentElement).scrollBehavior,
          top: document.scrollingElement?.scrollTop,
        };
      }, DIFF_SCROLL_SYNC_CODE);

      expect(result).toEqual({ behavior: "auto", top: 1800 });
    } finally {
      await page.close();
    }
  });
});
