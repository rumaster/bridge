#!/usr/bin/env node
/**
 * CommonJS-сборка контракта графа Workflow.
 *
 * Зачем: `services/backend` — CommonJS с `rootDir: "src"`, поэтому импортировать
 * ESM TS-исходники `packages/contracts` он не может физически. Именно из-за этого
 * в Backend годами жила вторая, независимая копия валидации схемы — она разошлась
 * с движком и дала дефект: узел ветвления с обеими ветками true/false нельзя было
 * сохранить через API. Общий контракт возможен только через собранный пакет.
 *
 * Собирается ровно `src/c5-workflow.ts` — он не имеет ни одного импорта (в
 * отличие от `c5.ts`, который тянет `node:fs` и `c4.ts`), поэтому одинаково
 * пригоден и для браузера, и для CommonJS.
 *
 * `dist/cjs/package.json` с `type: commonjs` обязателен: в корневом package.json
 * пакета стоит `type: module`, из-за чего Node трактовал бы dist/cjs/*.js как ESM.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const cjsDir = join(packageRoot, "dist", "cjs");
const require = createRequire(import.meta.url);

// tsc вызывается напрямую через node, а не через npx с shell: на Windows shell
// потребовал бы конкатенации аргументов вместо экранирования.
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.cjs.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});

mkdirSync(cjsDir, { recursive: true });
writeFileSync(join(cjsDir, "package.json"), `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`);

console.log("packages/contracts: CommonJS-сборка контракта Workflow готова (dist/cjs).");
