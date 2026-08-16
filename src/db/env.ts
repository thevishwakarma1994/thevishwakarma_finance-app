/**
 * Database backend selection. This is the only env-level dialect switch.
 * Application, domain, API, and UI code never branch on sqlite vs postgres.
 *
 * Rules:
 * - production requires DATABASE_URL (PostgreSQL) and must not use SQLite
 * - development/tests may use SQLite via DATABASE_PATH when DATABASE_URL is unset
 * - never log DATABASE_URL or other connection secrets
 */

export type DatabaseBackend = "sqlite" | "postgres";

export type SqliteDatabaseConfig = {
  backend: "sqlite";
  sqlitePath: string;
};

export type PostgresDatabaseConfig = {
  backend: "postgres";
  connectionString: string;
};

export type DatabaseConfig = SqliteDatabaseConfig | PostgresDatabaseConfig;

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

function looksLikePostgresUrl(value: string): boolean {
  return /^(postgres(ql)?:\/\/)/i.test(value.trim());
}

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const production = isProduction(env);

  if (production) {
    if (!databaseUrl) {
      throw new DatabaseConfigError(
        "Production requires DATABASE_URL pointing at PostgreSQL. SQLite is not allowed in production.",
      );
    }
    if (!looksLikePostgresUrl(databaseUrl)) {
      throw new DatabaseConfigError("Production DATABASE_URL must be a postgres:// or postgresql:// URL.");
    }
    if (env.DATABASE_BACKEND === "sqlite") {
      throw new DatabaseConfigError("Production cannot use DATABASE_BACKEND=sqlite.");
    }
    return { backend: "postgres", connectionString: databaseUrl };
  }

  if (databaseUrl) {
    if (!looksLikePostgresUrl(databaseUrl)) {
      throw new DatabaseConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL.");
    }
    return { backend: "postgres", connectionString: databaseUrl };
  }

  if (env.DATABASE_BACKEND === "postgres") {
    throw new DatabaseConfigError("DATABASE_BACKEND=postgres requires DATABASE_URL.");
  }

  return {
    backend: "sqlite",
    sqlitePath: env.DATABASE_PATH?.trim() || "data/app.sqlite",
  };
}

export function describeDatabaseConfig(config: DatabaseConfig): string {
  if (config.backend === "sqlite") {
    return `database backend=sqlite path=${config.sqlitePath}`;
  }
  return "database backend=postgres";
}
