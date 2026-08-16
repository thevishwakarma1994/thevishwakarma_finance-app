import { Hono } from "hono";
import {
  cardDetail,
  comingCardPayments,
  currentMonthSpend,
  cycleDetail,
  listAccounts,
  listActivity,
  listCards,
  listCategories,
  listPeople,
  monthReview,
  personDetail,
  suggestPersonAllocations,
  listPendingSurplus,
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

readRoutes.get("/cards", (c) => {
  try {
    return c.json({ cards: listCards(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/cards/:id", (c) => {
  try {
    return c.json(cardDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/cycles/:id", (c) => {
  try {
    return c.json(cycleDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/coming-card-payments", (c) => {
  try {
    return c.json({ items: comingCardPayments(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/people", (c) => {
  try {
    return c.json({ people: listPeople(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/people/:id", (c) => {
  try {
    return c.json(personDetail(c.get("handles"), c.get("workspaceId"), c.req.param("id")));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

readRoutes.get("/people/:id/suggest-allocations", (c) => {
  try {
    const amountPaise = Number(c.req.query("amountPaise") ?? "0");
    const direction = (c.req.query("direction") === "user_owes_them"
      ? "user_owes_them"
      : "they_owe_user") as "they_owe_user" | "user_owes_them";
    return c.json(
      suggestPersonAllocations(
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

readRoutes.get("/surplus", (c) => {
  try {
    return c.json({ items: listPendingSurplus(c.get("handles"), c.get("workspaceId")) });
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});
