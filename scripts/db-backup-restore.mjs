import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

function usage() {
  return [
    "Usage:",
    "  node scripts/db-backup-restore.mjs backup --database-url <url> --file <dump> [--target app|rf]",
    "  node scripts/db-backup-restore.mjs restore --database-url <url> --file <dump> [--clean] [--target app|rf]",
    "  node scripts/db-backup-restore.mjs probe --source-url <url> --restore-url <url> --file <dump> [--target app|rf]",
  ].join("\n");
}

function requireOption(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${name} is required\n${usage()}`);
  }

  return value;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

export async function backupDatabase({ databaseUrl, file }) {
  await mkdir(dirname(file), { recursive: true });
  await run("pg_dump", [
    "--format=custom",
    "--file",
    file,
    "--no-owner",
    "--no-privileges",
    databaseUrl,
  ]);
}

export async function restoreDatabase({ databaseUrl, file, clean = false }) {
  const args = [
    "--dbname",
    databaseUrl,
    "--no-owner",
    "--no-privileges",
  ];

  if (clean) {
    args.push("--clean", "--if-exists");
  }

  args.push(file);
  await run("pg_restore", args);
}

export async function probeBackupRestore({
  sourceUrl,
  restoreUrl,
  file,
  target = "app",
}) {
  const backupStartedAt = performance.now();
  await backupDatabase({ databaseUrl: sourceUrl, file });
  const backupMs = performance.now() - backupStartedAt;

  const restoreStartedAt = performance.now();
  await restoreDatabase({ databaseUrl: restoreUrl, file, clean: true });
  const restoreMs = performance.now() - restoreStartedAt;

  return {
    target,
    backupSeconds: Number((backupMs / 1000).toFixed(3)),
    restoreSeconds: Number((restoreMs / 1000).toFixed(3)),
    totalSeconds: Number(((backupMs + restoreMs) / 1000).toFixed(3)),
  };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      clean: { type: "boolean", default: false },
      "database-url": { type: "string" },
      file: { type: "string" },
      "restore-url": { type: "string" },
      "source-url": { type: "string" },
      target: { type: "string", default: "app" },
    },
  });
  const command = positionals[0];

  if (command === "backup") {
    await backupDatabase({
      databaseUrl: requireOption(values, "database-url"),
      file: requireOption(values, "file"),
    });
    return;
  }

  if (command === "restore") {
    await restoreDatabase({
      databaseUrl: requireOption(values, "database-url"),
      file: requireOption(values, "file"),
      clean: values.clean,
    });
    return;
  }

  if (command === "probe") {
    const result = await probeBackupRestore({
      sourceUrl: requireOption(values, "source-url"),
      restoreUrl: requireOption(values, "restore-url"),
      file: requireOption(values, "file"),
      target: values.target,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(usage());
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
