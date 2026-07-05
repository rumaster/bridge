import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

const SEEDS_DIR = fileURLToPath(new URL("../db/seeds", import.meta.url));

export async function runSeeds({
  databaseUrl = process.env.DATABASE_URL,
  client,
  seedsDir = SEEDS_DIR,
} = {}) {
  if (!client && !databaseUrl) {
    throw new Error("DATABASE_URL is required to run seeds");
  }

  const ownClient = client ? null : new pg.Client(databaseUrl);
  const dbClient = client ?? ownClient;

  if (ownClient) {
    await ownClient.connect();
  }

  try {
    const seedFiles = (await readdir(seedsDir))
      .filter((fileName) => fileName.endsWith(".ts"))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

    for (const seedFile of seedFiles) {
      const seedModule = await import(pathToFileURL(resolve(seedsDir, seedFile)).href);

      if (typeof seedModule.seed !== "function") {
        throw new TypeError(`${seedFile} must export seed(client)`);
      }

      await seedModule.seed(dbClient);
    }

    return seedFiles;
  } finally {
    if (ownClient) {
      await ownClient.end();
    }
  }
}

async function main() {
  const seedFiles = await runSeeds();
  console.log(`db:seed: ${seedFiles.length} seed file(s) processed`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
