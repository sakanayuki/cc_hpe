import { describe, expect, it } from "vitest";
import { poseDirection, solveFrontAlignment } from "./body-viewer";
import type { PoseGuidance } from "./pose";

const points = Array.from({ length: 33 }, () => ({
  x: 0,
  y: 0,
  z: 0,
  visibility: 1,
}));
const pose = {
  landmarks: points,
  worldLandmarks: points,
  mask: new Float32Array([1]),
  maskWidth: 1,
  maskHeight: 1,
} satisfies PoseGuidance;

describe("GLB pose retargeting", () => {
  it("uses 3D world-landmark depth instead of flattened image coordinates", () => {
    pose.worldLandmarks[11] = { x: 0, y: 0, z: 0, visibility: 1 };
    pose.worldLandmarks[13] = { x: 1, y: 0, z: 1, visibility: 1 };
    const direction = poseDirection([11], [13], pose);
    expect(direction.x).toBeCloseTo(Math.SQRT1_2);
    expect(direction.z).toBeCloseTo(-Math.SQRT1_2);
  });
  it("supports midpoint landmarks for torso retargeting", () => {
    pose.worldLandmarks[23] = { x: -1, y: 1, z: 0, visibility: 1 };
    pose.worldLandmarks[24] = { x: 1, y: 1, z: 0, visibility: 1 };
    pose.worldLandmarks[11] = { x: -1, y: 0, z: 0, visibility: 1 };
    pose.worldLandmarks[12] = { x: 1, y: 0, z: 0, visibility: 1 };
    expect(poseDirection([23, 24], [11, 12], pose).y).toBeCloseTo(1);
  });
});

describe("front image/GLB projection alignment", () => {
  it("minimizes shoulder, hip, knee and ankle error relative to image diagonal", () => {
    const glb = [
      { x: -0.45, y: -0.8 },
      { x: 0.45, y: -0.8 },
      { x: -0.25, y: 0 },
      { x: 0.25, y: 0 },
      { x: -0.22, y: 0.85 },
      { x: 0.22, y: 0.85 },
      { x: -0.2, y: 1.65 },
      { x: 0.2, y: 1.65 },
    ];
    const landmarks = glb.map((p, i) => ({
      x: 225 + p.x * 180 + (i % 2 ? 1 : -1),
      y: 360 + p.y * 180 + ((i % 3) - 1),
    }));
    const fit = solveFrontAlignment(glb, landmarks, {
      width: 450,
      height: 800,
    });
    expect(fit.rmsDiagonalRatio).toBeLessThan(0.003);
    expect(fit.pixelsPerUnit).toBeCloseTo(180, 0);
  });
});
