import {
  copyFile,
  mkdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(
  dirname(fileURLToPath(import.meta.url)),
);
const sourceRoot = join(projectRoot, "src", "electron");
const outputRoot = join(
  projectRoot,
  "dist",
  "electron-app",
  "electron",
);

// TypeScript 编译 Main 代码；这里复制 CommonJS Main/Preload 安全外壳。
// React Renderer 由 Vite 单独输出，避免把 Node 依赖打入页面。
await mkdir(outputRoot, { recursive: true });
await copyFile(
  join(sourceRoot, "main.cjs"),
  join(outputRoot, "main.cjs"),
);
await copyFile(
  join(sourceRoot, "preload.cjs"),
  join(outputRoot, "preload.cjs"),
);
