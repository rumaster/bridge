import { readFileSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2];
const allowedCommands = new Set(["lint", "test", "build"]);

if (!allowedCommands.has(command)) {
  console.error(`Unknown workspace command: ${command ?? "(empty)"}`);
  process.exit(1);
}

const manifestPath = join(process.cwd(), "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageName = manifest.name ?? process.cwd();

console.log(`${packageName}: ${command} placeholder for M0 scaffold.`);
