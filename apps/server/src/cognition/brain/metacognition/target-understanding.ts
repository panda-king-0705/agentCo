/**
 * Metacognition › Target Understanding:
 * Problem Definition → Literature Review → Analysis (Perspectives) → Understanding.
 */
import { limitsLine, needsBoardStep, realBoardSteps, type Capability, type ConnectedService } from "../../../org/capabilities.ts";
import { arr, obj, oneOf, str, strArr, unit } from "../../coerce.ts";
import { oneLine, truncate } from "../../text.ts";
import { readGlobalLongTerm, readGlobalWorking } from "../global-memory.ts";
import { block, capabilities, llmJson, type BrainRun } from "../runtime.ts";
import { localWorkingMemory, longTermMemory, memoryLine } from "./memory.ts";

export interface ProblemDefinition {
  intent: "chat" | "work";
  problem: string;
  title: string;
  successCriteria: string[];
  constraints: string[];
  unknowns: string[];
  /** Steps the request needs that this company cannot do (org/capabilities.ts): left to the Board. */
  boardSteps: string[];
}

export interface Perspective {
  lens: string;
  insight: string;
  implication: string;
}

export interface Understanding {
  perspectives: Perspective[];
  summary: string;
  score: number;
}

/** What the agent is asked: the task, or the latest chat message with a little history. */
export function requestText(run: BrainRun): string {
  const input = run.ctx.input;
  if (input.trigger === "message") {
    const prior = input.history.messages
      .filter((m) => m.id !== input.message.id)
      .slice(-4)
      .map((m) => `${m.senderId === run.agent.id ? "you" : m.senderId}: ${oneLine(m.content, 200)}`);
    return `${prior.length ? `Earlier:\n${prior.join("\n")}\n` : ""}Latest message: ${input.message.content}`;
  }
  const t = input.task;
  return (
    // An escalation carries the stuck task's text and the original request below its question: read more of it.
    `T-${t.number}: ${t.title}\n${truncate(t.description, t.state.kind === "escalation" ? 3500 : 1500)}${t.acceptanceCriteria ? `\nAcceptance criteria: ${truncate(t.acceptanceCriteria, 400)}` : ""}` +
    (input.recoveryNotice ? `\nRECOVERY NOTICE: ${input.recoveryNotice}` : "")
  );
}

export function coerceProblem(json: Record<string, unknown>, fallbackTitle: string, defaultIntent: "chat" | "work", company: ReadonlySet<Capability> = new Set(), services: readonly ConnectedService[] = []): ProblemDefinition {
  const criteria = strArr(json.successCriteria, 5, 200);
  // Backstop: a criterion that is itself an outside step ("the email reaches the investor list") is
  // the Board's step, not something to be judged against (2026-11-07, test 6) — unless a tool can do it.
  const outside = criteria.filter((c) => needsBoardStep(c, company));
  const named = realBoardSteps(strArr(json.boardSteps, 4, 200), services);
  // The model's own wording of the step reads better; the criterion stands in only when it named none.
  const boardSteps = (named.length ? named : outside).slice(0, 4);
  return {
    intent: oneOf(json.intent, ["chat", "work"] as const, defaultIntent),
    problem: str(json.problem, fallbackTitle, 500),
    title: truncate(str(json.title, fallbackTitle, 140), 140),
    successCriteria: criteria.filter((c) => !outside.includes(c)),
    constraints: strArr(json.constraints, 5, 200),
    unknowns: strArr(json.unknowns, 5, 200),
    boardSteps,
  };
}

/**
 * Block (economy): problem definition, incl. chat-vs-work intent for messages.
 * `gaps` (Q3): the evaluation's gaps when Confidence sent the block back.
 */
