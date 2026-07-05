import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const contractPath = join(
  root,
  "packages",
  "contracts",
  "consumer",
  "manager-workspace-c3.consumer.v1.json",
);

function readContract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

describe("SVC-MWS C3 consumer contract", () => {
  it("publishes the M1 C3 consumer contract", () => {
    const contract = readContract();

    assert.equal(contract["x-contract-id"], "C3.manager-workspace.consumer");
    assert.equal(contract["x-consumer"], "SVC-MWS");
    assert.equal(contract["x-stage"], "M1");
  });

  it("freezes the M1 endpoint set used by Manager Workspace", () => {
    const contract = readContract();

    assert.deepEqual(
      contract.interactions.map((interaction) => [interaction.method, interaction.path]),
      [
        ["POST", "/auth/login/telegram/start"],
        ["POST", "/auth/login/telegram/verify"],
        ["GET", "/auth/session"],
        ["GET", "/conversations"],
        ["GET", "/conversations/{conversationId}"],
        ["GET", "/conversations/{conversationId}/messages"],
        ["POST", "/messages"],
        ["GET", "/clients/{clientId}"],
        ["GET", "/clients"],
      ],
    );
  });

  it("requires idempotency for manager replies", () => {
    const contract = readContract();
    const createMessage = contract.interactions.find(
      (interaction) => interaction.method === "POST" && interaction.path === "/messages",
    );

    assert.ok(createMessage);
    assert.deepEqual(createMessage.request.required, [
      "conversationId",
      "content",
      "idempotencyKey",
    ]);
    assert.equal(createMessage.idempotency.keyField, "idempotencyKey");
    assert.equal(createMessage.idempotency.repeatReturnsSameMessage, true);
  });
});
