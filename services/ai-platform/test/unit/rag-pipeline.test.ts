import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPrompt, buildSources, rankChunks } from "../../src/rag-pipeline.js";

const ORG = "org-1";

function chunk(overrides) {
  return {
    organization_id: ORG,
    document_id: "doc",
    chunk_id: "chunk",
    chunk_no: 1,
    title: "Title",
    content: "Content",
    distance: 0.5,
    ...overrides,
  };
}

describe("rankChunks", () => {
  it("orders chunks by ascending L2 distance (closest first)", () => {
    const ranked = rankChunks(
      [
        chunk({ chunk_id: "far", distance: 0.9 }),
        chunk({ chunk_id: "near", distance: 0.1 }),
        chunk({ chunk_id: "mid", distance: 0.5 }),
      ],
      { organizationId: ORG },
    );

    assert.deepEqual(
      ranked.map((item) => item.chunk_id),
      ["near", "mid", "far"],
    );
  });

  it("drops chunks from other organizations (tenant isolation)", () => {
    const ranked = rankChunks(
      [
        chunk({ chunk_id: "own", organization_id: ORG, distance: 0.2 }),
        chunk({ chunk_id: "foreign", organization_id: "org-2", distance: 0.1 }),
      ],
      { organizationId: ORG },
    );

    assert.deepEqual(
      ranked.map((item) => item.chunk_id),
      ["own"],
    );
  });

  it("keeps only the top-K nearest chunks", () => {
    const ranked = rankChunks(
      [
        chunk({ chunk_id: "a", distance: 0.1 }),
        chunk({ chunk_id: "b", distance: 0.2 }),
        chunk({ chunk_id: "c", distance: 0.3 }),
      ],
      { organizationId: ORG, topK: 2 },
    );

    assert.deepEqual(
      ranked.map((item) => item.chunk_id),
      ["a", "b"],
    );
  });
});

describe("buildPrompt", () => {
  it("pins the assistant to the organization and forbids cross-tenant material", () => {
    const prompt = buildPrompt({
      query: "возврат",
      organizationId: ORG,
      chunks: [chunk({ chunk_id: "c1", distance: 0.1 })],
    });

    assert.match(prompt.system, new RegExp(ORG));
    assert.match(prompt.system, /других организаций/);
    assert.equal(prompt.organization_id, ORG);
    assert.equal(prompt.context.length, 1);
    assert.equal(prompt.context[0].ref, 1);
    assert.equal(prompt.context[0].chunk_id, "c1");
  });

  it("never embeds another organization's chunk into the context", () => {
    const prompt = buildPrompt({
      query: "возврат",
      organizationId: ORG,
      chunks: [
        chunk({ chunk_id: "own", organization_id: ORG, distance: 0.5 }),
        chunk({ chunk_id: "foreign", organization_id: "org-2", distance: 0.1 }),
      ],
    });

    assert.deepEqual(
      prompt.context.map((item) => item.chunk_id),
      ["own"],
    );
  });
});

describe("buildSources", () => {
  it("builds knowledge_chunk citations with title and excerpt", () => {
    const sources = buildSources([
      chunk({
        chunk_id: "c1",
        document_id: "d1",
        title: "Возврат",
        content: "Возврат оформляется в течение 14 дней.",
      }),
    ]);

    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0], {
      source_type: "knowledge_chunk",
      document_id: "d1",
      chunk_id: "c1",
      title: "Возврат",
      excerpt: "Возврат оформляется в течение 14 дней.",
    });
  });

  it("falls back to a document-based title when the chunk has none", () => {
    const [source] = buildSources([
      chunk({ chunk_id: "c1", document_id: "doc-42", title: null }),
    ]);
    assert.equal(source.title, "Документ doc-42");
  });

  it("returns a single 'none' source when there are no chunks", () => {
    const sources = buildSources([]);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source_type, "none");
  });
});
