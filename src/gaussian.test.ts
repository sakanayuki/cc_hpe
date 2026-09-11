import { describe, expect, it } from "vitest";
import { GaussianSource, imageToCloud } from "./gaussian";
import { exportPly, exportSplat, exportSpz } from "./exporters";

const landmarks = Array.from({ length: 33 }, (_, i) => ({
  x: 0.25 + (i % 2) * 0.5,
  y: 0.1 + (i % 5) * 0.2,
  z: (i % 3) * 0.05,
  visibility: 1,
}));
const pixels = new Uint8ClampedArray([
  255, 255, 255, 255, 20, 40, 80, 255, 0, 0, 0, 0, 200, 100, 50, 255,
]);
const pose = (mask: Float32Array) => ({
  landmarks,
  worldLandmarks: landmarks,
  mask,
  maskWidth: 2,
  maskHeight: 2,
  rigSurface: {
    width: 2,
    height: 2,
    frontDepth: new Float32Array([0.2, 0.3, 0.21, 0.3]),
    backDepth: new Float32Array([0.7, 0.8, 0.75, 0.85]),
    mask: new Uint8Array([1, 1, 1, 1]),
    normal: new Float32Array(12),
    inverseProjectionView: new Float32Array([
      0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]),
  },
});
const cloud = imageToCloud(
  { data: pixels, width: 2, height: 2 } as ImageData,
  { maxSplats: 12, depthStrength: 1, alphaThreshold: 8 },
  pose(new Float32Array([0, 1, 0, 1])),
);

describe("pose-guided Gaussian pipeline", () => {
  it("emits one observed surface per sampled UV instead of three fixed offsets", () => {
    const observed = [...cloud.layer].filter(
      (source) => source === GaussianSource.ObservedSurface,
    );
    expect(observed).toHaveLength(2);
    expect([...cloud.position].every(Number.isFinite)).toBe(true);
  });
  it("unprojects observed points exactly from the fitted rig depth", () => {
    // Right-column source pixels use identity inverse-PV: depth .3 -> NDC z -.4.
    expect(cloud.position[2]).toBeCloseTo(-0.4);
    expect(cloud.position[5]).toBeCloseTo(-0.4);
  });
  it("places inferred rear points only on valid mesh back depth", () => {
    const withRear = imageToCloud(
      { data: pixels, width: 2, height: 2 } as ImageData,
      { maxSplats: 8, depthStrength: 1, alphaThreshold: 8 },
      pose(new Float32Array([0, 1, 0, 1])),
    );
    const rear = [...withRear.layer]
      .map((v, i) => [v, i] as const)
      .filter(([v]) => v === GaussianSource.InferredBack);
    for (const [, i] of rear)
      expect(withRear.position[i * 3 + 2]).toBeGreaterThan(
        withRear.position[2],
      );
  });
  it("never exceeds the requested splat budget", () => {
    const limited = imageToCloud(
      { data: pixels, width: 2, height: 2 } as ImageData,
      { maxSplats: 4, depthStrength: 1, alphaThreshold: 8 },
      pose(new Float32Array([1, 1, 1, 1])),
    );
    expect(limited.count).toBeLessThanOrEqual(4);
  });
  it("rejects an incomplete skeleton instead of using a cylindrical fallback", () => {
    expect(() =>
      imageToCloud(
        { data: pixels, width: 2, height: 2 } as ImageData,
        { maxSplats: 12, depthStrength: 1, alphaThreshold: 8 },
        {
          ...pose(new Float32Array([1, 1, 1, 1])),
          landmarks: landmarks.slice(0, 10),
        },
      ),
    ).toThrow("人体骨格が不完全");
  });
  it("aligns anisotropic splats to edited rig depth gradients", () => {
    const guided = imageToCloud(
      { data: pixels, width: 2, height: 2 } as ImageData,
      { maxSplats: 12, depthStrength: 1, alphaThreshold: 8 },
      {
        ...pose(new Float32Array([1, 1, 1, 1])),
      },
    );
    expect(
      [...guided.rotation].some((v, i) => i % 4 < 2 && Math.abs(v) > 0.001),
    ).toBe(true);
    expect(guided.scale[2]).toBeLessThan(guided.scale[0]);
  });
  it("writes interoperable binary exports", async () => {
    const splat = exportSplat(cloud);
    expect(splat.size).toBe(cloud.count * 32);
    const raw = new DataView(await splat.arrayBuffer());
    expect(raw.getFloat32(4, true)).toBeCloseTo(-cloud.position[1]);
    const ply = exportPly(cloud),
      text = await ply.slice(0, 700).text();
    expect(text).toContain("property float depth");
    expect(text).toContain("property float confidence");
  });
});

describe("interoperable exports", () => {
  it("writes SuperSplat fields and debug layer to PLY", async () => {
    const bytes = new Uint8Array(await exportPly(cloud).arrayBuffer());
    const header = new TextDecoder().decode(bytes.subarray(0, 600));
    expect(header).toContain("property float f_dc_0");
    expect(header).toContain("property float source_layer");
    expect(exportSplat(cloud).size).toBe(cloud.count * 32);
  });
  it("writes a gzip-compressed SPZ stream", async () => {
    const bytes = new Uint8Array(await (await exportSpz(cloud)).arrayBuffer());
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x1f, 0x8b]);
  });
});
