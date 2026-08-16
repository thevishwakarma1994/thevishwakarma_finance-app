import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { webAppManifest } from "../../src/pwa/webManifest.js";

const iconsDir = path.join(process.cwd(), "public", "icons");

function pngSize(filePath: string): { width: number; height: number } {
  const buffer = fs.readFileSync(filePath);
  expect(buffer.subarray(0, 8).toString("binary")).toBe("\x89PNG\r\n\x1a\n");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe("PWA installability config", () => {
  it("uses standalone display with root start_url and scope", () => {
    expect(webAppManifest.display).toBe("standalone");
    expect(webAppManifest.start_url).toBe("/");
    expect(webAppManifest.scope).toBe("/");
    expect(webAppManifest.name).toBe("Finance");
    expect(webAppManifest.short_name).toBe("Finance");
  });

  it("declares 192 and 512 PNG icons including maskable", () => {
    const any192 = webAppManifest.icons.find((icon) => icon.sizes === "192x192" && icon.purpose === "any");
    const any512 = webAppManifest.icons.find((icon) => icon.sizes === "512x512" && icon.purpose === "any");
    const mask192 = webAppManifest.icons.find(
      (icon) => icon.sizes === "192x192" && icon.purpose === "maskable",
    );
    const mask512 = webAppManifest.icons.find(
      (icon) => icon.sizes === "512x512" && icon.purpose === "maskable",
    );
    expect(any192?.src).toBe("icons/icon-192.png");
    expect(any512?.src).toBe("icons/icon-512.png");
    expect(mask192?.src).toBe("icons/icon-maskable-192.png");
    expect(mask512?.src).toBe("icons/icon-maskable-512.png");
    expect(mask512?.type).toBe("image/png");
  });

  it("ships valid PNG files at the declared sizes", () => {
    expect(pngSize(path.join(iconsDir, "icon-192.png"))).toEqual({ width: 192, height: 192 });
    expect(pngSize(path.join(iconsDir, "icon-512.png"))).toEqual({ width: 512, height: 512 });
    expect(pngSize(path.join(iconsDir, "icon-maskable-192.png"))).toEqual({ width: 192, height: 192 });
    expect(pngSize(path.join(iconsDir, "icon-maskable-512.png"))).toEqual({ width: 512, height: 512 });
    expect(pngSize(path.join(iconsDir, "apple-touch-icon.png"))).toEqual({ width: 180, height: 180 });
  });
});
