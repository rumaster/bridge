// Считает план деплоя из deploy/components.json и пишет его в GITHUB_OUTPUT.
//
// Живёт отдельным файлом, а не инлайном в YAML: план — единственное место, где
// есть настоящая логика (валидация имён, дедуп образов, предупреждение об общих
// образах), и его надо уметь прогонять локально:
//
//   TARGET=app COMPONENTS=backend,web-chat SHA=deadbeef node .github/scripts/deploy-plan.js
//
// Используется и deploy.yml, и migrate.yml (последний — с COMPONENTS=__migrate__).
//
// ESM, а не CommonJS: в корневом package.json стоит "type": "module".
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const MIGRATE_SENTINEL = "__migrate__";

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`[output] ${key}=${value}`);
    return;
  }
  fs.appendFileSync(file, `${key}=${value}\n`);
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${markdown}\n`);
  console.log(markdown);
}

const reg = JSON.parse(fs.readFileSync("deploy/components.json", "utf8"));

const targetName = (process.env.TARGET || "").trim();
const stack = reg.stacks[targetName];
if (!stack) {
  fail(
    `Неизвестный стенд "${targetName}". Доступные: ${Object.keys(reg.stacks).join(", ")}`,
  );
}

// SHA коммита, который деплоим. В CI checkout уже стоит на нужном ref, поэтому
// разворачиваем HEAD в неподвижный sha: ветка может уехать, пока идёт сборка, и
// собранное разъедется с задеплоенным.
const sha =
  process.env.SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`Не похоже на полный SHA: "${sha}"`);

const raw = (process.env.COMPONENTS || "").trim();
if (!raw) fail("Не задан список компонентов");

let names;
let migrate = null;

if (raw === MIGRATE_SENTINEL) {
  // Режим миграций: сервис один и берётся из stack.migrate.
  migrate = stack.migrate;
  names = [];
} else if (raw === "all") {
  names = Object.keys(stack.components);
} else {
  names = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const unknown = names.filter((n) => !stack.components[n]);
  if (unknown.length) {
    fail(
      `Неизвестные компоненты для стенда "${targetName}": ${unknown.join(", ")}. ` +
        `Доступные: ${Object.keys(stack.components).join(", ")}`,
    );
  }
}

const usedImages = migrate
  ? [migrate.image]
  : [...new Set(names.map((n) => stack.components[n].image))];

const services = migrate ? [migrate.service] : names;
const profiles = migrate
  ? []
  : [...new Set(names.map((n) => stack.components[n].profile).filter(Boolean))];

// Матрица сборки: один build на ОБРАЗ, а не на сервис. c7-ws/edge-vpn-app/
// edge-gateway делят один Dockerfile — без дедупа мы бы собрали его трижды.
const matrix = usedImages.map((image) => {
  const meta = reg.images[image];
  if (!meta) fail(`Образ "${image}" не описан в deploy/components.json`);
  const buildArgs = (meta.build_args || [])
    .map((name) => {
      const value = process.env[name];
      if (!value) fail(`Для образа "${image}" нужен build-arg ${name}, а он не передан`);
      return `${name}=${value}`;
    })
    .join("\n");
  return { image, dockerfile: meta.dockerfile, build_args: buildArgs };
});

const tagCsv = usedImages.map((i) => `${reg.images[i].tag_var}=${sha}`).join(",");

setOutput("sha", sha);
setOutput("images", JSON.stringify(matrix));
setOutput("services", services.join(","));
setOutput("profiles", profiles.join(","));
setOutput("tag_csv", tagCsv);
setOutput("host_secret", stack.host_secret);
setOutput("known_hosts_secret", stack.known_hosts_secret);
setOutput("user", stack.user);
setOutput("workdir", stack.workdir);
setOutput("compose_file", stack.compose_file);
setOutput("env_file", stack.env_file);
if (migrate) {
  setOutput("migrate_service", migrate.service);
  setOutput("migrate_target", stack.migrate.migrate_target);
}

summary(`### План: ${targetName} @ \`${sha.slice(0, 12)}\``);
summary("");
summary(`| | |`);
summary(`|---|---|`);
summary(`| Сервисы | \`${services.join("`, `") || "—"}\` |`);
summary(`| Образы | \`${usedImages.join("`, `")}\` |`);
summary(`| Профили | ${profiles.length ? `\`${profiles.join("`, `")}\`` : "—"} |`);
summary(`| Теги | \`${tagCsv.replace(/,/g, "`, `")}\` |`);

// Общий образ = общий тег. Если деплоим c7-ws, а edge-vpn-app оставили в стороне,
// его объявленная версия в env-файле всё равно уедет, и следующий ручной
// `up -d` на стенде молча передвинет его на новый код. Лучше сказать это вслух.
if (!migrate) {
  const siblings = [];
  for (const [name, comp] of Object.entries(stack.components)) {
    if (names.includes(name)) continue;
    if (usedImages.includes(comp.image)) siblings.push(`${name} (образ ${comp.image})`);
  }
  if (siblings.length) {
    const text =
      `Общий образ с недеплоимыми сервисами: ${siblings.join(", ")}. ` +
      `Их тег в ${stack.env_file} тоже сдвинется на ${sha.slice(0, 12)}, ` +
      `и следующий \`up -d\` поднимет их на этом коде. Деплойте вместе, если менялся общий код.`;
    console.log(`::warning::${text}`);
    summary("");
    summary(`> ⚠️ ${text}`);
  }
}
