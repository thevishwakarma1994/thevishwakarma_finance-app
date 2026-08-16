import { paise, type Paise } from "../domain/money/paise.js";

const MIN = BigInt(Number.MIN_SAFE_INTEGER);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Persistence-boundary Paise loader.
 *
 * PostgreSQL BIGINT and SQLite INTEGER must be validated as a safe integer
 * before conversion to the domain `number` Paise type. Never `Number(bigint)`
 * an unvalidated value — that silently rounds past MAX_SAFE_INTEGER.
 */
export function fromStoredPaise(value: unknown): Paise {
  if (typeof value === "bigint") {
    if (value < MIN || value > MAX) {
      throw new Error("Paise exceeds safe integer range");
    }
    return paise(Number(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error("Paise must be a safe integer");
    }
    return fromStoredPaise(BigInt(trimmed));
  }
  if (typeof value === "number") {
    return paise(value);
  }
  throw new Error("Paise must be a safe integer");
}

export function fromStoredPaiseOrNull(value: unknown): Paise | null {
  if (value === null || value === undefined) {
    return null;
  }
  return fromStoredPaise(value);
}
