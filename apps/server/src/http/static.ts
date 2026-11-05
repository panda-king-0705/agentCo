/** Static console hosting: apps/web/dist with SPA fallback, and a friendly page when it is not built. */
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export const NOT_BUILT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AgentCo console not built</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#1b1b1f}code{background:#eee;padding:.1rem .35rem;border-radius:4px}</style></head>
<body><h1>The AgentCo console is not built yet</h1>
<p>The API is running. Build the console once with:</p>
<p><code>npm run build:web</code></p>
<p>then reload this page. API: <a href="/api/health"><code>/api/health</code></a>, <a href="/api/company"><code>/api/company</code></a>.</p></body></html>`;

/** Serves `pathname` from `distDir`; unknown non-asset paths fall back to index.html (SPA). */
export async function serveStatic(distDir: string, pathname: string, res: ServerResponse, headOnly = false): Promise<void> {
  const root = resolve(distDir);
  const index = join(root, "index.html");
  if (!existsSync(index)) return send(res, 200, "text/html; charset=utf-8", NOT_BUILT_PAGE, "no-cache", headOnly);

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, "text/plain; charset=utf-8", "bad path", "no-cache", headOnly);
  }
  const candidate = resolve(root, "." + normalize("/" + decoded));
  const inside = candidate === root || candidate.startsWith(root + sep);
  const isFile = inside && existsSync(candidate) && statSync(candidate).isFile();
  if (isFile) {
    const type = TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream";
    const hashed = /[.-][A-Za-z0-9_]{8,}\.(js|css|woff2)$/.test(candidate);
    return send(res, 200, type, await readFile(candidate), hashed ? "public, max-age=31536000, immutable" : "no-cache", headOnly);
  }
  // A missing asset (has an extension) is a real 404; any other path is a client-side route.
  if (extname(decoded)) return send(res, 404, "text/plain; charset=utf-8", "not found", "no-cache", headOnly);
  return send(res, 200, "text/html; charset=utf-8", await readFile(index), "no-cache", headOnly);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, cache: string, headOnly: boolean): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), "cache-control": cache });
  res.end(headOnly ? undefined : body);
}
