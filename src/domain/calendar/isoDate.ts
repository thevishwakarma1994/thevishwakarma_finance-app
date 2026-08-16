export type IsoDate = string & { readonly __brand: "IsoDate" };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isoDate(value: string): IsoDate {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new Error(`Invalid IsoDate: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return value as IsoDate;
}

export function isoDateParts(value: IsoDate): {
  year: number;
  month: number;
  day: number;
} {
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

export function isoMonth(value: IsoDate): { year: number; month: number } {
  const { year, month } = isoDateParts(value);
  return { year, month };
}

export function inCalendarMonth(
  value: IsoDate,
  year: number,
  month: number,
): boolean {
  const parts = isoDateParts(value);
  return parts.year === year && parts.month === month;
}
