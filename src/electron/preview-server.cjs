const { createReadStream } = require("node:fs");
const { realpath, stat } = require("node:fs/promises");
const { createServer } = require("node:http");
const { extname, join, relative, resolve } = require("node:path");

const TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
});

class PreviewServer {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.server = undefined;
    this.url = undefined;
    this.startPromise = undefined;
  }

  getStatus() {
    return this.url === undefined
      ? { state: "stopped" }
      : { state: "running", url: this.url };
  }

  async start() {
    if (this.url !== undefined) return this.getStatus();
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this.startOnce();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async startOnce() {
    const root = await realpath(this.rootPath);
    if (!(await stat(join(root, "index.html"))).isFile()) {
      throw new Error("Preview entry is unavailable");
    }
    this.server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
        const candidate = resolve(root, `.${requested}`);
        const fromRoot = relative(root, candidate);
        if (fromRoot.startsWith("..") || fromRoot.includes("\0")) {
          response.writeHead(403).end("Forbidden"); return;
        }
        const real = await realpath(candidate);
        if (relative(root, real).startsWith("..") || !(await stat(real)).isFile()) {
          response.writeHead(404).end("Not found"); return;
        }
        response.writeHead(200, {
          "content-type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'",
          "x-content-type-options": "nosniff",
        });
        createReadStream(real).pipe(response);
      } catch {
        response.writeHead(404).end("Not found");
      }
    });
    await new Promise((resolveListen, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = this.server.address();
    if (typeof address !== "object" || address === null) throw new Error("Preview address is unavailable");
    this.url = `http://127.0.0.1:${address.port}/`;
    return this.getStatus();
  }

  async stop() {
    if (this.startPromise !== undefined) await this.startPromise;
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (server === undefined) return this.getStatus();
    await new Promise((resolveClose) => server.close(resolveClose));
    return this.getStatus();
  }
}

module.exports = { PreviewServer };
