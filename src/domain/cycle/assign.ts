import { isoDateParts, type IsoDate } from "../calendar/isoDate.js";
import { KOLKATA, kolkataAddDays, kolkataCivilDate } from "../calendar/kolkata.js";
import { DateTime } from "luxon";
import { DomainError, type CardCycleRule } from "../ledger/types.js";

export type { CardCycleRule };

export type AssignedCycle = {
  purchaseWindowStart: IsoDate;
  purchaseWindowEnd: IsoDate;
  expectedStatementOn: IsoDate;
  expectedDueOn: IsoDate;
  ruleSnapshot: CardCycleRule;
};

export function parseCardCycleRule(value: unknown): CardCycleRule {
  if (!value || typeof value !== "object") {
    throw new DomainError("invalid_card_rule", "Card cycle rule is missing");
  }
  const record = value as { statementDay?: unknown; dueDaysAfterStatement?: unknown };
  const statementDay = record.statementDay;
  const dueDaysAfterStatement = record.dueDaysAfterStatement;
  if (typeof statementDay !== "number" || !Number.isInteger(statementDay) || statementDay < 1 || statementDay > 31) {
    throw new DomainError("invalid_card_rule", "Statement day must be an integer from 1 to 31");
  }
  if (
    typeof dueDaysAfterStatement !== "number" ||
    !Number.isInteger(dueDaysAfterStatement) ||
    dueDaysAfterStatement < 0
  ) {
    throw new DomainError("invalid_card_rule", "Due days after statement must be a non-negative integer");
  }
  return { statementDay, dueDaysAfterStatement };
}

/**
 * Stage 4 §6.1: purchase window is `(prevStatement, thisStatement]`.
 * Spend on the statement day belongs to that cycle; the day after starts the next.
 */
export function assignBillingCycle(occurredOn: IsoDate, rule: CardCycleRule): AssignedCycle {
  const parsed = parseCardCycleRule(rule);
  const parts = isoDateParts(occurredOn);
  const thisMonthStatement = kolkataCivilDate(parts.year, parts.month, parsed.statementDay);
  const expectedStatementOn =
    occurredOn <= thisMonthStatement
      ? thisMonthStatement
      : nextMonthStatement(parts.year, parts.month, parsed.statementDay);

  const statementParts = isoDateParts(expectedStatementOn);
  const previous = DateTime.fromObject(
    { year: statementParts.year, month: statementParts.month, day: 1 },
    { zone: KOLKATA },
  ).minus({ months: 1 });
  const prevStatement = kolkataCivilDate(previous.year, previous.month, parsed.statementDay);
  return {
    purchaseWindowStart: kolkataAddDays(prevStatement, 1),
    purchaseWindowEnd: expectedStatementOn,
    expectedStatementOn,
    expectedDueOn: kolkataAddDays(expectedStatementOn, parsed.dueDaysAfterStatement),
    ruleSnapshot: parsed,
  };
}

function nextMonthStatement(year: number, month: number, statementDay: number): IsoDate {
  const next = DateTime.fromObject({ year, month, day: 1 }, { zone: KOLKATA }).plus({ months: 1 });
  return kolkataCivilDate(next.year, next.month, statementDay);
}
