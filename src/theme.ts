export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "posesplat-theme";
export const THEME_COLORS: Record<Theme, string> = {
  dark: "#121018",
  light: "#f4f1f8",
};

type ThemeEnvironment = {
  storage: Pick<Storage, "getItem" | "setItem">;
  prefersLight: () => boolean;
  document: Document;
};

export function getInitialTheme(
  storage: Pick<Storage, "getItem">,
  prefersLight: () => boolean,
): Theme {
  const saved = storage.getItem(THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;
  return prefersLight() ? "light" : "dark";
}

export function applyTheme(theme: Theme, document: Document) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
}

export function initializeTheme(
  environment: ThemeEnvironment = {
    storage: localStorage,
    prefersLight: () => matchMedia("(prefers-color-scheme: light)").matches,
    document,
  },
) {
  let current = getInitialTheme(environment.storage, environment.prefersLight);
  applyTheme(current, environment.document);
  return {
    get current() {
      return current;
    },
    toggle() {
      current = current === "dark" ? "light" : "dark";
      environment.storage.setItem(THEME_STORAGE_KEY, current);
      applyTheme(current, environment.document);
      return current;
    },
  };
}

export function themeButtonText(theme: Theme) {
  const next = theme === "dark" ? "ライト" : "ダーク";
  return {
    label: `現在は${theme === "dark" ? "ダーク" : "ライト"}テーマです。${next}テーマに切り替え`,
    title: `${next}テーマに切り替え`,
  };
}
