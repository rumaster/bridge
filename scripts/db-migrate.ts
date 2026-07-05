import { fileURLToPath, pathToFileURL } from "node:url";

import { runner } from "node-pg-migrate";

import type { DatabaseConnection } from "./db-connection.js";

/** Опции запуска миграций (общий контракт CLI и интеграционных тестов). */
export interface RunMigrationsOptions {
  databaseUrl?: DatabaseConnection;
  direction?: "up" | "down";
  count?: number;
  target?: string;
  verbose?: boolean;
}

const MIGRATION_TARGETS = {
  app: {
    dir: fileURLToPath(new URL("../db/migrations", import.meta.url)),
    migrationsTable: "pgmigrations",
  },
  rf: {
    dir: fileURLToPath(new URL("../db/rf-migrations", import.meta.url)),
    migrationsTable: "pgmigrations_rf",
  },
};

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
  target = process.env.DB_MIGRATE_TARGET ?? "app",
  verbose = process.env.DB_MIGRATE_VERBOSE === "1",
}: RunMigrationsOptions = {}) {
  if (direction !== "up" && direction !== "down") {
    throw new TypeError("direction must be either 'up' or 'down'");
  }

  const migrationTarget = MIGRATION_TARGETS[target];
  if (!migrationTarget) {
    throw new TypeError(
      `target must be one of ${Object.keys(MIGRATION_TARGETS).join(", ")}`,
    );
  }

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  return runner({
    databaseUrl,
    direction,
    count,
    dir: migrationTarget.dir,
    migrationsTable: migrationTarget.migrationsTable,
    singleTransaction: true,
    checkOrder: true,
    verbose,
    logger: verbose ? console : quietLogger,
  });
}

async function main() {
  const direction = process.argv[2];
  const target = process.argv[3] ?? process.env.DB_MIGRATE_TARGET ?? "app";

  if (direction !== "up" && direction !== "down") {
    console.error(
      "Usage: DATABASE_URL=postgres://... node scripts/db-migrate.ts up|down [app|rf]",
    );
    process.exitCode = 1;
    return;
  }

  const migrations = await runMigrations({ direction, target, verbose: true });
  console.log(
    `db:migrate:${direction}:${target}: ${migrations.length} migration(s) processed`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
