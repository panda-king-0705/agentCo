/**
 * Validation contract and independent validator (docs/BRAIN.md › Solving and Evaluation).
 *
 * The founder, 2026-11-08, after the Factory "Missions" talk: write down what "done" means before the
 * work starts, and have it checked by someone who did not do the work. Four runs of the investor
 * update showed why: reviewers kept inventing new requirements mid-flight (per-toggle price
 * captures, dated sign-offs, version reconciliations), so every round of review found something new.
 *
 * - The CONTRACT: the objective's success criteria, numbered A1…An, fixed when the objective opens
 *   (the Board sees it in the first reply) and never changed by later reviews.
 * - Every part of the plan says which statements it makes true; its brief carries them.
 * - The VALIDATOR: one model call that sees only the contract and the saved work — not the plan, the
 *   workers' own accounts of what they did, nor the leader's charter — preferably on another provider
 *   (models/router.ts, validatorProfile). Each statement is met, unmet (what exactly is missing) or
 *   the Board's (needs data, a decision or a step only the Board has).
 * - Feedback may send work back only for unmet statements, and the fix round is told exactly those.
 */
import { arr, obj, str } from "../../coerce.ts";
import { oneLine, truncate } from "../../text.ts";
import { llmJson, type BrainRun } from "../runtime.ts";
import type { SpanHandle } from "../../../contracts.ts";
import type { ReviewFile } from "./solving-evaluation.ts";
import { REPO_SAVED } from "../../../org/rules.ts";

export interface Assertion {
  /** "A1", "A2", … */
  id: string;
  text: string;
}

export type CheckStatus = "met" | "unmet" | "board";

export interface AssertionCheck {
  id: string;
  text: string;
  status: CheckStatus;
  /** Where in the saved work it is met (a file and a short quote). */
  evidence: string;
  /** What exactly is missing (unmet), or what only the Board can give (board). */
  gap: string;
}

export interface Validation {
  checks: AssertionCheck[];
  unmet: AssertionCheck[];
  board: AssertionCheck[];
  /** The model that checked (a profile id), for the report. */
  checker: string;
}

export const MAX_ASSERTIONS = 6;

/** Success criteria → the numbered contract (duplicates and empties dropped). */
export function contractFrom(criteria: readonly string[]): Assertion[] {
  const seen = new Set<string>();
  const out: Assertion[] = [];
  for (const raw of criteria) {
    const text = oneLine(raw, 240).replace(/[.;\s]+$/, "");
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `A${out.length + 1}`, text });
    if (out.length >= MAX_ASSERTIONS) break;
  }
  return out;
}

/** A persisted contract (task state or plan), or [] when there is none. */
export function readContract(value: unknown): Assertion[] {
  return arr(value)
    .map(obj)
    .map((a) => ({ id: str(a.id, "", 8), text: str(a.text, "", 240) }))
    .filter((a) => /^A\d+$/.test(a.id) && a.text);
}

/** "1. … 2. …" for the reply that opens the objective. */
export function contractLines(contract: readonly Assertion[]): string {
  return contract.map((a, i) => `${i + 1}. ${a.text}`).join("\n");
}

/** "A1 — …; A2 — …" for briefs and prompts. */
export function contractList(contract: readonly Assertion[], ids?: readonly string[]): string {
  return contract
    .filter((a) => !ids || ids.includes(a.id))
    .map((a) => `${a.id} — ${a.text}`)
    .join("; ");
}

/** The validator's JSON → one check per contract statement (missing ones are unmet: nothing showed them). */
export function coerceChecks(json: Record<string, unknown>, contract: readonly Assertion[]): AssertionCheck[] | null {
  const given = arr(json.checks).map(obj);
  if (given.length === 0) return null;
  return contract.map((a) => {
    const c = given.find((g) => String(g.id ?? "").trim().toUpperCase() === a.id) ?? null;
    const raw = String(c?.status ?? "").toLowerCase();
    const status: CheckStatus = raw === "met" ? "met" : raw === "board" ? "board" : "unmet";
    return {
      id: a.id,
      text: a.text,
      status,
      evidence: truncate(oneLine(str(c?.evidence, ""), 300), 300),
      gap: truncate(oneLine(str(c?.gap, c ? "" : "the checker gave no verdict for this statement"), 300), 300),
    };
  });
}

const VALIDATOR_CHARTER =
  "You are the company's independent checker. You did not do this work and you have not seen how it was done or what anyone said about it: you judge only the saved work below against each numbered statement of the contract.";

