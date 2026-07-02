import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createBackendApp } from "../bootstrap";
import { buildOpenApiDocument } from "../common/openapi/openapi";

async function exportOpenApi(): Promise<void> {
  const app = await createBackendApp({
    installOperationAliases: false,
    installSwaggerUi: false,
    logger: false,
  });
  await app.init();

  const document = buildOpenApiDocument(app);
  const outputDirectory = resolve(process.cwd(), "../../packages/contracts/openapi/backend-core");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(`${outputDirectory}/openapi.json`, `${JSON.stringify(document, null, 2)}\n`);

  await app.close();
}

void exportOpenApi();
