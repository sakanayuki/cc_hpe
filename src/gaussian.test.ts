import { describe, expect, it } from 'vitest';
import { imageToCloud } from './gaussian';
import { exportPly, exportSplat } from './exporters';

describe('Gaussian pipeline', () => {
  const pixels = new Uint8ClampedArray([
    255, 255, 255, 255, 20, 40, 80, 255,
    0, 0, 0, 0, 200, 100, 50, 255,
  ]);
  const cloud = imageToCloud({ data: pixels, width: 2, height: 2 } as ImageData, { maxSplats: 8, depthStrength: 1, alphaThreshold: 8 });

  it('excludes transparent and white background pixels', () => {
    expect(cloud.count).toBe(2);
    expect([...cloud.position].every(Number.isFinite)).toBe(true);
  });

  it('writes a 32-byte splat record', () => {
    expect(exportSplat(cloud).size).toBe(cloud.count * 32);
  });

  it('writes binary PLY with custom debug fields', async () => {
    const ply = exportPly(cloud);
    const text = await ply.slice(0, 700).text();
    expect(text).toContain('format binary_little_endian 1.0');
    expect(text).toContain('property float depth');
    expect(text).toContain('property float confidence');
    const headerLength = text.indexOf('end_header\n') + 'end_header\n'.length;
    expect(ply.size).toBe(headerLength + cloud.count * 56);
  });
});
