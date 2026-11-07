/**
 * Metacognition › Cognitive Control (∝ from Confidence) → Decomposition and
 * Candidate Solutions (Solution 1 High Cost, Solution 2 Low Cost, Solution 3
 * Low Effort). One agent-tier model call proposes both; Role Arrangement
 * assigns each subprocess. Control level c = clamp(α·uncertainty) (Q4), raised
 * by OOD constraint pressure (finer decomposition, Q2).
 */
import type { Agent } from "../../../../../../packages/shared/src/index.ts";
import { arr, bool, num, obj, oneOf, str } from "../../coerce.ts";
import { oneLine, truncate } from "../../text.ts";
import { Q2_OOD, Q4_CONTROL, Q6_CANDIDATES, q4ControlLevel, type CandidateName } from "../interpretation.ts";
import { block, llmJson, type BrainRun } from "../runtime.ts";
import { candidatePool, namedCandidates, scoreCandidates, type Candidate } from "../self-management/role-arrangement.ts";
import type { Competence } from "./self-ability.ts";
import type { ProblemDefinition, Understanding } from "./target-understanding.ts";
import { isHiringRequest, normTitle } from "./solving-evaluation.ts";
import { describeHire, objectiveHires } from "../../../tools/builtins/hiring.ts";
import { contractList, type Assertion } from "./validation.ts";
import { overlap } from "../../text.ts";

export interface Subprocess {
  /**
   * 1 = handed out now; 2 = needs the round-1 parts' output (assembling, reconciling, reviewing):
   * handed out only after every round-1 part is done, with their results in its brief.
   */
  round?: 1 | 2;
  /** The assignee is an owner the request names (never trimmed by the candidate's subprocess share). */
  named?: boolean;
  title: string;
  description: string;
  value: number;
  estCostUsd: number;
  acceptanceCriteria: string;
  /** The contract statements (A1…) this part makes true (validation.ts). */
  covers?: string[];
  suggestedAssigneeId: string | null;
  assigneeId: string | null;
  fit: number | null;
  taskId: string | null;
}

export interface CandidateSolution {
  name: CandidateName;
  label: string;
  approach: string;
  estCostUsd: number;
  expectedValue: number;
  meetsCriteria: boolean;
}

export interface ControlOutput {
  controlLevel: number;
  maxSubprocesses: number;
  mode: "direct" | "delegate";
  subprocesses: Subprocess[];
  candidates: CandidateSolution[];
  rationale: string;
}

/** c = clamp(α·uncertainty) + pressure boost (each constraint-pressure signal decomposes finer). */
export function controlLevel(uncertainty: number, pressureSignals = 0): number {
  return Math.min(1, q4ControlLevel(uncertainty) + Q2_OOD.controlBoostPerSignal * Math.max(0, pressureSignals));
}

export function maxSubprocessesFor(c: number, essentialOnly: boolean, namedOwners = 0): number {
  const base = essentialOnly ? 1 : 1 + Math.round(Q4_CONTROL.granularity * c);
  const named = namedOwners > 0 ? namedOwners + (namedOwners >= 2 ? Q4_CONTROL.namedRound2Slack : 0) : 0;
  return Math.max(base, Math.min(Q4_CONTROL.maxParts, named));
}

/** A step that works on the other parts' output: assemble/merge/reconcile/review … the sections/drafts/inputs. */
const DEPENDENT_VERB = /\b(assembl\w*|compil\w*|merg\w*|integrat\w*|consolidat\w*|reconcil\w*|review\w*|stitch\w*|collat\w*|combin\w*|proofread\w*|sign[- ]?off|final (edit|check|qa|pass))\b/i;
const DEPENDENT_OBJECT = /\b(sections?|parts?|drafts?|inputs?|outputs?|deliverables?|contributions?|results|one[- ]pager?|one[- ]page|final (plan|document|doc|page|version))\b/i;

export function isDependentStep(title: string, description: string): boolean {
  return DEPENDENT_VERB.test(title) && DEPENDENT_OBJECT.test(`${title} ${description}`);
}

