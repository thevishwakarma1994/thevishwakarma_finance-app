import { Hono } from "hono";
import { utcNowIso } from "../../domain/calendar/kolkata.js";
import { applyOpening } from "../../app/applyOpening.js";
import { recordIncome } from "../../app/recordIncome.js";
import { recordExpense } from "../../app/recordExpense.js";
import type { SqliteHandles } from "../../db/client.js";
import { mapError } from "../auth/guard.js";

type Env = {
  Variables: {
    handles: SqliteHandles;
    workspaceId: string;
  };
};

export const commandRoutes = new Hono<Env>();

commandRoutes.post("/commands/opening", async (c) => {
  try {
    const body = await c.req.json();
    const result = applyOpening(c.get("handles"), { workspaceId: c.get("workspaceId") }, body);
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/income", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = recordIncome(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/expense", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = recordExpense(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});
