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

export function parseIsoDateInKolkata(value: IsoDate): DateTime {
  const dt = DateTime.fromISO(value, { zone: KOLKATA });
  if (!dt.isValid) {
    throw new Error(`Invalid Kolkata date: ${value}`);
  }
  return dt;
}
