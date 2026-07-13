import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Сводит встраиваемый бандл в артефакт страницы (W5): копирует `bridge-web-chat*`
 * из `dist` (lib-сборка) в `dist-page` (SPA-сборка), чтобы один контейнер
 * web-chat отдавал и хостируемую страницу `/chat/<id>`, и ESM-бандл для
 * встраивания на сторонние сайты.
 */
const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(scriptDir, "../dist");
const pageDir = join(scriptDir, "../dist-page");

if (!existsSync(distDir)) {
  console.error("dist/ не найден — сначала соберите lib-бандл (vite.lib.config.ts).");
  process.exit(1);
}

mkdirSync(pageDir, { recursive: true });

let copied = 0;
for (const fileName of readdirSync(distDir)) {
  const isEmbedArtifact =
    fileName.startsWith("bridge-web-chat") &&
    (fileName.endsWith(".js") || fileName.endsWith(".css") || fileName.endsWith(".map"));
  if (isEmbedArtifact) {
    copyFileSync(join(distDir, fileName), join(pageDir, fileName));
    copied += 1;
  }
}

console.log(`assemble-page-dist: скопировано ${copied} файлов встраиваемого бандла в dist-page/`);
