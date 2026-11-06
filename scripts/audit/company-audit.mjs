#!/usr/bin/env node
/**
 * Read-only internal audit of the company: prints one JSON document with the facts a weekly
 * review needs. Runs INSIDE the container (node:sqlite, /data); changes nothing.
 *
 *   docker cp scripts/audit/company-audit.mjs agentco-agentco-1:/tmp/company-audit.mjs
 *   docker exec agentco-agentco-1 node /tmp/company-audit.mjs [--days 7]
 *
 * Secrets: the API token is read from the container's environment and never printed; task and
 * memory text is truncated. The weekly scheduled audit (docs/DEPLOY.md › Weekly audit) feeds
 * this output to Claude, which writes the report.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.DATA_DIR || "/data";
const days = Number(process.argv.includes("--days") ? process.argv[process.argv.indexOf("--days") + 1] : 7) || 7;
const now = new Date();
const since = new Date(now.getTime() - days * 86_400_000).toISOString();
const ageH = (iso) => (iso ? Math.round((now.getTime() - Date.parse(iso)) / 3_600_000) : null);
const cut = (s, n = 160) => (s == null ? null : String(s).replace(/\s+/g, " ").slice(0, n));
const round = (x, d = 4) => Math.round((Number(x) || 0) * 10 ** d) / 10 ** d;

const db = new DatabaseSync(join(DATA, "agentco.db"), { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const hasTable = (name) => !!one("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?", name);

async function api(path) {
  try {
    const port = process.env.PORT || 3000;
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${process.env.APP_AUTH_TOKEN ?? ""}` } });
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

const agents = all("SELECT id, name, title, tier, cognition, status, affect, calibration, monthly_budget_usd, updated_at FROM agents");
const agentName = Object.fromEntries(agents.map((a) => [a.id, `${a.name} (${a.title})`]));
const taskNo = Object.fromEntries(all("SELECT id, number FROM tasks").map((t) => [t.id, t.number]));

const company = await api("/api/company");
const metrics = await api("/api/metrics/overview");

// ── Work
const tasksByStatus = Object.fromEntries(all("SELECT status, COUNT(*) n FROM tasks GROUP BY status").map((r) => [r.status, r.n]));
const open = all(`SELECT id, number, title, status, assignee_id, parent_task_id, root_task_id, attempts, state, updated_at, created_at FROM tasks
  WHERE status IN ('todo','in_progress','waiting','blocked') ORDER BY updated_at`);
const stuck = open
  .filter((t) => ageH(t.updated_at) >= 24 && (t.status === "blocked" || t.status === "waiting"))
  .map((t) => ({ task: `T-${t.number}`, status: t.status, title: cut(t.title, 100), assignee: agentName[t.assignee_id] ?? t.assignee_id, idleHours: ageH(t.updated_at) }));
const escalations = all("SELECT id, root_task_id, status, created_at FROM tasks WHERE json_extract(state, '$.kind') = 'escalation' AND created_at >= ?", since);
const escalationsByRoot = {};
for (const e of escalations) escalationsByRoot[`T-${taskNo[e.root_task_id]}`] = (escalationsByRoot[`T-${taskNo[e.root_task_id]}`] ?? 0) + 1;
const createdThisPeriod = one("SELECT COUNT(*) n FROM tasks WHERE created_at >= ?", since).n;
const doneThisPeriod = one("SELECT COUNT(*) n FROM tasks WHERE status = 'done' AND completed_at >= ?", since).n;
const failedThisPeriod = all("SELECT number, title, error FROM tasks WHERE status = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10", since).map((t) => ({
  task: `T-${t.number}`, title: cut(t.title, 90), error: cut(t.error, 200),
}));

// ── Board queue
const pending = all("SELECT id, kind, summary, requested_by, task_id, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at").map((a) => ({
  kind: a.kind, summary: cut(a.summary, 200), requestedBy: agentName[a.requested_by] ?? a.requested_by, task: a.task_id ? `T-${taskNo[a.task_id]}` : null, ageHours: ageH(a.created_at),
}));
const decided = Object.fromEntries(all("SELECT status, COUNT(*) n FROM approvals WHERE decided_at >= ? GROUP BY status", since).map((r) => [r.status, r.n]));
const questionsAsked = one("SELECT COUNT(*) n FROM approvals WHERE kind = 'question' AND created_at >= ?", since).n;

// ── Runs, model errors, spend
const runs = all("SELECT status, engine, error, cost_usd FROM runs WHERE created_at >= ?", since);
const runStatus = runs.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
const runErrors = {};
for (const r of runs.filter((r) => r.error)) {
  const key = cut(r.error, 140);
  runErrors[key] = (runErrors[key] ?? 0) + 1;
}
const modelErrors = all("SELECT model, error, COUNT(*) n FROM spans WHERE kind = 'llm' AND status = 'error' AND started_at >= ? GROUP BY model, substr(error, 1, 120) ORDER BY n DESC LIMIT 10", since).map((r) => ({
  model: r.model, count: r.n, error: cut(r.error, 200),
}));
const llmCalls = one("SELECT COUNT(*) n FROM spans WHERE kind = 'llm' AND started_at >= ?", since).n;
const spend = {
  periodUsd: round(one("SELECT COALESCE(SUM(cost_usd),0) c FROM spend WHERE at >= ?", since).c),
  frontierEquivalentUsd: round(one("SELECT COALESCE(SUM(frontier_cost_usd),0) c FROM spend WHERE at >= ?", since).c),
  byTier: all("SELECT tier, ROUND(SUM(cost_usd),4) usd, COUNT(*) calls FROM spend WHERE at >= ? GROUP BY tier ORDER BY usd DESC", since),
  byModel: all("SELECT model, ROUND(SUM(cost_usd),4) usd, COUNT(*) calls FROM spend WHERE at >= ? GROUP BY model ORDER BY usd DESC", since),
  topAgents: all("SELECT agent_id, ROUND(SUM(cost_usd),4) usd FROM spend WHERE at >= ? GROUP BY agent_id ORDER BY usd DESC LIMIT 5", since).map((r) => ({ agent: agentName[r.agent_id] ?? r.agent_id, usd: r.usd })),
  byDay: all("SELECT substr(at,1,10) day, ROUND(SUM(cost_usd),4) usd FROM spend WHERE at >= ? GROUP BY day ORDER BY day", since),
};

// ── People (agents)
const parse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const agentHealth = agents
  .filter((a) => a.status !== "terminated")
  .map((a) => ({ agent: agentName[a.id], tier: a.tier, status: a.status, ...parse(a.affect), calibration: parse(a.calibration) }))
  .filter((a) => a.frustration > 0.5 || a.valence < -0.3 || a.status === "paused" || (a.calibration?.samples >= 5 && Math.abs((a.calibration.meanConfidence ?? 0) - (a.calibration.successRate ?? 0)) > 0.3));
const headcount = Object.fromEntries(all("SELECT status, COUNT(*) n FROM agents GROUP BY status").map((r) => [r.status, r.n]));
const hires = all("SELECT name, title, created_by, created_at FROM agents WHERE created_at >= ?", since).map((a) => ({ agent: `${a.name} (${a.title})`, by: agentName[a.created_by] ?? a.created_by }));

// ── Company memory hygiene
const STALL = /verify the accountable person|routing authority or delivery is uncertain|keep the (task|work)[^.]{0,40}blocked/i;
const BAD = /\b(blocked|early stop|not acceptable|escalat)\b/i;
const mems = all("SELECT scope, kind, content, created_at, access_count FROM memories");
const memory = {
  total: mems.length,
  addedThisPeriod: mems.filter((m) => m.created_at >= since).length,
  byScopeKind: mems.reduce((acc, m) => ((acc[`${m.scope}/${m.kind}`] = (acc[`${m.scope}/${m.kind}`] ?? 0) + 1), acc), {}),
  stallLessons: mems.filter((m) => STALL.test(m.content)).map((m) => ({ scope: m.scope, recalled: m.access_count, text: cut(m.content, 200) })),
  badOutcomeEpisodeShare: round(mems.filter((m) => m.kind === "episodic").length ? mems.filter((m) => m.kind === "episodic" && BAD.test(m.content)).length / mems.filter((m) => m.kind === "episodic").length : 0, 2),
  mostRecalledGlobal: all("SELECT kind, content, access_count FROM memories WHERE scope = 'global' ORDER BY access_count DESC LIMIT 5").map((m) => ({ kind: m.kind, recalled: m.access_count, text: cut(m.content, 160) })),
  archived: hasTable("memories_archive") ? one("SELECT COUNT(*) n FROM memories_archive").n : 0,
};
const blackboard = all("SELECT key, value, updated_at FROM blackboard").map((b) => ({ key: b.key, value: cut(b.value, 140), ageHours: ageH(b.updated_at) }));
let workspaceFiles = 0;
const walk = (d) => {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (statSync(p).isFile()) workspaceFiles++;
  }
};
walk(join(DATA, "workspaces"));

console.log(
  JSON.stringify(
    {
      generatedAt: now.toISOString(),
      periodDays: days,
      company: company.error
        ? company
        : {
            name: company.settings?.name,
            paused: company.settings?.paused,
            headcount: company.headcount,
            dailyBudgetUsd: company.settings?.dailyBudgetUsd,
            monthlyBudgetUsd: company.settings?.monthlyBudgetUsd,
            spentTodayUsd: round(company.spentTodayUsd),
            spentMonthUsd: round(company.spentMonthUsd),
            models: company.models?.tiers ?? company.models,
          },
      metrics: metrics.error ? metrics : { runSuccessRate: metrics.runSuccessRate ?? metrics.successRate, routingSavingsUsd: round(metrics.routingSavingsUsd) },
      work: { tasksByStatus, createdThisPeriod, doneThisPeriod, failedThisPeriod, openCount: open.length, stuck, escalationsThisPeriod: escalations.length, escalationsByObjective: escalationsByRoot },
      board: { pending, decidedThisPeriod: decided, questionsAskedThisPeriod: questionsAsked },
      runs: { thisPeriod: runs.length, byStatus: runStatus, topErrors: Object.entries(runErrors).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([error, count]) => ({ error, count })), llmCalls, modelErrors },
      spend,
      people: { headcount, hiresThisPeriod: hires, attention: agentHealth },
      memory,
      blackboard,
      workspaceFiles,
    },
    null,
    1,
  ),
);
