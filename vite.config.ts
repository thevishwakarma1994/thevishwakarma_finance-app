import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";
import { webAppManifest } from "./src/pwa/webManifest.js";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/*.png"],
      manifest: webAppManifest,
      workbox: {
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/health$/],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
    }),
  ],
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
