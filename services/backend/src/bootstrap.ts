import "reflect-metadata";

import { VersioningType } from "@nestjs/common";
import type { LogLevel } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Express } from "express";

import { AppModule } from "./app.module";
import { setupSwaggerUi } from "./common/openapi/openapi";
import { HealthService } from "./modules/health/health.service";
import { MetricsService } from "./modules/health/metrics.service";

export interface BackendAppOptions {
  installOperationAliases?: boolean;
  installSwaggerUi?: boolean;
  logger?: false | LogLevel[];
}

export async function createBackendApp(options: BackendAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    logger: options.logger,
  });
  configureBackendApp(app, options);

  return app;
}

export function configureBackendApp(
  app: INestApplication,
  options: BackendAppOptions = {},
): void {
  app.setGlobalPrefix("api");
  app.enableVersioning({
    defaultVersion: "1",
    type: VersioningType.URI,
  });

  if (options.installOperationAliases !== false) {
    installOperationAliases(app);
  }

  if (options.installSwaggerUi !== false) {
    setupSwaggerUi(app);
  }
}

function installOperationAliases(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Express;

  express.get("/health", (_request, response) => {
    response.json(app.get(HealthService).getHealth());
  });
  express.get("/metrics", (_request, response) => {
    response.type("text/plain; version=0.0.4").send(app.get(MetricsService).renderPrometheus());
  });
}
