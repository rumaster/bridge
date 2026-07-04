import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "../dist");
const kib = 1024;

const files = readdirSync(distDir);
const jsFiles = files.filter((fileName) => fileName.endsWith(".js"));
const entryFileName = "bridge-web-chat.js";
const entrySource = readFileSync(join(distDir, entryFileName), "utf8");

if (!entrySource.includes("import(")) {
  fail("bridge-web-chat.js должен оставаться ленивым loader API с dynamic import().");
}

const runtimeJsFiles = jsFiles.filter(
  (fileName) =>
    fileName !== "mockServiceWorker.js" &&
    !fileName.includes("-browser-"),
);
const runtimeGzipBytes = runtimeJsFiles.reduce(
  (total, fileName) =>
    total + gzipSync(readFileSync(join(distDir, fileName)), { level: 9 }).byteLength,
  0,
);
const cssBytes = files
  .filter((fileName) => fileName.endsWith(".css"))
  .reduce((total, fileName) => total + statSync(join(distDir, fileName)).size, 0);

checkBudget("lazy loader raw", statSync(join(distDir, entryFileName)).size, 2 * kib);
checkBudget("runtime JS gzip", runtimeGzipBytes, 230 * kib);
checkBudget("runtime CSS raw", cssBytes, 8 * kib);

if (process.exitCode) {
  process.exit();
}

console.log(
  [
    "Web Chat bundle budgets:",
    `loader=${formatBytes(statSync(join(distDir, entryFileName)).size)}/2 KiB raw`,
    `runtime=${formatBytes(runtimeGzipBytes)}/230 KiB gzip`,
    `css=${formatBytes(cssBytes)}/8 KiB raw`,
  ].join(" "),
);

function checkBudget(label, actualBytes, maxBytes) {
  if (actualBytes > maxBytes) {
    fail(
      `${label} превышает бюджет: ${formatBytes(actualBytes)} > ${formatBytes(maxBytes)}.`,
    );
  }
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function formatBytes(bytes) {
  return `${(bytes / kib).toFixed(1)} KiB`;
}
