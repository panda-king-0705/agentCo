#!/usr/bin/env node
// Move the company-drive files that given traces (objectives) wrote into DATA_DIR/archive/<stamp>/,
// so agents stop reading drafts from abandoned runs as sources. Reversible: files are moved, never deleted.
//
//   node scripts/maintenance/archive-trace-files.mjs <traceId>...            dry run: what would move
//   node scripts/maintenance/archive-trace-files.mjs --apply <traceId>...    move + manifest.json
//   node scripts/maintenance/archive-trace-files.mjs --restore <stamp>       move them back
//
// Only shared/ files are moved (private notes stay with their author), and a file that any OTHER
// trace also wrote is left alone (someone else's work may depend on it).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA = resolve(process.env.DATA_DIR ?? "/data");
const SHARED = join(DATA, "workspaces", "shared");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
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
    const back = inside(SHARED, f.rel);
    if (existsSync(back)) {
      console.log(`skip (a file is there again): shared/${f.rel}`);
      continue;
    }
    mkdirSync(dirname(back), { recursive: true });
    renameSync(inside(dir, join("shared", f.rel)), back);
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
const writes = db
  .prepare("SELECT trace_id, output, attributes FROM spans WHERE kind = 'tool' AND name = 'tool.workspace_write_file' AND status = 'ok'")
  .all()
  .map((r) => ({ trace: String(r.trace_id), path: pathOf(r) }))
  .filter((w) => w.path.startsWith("shared/"));
const mine = new Set(traces);
const otherPaths = new Set(writes.filter((w) => !mine.has(w.trace)).map((w) => w.path));
const candidates = [...new Set(writes.filter((w) => mine.has(w.trace)).map((w) => w.path))].sort();
const move = [];
const kept = [];
for (const path of candidates) {
  const rel = path.slice("shared/".length);
  const abs = inside(SHARED, rel);
  if (!existsSync(abs)) kept.push({ path, why: "already gone" });
  else if (otherPaths.has(path)) kept.push({ path, why: "another objective also wrote it" });
  else move.push({ path, rel });
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(DATA, "archive", `${stamp}-drive`);
if (apply && move.length > 0) {
  for (const f of move) {
    const to = inside(dir, join("shared", f.rel));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(inside(SHARED, f.rel), to);
    // Folders the move left empty would still show in listings: remove them (empty only — no data).
    for (let d = dirname(inside(SHARED, f.rel)); d !== SHARED && d.startsWith(SHARED + sep); d = dirname(d)) {
      if (readdirSync(d).length > 0) break;
      rmdirSync(d);
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), traces, files: move.map((f) => ({ rel: f.rel })) }, null, 1));
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", move: move.map((f) => f.path), kept, archive: apply && move.length ? dir : null, restore: apply && move.length ? `--restore ${stamp}-drive` : null }, null, 1));
