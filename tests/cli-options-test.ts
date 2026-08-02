import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCliOptions,
} from "../src/cli/options.js";

test("解析 god-agent CLI 参数", () => {
  assert.deepEqual(parseCliOptions([]), {
    debug: false,
    help: false,
    version: false,
  });
  assert.deepEqual(
    parseCliOptions(["--debug", "--help"]),
    {
      debug: true,
      help: true,
      version: false,
    },
  );
  assert.deepEqual(parseCliOptions(["--version"]), {
    debug: false,
    help: false,
    version: true,
  });
});

test("拒绝未知 CLI 参数", () => {
  assert.throws(
    () => parseCliOptions(["--unknown"]),
    /Unknown option: --unknown/,
  );
});
