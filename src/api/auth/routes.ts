import { Hono } from "hono";
import type { SqliteHandles } from "../../db/client.js";

type Env = {
  Variables: { handles: SqliteHandles; workspaceId: string; userId: string };
};

export const authRoutes = new Hono<Env>();

authRoutes.get("/me", (c) => {
  return c.json({
    authenticated: true,
    userId: c.get("userId"),
    workspaceId: c.get("workspaceId"),
  });
});
