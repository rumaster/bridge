import "reflect-metadata";

import { ROLES_KEY } from "../../src/common/auth/roles.decorator";
import { WorkflowController } from "../../src/modules/workflow/workflow.controller";

describe("WorkflowController RBAC", () => {
  it("ограничивает API Workflow ролью platform_operator", () => {
    expect(Reflect.getMetadata(ROLES_KEY, WorkflowController)).toEqual(["platform_operator"]);
  });
});
