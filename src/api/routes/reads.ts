import { Hono } from "hono";
import {
  currentMonthSpend,
  listAccounts,
  listActivity,
  listCategories,
  monthReview,
} from "../../db/reads.js";
import type { SqliteHandles } from "../../db/client.js";
import { isoDate } from "../../domain/calendar/isoDate.js";
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
    const categoryId = c.req.query("categoryId") || undefined;
    const month = c.req.query("month") || undefined;
    return c.json({
      events: listActivity(c.get("handles"), c.get("workspaceId"), { categoryId, month }),
    });
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

readRoutes.get("/month-review", (c) => {
  try {
    const month = c.req.query("month");
    const asOf = month ? `${month}-01` : undefined;
    return c.json(
      monthReview(
        c.get("handles"),
        c.get("workspaceId"),
        asOf ? isoDate(asOf) : undefined,
      ),
    );
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});
