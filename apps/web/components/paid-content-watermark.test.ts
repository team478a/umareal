import { describe, expect, it } from 'vitest';
import { paidContentWatermarkLabel } from './paid-content-watermark';

describe('paidContentWatermarkLabel', () => {
  const viewer = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    displayName: '表示してはいけない氏名',
  };

  it('uses an opaque member code without exposing the display name', () => {
    const label = paidContentWatermarkLabel(viewer);
    expect(label).toContain('446655440000');
    expect(label).not.toContain(viewer.displayName);
  });

  it('adds the viewing minute in JST', () => {
    const label = paidContentWatermarkLabel(viewer, new Date('2026-10-04T03:05:00.000Z'));
    expect(label).toContain('2026/10/04 12:05 JST');
  });
});
