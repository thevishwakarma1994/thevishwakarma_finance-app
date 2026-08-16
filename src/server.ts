import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { closeDatabase, openConfiguredDatabase } from "./db/client.js";
import { applyMigrations } from "./db/migrate.js";
import { describeDatabaseConfig, resolveDatabaseConfig } from "./db/env.js";
import { createApp } from "./api/app.js";
import { assertFirebaseAdminConfig } from "./api/auth/firebaseAdmin.js";

assertFirebaseAdminConfig();

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === "production";
const databaseConfig = resolveDatabaseConfig();
console.log(describeDatabaseConfig(databaseConfig));

const handles = await openConfiguredDatabase(databaseConfig);
await applyMigrations(handles);

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

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`API listening on http://127.0.0.1:${info.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await closeDatabase(handles);
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
