import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { DbHandles } from "../db/client.js";
import { authRoutes } from "./auth/routes.js";
import { requireFirebaseAuth, requireOrigin, type VerifyIdToken } from "./auth/guard.js";
import { verifyFirebaseIdToken } from "./auth/firebaseAdmin.js";
import { commandRoutes } from "./routes/commands.js";
import { readRoutes } from "./routes/reads.js";
import {
  createPerfMarks,
  logPerf,
  perfEnabledFromEnv,
  perfEnabledFromHeader,
  runWithPerf,
  serverTimingValue,
} from "../perf/timing.js";

export type AppEnv = {
  Variables: {
    handles: DbHandles;
    workspaceId: string;
    userId: string;
    verifyIdToken: VerifyIdToken;
  };
};

export function createApp(
  handles: DbHandles,
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
  app.use("*", async (c, next) => {
    const enabled =
      perfEnabledFromEnv() || perfEnabledFromHeader(c.req.header("x-perf-timing") ?? undefined);
    if (!enabled) {
      await next();
      return;
    }
    const marks = createPerfMarks(c.req.path);
    const started = performance.now();
    await runWithPerf(marks, async () => {
      await next();
    });
    marks.totalMs = performance.now() - started;
    c.header("Server-Timing", serverTimingValue(marks));
    c.header("X-Request-Id", marks.requestId);
    c.header(
      "X-Perf-Summary",
      [
        `auth=${Math.round(marks.authMs)}`,
        `prov=${Math.round(marks.provisionMs)}`,
        `obl=${Math.round(marks.obligationsMs)}`,
        `snap=${Math.round(marks.snapshotMs)}`,
        `calls=${marks.snapshotCalls}`,
        `q=${marks.dbQueryCount}`,
        `eng=${Math.round(marks.engineMs)}`,
        `total=${Math.round(marks.totalMs)}`,
      ].join(";"),
    );
    logPerf(marks);
  });
  app.get("/health", (c) => c.json({ ok: true }));
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
