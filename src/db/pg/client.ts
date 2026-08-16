import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "./schema.js";
import type { PostgresHandles } from "../handles.js";

/**
 * Neon-compatible node-postgres pool.
 * SSL and credentials come only from DATABASE_URL (e.g. sslmode=require).
 * Do not log the connection string.
 */
export function openPostgresDatabase(connectionString: string): PostgresHandles {
  const pool = new Pool({
    connectionString,
    max: 10,
  });
  pool.on("error", (error) => {
    console.error("PostgreSQL pool error", error.message);
  });
  const db = drizzle(pool, { schema });
  return { dialect: "postgres", pool, db };
}
