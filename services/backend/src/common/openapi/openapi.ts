import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle("Bridge Backend Core API")
    .setDescription("M0 REST skeleton for C3 backend core contracts.")
    .setVersion("1.0.0")
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupSwaggerUi(app: INestApplication): void {
  SwaggerModule.setup("api/docs", app, buildOpenApiDocument(app), {
    jsonDocumentUrl: "api/docs-json",
  });
}