/**
 * The independent check: the contract and the saved work only. Returns null when there is nothing
 * to check or the checker gave no usable verdict (the leader's own review then decides, as before).
 */
export async function validateContract(
  run: BrainRun,
  span: SpanHandle,
  o: { contract: readonly Assertion[]; files: readonly ReviewFile[]; solution: string | null; boardSteps: readonly string[] },
): Promise<Validation | null> {
  if (o.contract.length === 0) return null;
  const work =
    (o.files.length
      ? o.files.map((f) => `=== ${f.display} (${f.words} words${f.truncated ? "; shown in part" : ""}) ===\n${f.content}`).join("\n")
      : "(no files were saved)") + (o.solution ? `\n=== the final text handed in ===\n${truncate(o.solution, 3000)}` : "");
  const checker = run.platform.models.validatorProfile?.() ?? null;
  const call = (modelOverride: string | null) =>
    llmJson(run, {
      stage: "metacognition.solving_evaluation.validation",
      span,
      charter: VALIDATOR_CHARTER,
      modelOverride,
      instructions:
        `The contract — what "done" means, fixed before the work started:\n${o.contract.map((a) => `${a.id}: ${a.text}`).join("\n")}\n\n` +
        (o.boardSteps.length ? `Left to the Board (this company cannot do these; never count them): ${o.boardSteps.join("; ")}\n\n` : "") +
        `The saved work${o.files.some((f) => /^[\w.-]+\/[\w.-]+@/.test(f.display)) ? ` (${REPO_SAVED.trim()})` : ""}:\n${work}\n\n` +
        "For each statement give status: met (evidence: the file and a short quote that shows it), unmet (gap: exactly what is missing for THIS statement — nothing it does not ask for), or board (it can only be met with something only the Board can give: data no one in the company has, a decision, an outside step). " +
        "Judge substance only: formatting, wording style, sign-offs and small count differences never make a statement unmet. A figure honestly marked as not available, where no file in the company has it, is the Board's, not unmet. Do not add requirements, and do not trust claims — only what the saved work shows.",
      shape: '{"checks":[{"id":"A1","status":"met"|"unmet"|"board","evidence":string,"gap":string}]}',
      context: { mode: "validation", contract: o.contract, files: o.files.map((f) => f.display) },
      maxOutputTokens: 300 + 120 * o.contract.length,
    });
  let json: Record<string, unknown>;
  let used = checker;
  try {
    json = await call(checker);
  } catch (error) {
    // The other provider is down (or the override is unusable): check on the leader's own tier rather than not at all.
    if (!checker || run.ctx.signal.aborted || (error instanceof Error && error.name === "BudgetExceededError")) throw error;
    span.setAttributes({ "agentco.validation.checker_failed": checker });
    used = null;
    json = await call(null);
  }
  const checks = coerceChecks(json, o.contract);
  if (!checks) {
    span.setAttributes({ "agentco.validation": "no verdict" });
    return null;
  }
  const v: Validation = {
    checks,
    unmet: checks.filter((c) => c.status === "unmet"),
    board: checks.filter((c) => c.status === "board"),
    checker: used ?? "the leader's tier",
  };
  span.setAttributes({
    "agentco.validation.met": checks.filter((c) => c.status === "met").length,
    "agentco.validation.unmet": v.unmet.map((c) => c.id).join(",") || "none",
    "agentco.validation.board": v.board.map((c) => c.id).join(",") || "none",
    "agentco.validation.checker": v.checker,
  });
  return v;
}

/** The checker's verdict, for the leader's own review. */
export function validationBrief(v: Validation): string {
  return v.checks.map((c) => `${c.id} ${c.status.toUpperCase()}${c.status === "met" ? (c.evidence ? ` (${c.evidence})` : "") : `: ${c.gap || "no detail"}`}`).join("\n");
}

/** The report's section: each statement and how it stands. */
export function validationSection(v: Validation): string {
  const met = v.checks.filter((c) => c.status === "met").length;
  const mark = (c: AssertionCheck) => (c.status === "met" ? "✓" : c.status === "board" ? "Board" : "✗");
  return (
    `## Checked against what "done" means\n${met} of ${v.checks.length} met — checked by a model that did not do the work.\n` +
    v.checks.map((c) => `- ${mark(c)} ${c.id} ${truncate(c.text, 140)}${c.status === "met" ? "" : ` — ${truncate(c.gap || (c.status === "board" ? "needs the Board" : "not shown in the saved work"), 160)}`}`).join("\n")
  );
}
