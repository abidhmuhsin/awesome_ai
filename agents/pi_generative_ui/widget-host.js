/**
 * ============================================================================
 *  Widget Host Server — serves saved widget files for cross-origin fetch
 * ============================================================================
 *
 *  Widgets render via sandboxed srcdoc iframes (see ui/widgets.js), so this
 *  server has one job: serve saved widget files from /exports/ to the host
 *  page (which fetches them cross-origin to finalize a widget or trigger a
 *  download).
 *
 *  Kept on a separate port (3001) so the host page can fetch widget files
 *  even if it were on a different origin in the future.
 * ============================================================================
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXPORTS_DIR = join(__dirname, "exports");

const MIME = {
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

let started = false;

/**
 * Create and start the widget-host HTTP server. Idempotent — calling more
 * than once is a no-op. Exported so server.js can start it explicitly
 * (and surface startup errors) rather than relying on a side-effecting import.
 */
export function startWidgetHost() {
  if (started) return;
  started = true;

  // Read config here, not at module top: server.js loads .env after imports
  // evaluate, so module-level reads would miss WIDGET_PORT/PORT from .env.
  const PORT = process.env.WIDGET_PORT || 3001;
  const APP_PORT = process.env.PORT || 3000;

  // Only the app page (served from APP_PORT) may read files cross-origin.
  const ALLOWED_ORIGINS = new Set([
    `http://localhost:${APP_PORT}`,
    `http://127.0.0.1:${APP_PORT}`,
  ]);
  const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

  const server = createServer(async (req, res) => {
    // Foreign Host = DNS-rebinding probe → refuse.
    if (!ALLOWED_HOSTS.has(req.headers.host || "")) {
      res.writeHead(403);
      return res.end("forbidden");
    }

    // CORS: echo the origin only if it's the app page — never "*".
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (!url.pathname.startsWith("/exports/")) {
      res.writeHead(404);
      return res.end("not found");
    }

    // Only serve a basename — prevent path traversal out of EXPORTS_DIR.
    const filename = url.pathname.split("/").pop();
    if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      res.writeHead(400);
      return res.end("bad filename");
    }

    try {
      const data = await readFile(join(EXPORTS_DIR, filename));
      const ext = filename.match(/\.[^.]+$/)?.[0] || ".html";
      res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`  ✗ Widget host port ${PORT} is already in use.`);
      return;
    }
    throw err;
  });

  // 127.0.0.1 only — saved widgets are not for the LAN.
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`  🔒 Widget host (saved-file server): http://localhost:${PORT}`);
  });
}
