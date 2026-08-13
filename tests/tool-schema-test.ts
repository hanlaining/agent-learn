import assert from "node:assert/strict";
import test from "node:test";

import {
  isStrictObjectSchema,
  strictObjectSchema,
} from "../src/llm/tool-schema.js";

test("strictObjectSchema derives required from every property", () => {
  assert.deepEqual(
    strictObjectSchema({
      query: { type: "string" },
      limit: { type: "number" },
    }),
    {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  );
});

test("strictObjectSchema supports tools without arguments", () => {
  assert.deepEqual(strictObjectSchema({}), {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  });
});

test("isStrictObjectSchema accepts only complete strict schemas", () => {
  assert.equal(isStrictObjectSchema(strictObjectSchema({
    query: { type: "string" },
  })), true);

  const invalidSchemas: Record<string, unknown>[] = [
    { type: "object", properties: { query: {}, limit: {} }, required: ["query"], additionalProperties: false },
    { type: "object", properties: { query: {} }, required: ["query", "unknown"], additionalProperties: false },
    { type: "object", properties: { query: {} }, required: ["query", "query"], additionalProperties: false },
    { type: "object", properties: { query: {} }, required: ["query"] },
    { type: "array", properties: { query: {} }, required: ["query"], additionalProperties: false },
    { type: "object", properties: [], required: [], additionalProperties: false },
  ];

  for (const schema of invalidSchemas) {
    assert.equal(isStrictObjectSchema(schema), false);
  }
});
