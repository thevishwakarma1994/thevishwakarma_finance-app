/**
 * Bind address for the Node HTTP server.
 * Production (Render) must accept traffic on all interfaces.
 * Local/dev stays on loopback so the Vite proxy target is unchanged.
 */
export function serverBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
}

/** API and health are Hono routes, not files and not the SPA shell. */
export function isApiOrHealthPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/api");
}

/**
 * Frontend routes without a file extension may use index.html.
 * Manifest, service worker, icons, and hashed assets must 404 if missing
 * rather than returning the SPA shell.
 */
export function isSpaFallbackPath(pathname: string): boolean {
  if (isApiOrHealthPath(pathname)) {
    return false;
  }
  if (pathname.includes(".")) {
    return false;
  }
  return true;
}

