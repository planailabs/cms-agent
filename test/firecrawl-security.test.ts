import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from '@/lib/firecrawl/fetch';

describe('web fetch network boundary', () => {
  it('rejects local, private, credentialed, and non-HTTP targets', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('http://10.0.0.1/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl('https://user:pass@example.com/')).rejects.toThrow(/without credentials/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/HTTP/);
  });
});
