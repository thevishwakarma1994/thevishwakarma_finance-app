import { Hono } from "hono";
import { utcNowIso, todayKolkata } from "../../domain/calendar/kolkata.js";
import { isoDate } from "../../domain/calendar/isoDate.js";
import { recordIncome } from "../../app/recordIncome.js";
import { recordExpense } from "../../app/recordExpense.js";
import { transferMoney } from "../../app/transferMoney.js";
import { recordCardSpend } from "../../app/recordCardSpend.js";
import { recordSplit } from "../../app/recordSplit.js";
import { lendMoney } from "../../app/lendMoney.js";
import { borrowMoney } from "../../app/borrowMoney.js";
import { receiveSettlement } from "../../app/receiveSettlement.js";
import { paySettlement } from "../../app/paySettlement.js";
import { resolveSurplus } from "../../app/resolveSurplus.js";
import { simulateAffordability } from "../../app/simulateAffordability.js";
import { payCard } from "../../app/payCard.js";
import { recordObligationPayment } from "../../app/recordObligationPayment.js";
import { skipObligation } from "../../app/skipObligation.js";
import {
  archiveObligationTemplate,
  changeObligationFrom,
  createObligationTemplate,
  createOneOffObligation,
} from "../../app/obligations.js";
import { confirmStatement } from "../../app/confirmStatement.js";
import { createAccount, updateAccount } from "../../app/accounts.js";
import { createCategory, updateCategory } from "../../app/categories.js";
import { createCard, updateCard } from "../../app/cards.js";
import { createPerson, updatePerson } from "../../app/people.js";
import { ensureObligationInstances } from "../../app/ensureObligationInstances.js";
import { applyOpeningCard, correctOpeningCard } from "../../app/openingCard.js";
import { applyOpeningClaim, correctOpeningClaim } from "../../app/openingClaim.js";
import { applyOpeningReservation, correctOpeningReservation } from "../../app/openingReservation.js";
import type { DbHandles } from "../../db/client.js";
import { mapError } from "../auth/guard.js";

type Env = {
  Variables: {
    handles: DbHandles;
    workspaceId: string;
    userId: string;
  };
};

export const commandRoutes = new Hono<Env>();

commandRoutes.post("/commands/income", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await recordIncome(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
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
    const result = await recordExpense(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/transfer", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await transferMoney(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/accounts", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await createAccount(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/accounts/update", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await updateAccount(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/categories", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await createCategory(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/categories/update", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await updateCategory(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/cards", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await createCard(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/cards/update", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await updateCard(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/card-spend", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await recordCardSpend(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/pay-card", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await payCard(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/confirm-statement", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await confirmStatement(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/people", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await createPerson(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/people/update", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await updatePerson(c.get("handles"), { workspaceId: c.get("workspaceId") }, body));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/split", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await recordSplit(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/lend", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await lendMoney(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/borrow", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await borrowMoney(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/receive-settlement", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await receiveSettlement(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/pay-settlement", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await paySettlement(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/resolve-surplus", async (c) => {
  try {
    const body = await c.req.json();
    const result = await resolveSurplus(c.get("handles"), { workspaceId: c.get("workspaceId") }, body);
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/simulate-affordability", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const asOf = isoDate(typeof body.occurredOn === "string" ? body.occurredOn : todayKolkata());
    await ensureObligationInstances(c.get("handles"), c.get("workspaceId"), asOf);
    const result = await simulateAffordability(c.get("handles"), { workspaceId: c.get("workspaceId") }, body);
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/obligation-templates", async (c) => {
  try {
    return c.json(await createObligationTemplate(c.get("handles"), { workspaceId: c.get("workspaceId") }, await c.req.json()));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/obligation-templates/change", async (c) => {
  try {
    return c.json(await changeObligationFrom(c.get("handles"), { workspaceId: c.get("workspaceId") }, await c.req.json()));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/obligation-templates/archive", async (c) => {
  try {
    return c.json(await archiveObligationTemplate(c.get("handles"), { workspaceId: c.get("workspaceId") }, await c.req.json()));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/obligation-one-off", async (c) => {
  try {
    return c.json(await createOneOffObligation(c.get("handles"), { workspaceId: c.get("workspaceId") }, await c.req.json()));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/pay-obligation", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await recordObligationPayment(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/skip-obligation", async (c) => {
  try {
    return c.json(await skipObligation(c.get("handles"), { workspaceId: c.get("workspaceId") }, await c.req.json()));
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/opening/card", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await applyOpeningCard(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/opening/card/correct", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await correctOpeningCard(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/opening/claim", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await applyOpeningClaim(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/opening/claim/correct", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await correctOpeningClaim(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/opening/reservation", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await applyOpeningReservation(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});

commandRoutes.post("/commands/opening/reservation/correct", async (c) => {
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const result = await correctOpeningReservation(c.get("handles"), { workspaceId: c.get("workspaceId") }, {
      ...body,
      capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : utcNowIso(),
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapError(error);
    return c.json(mapped.body, mapped.status);
  }
});
