import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { SqliteHandles } from "../db/client.js";
import { authRoutes } from "./auth/routes.js";
import { requireFirebaseAuth, requireOrigin, type VerifyIdToken } from "./auth/guard.js";
import { verifyFirebaseIdToken } from "./auth/firebaseAdmin.js";
import { commandRoutes } from "./routes/commands.js";
import { readRoutes } from "./routes/reads.js";

export type AppEnv = {
  Variables: {
    handles: SqliteHandles;
    workspaceId: string;
    userId: string;
    verifyIdToken: VerifyIdToken;
  };
};

export function createApp(
  handles: SqliteHandles,
  options: { verifyIdToken?: VerifyIdToken } = {},
) {
  const app = new Hono<AppEnv>();
  const verifyIdToken = options.verifyIdToken ?? verifyFirebaseIdToken;

  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    c.set("handles", handles);
    c.set("verifyIdToken", verifyIdToken);
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
  app.use("/api/*", requireFirebaseAuth);
  app.route("/api", authRoutes);
  app.route("/api", readRoutes);
  app.route("/api", commandRoutes);

  return app;
}
