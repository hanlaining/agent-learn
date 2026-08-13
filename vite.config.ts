import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, "src", "electron", "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(
      projectRoot,
      "dist",
      "electron-app",
      "electron",
      "renderer",
    ),
    emptyOutDir: true,
  },
});
