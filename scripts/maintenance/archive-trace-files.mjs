#!/usr/bin/env node
// Move the company-drive files that given traces (objectives) wrote into DATA_DIR/archive/<stamp>/,
// so agents stop reading drafts from abandoned runs as sources. Reversible: files are moved, never deleted.
//
//   node scripts/maintenance/archive-trace-files.mjs <traceId>...            dry run: what would move
//   node scripts/maintenance/archive-trace-files.mjs --apply <traceId>...    move + manifest.json
//   node scripts/maintenance/archive-trace-files.mjs --private ...          also the authors' private drafts
//   node scripts/maintenance/archive-trace-files.mjs --restore <stamp>       move them back
//
// Shared files by default; with --private also the private files those traces wrote (a stale draft
// is still found by its author's plain-path reads). A file that any OTHER trace also wrote is left
// alone (someone else's work may depend on it).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA = resolve(process.env.DATA_DIR ?? "/data");
const SHARED = join(DATA, "workspaces", "shared");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const withPrivate = args.includes("--private");
const WS = join(DATA, "workspaces");
const restoreAt = args.indexOf("--restore");

function inside(root, path) {
  const abs = resolve(root, path);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path escapes ${root}: ${path}`);
  return abs;
}

if (restoreAt >= 0) {
  const stamp = args[restoreAt + 1];
  if (!stamp) throw new Error("--restore needs the archive stamp");
  const dir = inside(join(DATA, "archive"), stamp);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  let restored = 0;
  for (const f of manifest.files) {
    const where = f.agentId ? join(f.agentId, f.rel) : join("shared", f.rel);
    const back = inside(WS, where);
    if (existsSync(back)) {
      console.log(`skip (a file is there again): ${where}`);
      continue;
    }
    mkdirSync(dirname(back), { recursive: true });
    renameSync(inside(dir, f.agentId ? join("private", f.agentId, f.rel) : join("shared", f.rel)), back);
    restored++;
  }
  console.log(JSON.stringify({ restored, of: manifest.files.length, from: dir }));
  process.exit(0);
}

const traces = args.filter((a) => !a.startsWith("--"));
if (traces.length === 0) throw new Error("give one or more trace ids");
const db = new DatabaseSync(join(DATA, "agentco.db"), { readOnly: true });
const pathOf = (row) => {
  let attrs = {};
  try {
    attrs = JSON.parse(row.attributes ?? "{}");
  } catch {}
  return typeof attrs["agentco.file.path"] === "string" ? attrs["agentco.file.path"] : (/^Wrote (\S+) \(/.exec(String(row.output ?? ""))?.[1] ?? "");
};
// A location: "shared/<rel>" or "<agentId>/<rel>" (a private file; a path with no area prefix was
// written before the drive became the default, i.e. privately).
const writes = db
  .prepare("SELECT trace_id, agent_id, output, attributes FROM spans WHERE kind = 'tool' AND name = 'tool.workspace_write_file' AND status = 'ok'")
  .all()
  .map((r) => {
    const path = pathOf(r);
    if (!path) return null;
    if (path.startsWith("shared/")) return { trace: String(r.trace_id), key: path, path, rel: path.slice(7), agentId: null };
    const rel = path.replace(/^private\//, "");
    return { trace: String(r.trace_id), key: `${r.agent_id}/${rel}`, path: `private/${rel} (${r.agent_id})`, rel, agentId: String(r.agent_id) };
  })
  .filter((w) => w && (withPrivate || w.agentId === null));
const mine = new Set(traces);
const otherKeys = new Set(writes.filter((w) => !mine.has(w.trace)).map((w) => w.key));
const byKey = new Map(writes.filter((w) => mine.has(w.trace)).map((w) => [w.key, w]));
const move = [];
const kept = [];
for (const w of [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const abs = inside(WS, w.agentId ? join(w.agentId, w.rel) : join("shared", w.rel));
  if (!existsSync(abs)) kept.push({ path: w.path, why: "already gone" });
  else if (otherKeys.has(w.key)) kept.push({ path: w.path, why: "another objective also wrote it" });
  else move.push(w);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(DATA, "archive", `${stamp}-drive`);
if (apply && move.length > 0) {
  for (const f of move) {
    const root = f.agentId ? inside(WS, f.agentId) : SHARED;
    const from = inside(root, f.rel);
    const to = inside(dir, f.agentId ? join("private", f.agentId, f.rel) : join("shared", f.rel));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    // Folders the move left empty would still show in listings: remove them (empty only — no data).
    for (let d = dirname(from); d !== root && d.startsWith(root + sep); d = dirname(d)) {
      if (readdirSync(d).length > 0) break;
      rmdirSync(d);
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), traces, files: move.map((f) => (f.agentId ? { rel: f.rel, agentId: f.agentId } : { rel: f.rel })) }, null, 1));
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", move: move.map((f) => f.path), kept, archive: apply && move.length ? dir : null, restore: apply && move.length ? `--restore ${stamp}-drive` : null }, null, 1));
