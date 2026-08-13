import assert from "node:assert/strict";
import test from "node:test";

import {
  isTurnCancelResult,
  parseTurnCancelParams,
} from "../src/runtime/turn-cancel.js";

test("解析 turn/cancel 参数", () => {
  assert.deepEqual(
    parseTurnCancelParams({ turnId: "turn-1" }),
    { turnId: "turn-1" },
  );

  assert.throws(
    () => parseTurnCancelParams({ turnId: "  " }),
    /turn\/cancel turnId must be a non-empty string/,
  );
});

test("识别 turn/cancel 成功结果", () => {
  assert.equal(
    isTurnCancelResult({
      turnId: "turn-1",
      cancelled: true,
    }),
    true,
  );
  assert.equal(
    isTurnCancelResult({
      turnId: "turn-1",
      cancelled: false,
    }),
    false,
  );
});
