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
  "manager-workspace-c4-c7.consumer.v1.json",
);

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function readContract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

describe("SVC-MWS CP-3 C4/C7 consumer contract", () => {
  it("publishes the M2 consumer contract for C4 and C7", () => {
    const contract = readContract();

    assert.equal(contract["x-contract-id"], "CP3.manager-workspace.consumer");
    assert.equal(contract["x-consumer"], "SVC-MWS");
    assert.equal(contract["x-stage"], "M2");
    assert.deepEqual(contract.upstream_contracts, ["C4", "C7"]);
  });

  it("consumes the frozen C4 assistant suggestion operation", () => {
    const contract = readContract();
    const c4OpenApi = readJson("packages/contracts/openapi/ai/c4.ai.openapi.json");
    const suggest = contract.interactions.find(
      (interaction) => interaction.contract === "C4" && interaction.path === "/ai/assistant:suggest",
    );

    assert.ok(suggest);
    assert.ok(c4OpenApi.paths["/ai/assistant:suggest"].post);
    assert.deepEqual(suggest.request.required, [
      "contract",
      "version",
      "request_id",
      "organization_id",
      "query",
    ]);
    assert.equal(suggest.degradation.aiUnavailableKeepsMessagingUsable, true);
  });

  it("consumes the M2 realtime C7 events and reconnect invariants", () => {
    const contract = readContract();
    const c7Schema = readJson("packages/contracts/events/c7-websocket-event.schema.json");
    const c7EventNames = c7Schema.properties.event.enum;

    assert.deepEqual(
      contract.events.map((event) => event.name),
      [
        "message.created",
        "message.status_changed",
        "typing.started",
        "typing.stopped",
        "client.status_changed",
      ],
    );

    for (const event of contract.events) {
      assert.ok(c7EventNames.includes(event.name), `${event.name} is not published by C7`);
      assert.equal(event.consumer_behavior.catchUpCursor, "sequence_number");
    }

    assert.deepEqual(contract.reconnect, {
      transportCursor: "last_event_id",
      eventDeduplication: "event_id",
      messageDeduplication: "payload.message.id",
      gapDetection: "sequence_number",
    });
  });
});
