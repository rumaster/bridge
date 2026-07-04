import "reflect-metadata";

import { RequestMethod, VersioningType } from "@nestjs/common";
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
  // Внутренние service-to-service маршруты messaging-пути (issue #189) вызывает
  // integration-platform по фиксированным путям без префикса `api` и без версии
  // (CORE_INGRESS_URL=/internal/ingress/messages и т.п.), поэтому исключаем их
  // из глобального префикса.
  app.setGlobalPrefix("api", {
    exclude: [
      { path: "internal/ingress/messages", method: RequestMethod.POST },
      { path: "internal/egress/messages", method: RequestMethod.POST },
      { path: "internal/delivery/attempts", method: RequestMethod.POST },
    ],
  });
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
