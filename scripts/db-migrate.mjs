import { fileURLToPath, pathToFileURL } from "node:url";

import { runner } from "node-pg-migrate";

const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));
const MIGRATIONS_TABLE = "pgmigrations";

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (message) => {
    console.error(message);
  },
};

export async function runMigrations({
  databaseUrl = process.env.DATABASE_URL,
  direction = "up",
  count,
  verbose = process.env.DB_MIGRATE_VERBOSE === "1",
} = {}) {
  if (direction !== "up" && direction !== "down") {
    throw new TypeError("direction must be either 'up' or 'down'");
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  return runner({
    databaseUrl,
    direction,
    count,
    dir: MIGRATIONS_DIR,
    migrationsTable: MIGRATIONS_TABLE,
    singleTransaction: true,
    checkOrder: true,
    verbose,
    logger: verbose ? console : quietLogger,
  });
}

async function main() {
  const direction = process.argv[2];

  if (direction !== "up" && direction !== "down") {
    console.error("Usage: DATABASE_URL=postgres://... node scripts/db-migrate.mjs up|down");
    process.exitCode = 1;
    return;
  }

  const migrations = await runMigrations({ direction, verbose: true });
  console.log(`db:migrate:${direction}: ${migrations.length} migration(s) processed`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
