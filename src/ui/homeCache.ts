import type { HomeView } from "./apiClient.js";

/**
 * In-memory Home payload for same-session STS Explain / Can I Spend reuse.
 * Not a financial source of truth — affordability simulation stays server-side.
 */
let cachedHome: HomeView | null = null;

export function cacheHomeView(view: HomeView): void {
  cachedHome = view;
}

export function getCachedHomeView(): HomeView | null {
  return cachedHome;
}

export function clearCachedHomeView(): void {
  cachedHome = null;
}