/** Round 2 only makes sense with round-1 work to wait for: a plan that is all round 2 runs as one round. */
export function settleRounds(subprocesses: Subprocess[]): Subprocess[] {
  if (subprocesses.length < 2 || subprocesses.every((s) => s.round === 2)) for (const s of subprocesses) s.round = 1;
  return subprocesses;
}

export function coerceSubprocesses(json: Record<string, unknown>, max: number, fallbackValue: number): Subprocess[] {
  const out: Subprocess[] = [];
  for (const raw of arr(json.subprocesses ?? json.subtasks)) {
    const s = obj(raw);
    const title = str(s.title, "", 140);
    if (!title) continue;
    const description = str(s.description, title, 2000);
    const given = Number(s.round);
    out.push({
      round: given === 2 ? 2 : given === 1 ? 1 : isDependentStep(title, description) ? 2 : 1,
      named: false,
      title: truncate(title, 140),
      description,
      value: num(s.value, fallbackValue, 0, 1000),
      estCostUsd: num(s.estCostUsd ?? s.cost, 0.05, 0.001, 50),
      acceptanceCriteria: str(s.acceptanceCriteria, `A concrete written deliverable for "${truncate(title, 80)}"`, 600),
      covers: arr(s.covers)
        .map((c) => String(c).trim().toUpperCase())
        .filter((c) => /^A\d+$/.test(c)),
      suggestedAssigneeId: typeof s.assigneeId === "string" && s.assigneeId ? s.assigneeId : null,
      assigneeId: null,
      fit: null,
      taskId: null,
    });
    if (out.length >= max) break;
  }
  return settleRounds(out);
}

/** Always the diagram's three candidates, in order, with defaults scaled from the task. */
export function coerceCandidates(json: Record<string, unknown>, taskValue: number, taskCost: number): CandidateSolution[] {
  const given = arr(json.candidates).map(obj);
  const scale: Record<CandidateName, { cost: number; value: number }> = {
    high_cost: { cost: 2, value: 1 },
    low_cost: { cost: 1, value: 0.8 },
    low_effort: { cost: 0.3, value: 0.5 },
  };
  return Q6_CANDIDATES.map((c, i) => {
    const match = given.find((g) => oneOf(g.name, [c.name] as const, "x" as never) === c.name) ?? given[i] ?? {};
    const d = scale[c.name];
    return {
      name: c.name,
      label: c.label,
      approach: str(match.approach, c.approach, 400),
      estCostUsd: num(match.estCostUsd ?? match.cost, Math.max(0.005, taskCost * d.cost), 0.001, 100),
      expectedValue: num(match.expectedValue ?? match.value, taskValue * d.value, 0, 1000),
      meetsCriteria: bool(match.meetsCriteria, true),
    };
  });
}

function reportView(run: BrainRun, a: Agent): { id: string; title: string; mandate: string; department: string } {
  return { id: a.id, title: a.title, mandate: truncate(a.identity.mission, 160), department: run.platform.org.departmentName(a.departmentId) };
}

export interface DecomposeArgs {
  problem: ProblemDefinition;
  understanding: Understanding;
  competence: Competence;
  uncertainty: number;
  calibrated: number;
  feedback: string[];
  preferDelegation: boolean;
  pressureSignals: number;
  /** Data-driven Analysis: optimization insights + past-cost notes for the prompt. */
  lessons: string[];
  /** The objective's contract (root only): what "done" means, fixed before the work starts. */
  contract?: Assertion[];
}

