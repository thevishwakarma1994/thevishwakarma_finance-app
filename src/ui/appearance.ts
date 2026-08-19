import { useEffect, useState } from "react";

export type Appearance = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "finance:appearance";
export const LIGHT_THEME_COLOR = "#f5f5f6";
export const DARK_THEME_COLOR = "#141416";

export function getStoredAppearance(): Appearance {
  try {
    const val = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (val === "light" || val === "dark" || val === "system") {
      return val;
    }
  } catch {
    // Fail-safe fallback if localStorage access is blocked/throws
  }
  return "system";
}

export function setStoredAppearance(val: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, val);
  } catch {
    // Fail-safe if localStorage write fails
  }
}

export function getSystemIsDark(): boolean {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
  } catch {
    // Fail-safe if matchMedia throws
  }
  return false;
}

export function resolveTheme(appearance: Appearance, systemIsDark: boolean): ResolvedTheme {
  if (appearance === "light") return "light";
  if (appearance === "dark") return "dark";
  return systemIsDark ? "dark" : "light";
}

export function applyThemeToDOM(theme: ResolvedTheme): void {
  try {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.setAttribute("data-theme", theme);
      document.documentElement.style.colorScheme = theme;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute("content", theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
      }
    }
  } catch {
    // Fail-safe DOM operations
  }
}

export function useAppearance() {
  const [appearance, setAppearanceState] = useState<Appearance>(getStoredAppearance);
  const [systemIsDark, setSystemIsDark] = useState<boolean>(getSystemIsDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    try {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
        setSystemIsDark(e.matches);
      };

      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", onChange);
        return () => mediaQuery.removeEventListener("change", onChange);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(onChange);
        return () => mediaQuery.removeListener(onChange);
      }
    } catch {
      // Fail-safe listener setup
    }
  }, []);

  const resolvedTheme = resolveTheme(appearance, systemIsDark);

  useEffect(() => {
    applyThemeToDOM(resolvedTheme);
  }, [resolvedTheme]);

  const setAppearance = (newVal: Appearance) => {
    setStoredAppearance(newVal);
    setAppearanceState(newVal);
  };

  return {
    appearance,
    setAppearance,
    resolvedTheme,
  };
}
