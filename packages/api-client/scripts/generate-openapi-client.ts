import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

type OpenApiDocument = {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  "x-contract-id"?: string;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  tags?: unknown[];
};

type GeneratedDocument = {
  artifact: string;
  contractId: string;
  openapi: string;
  title: string;
  version: string;
  pathCount: number;
  operationCount: number;
};

type GeneratedOperation = {
  artifact: string;
  contractId: string;
  method: string;
  path: string;
  operationId: string;
  summary?: string;
  tags: string[];
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const openApiRoot = resolve(repositoryRoot, "packages/contracts/openapi");
const outputPath = resolve(packageRoot, "src/generated/openapi.ts");
const checkOnly = process.argv.includes("--check");

const { documents, operations } = collectOpenApiCatalog();
const nextSource = renderGeneratedSource(documents, operations);

if (checkOnly) {
  const currentSource = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
  if (currentSource !== nextSource) {
    console.error(
      "Generated OpenAPI catalog is out of date. Run `npm run generate --workspace @bridge/api-client`.",
    );
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, nextSource);
}

function collectOpenApiCatalog() {
  const documents: GeneratedDocument[] = [];
  const operations: GeneratedOperation[] = [];

  for (const absolutePath of listOpenApiFiles(openApiRoot)) {
    const artifact = toRepositoryPath(absolutePath);
    const document = readOpenApiDocument(absolutePath);
    const contractId = getContractId(document, artifact);
    const documentOperations = extractOperations(document, artifact, contractId);

    documents.push({
      artifact,
      contractId,
      openapi: document.openapi ?? "",
      title: document.info?.title ?? contractId,
      version: document.info?.version ?? "",
      pathCount: Object.keys(document.paths ?? {}).length,
      operationCount: documentOperations.length,
    });
    operations.push(...documentOperations);
  }

  documents.sort((left, right) => left.artifact.localeCompare(right.artifact));
  operations.sort(
    (left, right) =>
      left.artifact.localeCompare(right.artifact) ||
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );

  return { documents, operations };
}

function listOpenApiFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listOpenApiFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && [".json", ".yaml", ".yml"].includes(extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

function readOpenApiDocument(absolutePath: string): OpenApiDocument {
  const rawSource = readFileSync(absolutePath, "utf8");
  if (extname(absolutePath) === ".json") {
    return JSON.parse(rawSource) as OpenApiDocument;
  }

  return parseYamlOpenApi(rawSource);
}

function parseYamlOpenApi(source: string): OpenApiDocument {
  const document: OpenApiDocument = {
    info: {},
    paths: {},
  };
  let section: "info" | "paths" | null = null;
  let currentPath: string | null = null;
  let currentMethod: string | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (indent === 0) {
      section = null;
      currentPath = null;
      currentMethod = null;
      if (line.startsWith("openapi:")) {
        document.openapi = readYamlScalar(line);
      } else if (line === "info:") {
        section = "info";
      } else if (line === "paths:") {
        section = "paths";
      }
      continue;
    }

    if (section === "info" && indent === 2) {
      if (line.startsWith("title:")) {
        document.info!.title = readYamlScalar(line);
      } else if (line.startsWith("version:")) {
        document.info!.version = readYamlScalar(line);
      }
      continue;
    }

    if (section !== "paths") {
      continue;
    }

    if (indent === 2 && line.endsWith(":")) {
      currentPath = stripYamlQuotes(line.slice(0, -1));
      currentMethod = null;
      document.paths![currentPath] = {};
      continue;
    }

    if (indent === 4 && line.endsWith(":")) {
      const maybeMethod = line.slice(0, -1);
      if (currentPath && HTTP_METHOD_SET.has(maybeMethod)) {
        currentMethod = maybeMethod;
        document.paths![currentPath]![currentMethod] = {};
      }
      continue;
    }

    if (indent === 6 && currentPath && currentMethod) {
      const operation = document.paths![currentPath]![currentMethod]!;
      if (line.startsWith("operationId:")) {
        operation.operationId = readYamlScalar(line);
      } else if (line.startsWith("summary:")) {
        operation.summary = readYamlScalar(line);
      }
    }
  }

  return document;
}

function readYamlScalar(line: string) {
  return stripYamlQuotes(line.slice(line.indexOf(":") + 1).trim());
}

function stripYamlQuotes(value: string) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function extractOperations(
  document: OpenApiDocument,
  artifact: string,
  contractId: string,
): GeneratedOperation[] {
  const operations: GeneratedOperation[] = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHOD_SET.has(method) || typeof operation !== "object" || operation === null) {
        continue;
      }

      const operationId =
        operation.operationId ?? `${contractId}_${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`;

      operations.push({
        artifact,
        contractId,
        method,
        path,
        operationId,
        ...(operation.summary ? { summary: operation.summary } : {}),
        tags: Array.isArray(operation.tags)
          ? operation.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      });
    }
  }

  return operations;
}

function getContractId(document: OpenApiDocument, artifact: string) {
  if (typeof document["x-contract-id"] === "string" && document["x-contract-id"].trim() !== "") {
    return document["x-contract-id"];
  }

  const fileName = basename(artifact, extname(artifact));
  const directoryName = basename(dirname(artifact));
  return directoryName === "openapi" ? fileName : directoryName;
}

function toRepositoryPath(absolutePath: string) {
  return relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
}

function renderGeneratedSource(documents: GeneratedDocument[], operations: GeneratedOperation[]) {
  return `/* Auto-generated by packages/api-client/scripts/generate-openapi-client.ts. */\n/* Do not edit by hand. Run npm run generate --workspace @bridge/api-client. */\n\nexport type GeneratedOpenApiHttpMethod = ${HTTP_METHODS.map((method) => JSON.stringify(method)).join(" | ")};\n\nexport interface GeneratedOpenApiDocument {\n  readonly artifact: string;\n  readonly contractId: string;\n  readonly openapi: string;\n  readonly title: string;\n  readonly version: string;\n  readonly pathCount: number;\n  readonly operationCount: number;\n}\n\nexport interface GeneratedOpenApiOperation {\n  readonly artifact: string;\n  readonly contractId: string;\n  readonly method: GeneratedOpenApiHttpMethod;\n  readonly path: string;\n  readonly operationId: string;\n  readonly summary?: string;\n  readonly tags: readonly string[];\n}\n\nexport const generatedOpenApiDocuments = ${JSON.stringify(documents, null, 2)} as const satisfies readonly GeneratedOpenApiDocument[];\n\nexport const generatedOpenApiOperations = ${JSON.stringify(operations, null, 2)} as const satisfies readonly GeneratedOpenApiOperation[];\n\nexport type GeneratedOpenApiOperationId = typeof generatedOpenApiOperations[number][\"operationId\"];\n\nexport function resolveGeneratedOpenApiOperation(\n  operationId: GeneratedOpenApiOperationId,\n): GeneratedOpenApiOperation {\n  const operation = generatedOpenApiOperations.find((candidate) => candidate.operationId === operationId);\n\n  if (!operation) {\n    throw new Error(\`Unknown generated OpenAPI operation: \${operationId}\`);\n  }\n\n  return operation;\n}\n`;
}
