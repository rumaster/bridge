import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import {
  DEFAULT_CONFIGURATION_KEY,
  PutOrganizationConfigurationDto,
  PutConfigurationDto,
  normalizeOrganizationConfigurationValue,
  nextConfigurationVersion,
} from "../../src/modules/configuration/configuration.dto";
import { CreateClientDto, mapClient } from "../../src/modules/client/client.dto";

describe("M1 domain DTO validators and mappers", () => {
  it("rejects blank client display names before business logic", async () => {
    const dto = plainToInstance(CreateClientDto, { displayName: "   " });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === "displayName")).toBe(true);
  });

  it("requires configuration payload value to be a JSON object", async () => {
    const dto = plainToInstance(PutConfigurationDto, {
      key: DEFAULT_CONFIGURATION_KEY,
      value: "not-object",
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === "value")).toBe(true);
  });

  it("requires explicit organization configuration fields", async () => {
    const dto = plainToInstance(PutOrganizationConfigurationDto, {
      defaultLanguage: "ru",
      aiAssistantEnabled: true,
      workflowAutomationEnabled: false,
      notificationEmail: "admin@example.test",
      retentionDays: 90,
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === "monthlyMessageLimit")).toBe(true);
  });

  it("normalizes missing organization configuration fields to defaults", () => {
    expect(
      normalizeOrganizationConfigurationValue({
        aiAssistantEnabled: true,
        monthlyMessageLimit: null,
      }),
    ).toEqual({
      aiAssistantEnabled: true,
      defaultLanguage: "ru",
      monthlyMessageLimit: 10000,
      notificationEmail: "",
      retentionDays: 90,
      workflowAutomationEnabled: false,
    });
  });

  it("maps client rows from PostgreSQL shape to API shape", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");

    expect(
      mapClient({
        anonymized_at: null,
        created_at: createdAt,
        display_name: "Jane Customer",
        id: "10000000-0000-4000-8000-000000000301",
        organization_id: "10000000-0000-4000-8000-000000000101",
        updated_at: createdAt,
      }),
    ).toEqual({
      anonymizedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      displayName: "Jane Customer",
      id: "10000000-0000-4000-8000-000000000301",
      organizationId: "10000000-0000-4000-8000-000000000101",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("increments configuration versions deterministically", () => {
    expect(nextConfigurationVersion(undefined)).toBe(1);
    expect(nextConfigurationVersion(null)).toBe(1);
    expect(nextConfigurationVersion(1)).toBe(2);
  });
});
