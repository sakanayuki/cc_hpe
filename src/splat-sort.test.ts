import { describe, expect, it } from "vitest";
import { depthSortIndices, reorder } from "./splat-sort";

describe("Gaussian depth sorting", () => {
  it("sorts far-to-near for source-over blending", () => {
    const positions = new Float32Array([0, 0, 1, 0, 0, -2, 0, 0, 4]);
    expect([
      ...depthSortIndices(positions, [0, 0, 10], [0, 0, -1], 32),
    ]).toEqual([1, 0, 2]);
  });
  it("reorders every component of an instance without mutating the source", () => {
    const source = new Uint8Array([10, 11, 20, 21, 30, 31]);
    expect([...reorder(source, 2, new Uint32Array([2, 0, 1]))]).toEqual([
      30, 31, 10, 11, 20, 21,
    ]);
    expect([...source]).toEqual([10, 11, 20, 21, 30, 31]);
  });
});
