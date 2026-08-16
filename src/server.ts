import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { openDatabase } from "./db/client.js";
import { applyMigrations } from "./db/migrate.js";
import { createApp } from "./api/app.js";
import { assertProductionPasswordConfig } from "./api/auth/password.js";

assertProductionPasswordConfig();

const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.DATABASE_PATH ?? "data/app.sqlite";
const production = process.env.NODE_ENV === "production";

const handles = openDatabase(databasePath);
applyMigrations(handles);

const app = createApp(handles);

if (production) {
  const dist = "dist";
  app.use("/*", async (c, next) => {
    if (c.req.path.startsWith("/api")) {
      await next();
      return;
    }
    await next();
  });
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", async (c, next) => {
    if (c.req.path.startsWith("/api")) {
      await next();
      return;
    }
    const index = path.join(dist, "index.html");
    return c.html(fs.readFileSync(index, "utf8"));
  });
}

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`API listening on http://127.0.0.1:${info.port}`);
});
