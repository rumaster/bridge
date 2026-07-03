import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AI_ONBOARDING_COMMAND_ACTIONS,
  AI_ONBOARDING_COMMAND_SCHEMA,
} from "../../src/modules/ai-integration/ai-onboarding-command.schema";

const CANONICAL_SCHEMA_PATH = join(
  __dirname,
  "../../../../packages/contracts/json-schema/c4-ai-onboarding-command.schema.json",
);

describe("C4 AI onboarding command schema drift", () => {
  it("keeps the embedded backend copy identical to the canonical contract JSON", () => {
    const canonical = JSON.parse(readFileSync(CANONICAL_SCHEMA_PATH, "utf8"));

    expect(AI_ONBOARDING_COMMAND_SCHEMA).toEqual(canonical);
  });

  it("keeps the embedded action list identical to the canonical enum", () => {
    const canonical = JSON.parse(readFileSync(CANONICAL_SCHEMA_PATH, "utf8"));

    expect([...AI_ONBOARDING_COMMAND_ACTIONS]).toEqual(canonical.properties.action.enum);
  });
});
