#!/usr/bin/env node

import { runMockWebSocketLoadProbe } from "../services/edge-gateway/src/ws-load-probe.js";

const result = runMockWebSocketLoadProbe({
  connections: readIntegerEnv("EDGE_WS_PROBE_CONNECTIONS", 500),
  events: readIntegerEnv("EDGE_WS_PROBE_EVENTS", 200),
});

console.log(JSON.stringify(process.env.EDGE_WS_PROBE_VERBOSE === "1" ? result : summarize(result), null, 2));

function summarize(result) {
  const { delivered_by_connection, ...summary } = result;
  return {
    ...summary,
    min_delivered_per_connection:
      delivered_by_connection.length > 0 ? Math.min(...delivered_by_connection) : 0,
    max_delivered_per_connection:
      delivered_by_connection.length > 0 ? Math.max(...delivered_by_connection) : 0,
  };
}

function readIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
