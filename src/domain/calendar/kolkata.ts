import { DateTime } from "luxon";
import { isoDate, type IsoDate } from "./isoDate.js";

export const KOLKATA = "Asia/Kolkata";

export function todayKolkata(now: DateTime = DateTime.now()): IsoDate {
  if (!now.isValid) {
    throw new Error("Invalid timestamp for Kolkata date");
  }
  const local = now.setZone(KOLKATA);
  const formatted = local.toISODate();
  if (!formatted) {
    throw new Error("Could not read Kolkata date");
  }
  return isoDate(formatted);
}

export function utcNowIso(now = DateTime.now()): string {
  return now.toUTC().toISO({ suppressMilliseconds: false }) ?? now.toUTC().toISO()!;
}

export function kolkataMonthStart(value: IsoDate): IsoDate {
  return isoDate(`${value.slice(0, 7)}-01`);
}

export function kolkataMonthEnd(value: IsoDate): IsoDate {
  const start = DateTime.fromISO(value, { zone: KOLKATA }).startOf("month");
  const end = start.endOf("month");
  const formatted = end.toISODate();
  if (!formatted) {
    throw new Error("Could not read month end");
  }
  return isoDate(formatted);
}

export function kolkataAddMonths(value: IsoDate, months: number): IsoDate {
  const shifted = DateTime.fromISO(value, { zone: KOLKATA }).plus({ months });
  const formatted = shifted.toISODate();
  if (!formatted) {
    throw new Error("Could not shift calendar month");
  }
  return isoDate(formatted);
}

export function kolkataAddDays(value: IsoDate, days: number): IsoDate {
  const shifted = DateTime.fromISO(value, { zone: KOLKATA }).plus({ days });
  const formatted = shifted.toISODate();
  if (!formatted) {
    throw new Error("Could not shift calendar day");
  }
  return isoDate(formatted);
}

/** Clamp `day` to the last civil day of that Kolkata month (e.g. 31 → 28/29 in February). */
export function kolkataCivilDate(year: number, month: number, day: number): IsoDate {
  const start = DateTime.fromObject({ year, month, day: 1 }, { zone: KOLKATA });
  if (!start.isValid) {
    throw new Error(`Invalid Kolkata month: ${year}-${month}`);
  }
  const last = start.endOf("month").day;
  const use = Math.min(Math.max(day, 1), last);
  const formatted = start.set({ day: use }).toISODate();
  if (!formatted) {
    throw new Error("Could not build Kolkata civil date");
  }
  return isoDate(formatted);
}

export function parseIsoDateInKolkata(value: IsoDate): DateTime {
  const dt = DateTime.fromISO(value, { zone: KOLKATA });
  if (!dt.isValid) {
    throw new Error(`Invalid Kolkata date: ${value}`);
  }
  return dt;
}
