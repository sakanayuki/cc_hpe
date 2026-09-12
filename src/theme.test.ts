import { describe, expect, it, vi } from "vitest";
import {
  getInitialTheme,
  initializeTheme,
  THEME_COLORS,
  THEME_STORAGE_KEY,
} from "./theme";

const page = () => {
  const meta = { setAttribute: vi.fn(), getAttribute: vi.fn() };
  const document = {
    documentElement: { dataset: {}, style: {} },
    querySelector: vi.fn(() => meta),
  } as unknown as Document;
  return { document, meta };
};

describe("theme", () => {
  it("prefers a saved setting over the operating-system preference", () => {
    expect(getInitialTheme({ getItem: () => "dark" }, () => true)).toBe("dark");
    expect(getInitialTheme({ getItem: () => "light" }, () => false)).toBe(
      "light",
    );
  });

  it("uses prefers-color-scheme when no valid setting exists", () => {
    expect(getInitialTheme({ getItem: () => null }, () => true)).toBe("light");
    expect(getInitialTheme({ getItem: () => "invalid" }, () => false)).toBe(
      "dark",
    );
  });

  it("toggles, persists, and synchronizes the document and theme-color", () => {
    const { document, meta } = page();
    const storage = { getItem: vi.fn(() => "dark"), setItem: vi.fn() };
    const theme = initializeTheme({
      storage,
      prefersLight: () => true,
      document,
    });

    expect(theme.toggle()).toBe("light");
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.setAttribute).toHaveBeenCalledWith(
      "content",
      THEME_COLORS.light,
    );
  });
});