/** Blocks: decomposition (+ role arrangement) and candidate solutions, from one agent-tier call. */
export async function cognitiveControl(run: BrainRun, a: DecomposeArgs): Promise<ControlOutput> {
  const c = controlLevel(a.uncertainty, a.pressureSignals);
  const reports = run.platform.org.directReports(run.agent.id).filter((r) => r.status !== "terminated" && r.status !== "paused");
  const canDelegate = reports.length > 0 && run.platform.tools.specsFor(run.agent).some((t) => t.name === "delegate_task");
  const task = run.task!;
  // Owners the request names (the Board's split) each get a part: the cap never merges them away.
  // A revision after parts were delivered fixes what the feedback names — it does not redo them
  // (2026-11-07, test 4: a "read it back and count the words" verdict re-delegated all four parts, $1.90).
  const delivered = a.feedback.length > 0 ? deliveredParts(run, task.id) : [];
  // Owners the request names each get a part on the first plan; a fix round only goes to whoever a fix concerns.
  const owners = canDelegate && task.state.kind !== "escalation" && delivered.length === 0 ? namedOwners(run, reports, `${task.title} ${task.description}`) : [];
  const named = owners.map((o) => o.agent);
  const max = maxSubprocessesFor(c, run.drives.essentialOnly, named.length);
  const hires = objectiveHires(run.platform.tasks, run.platform.tasks.get(task.id) ?? task).filter((h) => h.status !== "declined");
  const hiring = canDelegate && isHiringRequest(`${task.title} ${task.description}`) && hires.length === 0;
  // What is already on the drive, so the plan names paths that update existing documents in place
  // (2026-11-07, test 4 rerun: briefs named no path, and every section got a second and third copy).
  const onDrive = driveOverview(run);

  const decomposition = await block(
    run,
    "metacognition.cognitive_control.decomposition",
    `Decomposing T-${task.number} (control ${c.toFixed(2)}, ≤${max} parts)`,
    async (span) => {
      const json = await llmJson(run, {
        stage: "metacognition.cognitive_control",
        span,
        instructions:
          `Problem: ${a.problem.problem}\nSuccess criteria: ${a.problem.successCriteria.join("; ")}\nUnderstanding: ${truncate(a.understanding.summary, 400)}\n` +
          (a.feedback.length ? `Address this feedback: ${a.feedback.join("; ")}\n` : "") +
          (delivered.length
            ? `Already delivered — keep these, do NOT redo them:\n${delivered.join("\n")}\n` +
              'Fix only what the feedback names, with as few parts as possible: send a fix only to the owner whose part it concerns (title it "Fix: …" and say exactly what to change), and do small fixes yourself (mode "direct"): an edit to the assembled page, a count, a note of open points. Points that only the Board can decide are not fixes — list them in your result.\n'
            : "") +
          (canDelegate
            ? `Your direct reports:\n${reports.map((r) => `- ${r.id}: ${r.title} — ${oneLine(r.identity.mission, 120)}`).join("\n")}\n` +
              `Decompose into at most ${max} subprocesses, each for ONE report (assigneeId), with value 0-1000, estCostUsd and acceptanceCriteria; mode "delegate". ` +
              "Write acceptance criteria about content — what must be covered, correct and consistent — not formatting (exact heading counts, tag placement, layout). Keep them checkable with the assignee's tools: the file tools confirm every save and report word, line and character counts, and the reviewer sees the saved files themselves, so never ask for a read-back, a pasted copy or a separate word count. " +
              "If the request names a department or person (\"have Finance…\", \"ask the CTO…\"), assign that part to them. " +
              "Give each part to the report whose field it is — figures, budgets and spend to Finance; wording and legal risk to Legal — and do not bundle different fields into one part. A review or check never goes to the person whose work it checks: give it to someone else, or leave it out and review it yourself when you are resumed. " +
              (owners.length
                ? `The request names these owners — give each of them their own part (at least one part each): ${owners.map((o) => `${o.agent.id} (${o.agent.title}${o.via ? ` — ${o.via} is in their team; the part is for them` : ""})`).join(", ")}. `
                : "") +
              // Founder, 2026-11-07: "managers hire, recruiter sources".
              (hiring
                ? "Hiring: the head of the team the new hire joins makes the hire — hire_agent places people only in the hirer's own team and takes monthlyBudgetUsd and firstTask (their first assignment, with the exact file path). The budget is the new hire's monthly model budget, set by the hirer: the catalog has no prices. A recruiter in People finds and recommends the candidate first (catalog id and why). Plan the recommendation as round 1 (to the head of People, for their recruiter) and the hire — with budget and first task — as round 2 (to the receiving department's head). The recommendation step only recommends; the hire step uses the request's own budget and first task word for word (a \"$10 monthly budget\" is $10, not \"up to $10\"). "
                : "") +
              (hires.length ? `Already done on this objective: ${hires.map(describeHire).join("; ")}. Do not plan another hire. ` : "") +
              (a.contract?.length
                ? `What "done" means for this objective — fixed before the work starts; an independent checker judges the finished work against exactly these: ${contractList(a.contract)}. Give every part "covers": the ids of the statements it makes true; together the parts cover all of them, and each part's acceptance criteria come from its statements. `
                : "") +
              "Carry the request's own figures into the parts word for word — budgets, word counts, dates, file paths. " +
              "A document for outsiders (investors, customers) holds only what they should read: never brief anyone to add review notes, condition lists or change logs to it — those go in the review file. A part that changes an existing document names the section(s) to change; its owner edits them in place. " +
              "Name the exact file path each part saves to in its description (e.g. launch-plan/finance.md), and the path of the combined document in the round-2 step. If the same document already exists on the drive (listed below), reuse its path: saving replaces it and keeps the previous version. Never ask for a second copy of a document under another name. " +
              'Parts that need other parts\' output — assembling, merging, reconciling, reviewing, final QA — are round 2 ("round":2): they are handed out only after every round-1 part is done, and their owner gets those results. You may instead do the assembly yourself: you are resumed with every part\'s result when they finish. ' +
              "Work that spans several departments' expertise (e.g. marketing + pricing + engineering) is delegated: one part per owning report — do not write other departments' parts yourself; reports run on cheaper models, so delegating is usually cheaper than doing it all yourself. " +
              (a.preferDelegation ? "Prefer delegating: your own competence is limited here. " : "") +
              `Use mode "direct" (no subprocesses) when you can do it yourself quickly with your own tools — e.g. recording a fact, a short note or decision, a lookup — never split such a task across reports.\n` +
              (task.state.kind === "escalation" ? 'This is a report\'s escalation: answer it yourself (mode "direct") with a decision or guidance unless the fix needs another report\'s work.\n' : "")
            : `You have no one to delegate to: mode "direct", subprocesses are your own steps (at most ${max}).\n`) +
          (onDrive ? `Files on the company drive (newest first):\n${onDrive}\n` : "") +
          (a.lessons.length ? `From past runs:\n${a.lessons.slice(0, 5).map((l) => `- ${l}`).join("\n")}\n` : "") +
          "Also give exactly three candidate solutions: high_cost (thorough: higher tier, more steps, extra verification), low_cost (same scope, cheaper tiers, fewer steps), low_effort (smallest change that meets the criteria: reuse memory, existing files and subtask results); each {approach, estCostUsd, expectedValue 0-1000, meetsCriteria}.",
        shape:
          '{"mode":"delegate"|"direct","subprocesses":[{"title":string,"description":string,"assigneeId":string,"round":1|2,"value":number,"estCostUsd":number,"acceptanceCriteria":string,"covers":["A1"]}],"candidates":[{"name":"high_cost"|"low_cost"|"low_effort","approach":string,"estCostUsd":number,"expectedValue":number,"meetsCriteria":boolean}],"rationale":string}',
        context: {
          mode: "task",
          task: { number: task.number, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria },
          reports: canDelegate ? reports.map((r) => reportView(run, r)) : [],
          maxSubprocesses: max,
          ...(named.length ? { namedOwners: named.map((r) => r.id) } : {}),
          ...(hiring ? { hiring: true } : {}),
          feedback: a.feedback,
        },
        // Room for the whole plan: a cut-off reply lost every subprocess (json.ts now returns null for it).
        maxOutputTokens: 1200 + 350 * max,
      });
      const subprocesses = coerceSubprocesses(json, max, Math.max(50, Math.round(task.value / Math.max(1, max))));
      // A part handed out in a fix round is a fix: its owner reports what is still short instead of
      // starting a fix round of their own (brain/index.ts, reworkRounds). A part titled exactly like
      // one already delivered stays as it is: that is a redo, which delegation refuses.
      if (delivered.length) {
        const existing = new Set(run.platform.tasks.children(task.id).map((c) => normTitle(c.title)));
        for (const s of subprocesses) if (!FIX_TITLE.test(s.title) && !existing.has(normTitle(s.title))) s.title = truncate(`Fix: ${s.title}`, 140);
      }
      let mode = oneOf(json.mode, ["delegate", "direct"] as const, subprocesses.length > 0 && canDelegate ? "delegate" : "direct");
      if (!canDelegate || subprocesses.length === 0) mode = "direct";
      if (mode === "delegate") await arrangeRoles(run, subprocesses, reports);
      const assigned = subprocesses.filter((s) => s.assigneeId);
      if (mode === "delegate" && assigned.length === 0) mode = "direct";
      // Each brief carries the contract statements its part must make true; none is left uncovered.
      // In a fix round, only the statements the feedback names are in play (never the whole contract again).
      const fixing = delivered.length > 0 ? [...new Set(a.feedback.flatMap((f) => f.match(/\bA\d+\b/g) ?? []))] : null;
      const uncovered = mode === "delegate" && a.contract?.length ? attachContract(assigned, a.contract, fixing) : [];
      if (uncovered.length) span.setAttributes({ "agentco.contract.uncovered_assigned": uncovered.join(",") });
      span.setAttributes({
        "agentco.control_level": c,
        "agentco.decomposition.mode": mode,
        "agentco.decomposition.count": subprocesses.length,
        "agentco.decomposition.round2": subprocesses.filter((s) => s.round === 2).length,
        ...(named.length ? { "agentco.decomposition.named_owners": named.map((r) => r.id).join(",") } : {}),
      });
      return { json, subprocesses: mode === "delegate" ? assigned : subprocesses, mode, rationale: str(json.rationale, "", 400) };
    },
    { attributes: { "agentco.control_level": c, "agentco.uncertainty": a.uncertainty } },
  );

  const candidates = await block(run, "metacognition.cognitive_control.candidate_solutions", "Weighing candidate solutions", (span) => {
    const list = coerceCandidates(decomposition.json, task.value, task.estCostUsd);
    span.setAttributes({ "agentco.candidates": list.map((x) => `${x.name}:$${x.estCostUsd}/${x.expectedValue}`).join(" ") });
    return list;
  });

  return { controlLevel: c, maxSubprocesses: max, mode: decomposition.mode, subprocesses: decomposition.subprocesses, candidates, rationale: decomposition.rationale };
}

