import { describe, expect, it } from 'vitest';
import { crawlWeb, mapWeb, scrapeWeb, searchWeb } from '@/lib/firecrawl/web';

describe.skipIf(process.env.RUN_NETWORK_TESTS !== '1')('Firecrawl browser web operations', () => {
  it('renders, cleans, and searches the public web with the shipped browser', async () => {
    const page = await scrapeWeb('https://example.com/', { timeout: 30_000 });
    expect(page.url).toMatch(/^https:\/\/example\.com/);
    expect(page.html).toContain('Example Domain');
    expect(page.links?.length).toBeGreaterThan(0);

    const results = await searchWeb({ query: 'Example Domain IANA', limit: 3, timeout: 30_000 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({ url: expect.stringMatching(/^https?:\/\//) });

    expect(await mapWeb('https://example.com/', { limit: 2, maxDiscoveryDepth: 1 })).toContain('https://example.com/');
    const documents = await crawlWeb('https://example.com/', { limit: 2, maxDiscoveryDepth: 1 });
    expect(documents[0]?.html).toContain('Example Domain');
  }, 90_000);
});
