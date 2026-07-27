import { describe, expect, it } from 'vitest';
import { closeTopLayer, registerLayer } from '@/components/chat/app/layers';

describe('layer stack', () => {
  it('closes the topmost open layer first, one per call', () => {
    const closed: string[] = [];
    let lowOpen = true;
    let highOpen = true;
    registerLayer({
      id: 'test-low',
      priority: 1,
      isOpen: () => lowOpen,
      close: () => {
        lowOpen = false;
        closed.push('low');
      },
    });
    registerLayer({
      id: 'test-high',
      priority: 9,
      isOpen: () => highOpen,
      close: () => {
        highOpen = false;
        closed.push('high');
      },
    });

    expect(closeTopLayer()).toBe(true);
    expect(closed).toEqual(['high']);
    expect(closeTopLayer()).toBe(true);
    expect(closed).toEqual(['high', 'low']);
    expect(closeTopLayer()).toBe(false);
  });
});