/** The newest files on the company drive, one line each (path, size, when) — "" without a drive. */
export function driveOverview(run: BrainRun, limit = 25): string {
  const files = run.platform.drive?.recent(limit) ?? [];
  return files.map((f) => `- ${f.rel} (${f.chars} chars, saved ${f.modified.slice(0, 16).replace("T", " ")} UTC)`).join("\n");
}

/** Parts of this task already done by someone (escalations excluded), one line each for the re-plan. */
export function deliveredParts(run: BrainRun, taskId: string): string[] {
  return run.platform.tasks
    .children(taskId)
    .filter((c) => c.status === "done" && c.state.kind !== "escalation")
    .slice(-8)
    .map((c) => `- T-${c.number} "${truncate(c.title, 80)}" by ${run.platform.org.getAgent(c.assigneeId ?? "")?.name ?? "?"}: ${truncate(oneLine(c.result ?? "", 300), 300)}`);
}

/**
 * The leader's direct reports the request names — by department, role or name — plus, for a person
 * named who is NOT a direct report (e.g. "Jasmine should…", a recruiter two levels down), the direct
 * report whose team they are in: the part goes there, for them (2026-11-07, test 5).
 */
export function namedOwners(run: BrainRun, reports: Agent[], text: string): { agent: Agent; via: string | null }[] {
  const org = run.platform.org;
  const ownDepartment = org.departmentName(run.agent.departmentId);
  const candidates: Candidate[] = reports.map((agent) => ({ agent, departmentName: org.departmentName(agent.departmentId), catalogProfile: null }));
  const ids = namedCandidates(text, candidates, { ownDepartment });
  const out = new Map<string, { agent: Agent; via: string | null }>();
  for (const r of reports) if (ids.has(r.id)) out.set(r.id, { agent: r, via: null });
  const reportIds = new Set(reports.map((r) => r.id));
  for (const person of mentionedPeople(text, org.listActiveAgents())) {
    if (person.id === run.agent.id || reportIds.has(person.id)) continue;
    let up = person.managerId;
    const seen = new Set<string>();
    while (up && !reportIds.has(up) && !seen.has(up)) {
      seen.add(up);
      up = org.getAgent(up)?.managerId ?? null;
    }
    const report = up ? reports.find((r) => r.id === up) : undefined;
    if (report && !out.has(report.id)) out.set(report.id, { agent: report, via: person.name });
  }
  return [...out.values()];
}

