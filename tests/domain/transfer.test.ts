import { describe, expect, it } from "vitest";
import { paise } from "../../src/domain/money/paise.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { transferMoney } from "../../src/domain/commands/transferMoney.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { accountFixture, paiseOf, snapshotFixture } from "./fixtures.js";

const occurredOn = isoDate("2026-08-11");
const capturedAt = "2026-08-11T04:30:00.000Z";

describe("transfer conservation", () => {
  it("moves money between accounts without income or expense", () => {
    const hdfc = accountFixture({ displayName: "HDFC", balancePaise: paiseOf(10_000) });
    const cash = accountFixture({
      id: "cash",
      displayName: "Cash",
      kind: "cash",
      isPrimarySalary: false,
      balancePaise: paise(0),
    });
    const { batch, preview } = transferMoney(
      {
        occurredOn,
        capturedAt,
        amountPaise: paiseOf(2_000),
        fromAccountId: hdfc.id,
        toAccountId: cash.id,
      },
      snapshotFixture({ accounts: [hdfc, cash] }),
    );
    expect(() => assertConservation("transfer", batch)).not.toThrow();
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.meaning).toBe("transfer");
    expect(batch.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(
      batch.postings.some(
        (posting) => posting.pnl === "income_salary" || posting.pnl === "income_other",
      ),
    ).toBe(false);
    expect(preview.classifications.spent).toBe(0);
    expect(preview.classifications.income).toBe(0);
    expect(preview.classifications.moved).toBe(200_000);
  });

  it("rejects a transfer to the same account", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(10_000) });
    expect(() =>
      transferMoney(
        {
          occurredOn,
          capturedAt,
          amountPaise: paiseOf(1_000),
          fromAccountId: hdfc.id,
          toAccountId: hdfc.id,
        },
        snapshotFixture({ accounts: [hdfc] }),
      ),
    ).toThrow(DomainError);
  });

  it("rejects a transfer that exceeds the source balance", () => {
    const hdfc = accountFixture({ displayName: "HDFC", balancePaise: paiseOf(1_000) });
    const cash = accountFixture({
      id: "cash",
      displayName: "Cash",
      kind: "cash",
      isPrimarySalary: false,
      balancePaise: paise(0),
    });
    expect(() =>
      transferMoney(
        {
          occurredOn,
          capturedAt,
          amountPaise: paiseOf(2_000),
          fromAccountId: hdfc.id,
          toAccountId: cash.id,
        },
        snapshotFixture({ accounts: [hdfc, cash] }),
      ),
    ).toThrow(/exceeds the money currently in the source account/);
  });
});
