import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { SqliteHandles } from "../db/client.js";
import { authRoutes } from "./auth/routes.js";
import { requireOrigin, requireSession } from "./auth/guard.js";
import { commandRoutes } from "./routes/commands.js";
import { readRoutes } from "./routes/reads.js";

export type AppEnv = {
  Variables: {
    handles: SqliteHandles;
    workspaceId: string;
  };
};

export function createApp(handles: SqliteHandles) {
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    c.set("handles", handles);
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "payload_too_large", message: "Request is too large" }, 413),
    }),
  );
  app.use("/api/*", requireOrigin);
  app.use("/api/*", requireSession);
  app.route("/api", authRoutes);
  app.route("/api", readRoutes);
  app.route("/api", commandRoutes);

  return app;
}