/** People named in the text: by full name, or by a first name written with a capital that only one person has. */
export function mentionedPeople(text: string, agents: Agent[]): Agent[] {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const firsts = new Map<string, number>();
  for (const a of agents) {
    const f = a.name.split(/\s+/)[0] ?? "";
    firsts.set(f, (firsts.get(f) ?? 0) + 1);
  }
  return agents.filter((a) => {
    const full = a.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (full.length >= 3 && lower.includes(` ${full} `)) return true;
    const first = a.name.split(/\s+/)[0] ?? "";
    return first.length >= 3 && firsts.get(first) === 1 && new RegExp(`\\b${first.replace(/[^A-Za-z]/g, "")}\\b`).test(text);
  });
}

/** Block: Role Arrangement assigns each subprocess ("Assign Suitable Role to Workers"). */
export async function arrangeRoles(run: BrainRun, subprocesses: Subprocess[], reports: Agent[]): Promise<void> {
  await block(run, "self_management.role_arrangement", `Assigning ${subprocesses.length} subprocess(es) to the best-fit roles`, (span) => {
    const pool = candidatePool(run.agent, reports, run.platform.org.listActiveAgents(), subprocesses.map((s) => s.suggestedAssigneeId ?? "").filter(Boolean));
    const candidates: Candidate[] = pool.map((agent) => ({
      agent,
      departmentName: run.platform.org.departmentName(agent.departmentId),
      catalogProfile: run.platform.catalog?.profileFor(agent) ?? null,
    }));
    const used = new Map<string, number>();
    // A department/role named in the request (the Board's words) routes a subprocess that names none itself.
    const task = run.task;
    const ownDepartment = run.platform.org.departmentName(run.agent.departmentId);
    const people = candidates.map((x) => x.agent);
    const requestText = task && task.state.kind !== "escalation" ? `${task.title} ${task.description}` : "";
    const namedInRequest = requestText ? namedCandidates(requestText, candidates, { ownDepartment }) : new Set<string>();
    // A person the request names outside the leader's reports ("Jasmine should…") names their team's
    // head too — otherwise "Marketing" was the only name and took every part (2026-11-07, trc_617b…).
    if (requestText) for (const o of namedOwners(run, people, requestText)) if (o.via) namedInRequest.add(o.agent.id);
    for (const s of subprocesses) {
      if (candidates.length === 0) break;
      // The part's TITLE says whose it is ("Engineering scope…"); descriptions mention other departments in passing.
      const own = namedCandidates(s.title, candidates, { ownDepartment });
      for (const o of namedOwners(run, people, s.title)) if (o.via) own.add(o.agent.id);
      // The leader's pick stands when the part names a person on that pick's team ("Have Jasmine Lee
      // run the catalog search" → her head of People), even if the request also names another department.
      if (own.size === 0 && s.suggestedAssigneeId) {
        const viaPerson = namedOwners(run, people, `${s.title} ${s.description}`).filter((o) => o.via).map((o) => o.agent.id);
        if (viaPerson.includes(s.suggestedAssigneeId)) own.add(s.suggestedAssigneeId);
      }
      // A part about the company's numbers is Finance's when its title names no one (2026-11-08,
      // trc_6ee6…: "Confirm figures, finalize draft…" went to the General Counsel, and her contracts
      // analyst searched the drive for numbers only Finance keeps).
      if (own.size === 0) for (const id of fieldOwners(s.title, candidates, ownDepartment)) own.add(id);
      const namedIds = own.size ? own : namedInRequest.size === 1 ? namedInRequest : undefined;
      const scores = scoreCandidates(`${s.title} ${s.description}`, candidates, { suggestedId: s.suggestedAssigneeId, usedCounts: used, fallbackDepartment: run.facts.department, ...(namedIds ? { namedIds } : {}) });
      const best = scores[0]!;
      s.assigneeId = best.agentId;
      s.fit = best.fit;
      s.named = namedInRequest.has(best.agentId);
      used.set(best.agentId, (used.get(best.agentId) ?? 0) + 1);
    }
    const independent = keepReviewsIndependent(run, subprocesses, candidates, (s, pool) =>
      scoreCandidates(`${s.title} ${s.description}`, pool, { suggestedId: s.suggestedAssigneeId, usedCounts: used, fallbackDepartment: run.facts.department }),
    );
    span.setAttributes({
      "agentco.role_arrangement": subprocesses.map((s) => `${truncate(s.title, 30)}→${s.assigneeId}(${s.fit})`).join("; "),
      "agentco.role_arrangement.overrode_llm": subprocesses.filter((s) => s.suggestedAssigneeId && s.suggestedAssigneeId !== s.assigneeId).length,
      "agentco.role_arrangement.named": [...namedInRequest].join(","),
      ...(independent.length ? { "agentco.role_arrangement.independent_review": independent.join("; ") } : {}),
    });
  });
}

