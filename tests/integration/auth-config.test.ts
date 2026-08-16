import { afterEach, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_DEFAULT_PASSWORD,
  assertProductionPasswordConfig,
  hashPassword,
} from "../../src/api/auth/password.js";

const originalEnv = process.env.NODE_ENV;
const originalHash = process.env.APP_PASSWORD_HASH;

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
  if (originalHash === undefined) {
    delete process.env.APP_PASSWORD_HASH;
  } else {
    process.env.APP_PASSWORD_HASH = originalHash;
  }
});

describe("production password config", () => {
  it("allows the documented development default outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.APP_PASSWORD_HASH = hashPassword(DEVELOPMENT_DEFAULT_PASSWORD);
    expect(() => assertProductionPasswordConfig()).not.toThrow();
  });

  it("refuses startup when production hash is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_PASSWORD_HASH;
    expect(() => assertProductionPasswordConfig()).toThrow(/required in production/);
  });

  it("refuses startup when production hash is the documented development default", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_PASSWORD_HASH = hashPassword(DEVELOPMENT_DEFAULT_PASSWORD);
    expect(() => assertProductionPasswordConfig()).toThrow(/development default/);
  });

  it("allows a distinct production hash", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_PASSWORD_HASH = hashPassword("distinct-production-secret");
    expect(() => assertProductionPasswordConfig()).not.toThrow();
  });
});
