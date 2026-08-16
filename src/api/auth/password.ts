import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

/** Known local-only password. Production startup rejects a hash of this value. */
export const DEVELOPMENT_DEFAULT_PASSWORD = "changeme";

export function readPasswordHashFromEnv(): string {
  return process.env.APP_PASSWORD_HASH?.trim() ?? "";
}

export function assertProductionPasswordConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  const hash = readPasswordHashFromEnv();
  if (!hash) {
    throw new Error("APP_PASSWORD_HASH is required in production");
  }
  if (verifyPassword(DEVELOPMENT_DEFAULT_PASSWORD, hash)) {
    throw new Error("APP_PASSWORD_HASH must not use the documented development default");
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, KEYLEN, { N: 16384, r: 8, p: 1 }).toString("hex");
  return `scrypt$16384$8$1$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4] ?? "";
  const expected = parts[5] ?? "";
  const actual = scryptSync(password, salt, KEYLEN, { N: n, r, p }).toString("hex");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
