import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function collectMjsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries.flatMap((entry) => {
    if (entry.name === "node_modules") {
      return [];
    }

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      return collectMjsFiles(fullPath);
    }

    return entry.isFile() && entry.name.endsWith(".mjs") ? [fullPath] : [];
  });
}

const dirs = process.argv.slice(2);

if (dirs.length === 0) {
  console.error("Usage: node check-mjs.mjs <dir> [dir...]");
  process.exit(1);
}

const files = dirs.flatMap(collectMjsFiles);

let hasError = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    hasError = true;
  }
}

process.exit(hasError ? 1 : 0);
