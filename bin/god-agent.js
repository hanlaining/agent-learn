#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(
  new URL("../src/cli/main.ts", import.meta.url),
);

// npm bin 入口保持为普通 JavaScript；TypeScript CLI 由项目内 tsx 加载。
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    cliEntry,
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    windowsHide: false,
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
