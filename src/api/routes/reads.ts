import { Hono, type Context } from "hono";
import {
  cardDetail,
  comingCardPayments,
  comingUp,
  currentMonthSpend,
  cycleDetail,
  home,
  listAccounts,
  listActivity,
  listCards,
  listCategories,
  listPeople,
  money,
  monthReview,
  obligationDetail,
  personDetail,
  suggestPersonAllocations,
  listPendingSurplus,
} from "../../db/reads.js";
import type { DbHandles } from "../../db/client.js";
import { isoDate, type IsoDate } from "../../domain/calendar/isoDate.js";
import { COMING_UP_FILTERS, type ComingUpFilter } from "../../domain/engine/comingUp.js";
import { mapError } from "../auth/guard.js";
import { listObligationTemplates } from "../../app/obligations.js";
import { salarySchedule } from "../../app/salaryPolicy.js";
import { ensureObligationInstances } from "../../app/ensureObligationInstances.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";

type Env = {
  Variables: {
    handles: DbHandles;
    workspaceId: string;
    userId: string;
  };
};

export const readRoutes = new Hono<Env>();

function requestAsOf(c: Context<Env>): IsoDate {
  const asOf = c.req.query("asOf");
  return asOf ? isoDate(asOf) : todayKolkata();
}

async function prepareObligationReads(c: Context<Env>, asOf: IsoDate) {
  await ensureObligationInstances(c.get("handles"), c.get("workspaceId"), asOf);
}

readRoutes.get("/accounts", async (c) => {
  try {
    return c.json({ accounts: await listAccounts(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/categories", async (c) => {
  try {
    return c.json({ categories: await listCategories(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/activity", async (c) => {
  try {
    const categoryId = c.req.query("categoryId") || undefined;
    const month = c.req.query("month") || undefined;
    return c.json({
      events: await listActivity(c.get("handles"), c.get("workspaceId"), { categoryId, month }),
    });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/month", async (c) => {
  try {
    return c.json(await currentMonthSpend(c.get("handles"), c.get("workspaceId")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/month-review", async (c) => {
  try {
    const month = c.req.query("month");
    const asOf = month ? `${month}-01` : undefined;
    return c.json(
      await monthReview(
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

readRoutes.get("/cards", async (c) => {
  try {
    return c.json({ cards: await listCards(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/cards/:id", async (c) => {
  try {
    return c.json(await cardDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/cycles/:id", async (c) => {
  try {
    return c.json(await cycleDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/coming-up", async (c) => {
  try {
    const asOf = requestAsOf(c);
    await prepareObligationReads(c, asOf);
    const raw = c.req.query("filter") ?? "all_open";
    const filter = (COMING_UP_FILTERS as readonly string[]).includes(raw)
      ? (raw as ComingUpFilter)
      : "all_open";
    return c.json(await comingUp(c.get("handles"), c.get("workspaceId"), asOf, filter));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/obligations/:id", async (c) => {
  try {
    return c.json(await obligationDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/coming-card-payments", async (c) => {
  try {
    return c.json({ items: await comingCardPayments(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/people", async (c) => {
  try {
    return c.json({ people: await listPeople(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/people/:id", async (c) => {
  try {
    return c.json(await personDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/people/:id/suggest-allocations", async (c) => {
  try {
    const amountPaise = Number(c.req.query("amountPaise") ?? "0");
    const direction = (c.req.query("direction") === "user_owes_them"
      ? "user_owes_them"
      : "they_owe_user") as "they_owe_user" | "user_owes_them";
    return c.json(
      await suggestPersonAllocations(
        c.get("handles"),
        c.get("workspaceId"),
        c.req.param("id"),
        Number.isFinite(amountPaise) ? amountPaise : 0,
        direction,
      ),
    );
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/surplus", async (c) => {
  try {
    return c.json({ items: await listPendingSurplus(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/obligation-templates", async (c) => {
  try {
    await prepareObligationReads(c, todayKolkata());
    return c.json({
      templates: await listObligationTemplates(c.get("handles"), c.get("workspaceId")),
    });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/home", async (c) => {
  try {
    const asOf = requestAsOf(c);
    await prepareObligationReads(c, asOf);
    return c.json(await home(c.get("handles"), c.get("workspaceId"), asOf));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/salary-schedule", async (c) => {
  try {
    const asOf = requestAsOf(c);
    return c.json(await salarySchedule(c.get("handles"), { workspaceId: c.get("workspaceId") }, asOf));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/money", async (c) => {
  try {
    const asOf = requestAsOf(c);
    await prepareObligationReads(c, asOf);
    return c.json(await money(c.get("handles"), c.get("workspaceId"), asOf));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});
