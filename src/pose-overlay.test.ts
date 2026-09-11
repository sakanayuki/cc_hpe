import { describe, expect, it } from "vitest";
import { getContainRect, mapLandmarkToContain } from "./pose-overlay";

const display = { width: 300, height: 500 };

describe.each([
  ["landscape", { width: 1600, height: 900 }],
  ["square", { width: 1000, height: 1000 }],
  ["9:16 portrait", { width: 900, height: 1600 }],
  ["extreme portrait", { width: 200, height: 2000 }],
])("contain coordinate conversion: %s", (_label, source) => {
  it("places image-edge landmarks on the same displayed image edges", () => {
    const rect = getContainRect(source, display);
    expect(mapLandmarkToContain({ x: 0, y: 0 }, rect)).toEqual({
      x: rect.x,
      y: rect.y,
    });
    expect(mapLandmarkToContain({ x: 1, y: 1 }, rect)).toEqual({
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    });
    expect(rect.width / rect.height).toBeCloseTo(source.width / source.height);
    expect(rect.width).toBeLessThanOrEqual(display.width);
    expect(rect.height).toBeLessThanOrEqual(display.height);
  });
});
