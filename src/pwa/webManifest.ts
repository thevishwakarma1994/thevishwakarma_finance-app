export const webAppManifest = {
  name: "Finance",
  short_name: "Finance",
  display: "standalone" as const,
  start_url: "/",
  scope: "/",
  id: "/",
  background_color: "#f6f4f0",
  theme_color: "#1c1917",
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    {
      src: "icons/icon-maskable-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "icons/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};
