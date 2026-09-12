import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

const mobileViewerHeight = (viewportHeight: number, landscape: boolean) => {
  const preferred = viewportHeight * (landscape ? 0.38 : 0.42);
  return landscape
    ? Math.min(210, Math.max(120, viewportHeight * 0.34))
    : Math.min(360, Math.max(210, preferred));
};

describe("STEP 1 responsive layout", () => {
  it("uses one relocatable editor DOM and collapsible workflow sections", () => {
    expect(main).toContain('id="jointR${axis}"');
    expect(main).toContain('id="jointT${axis}"');
    expect(main).toContain('["X", "Y", "Z"].map');
    for (const section of [
      "photo-section",
      "body-section",
      "joint-editor",
      "step-two",
    ]) {
      expect(main).toContain(`<details class="control-section ${section}`);
    }
  });

  it("keeps the preview sticky above the editor at mobile widths", () => {
    expect(css).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.viewer-card \{[\s\S]*?order: -1;[\s\S]*?position: sticky;/,
    );
    expect(css).toContain("height: clamp(210px, 42dvh, 360px)");
    expect(css).toContain("height: clamp(120px, 34dvh, 210px)");
  });

  it.each([
    [320, 568],
    [375, 667],
    [390, 844],
    [430, 932],
  ])(
    "fits preview and active slider at %ipx in portrait and landscape",
    (deviceWidth, deviceHeight) => {
      for (const [width, height, landscape] of [
        [deviceWidth, deviceHeight, false],
        [deviceWidth, Math.round(deviceWidth * 0.7), true],
      ] as const) {
        const viewer = mobileViewerHeight(height, landscape);
        const toolbar = 52;
        const footer = landscape ? 0 : 34;
        const activeSliderRow = 44;
        expect(width).toBeLessThanOrEqual(430);
        expect(viewer + toolbar + footer + activeSliderRow).toBeLessThanOrEqual(
          height,
        );
      }
    },
  );
});
