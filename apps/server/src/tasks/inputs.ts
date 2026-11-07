// Waiting for colleagues' inputs instead of escalating (founder, 2026-11-07).
//
// In test 4 (T-171) the Chief of Staff was told to assemble sections that his colleagues were
// still writing. He re-checked the drive 6–7 times per run and escalated to the CEO twice. Now an
// escalation whose question is about work a colleague on the same objective is still doing puts
// the asker on hold instead: an "inputs wait" subtask (kind "escalation", so every engine already
// knows how to wait for it and resume with its result) that the platform completes by itself when
// that work finishes — no manager run, no model call. Pure helpers here; TaskService wires them.
import type { Agent, Task } from "../../../../packages/shared/src/index.ts";
import { roleWordFor } from "../org/directory.ts";

/** Statuses of colleague work worth waiting for (blocked = waiting on the Board: no ETA, not waited on). */
export const WAITABLE: ReadonlySet<Task["status"]> = new Set(["todo", "in_progress", "waiting"]);
/** Waits per task: the second time the asker is stuck, the escalation goes to the manager. */
export const MAX_INPUT_WAITS = 1;
export const MAX_WAIT_FOR = 6;

/** The question is about missing / not-yet-delivered input. */
const MISSING_INPUT =
  /\b(missing|not (yet )?(received|available|ready|delivered|written|saved|done|there|found|exist)|(do(es)?n'?t|does not|do not) (yet )?exist|waiting (for|on)|depends? on|until .* (done|ready|delivered)|inputs?|drafts?|sections?|deliverables?|haven'?t (been )?(received|delivered|sent))\b/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function isInputsWait(task: Task): boolean {
  return task.state.inputsWait === true;
}

/**
 * Open work by OTHER people on the same objective that the asker may be waiting on: same root, not
 * the asker's own task, its ancestors (they wait on the asker) or its descendants, not escalations,
 * not tasks that are themselves on hold for inputs (no waiting in a circle). When the text names
 * some of them (T-number, name, title, role word) only those; otherwise all of them, but only if
 * the text is about missing input at all.
 */
export function waitableInputs(all: Task[], task: Task, askerId: string, text: string, agentOf: (id: string) => Agent | null): Task[] {
  const byId = new Map(all.map((t) => [t.id, t]));
  const ancestors = new Set<string>();
  for (let p = task.parentTaskId; p && !ancestors.has(p); p = byId.get(p)?.parentTaskId ?? null) ancestors.add(p);
  const below = (t: Task) => {
    const seen = new Set<string>();
    for (let p = t.parentTaskId; p && !seen.has(p); p = byId.get(p)?.parentTaskId ?? null) {
      if (p === task.id) return true;
      seen.add(p);
    }
    return false;
  };
  const onHold = (t: Task) => all.some((c) => c.parentTaskId === t.id && isInputsWait(c) && WAITABLE.has(c.status));
  const open = all.filter(
    (t) =>
      t.rootTaskId === task.rootTaskId &&
      WAITABLE.has(t.status) &&
      t.id !== task.id &&
      !ancestors.has(t.id) &&
      !below(t) &&
      t.state.kind !== "escalation" &&
      !!t.assigneeId &&
      t.assigneeId !== askerId &&
      !onHold(t),
  );
  if (open.length === 0) return [];
  const said = ` ${norm(text)} `;
  const mentions = (t: Task) => {
    if (new RegExp(`\\bT-?${t.number}\\b`, "i").test(text)) return true;
    const a = agentOf(t.assigneeId!);
    if (!a) return false;
    const words = [norm(a.name), norm(a.name).split(" ")[0] ?? "", norm(a.title), roleWordFor(a.title) ?? ""].filter((w) => w.length >= 3);
    return words.some((w) => said.includes(` ${w} `));
  };
  const named = open.filter(mentions);
  if (named.length > 0) return named.slice(0, MAX_WAIT_FOR);
  return MISSING_INPUT.test(text) ? open.slice(0, MAX_WAIT_FOR) : [];
}

export function waitTitle(deps: Task[], agentOf: (id: string) => Agent | null): string {
  const list = deps.map((t) => `T-${t.number} (${agentOf(t.assigneeId ?? "")?.name ?? "?"})`).join(", ");
  return `Waiting for ${list}`.slice(0, 300);
}

export function waitDescription(caller: Task, asker: Agent, deps: Task[], reason: string, agentOf: (id: string) => Agent | null): string {
  return (
    `${asker.name} is waiting for colleagues' work on this objective before continuing T-${caller.number} "${caller.title}":\n` +
    deps.map((t) => `- T-${t.number} "${t.title}" — ${agentOf(t.assigneeId ?? "")?.name ?? "?"}, ${t.status.replace("_", " ")}`).join("\n") +
    `\n\nWhy: ${reason.slice(0, 1500)}\n\nThis finishes by itself when they are done; ${asker.name} then resumes with their results. No one needs to act on it.`
  );
}

/** The wait's result: what each awaited task produced (the asker resumes with it as guidance). */
export function waitResult(deps: Task[], agentOf: (id: string) => Agent | null): string {
  const lines = deps.map((t) => {
    const who = agentOf(t.assigneeId ?? "")?.name ?? "?";
    const body = t.status === "done" ? (t.result ?? "(no result text)") : `${t.status}${t.error ? `: ${t.error}` : ""}`;
    return `- T-${t.number} "${t.title}" — ${who}, ${t.status}: ${body.replace(/\s+/g, " ").slice(0, 900)}`;
  });
  return `The colleague work you were waiting for has finished:\n${lines.join("\n")}\nTheir files are on the company drive (workspace_list shows what was saved on this objective). Continue your task with these.`;
}
