import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GenericContainer, Wait } from "testcontainers";

import { RedisInfrastructure } from "../../services/backend/src/common/redis/redis.infrastructure.js";

const REDIS_PORT = 6379;

describe("Stage 1 DR-02 Redis infrastructure", { timeout: 120_000 }, () => {
  it("supports cache operations and Redis Streams consumer groups", async () => {
    const container = await new GenericContainer("redis:7.4-alpine")
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(REDIS_PORT)}`;
    const redis = await RedisInfrastructure.connect(url);

    try {
      await redis.setCache("stage1:cache", "cache-ok", { ttlSeconds: 60 });
      assert.equal(await redis.getCache("stage1:cache"), "cache-ok");

      await redis.ensureConsumerGroup("stage1:stream", "stage1-group");
      await redis.ensureConsumerGroup("stage1:stream", "stage1-group");
      const id = await redis.publishStream("stage1:stream", {
        payload: "stream-ok",
        type: "stage1.probe",
      });
      assert.match(id, /^\d+-\d+$/);

      const messages = await redis.readGroup({
        consumer: "stage1-consumer",
        group: "stage1-group",
        stream: "stage1:stream",
      });
      assert.match(JSON.stringify(messages), /stream-ok/);
    } finally {
      await redis.close();
      await container.stop();
    }
  });
});
