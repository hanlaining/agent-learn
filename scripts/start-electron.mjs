import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

const projectRoot = dirname(
  dirname(fileURLToPath(import.meta.url)),
);
const environment = { ...process.env };

// 某些桌面开发环境会给终端继承该变量；Electron Main 必须在桌面模式启动。
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [projectRoot], {
  cwd: projectRoot,
  env: environment,
  stdio: "inherit",
  windowsHide: false,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

