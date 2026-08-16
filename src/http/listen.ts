/**
 * Bind address for the Node HTTP server.
 * Production (Render) must accept traffic on all interfaces.
 * Local/dev stays on loopback so the Vite proxy target is unchanged.
 */
export function serverBindHostname(env: NodeJS.ProcessEnv = process.env): string {
  return env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
}

export function isSpaFallbackPath(pathname: string): boolean {
  if (pathname === "/health" || pathname.startsWith("/api")) {
    return false;
  }
  if (
    pathname === "/sw.js" ||
    pathname === "/registerSW.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname.startsWith("/workbox-")
  ) {
    return false;
  }
  if (/\.(?:webmanifest|js|css|png|svg|ico|map|txt|woff2?)$/i.test(pathname)) {
    return false;
  }
  return true;
}
