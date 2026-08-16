import { Hono } from "hono";
import {
  currentMonthSpend,
  listAccounts,
  listActivity,
  listCategories,
} from "../../db/reads.js";
import type { SqliteHandles } from "../../db/client.js";
import { mapError } from "../auth/guard.js";

type Env = {
  Variables: {
    handles: SqliteHandles;
    workspaceId: string;
  };
};

export const readRoutes = new Hono<Env>();

readRoutes.get("/accounts", (c) => {
  try {
    return c.json({ accounts: listAccounts(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/categories", (c) => {
  try {
    return c.json({ categories: listCategories(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/activity", (c) => {
  try {
    return c.json({ events: listActivity(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/month", (c) => {
  try {
    return c.json(currentMonthSpend(c.get("handles"), c.get("workspaceId")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});
