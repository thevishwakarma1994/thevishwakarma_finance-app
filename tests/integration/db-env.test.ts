import { afterEach, describe, expect, it } from "vitest";
import {
  DatabaseConfigError,
  describeDatabaseConfig,
  resolveDatabaseConfig,
} from "../../src/db/env.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_PATH: process.env.DATABASE_PATH,
  DATABASE_BACKEND: process.env.DATABASE_BACKEND,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("database backend selection", () => {
  it("uses SQLite in development when DATABASE_URL is unset", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_PATH: "data/app.sqlite",
    } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    const config = resolveDatabaseConfig(env);
    expect(config).toEqual({ backend: "sqlite", sqlitePath: "data/app.sqlite" });
    expect(describeDatabaseConfig(config)).toContain("backend=sqlite");
    expect(describeDatabaseConfig(config)).not.toContain("postgres://");
  });

  it("refuses production without DATABASE_URL", () => {
    const env = { NODE_ENV: "production", DATABASE_PATH: "data/app.sqlite" } as NodeJS.ProcessEnv;
    delete env.DATABASE_URL;
    expect(() => resolveDatabaseConfig(env)).toThrow(DatabaseConfigError);
    expect(() => resolveDatabaseConfig(env)).toThrow(/DATABASE_URL/);
  });

  it("refuses production SQLite even when DATABASE_BACKEND=sqlite", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:pass@localhost/finance",
      DATABASE_BACKEND: "sqlite",
    } as NodeJS.ProcessEnv;
    expect(() => resolveDatabaseConfig(env)).toThrow(/cannot use DATABASE_BACKEND=sqlite/);
  });

  it("selects postgres from DATABASE_URL without logging the secret", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://user:secret@db.example/finance",
    } as NodeJS.ProcessEnv;
    const config = resolveDatabaseConfig(env);
    expect(config.backend).toBe("postgres");
    expect(describeDatabaseConfig(config)).toBe("database backend=postgres");
    expect(describeDatabaseConfig(config)).not.toContain("secret");
    expect(describeDatabaseConfig(config)).not.toContain("postgresql://");
  });

  it("refuses a non-postgres DATABASE_URL", () => {
    const env = {
      NODE_ENV: "development",
      DATABASE_URL: "sqlite:///tmp/app.sqlite",
    } as NodeJS.ProcessEnv;
    expect(() => resolveDatabaseConfig(env)).toThrow(/postgres:\/\//);
  });
});
