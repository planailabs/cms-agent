/**
 * Preview device presets — the curated keys must all resolve against the
 * playwright registry with complete descriptors (a playwright upgrade that
 * renames a device should fail here, not blank the workspace selector).
 */
import { describe, expect, it } from 'vitest';
import { getPreviewDevice, previewDeviceList } from '@/lib/preview/devices';

describe('preview device presets', () => {
  it('resolves every curated key with a complete descriptor', async () => {
    const list = await previewDeviceList();
    expect(list.length).toBeGreaterThanOrEqual(10);
    for (const d of list) {
      expect(d.key).toBeTruthy();
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
      expect(d.deviceScaleFactor).toBeGreaterThan(0);
      expect(d.userAgent).toMatch(/Mozilla/);
    }
    expect(list.some((d) => d.isMobile)).toBe(true);
    expect(list.some((d) => !d.isMobile)).toBe(true);
  });

  it('getPreviewDevice returns the descriptor or null', async () => {
    const iphone = await getPreviewDevice('iPhone 15');
    expect(iphone?.userAgent).toContain('iPhone');
    expect(iphone?.isMobile).toBe(true);
    expect(await getPreviewDevice('Nokia 3310')).toBeNull();
    expect(await getPreviewDevice(null)).toBeNull();
    expect(await getPreviewDevice('')).toBeNull();
  });
});