/** "Fix: …" — a part handed out in a fix round. */
export const FIX_TITLE = /^\s*fix\b/i;

/** Is this task a fix, or part of one (anything under a "Fix: …" task)? */
export function insideFix(task: { title: string; parentTaskId: string | null }, get: (id: string) => { title: string; parentTaskId: string | null } | null): boolean {
  let cur: { title: string; parentTaskId: string | null } | null = task;
  for (let i = 0; cur && i < 16; i++) {
    if (FIX_TITLE.test(cur.title)) return true;
    cur = cur.parentTaskId ? get(cur.parentTaskId) : null;
  }
  return false;
}

// Fields whose work belongs to one department, matched on a part's title when it names no one.
const FIELDS: readonly { title: RegExp; department: RegExp }[] = [
  { title: /\b(figures?|numbers|metrics?|kpis?|budgets?|spend(?:ing)?|financials?|revenue|forecasts?|unit economics)\b/i, department: /\bfinance\b/i },
];

/** Candidates in the department whose field the part's title is (none when it is the leader's own department). */
export function fieldOwners(title: string, candidates: readonly Candidate[], ownDepartment: string | null): string[] {
  for (const f of FIELDS) {
    if (!f.title.test(title)) continue;
    if (ownDepartment && f.department.test(ownDepartment)) return [];
    return candidates.filter((c) => f.department.test(c.departmentName)).map((c) => c.agent.id);
  }
  return [];
}

