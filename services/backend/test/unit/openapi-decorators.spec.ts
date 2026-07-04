import "reflect-metadata";

import { METHOD_METADATA, PATH_METADATA, VERSION_METADATA } from "@nestjs/common/constants";

import { AiIntegrationController } from "../../src/modules/ai-integration/ai-integration.controller";
import { BackendApiController } from "../../src/modules/backend-api/backend-api.controller";
import { BroadcastFacadeController } from "../../src/modules/broadcast-facade/broadcast-facade.controller";
import { ClientController, ClientMergeController } from "../../src/modules/client/client.controller";
import {
  ConversationController,
  MessageController,
} from "../../src/modules/communication-core/communication-core.controller";
import { ConfigurationController } from "../../src/modules/configuration/configuration.controller";
import { FbpIntegrationController } from "../../src/modules/fbp-integration/fbp-integration.controller";
import { HealthController } from "../../src/modules/health/health.controller";
import {
  InvitationsController,
  PlatformOrganizationsController,
} from "../../src/modules/identity/identity-m4.controller";
import {
  ChannelsController,
  ChannelTestController,
} from "../../src/modules/integration-gateway/channels.controller";
import { NotificationFacadeController } from "../../src/modules/notification-facade/notification-facade.controller";
import { OrganizationController } from "../../src/modules/organization/organization.controller";
import { OrganizationUsersController, UserController } from "../../src/modules/user/user.controller";

type ControllerClass = new (...args: never[]) => unknown;

const OPENAPI_OPERATION_METADATA = "swagger/apiOperation";
const OPENAPI_RESPONSE_METADATA = "swagger/apiResponse";
const OPENAPI_TAGS_METADATA = "swagger/apiUseTags";

const CONTROLLERS: readonly ControllerClass[] = [
  HealthController,
  AiIntegrationController,
  FbpIntegrationController,
  BroadcastFacadeController,
  ChannelsController,
  ChannelTestController,
  NotificationFacadeController,
  PlatformOrganizationsController,
  InvitationsController,
  OrganizationController,
  ConfigurationController,
  ClientController,
  ClientMergeController,
  ConversationController,
  MessageController,
  OrganizationUsersController,
  UserController,
  BackendApiController,
];

describe("OpenAPI decorators", () => {
  it("keeps every Nest controller operation tagged, versioned and response-documented", () => {
    const missing: string[] = [];

    for (const controller of CONTROLLERS) {
      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller);
      const controllerTags = Reflect.getMetadata(OPENAPI_TAGS_METADATA, controller);

      if (controllerPath === undefined) {
        missing.push(`${controller.name}: @Controller path`);
      }
      if (!Array.isArray(controllerTags) || controllerTags.length === 0) {
        missing.push(`${controller.name}: @ApiTags`);
      }

      for (const methodName of routeHandlerNames(controller)) {
        const handler = controller.prototype[methodName] as (...args: unknown[]) => unknown;
        const operation = Reflect.getMetadata(OPENAPI_OPERATION_METADATA, handler);
        const responses = Reflect.getMetadata(OPENAPI_RESPONSE_METADATA, handler);
        const version = Reflect.getMetadata(VERSION_METADATA, handler);
        const label = `${controller.name}.${methodName}`;

        if (!operation?.summary) {
          missing.push(`${label}: @ApiOperation summary`);
        }
        if (responseCount(responses) === 0) {
          missing.push(`${label}: @ApiOkResponse/@ApiCreatedResponse`);
        }
        if (!versions(version).includes("1")) {
          missing.push(`${label}: @Version("1")`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

function routeHandlerNames(controller: ControllerClass): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((property) => {
    if (property === "constructor") {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, property);
    return descriptor?.value && Reflect.getMetadata(METHOD_METADATA, descriptor.value) !== undefined;
  });
}

function responseCount(metadata: unknown): number {
  if (Array.isArray(metadata)) {
    return metadata.length;
  }

  if (metadata && typeof metadata === "object") {
    return Object.keys(metadata).length;
  }

  return 0;
}

function versions(metadata: unknown): string[] {
  if (Array.isArray(metadata)) {
    return metadata.map(String);
  }

  if (metadata === undefined) {
    return [];
  }

  return [String(metadata)];
}
