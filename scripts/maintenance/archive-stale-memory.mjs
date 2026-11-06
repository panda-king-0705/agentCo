#!/usr/bin/env node
/**
 * Archive stale "company memory" that keeps teaching agents to stall — reversibly.
 *
 * Runs INSIDE the container (node:sqlite, /data). Pause the company first.
 *
 *   docker cp scripts/maintenance/archive-stale-memory.mjs agentco-agentco-1:/tmp/archive.mjs
 *   docker exec agentco-agentco-1 node /tmp/archive.mjs              # dry run: lists what would move
 *   docker exec agentco-agentco-1 node /tmp/archive.mjs --apply      # archive
 *   docker exec agentco-agentco-1 node /tmp/archive.mjs --restore <stamp>   # undo one archive
 *
 * Nothing is deleted. Archived memories and blackboard entries move to the `memories_archive` /
 * `blackboard_archive` tables of the same database (agents never read those), workspace files move
 * to /data/archive/<stamp>/workspaces/…, and /data/archive/<stamp>/manifest.json lists everything.
 *
 * What counts as stale (2026-11-06 live-loop clean-up, docs/DEPLOY.md › Maintenance):
 *  - lessons encoding the verify-everything-first stance (global and per-agent copies);
 *  - episodic memories of cancelled tasks, or recording a blocked / early-stopped / rejected outcome;
 *  - behaviour-shaping optimization insights from the broken period: "budget pressure → conservation"
 *    (budgets were raised) and "task OOD → delegate" (pushed one-line requests down the org);
 *  - blackboard entries announcing a blocked objective or status;
 *  - shared workspace files that are blocker reports or belong only to cancelled objectives.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const DATA = process.env.DATA_DIR || "/data";
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const restoreStamp = args.includes("--restore") ? args[args.indexOf("--restore") + 1] : null;

const db = new DatabaseSync(join(DATA, "agentco.db"));
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`CREATE TABLE IF NOT EXISTS memories_archive (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
  importance REAL NOT NULL, source_run_id TEXT, source_task_id TEXT, access_count INTEGER NOT NULL, created_at TEXT NOT NULL,
  last_accessed_at TEXT, archived_at TEXT NOT NULL, archive_stamp TEXT NOT NULL, archive_reason TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS blackboard_archive (
  key TEXT NOT NULL, value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived_at TEXT NOT NULL, archive_stamp TEXT NOT NULL, archive_reason TEXT NOT NULL, PRIMARY KEY (key, archive_stamp))`);

const MEMORY_COLS = ["id", "scope", "agent_id", "kind", "content", "tags", "importance", "source_run_id", "source_task_id", "access_count", "created_at", "last_accessed_at"];

if (restoreStamp) {
  restore(restoreStamp);
  process.exit(0);
}

const tasks = new Map(db.prepare("SELECT id, number, status FROM tasks").all().map((t) => [t.id, t]));
const byNumber = new Map([...tasks.values()].map((t) => [t.number, t]));

const VERIFY_FIRST = /verify the accountable person|routing authority or delivery is uncertain|keep the (task|work)[^.]{0,40}blocked/i;
const BAD_OUTCOME = /\b(blocked|early stop|not acceptable|escalat|could not complete)\b/i;
const STALE_INSIGHT = /^optimization insight \[[^\]]+\] tier=\w+: (budget pressure:|task OOD: no similar past episode)/;

function memoryReason(m) {
  if (VERIFY_FIRST.test(m.content)) return "verify-first lesson";
  if (m.kind === "procedural" && STALE_INSIGHT.test(m.content)) return "stale optimization insight";
  if (m.kind === "episodic") {
    const src = m.source_task_id ? tasks.get(m.source_task_id) : null;
    if (src?.status === "cancelled") return "episode of a cancelled task";
    if (BAD_OUTCOME.test(m.content)) return "episode of a blocked/early-stopped outcome";
  }
  return null;
}

const memories = db.prepare(`SELECT ${MEMORY_COLS.join(", ")} FROM memories`).all().map((m) => ({ ...m, reason: memoryReason(m) })).filter((m) => m.reason);
const blackboard = db
  .prepare("SELECT key, value, updated_by, updated_at FROM blackboard")
  .all()
  .filter((b) => b.key !== "welcome" && /^\s*blocked\b|\bBLOCKED\b/.test(b.value))
  .map((b) => ({ ...b, reason: "blocked-status entry" }));

const sharedRoot = join(DATA, "workspaces", "shared");
const files = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      const rel = relative(sharedRoot, p);
      const refs = [...e.name.matchAll(/T-?(\d+)/g)].map((m) => byNumber.get(Number(m[1]))).filter(Boolean);
      const blockerReport = /block/i.test(e.name) || /^\s*(status:\s*)?blocked\b/im.test(readFileSync(p, "utf8").slice(0, 600));
      const allCancelled = refs.length > 0 && refs.every((t) => t.status === "cancelled");
      if (blockerReport || allCancelled) files.push({ path: rel, reason: blockerReport ? "blocker report" : "output of cancelled objective(s) only" });
    }
  }
};
walk(sharedRoot);

const count = (list) => Object.entries(list.reduce((acc, x) => ((acc[x.reason] = (acc[x.reason] ?? 0) + 1), acc), {})).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
console.log(`memories   : ${memories.length} (${count(memories)}) of ${db.prepare("SELECT COUNT(*) n FROM memories").get().n}`);
console.log(`blackboard : ${blackboard.length} (${blackboard.map((b) => b.key).join(", ") || "none"})`);
console.log(`workspace  : ${files.length} shared file(s)`);
for (const f of files) console.log(`  - ${f.path}  [${f.reason}]`);
const kept = db.prepare(`SELECT content FROM memories WHERE id NOT IN (${memories.map(() => "?").join(",") || "''"})`).all(...memories.map((m) => m.id));
console.log(`kept       : ${kept.length} memories, e.g. ${kept.slice(0, 3).map((k) => JSON.stringify(k.content.slice(0, 80))).join(" | ") || "—"}`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to archive (reversible with --restore <stamp>).");
  process.exit(0);
}

const at = new Date().toISOString();
const stamp = at.replace(/[:.]/g, "-");
const dir = join(DATA, "archive", stamp);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ stamp, at, memories, blackboard, files }, null, 2));

db.exec("BEGIN IMMEDIATE");
try {
  const insM = db.prepare(`INSERT INTO memories_archive (${MEMORY_COLS.join(", ")}, archived_at, archive_stamp, archive_reason) VALUES (${MEMORY_COLS.map(() => "?").join(", ")}, ?, ?, ?)`);
  const delM = db.prepare("DELETE FROM memories WHERE id = ?");
  const delF = db.prepare("DELETE FROM memories_fts WHERE memory_id = ?");
  for (const m of memories) {
    insM.run(...MEMORY_COLS.map((c) => m[c]), at, stamp, m.reason);
    delF.run(m.id);
    delM.run(m.id);
  }
  const insB = db.prepare("INSERT INTO blackboard_archive (key, value, updated_by, updated_at, archived_at, archive_stamp, archive_reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const delB = db.prepare("DELETE FROM blackboard WHERE key = ?");
  for (const b of blackboard) {
    insB.run(b.key, b.value, b.updated_by, b.updated_at, at, stamp, b.reason);
    delB.run(b.key);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
for (const f of files) {
  const to = join(dir, "workspaces", "shared", f.path);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(join(sharedRoot, f.path), to);
}
pruneEmpty(sharedRoot);
console.log(`\nArchived as ${stamp} → ${dir}. Undo: node archive-stale-memory.mjs --restore ${stamp}`);

function restore(s) {
  const d = join(DATA, "archive", s);
  const manifest = JSON.parse(readFileSync(join(d, "manifest.json"), "utf8"));
  db.exec("BEGIN IMMEDIATE");
  try {
    const insM = db.prepare(`INSERT OR IGNORE INTO memories (${MEMORY_COLS.join(", ")}) VALUES (${MEMORY_COLS.map(() => "?").join(", ")})`);
    const insF = db.prepare("INSERT INTO memories_fts (content, tags, memory_id) VALUES (?, ?, ?)");
    for (const m of manifest.memories) {
      if (insM.run(...MEMORY_COLS.map((c) => m[c])).changes) insF.run(m.content, JSON.parse(m.tags).join(" "), m.id);
    }
    db.prepare("DELETE FROM memories_archive WHERE archive_stamp = ?").run(s);
    const insB = db.prepare("INSERT OR IGNORE INTO blackboard (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)");
    for (const b of manifest.blackboard) insB.run(b.key, b.value, b.updated_by, b.updated_at);
    db.prepare("DELETE FROM blackboard_archive WHERE archive_stamp = ?").run(s);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const f of manifest.files) {
    const from = join(d, "workspaces", "shared", f.path);
    if (!existsSync(from)) continue;
    const to = join(DATA, "workspaces", "shared", f.path);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  console.log(`Restored ${manifest.memories.length} memories, ${manifest.blackboard.length} blackboard entries, ${manifest.files.length} files from ${s}.`);
}

function pruneEmpty(root) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name);
    pruneEmpty(p);
    if (readdirSync(p).length === 0) rmdirSync(p);
  }
}
