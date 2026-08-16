import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { lendMoney } from "../../src/domain/commands/lendMoney.js";
import { borrowMoney } from "../../src/domain/commands/borrowMoney.js";
import {
  accountFixture,
  paiseOf,
  personFixture,
  snapshotFixture,
} from "./fixtures.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

describe("lend and borrow", () => {
  it("lends from an account without creating expense", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture({ name: "Rahul" });
    const { batch, preview } = lendMoney(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        accountId: hdfc.id,
        personId: rahul.id,
        amountPaise: paiseOf(2_000),
      },
      snapshotFixture({ accounts: [hdfc], people: [rahul] }),
    );
    expect(batch.events[0]?.meaning).toBe("lend");
    expect(batch.postings.find((posting) => posting.accountId)?.amountPaise).toBe(-200_000);
    expect(batch.claims?.[0]?.kind).toBe("direct_loan");
    expect(batch.claims?.[0]?.direction).toBe("they_owe_user");
    expect(batch.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(preview.classifications.spent).toBe(0);
    expect(() => assertConservation("lend", batch)).not.toThrow();
  });

  it("borrows into an account without creating income", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture({ name: "Rahul" });
    const { batch, preview } = borrowMoney(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        accountId: hdfc.id,
        personId: rahul.id,
        amountPaise: paiseOf(2_000),
      },
      snapshotFixture({ accounts: [hdfc], people: [rahul] }),
    );
    expect(batch.events[0]?.meaning).toBe("borrow");
    expect(batch.postings.find((posting) => posting.accountId)?.amountPaise).toBe(200_000);
    expect(batch.claims?.[0]?.kind).toBe("borrowing");
    expect(batch.claims?.[0]?.direction).toBe("user_owes_them");
    expect(batch.postings.some((posting) => posting.pnl === "income_salary" || posting.pnl === "income_other")).toBe(
      false,
    );
    expect(preview.classifications.income).toBe(0);
    expect(() => assertConservation("borrow", batch)).not.toThrow();
  });
});
