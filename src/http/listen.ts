/**
 * Bind address for the Node HTTP server.
 * Production (Render) must accept traffic on all interfaces.
 * Local/dev stays on loopback so the Vite proxy target is unchanged.
 */
export function serverBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
}

export function isSpaFallbackPath(pathname: string): boolean {
  return pathname !== "/health" && !pathname.startsWith("/api");
}