export async function problemDefinition(run: BrainRun, gaps: string[] = []): Promise<ProblemDefinition> {
  const input = run.ctx.input;
  const isMessage = input.trigger === "message";
  const fallbackTitle = isMessage ? truncate(input.message.content.split("\n")[0] ?? "Request", 100) : input.task.title;
  return block(run, "metacognition.target_understanding.problem_definition", isMessage ? "Understanding the message" : `Defining the problem for T-${input.task.number}`, async (span) => {
    const caps = capabilities(run);
    const json = await llmJson(run, {
      stage: "metacognition.target_understanding.problem_definition",
      span,
      instructions:
        `${requestText(run)}\n\nDefine the problem.\n${limitsLine(caps.company, caps.mine, caps.services)}\n` +
        "Success criteria are what this company can deliver. A step it cannot do goes in boardSteps (e.g. \"Send the update to the investors\"), and its criterion becomes that it is ready for the Board (e.g. \"The update is drafted, checked and ready for the Board to send\"). " +
        "The title says what we will deliver (\"Draft the monthly investor update\", not \"Send…\")." +
        (gaps.length ? ` Your previous understanding was evaluated as insufficient; re-define the problem around these gaps: ${gaps.join("; ")}.` : "") +
        (isMessage
          ? ' intent = "work" if the message asks for anything to be done or changed — including small actions such as recording, saving, setting, updating, sending or deleting something — not only big projects (build, plan, write, research, …); greetings, questions and chat = "chat".'
          : ""),
      shape: '{"intent":"chat"|"work","title":string,"problem":string,"successCriteria":string[],"constraints":string[],"unknowns":string[],"boardSteps":string[]}',
      context: {
        mode: isMessage ? "message" : "task",
        message: isMessage ? input.message.content : undefined,
        task: isMessage ? undefined : { number: input.task.number, title: input.task.title, description: input.task.description, acceptanceCriteria: input.task.acceptanceCriteria },
        agent: { name: run.agent.name, title: run.agent.title, department: run.facts.department, departmentSlug: run.facts.departmentSlug },
        gaps,
      },
      maxOutputTokens: 800,
    });
    const p = coerceProblem(json, fallbackTitle, isMessage ? "chat" : "work", caps.company, caps.services);
    if (!isMessage) p.intent = "work";
    if (p.successCriteria.length === 0) {
      const ac = !isMessage && input.task.acceptanceCriteria && !needsBoardStep(input.task.acceptanceCriteria, caps.company) ? input.task.acceptanceCriteria : null;
      p.successCriteria = ac
        ? [truncate(ac, 200)]
        : p.boardSteps.length
          ? [`Everything up to "${truncate(p.boardSteps[0]!, 80)}" is done and ready for the Board`]
          : [`A concrete deliverable for "${truncate(p.title, 80)}"`];
    }
    if (gaps.length) p.unknowns = p.unknowns.filter((u) => !gaps.includes(u));
    span.setAttributes({ "agentco.intent": p.intent, "agentco.fallback.gaps": gaps.length, ...(p.boardSteps.length ? { "agentco.board_steps": p.boardSteps.join(" | ") } : {}) });
    return p;
  });
}

/** Block (no model): Literature Review = Memory recall (local + long-term + global), subtask results, inbox. */
export async function literatureReview(run: BrainRun, query: string, k: number): Promise<string[]> {
  return block(run, "metacognition.target_understanding.literature_review", "Reviewing what we already know", async (span) => {
    const lines: string[] = [];
    lines.push(...(await localWorkingMemory(run)));
    for (const m of await longTermMemory(run, query, k)) lines.push(memoryLine(m));
    for (const m of await readGlobalLongTerm(run, query, Math.max(2, Math.floor(k / 2)))) lines.push(memoryLine(m));
    for (const e of await readGlobalWorking(run, 3)) lines.push(`- [blackboard] ${e.key}: ${oneLine(e.value, 160)}`);
    const input = run.ctx.input;
    if (input.trigger !== "message") {
      for (const s of input.subtasks.slice(0, 8)) {
        lines.push(`- [subtask T-${s.number} ${s.status}] ${oneLine(s.title, 80)}: ${oneLine(s.result ?? s.error ?? "", 240)}`);
      }
    }
    const inbox = run.platform.memory.inbox(run.agent.id, 5);
    if (inbox.length) {
      run.platform.memory.markRead(inbox.map((m) => m.id));
      for (const m of inbox) lines.push(`- [inbox from ${m.senderId}] ${oneLine(m.content, 200)}`);
    }
    span.setAttributes({ "agentco.literature.items": lines.length, "agentco.literature.k": k });
    return lines;
  });
}

export function coerceUnderstanding(json: Record<string, unknown>, n: number, fallbackSummary: string): Understanding {
  const perspectives: Perspective[] = [];
  for (const raw of arr(json.perspectives)) {
    const p = obj(raw);
    const lens = str(p.lens, "");
    if (!lens) continue;
    perspectives.push({ lens: truncate(lens, 60), insight: str(p.insight, "", 300), implication: str(p.implication, "", 300) });
    if (perspectives.length >= n) break;
  }
  const u = obj(json.understanding);
  return {
    perspectives,
    summary: str(u.summary ?? json.summary, fallbackSummary, 600),
    // No usable analysis → low understanding, which triggers the Target Understanding fallback.
    score: unit(u.score ?? json.score, perspectives.length > 0 ? 0.6 : 0.3),
  };
}

/** Block (standard): N perspectives (curiosity) → understanding {summary, score}. */
export async function analysis(run: BrainRun, problem: ProblemDefinition, literature: string[], n: number): Promise<Understanding> {
  return block(run, "metacognition.target_understanding.analysis", `Analysing from ${n} perspectives`, async (span) => {
    const json = await llmJson(run, {
      stage: "metacognition.target_understanding.analysis",
      span,
      instructions:
        `Problem: ${problem.problem}\nSuccess criteria: ${problem.successCriteria.join("; ")}\nKnown context:\n${literature.slice(0, 12).join("\n") || "(nothing recalled)"}\n\n` +
        `Analyse from exactly ${n} distinct perspectives, then state your understanding and how well you understand it (score 0-1).`,
      shape: '{"perspectives":[{"lens":string,"insight":string,"implication":string}],"understanding":{"summary":string,"score":number}}',
      context: {
        mode: "task",
        task: run.task ? { number: run.task.number, title: run.task.title, description: run.task.description } : { title: problem.title, description: problem.problem },
        perspectives: n,
      },
      maxOutputTokens: 400 + 160 * n,
    });
    const u = coerceUnderstanding(json, n, problem.problem);
    span.setAttributes({ "agentco.understanding": u.score, "agentco.perspectives": u.perspectives.length });
    return u;
  });
}
