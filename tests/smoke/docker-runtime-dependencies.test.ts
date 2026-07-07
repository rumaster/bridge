import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

const grpcRuntimeServices = [
  {
    name: "@bridge/broadcast-platform",
    workspace: "services/broadcast-platform",
    dockerfile: "deploy/docker/broadcast-platform/Dockerfile",
    dependencies: ["@grpc/grpc-js", "@grpc/proto-loader"],
  },
  {
    name: "@bridge/notification-platform",
    workspace: "services/notification-platform",
    dockerfile: "deploy/docker/notification-platform/Dockerfile",
    dependencies: ["@grpc/grpc-js", "@grpc/proto-loader", "redis"],
  },
];

function readText(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readText(path));
}

describe("runtime Dockerfiles for gRPC services", () => {
  for (const service of grpcRuntimeServices) {
    it(`installs workspace dependencies for ${service.name}`, () => {
      const manifest = readJson(`${service.workspace}/package.json`) as {
        dependencies?: Record<string, string>;
      };
      const dockerfile = readText(service.dockerfile);

      for (const dependency of service.dependencies) {
        assert.equal(
          typeof manifest.dependencies?.[dependency],
          "string",
          `${service.name} must declare ${dependency}`,
        );
      }

      assert.match(
        dockerfile,
        /^\s*COPY\s+\.\s+\.\s*$/m,
        `${service.dockerfile} must copy the workspace lockfile into the image`,
      );
      assert.match(
        dockerfile,
        /^\s*RUN\s+npm\s+ci\s*$/m,
        `${service.dockerfile} must install runtime dependencies from package-lock.json`,
      );
    });
  }
});
