import { isoDate, isoDateParts, type IsoDate } from "../calendar/isoDate.js";
import { kolkataAddDays, kolkataCivilDate } from "../calendar/kolkata.js";
import { newId } from "../ids.js";
import { DomainError, type DueRule, type ObligationInstance, type ObligationPriority, type ObligationTemplate } from "../ledger/types.js";
import { paise, type Paise } from "../money/paise.js";
import { compareYearMonth, shiftYearMonth, yearMonthOf } from "../funding/cycles.js";

/** Generate from 1 month before asOf through 4 months after (aligned with funding-cycle forward window). */
export const INSTANCE_GENERATION_MONTHS_BACK = 1;
export const INSTANCE_GENERATION_MONTHS_FORWARD = 4;

export const CONFIG_OBLIGATION_AMOUNT = "obligation.amount";
export const CONFIG_OBLIGATION_PRIORITY = "obligation.priority";

export type ObligationConfigRow = {
  key: string;
  subjectId: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  value: unknown;
};

export function parseDueRule(raw: unknown): DueRule {
  const record = raw as { dayOfMonth?: unknown };
  const day = Number(record?.dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new DomainError("invalid_due_rule", "Due day must be a day of month from 1 to 31");
  }
  return { dayOfMonth: day };
}

export function dueOnForMonth(rule: DueRule, year: number, month: number): IsoDate {
  return kolkataCivilDate(year, month, rule.dayOfMonth);
}

export function templateCoversDueOn(template: ObligationTemplate, dueOn: IsoDate): boolean {
  if (dueOn < template.effectiveFrom) return false;
  if (template.effectiveTo !== null && dueOn >= template.effectiveTo) return false;
  return true;
}

export function configValueAsOf(
  rows: ObligationConfigRow[],
  key: string,
  subjectId: string,
  asOf: IsoDate,
): unknown | null {
  const current = rows
    .filter(
      (row) =>
        row.key === key &&
        row.subjectId === subjectId &&
        row.effectiveFrom <= asOf &&
        (row.effectiveTo === null || asOf < row.effectiveTo),
    )
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
  return current?.value ?? null;
}

export function amountAsOf(rows: ObligationConfigRow[], templateId: string, asOf: IsoDate): Paise | null {
  const value = configValueAsOf(rows, CONFIG_OBLIGATION_AMOUNT, templateId, asOf) as {
    amountPaise?: unknown;
  } | null;
  const amount = Number(value?.amountPaise);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  return paise(amount);
}

export function priorityAsOf(
  rows: ObligationConfigRow[],
  templateId: string,
  fallback: ObligationPriority,
  asOf: IsoDate,
): ObligationPriority {
  const value = configValueAsOf(rows, CONFIG_OBLIGATION_PRIORITY, templateId, asOf) as {
    priority?: unknown;
  } | null;
  const priority = value?.priority;
  if (priority === "must_pay" || priority === "committed" || priority === "planned") {
    return priority;
  }
  return fallback;
}

export function remainingObligationPaise(instance: ObligationInstance): Paise {
  if (instance.status !== "open") return paise(0);
  return instance.amountPaise;
}

export function generateObligationInstances(input: {
  templates: ObligationTemplate[];
  existing: ObligationInstance[];
  configs: ObligationConfigRow[];
  asOf: IsoDate;
  monthsBack?: number;
  monthsForward?: number;
}): ObligationInstance[] {
  const monthsBack = input.monthsBack ?? INSTANCE_GENERATION_MONTHS_BACK;
  const monthsForward = input.monthsForward ?? INSTANCE_GENERATION_MONTHS_FORWARD;
  const origin = yearMonthOf(input.asOf);
  const start = shiftYearMonth(origin.year, origin.month, -monthsBack);
  const end = shiftYearMonth(origin.year, origin.month, monthsForward);
  const seen = new Set(
    input.existing
      .filter((instance) => instance.templateId)
      .map((instance) => `${instance.templateId}:${instance.dueOn}`),
  );
  const created: ObligationInstance[] = [];
  let cursor = start;
  while (compareYearMonth(cursor, end) <= 0) {
    for (const template of input.templates) {
      const dueOn = dueOnForMonth(template.dueRule, cursor.year, cursor.month);
      if (!templateCoversDueOn(template, dueOn)) continue;
      const key = `${template.id}:${dueOn}`;
      if (seen.has(key)) continue;
      const amountPaise = amountAsOf(input.configs, template.id, dueOn);
      if (amountPaise === null) continue;
      created.push({
        id: newId(),
        templateId: template.id,
        nameSnapshot: template.name,
        dueOn,
        amountPaise,
        prioritySnapshot: priorityAsOf(input.configs, template.id, template.priority, dueOn),
        status: "open",
        fundingCycleId: null,
        paidEventId: null,
      });
      seen.add(key);
    }
    cursor = shiftYearMonth(cursor.year, cursor.month, 1);
  }
  return created;
}

export function rangesOverlap(
  leftFrom: IsoDate,
  leftTo: IsoDate | null,
  rightFrom: IsoDate,
  rightTo: IsoDate | null,
): boolean {
  const leftEnd = leftTo ?? isoDate("9999-12-31");
  const rightEnd = rightTo ?? isoDate("9999-12-31");
  return leftFrom < rightEnd && rightFrom < leftEnd;
}

export function assertNoOverlappingConfigs(
  rows: ObligationConfigRow[],
  key: string,
  subjectId: string,
): void {
  const slice = rows
    .filter((row) => row.key === key && row.subjectId === subjectId)
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  for (let index = 1; index < slice.length; index += 1) {
    const previous = slice[index - 1];
    const current = slice[index];
    if (!previous || !current) continue;
    if (rangesOverlap(previous.effectiveFrom, previous.effectiveTo, current.effectiveFrom, current.effectiveTo)) {
      throw new DomainError("config_overlap", "Effective configuration ranges cannot overlap");
    }
  }
}

export function dayAfter(value: IsoDate): IsoDate {
  return kolkataAddDays(value, 1);
}

export function isoYearMonth(value: IsoDate): { year: number; month: number } {
  return isoDateParts(value);
}
