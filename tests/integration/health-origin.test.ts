import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { originAllowed } from "../../src/api/auth/guard.js";
import { openMemoryDatabase } from "../../src/db/client.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { isSpaFallbackPath, serverBindHostname } from "../../src/http/listen.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  APP_ORIGIN: process.env.APP_ORIGIN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("production HTTP bind and SPA fallback", () => {
  it("binds all interfaces in production and loopback otherwise", () => {
    expect(serverBindHostname({ NODE_ENV: "production" })).toBe("0.0.0.0");
    expect(serverBindHostname({ NODE_ENV: "development" })).toBe("127.0.0.1");
  });

  it("does not serve SPA HTML for API, health, or PWA static assets", () => {
    expect(isSpaFallbackPath("/")).toBe(true);
    expect(isSpaFallbackPath("/activity")).toBe(true);
    expect(isSpaFallbackPath("/people")).toBe(true);
    expect(isSpaFallbackPath("/money")).toBe(true);
    expect(isSpaFallbackPath("/coming-up")).toBe(true);
    expect(isSpaFallbackPath("/health")).toBe(false);
    expect(isSpaFallbackPath("/api/me")).toBe(false);
    expect(isSpaFallbackPath("/manifest.webmanifest")).toBe(false);
    expect(isSpaFallbackPath("/sw.js")).toBe(false);
    expect(isSpaFallbackPath("/registerSW.js")).toBe(false);
    expect(isSpaFallbackPath("/icons/icon-192.png")).toBe(false);
    expect(isSpaFallbackPath("/icons/icon-512.png")).toBe(false);
    expect(isSpaFallbackPath("/assets/index.js")).toBe(false);
  });
});

describe("write origin validation", () => {
  it("allows the Render same-origin Host in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_ORIGIN;
    expect(originAllowed("https://finance.onrender.com", "finance.onrender.com")).toBe(true);
    expect(originAllowed("https://evil.example", "finance.onrender.com")).toBe(false);
  });

  it("allows APP_ORIGIN when set", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://finance.onrender.com";
    expect(originAllowed("https://finance.onrender.com", "other.host")).toBe(true);
    expect(originAllowed("https://other.example", "other.host")).toBe(false);
  });

  it("keeps localhost writes working in development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.APP_ORIGIN;
    expect(originAllowed("http://localhost:5173", "127.0.0.1:3000")).toBe(true);
    expect(originAllowed(undefined, "127.0.0.1:3000")).toBe(true);
  });

  it("rejects missing Origin on production writes", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_ORIGIN;
    expect(originAllowed(undefined, "finance.onrender.com")).toBe(false);
  });
});

describe("health endpoint", () => {
  it("is unauthenticated and does not expose secrets", async () => {
    const handles = openMemoryDatabase();
    await applyMigrations(handles);
    const app = createApp(handles, {
      verifyIdToken: async () => {
        throw new Error("unused");
      },
    });
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain("postgres://");
    expect(JSON.stringify(body)).not.toContain("BEGIN PRIVATE KEY");
    handles.sqlite.close();
  });
});