const REVIEW_PART = /\b(re-?review|review|verif(?:y|ies|ication)|proof-?read|audit|qa|sign[- ]?off|verdict|double[- ]check)\b/i;
const PATH = /[\w.-]+(?:\/[\w.-]+)*\.(?:md|txt|csv|json|html|ya?ml)\b/gi;

/**
 * A review never goes to the person whose work it reviews (2026-11-08, trc_6ee6…: Eva applied Legal's
 * edits, then "re-reviewed" them herself — REJECT — and drafted the legal review of a draft she had
 * written). The author of a part is whoever does an earlier part of this plan, or saved a file the
 * review names on this objective. The review goes to the best-fit colleague in the same field who did
 * not write it. With none, a leader of that field reviews it on resume (it is left out of the plan; all
 * parts left out: the leader does the work directly); a leader from another field keeps the expert.
 * Returns what changed, for the span.
 */
export function keepReviewsIndependent(
  run: BrainRun,
  subprocesses: Subprocess[],
  candidates: readonly Candidate[],
  rescore: (s: Subprocess, pool: Candidate[]) => { agentId: string; fit: number }[],
): string[] {
  const changes: string[] = [];
  const traceId = run.task?.traceId;
  const written = traceId ? (run.platform.drive?.written(traceId) ?? []) : [];
  for (const s of subprocesses) {
    if (!s.assigneeId || !REVIEW_PART.test(s.title)) continue;
    const authors = new Set<string>();
    for (const o of subprocesses) if (o !== s && o.assigneeId && !REVIEW_PART.test(o.title) && (o.round ?? 1) < (s.round ?? 1)) authors.add(o.assigneeId);
    const named = new Set([...`${s.title} ${s.description}`.matchAll(PATH)].map((m) => m[0].toLowerCase().replace(/^shared\//, "")));
    for (const w of written) if (named.has(w.display.toLowerCase().replace(/^shared\//, ""))) authors.add(w.agentId);
    if (!authors.has(s.assigneeId)) continue;
    const author = run.platform.org.getAgent(s.assigneeId);
    const field = author?.departmentId ?? null;
    const pool = candidates.filter((c) => !authors.has(c.agent.id) && c.agent.departmentId === field);
    const best = pool.length ? rescore(s, pool)[0] : undefined;
    const was = author?.name ?? s.assigneeId;
    if (best) {
      s.assigneeId = best.agentId;
      s.fit = best.fit;
      changes.push(`"${truncate(s.title, 40)}": ${was} wrote it → ${run.platform.org.getAgent(best.agentId)?.name ?? best.agentId}`);
    } else if (run.agent.departmentId === field) {
      s.assigneeId = null;
      s.fit = null;
      changes.push(`"${truncate(s.title, 40)}": ${was} wrote it → left for the leader`);
    } else {
      changes.push(`"${truncate(s.title, 40)}": ${was} wrote it, kept (no one else in that field)`);
    }
  }
  return changes;
}

/**
 * Puts each part's contract statements in its acceptance criteria (the worker sees the bar up front).
 * A statement no part claims goes to the round-2 part (assembly or review), else to the part whose
 * text is closest to it. Returns the ids that were assigned that way.
 */
export function attachContract(parts: Subprocess[], contract: readonly Assertion[], fixing: readonly string[] | null = null): string[] {
  if (parts.length === 0) return [];
  const known = new Set(contract.map((c) => c.id));
  const namedNone = new Set(parts.filter((p) => !(p.covers ?? []).some((id) => known.has(id))));
  for (const p of parts) p.covers = (p.covers ?? []).filter((id) => known.has(id) && (!fixing || fixing.includes(id)));
  // A fix round: parts that name no statement get the ones the feedback names; nothing else is added.
  if (fixing) {
    for (const p of parts) if (namedNone.has(p)) p.covers = fixing.filter((id) => known.has(id));
  }
  const claimed = new Set(parts.flatMap((p) => p.covers ?? []));
  const added: string[] = [];
  for (const c of contract) {
    if (fixing) break;
    if (claimed.has(c.id)) continue;
    const last = parts.filter((p) => p.round === 2).at(-1);
    const best = last ?? [...parts].sort((x, y) => overlap(`${y.title} ${y.description}`, c.text) - overlap(`${x.title} ${x.description}`, c.text))[0]!;
    best.covers = [...(best.covers ?? []), c.id];
    added.push(c.id);
  }
  for (const p of parts) {
    if (!p.covers?.length) continue;
    p.acceptanceCriteria = `${p.acceptanceCriteria} This part must make true (the objective's contract, checked independently at the end): ${contractList(contract, p.covers)}.`.slice(0, 3500);
  }
  return added;
}
