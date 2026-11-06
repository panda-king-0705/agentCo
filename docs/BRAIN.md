# Brain-Inspired Agent Architecture — implementation spec

Spec of record for `BrainEngine` (executives and managers). It follows the
founder's diagram ("Brain-Inspired Agent Architecture") **block for block**:
every box is a module and a traced block id (`BrainBlockId` in
`packages/shared`), and every arrow is a data flow below. It supersedes the
stage table that used to be in `ARCHITECTURE.md`.

The founder's readings of the diagram's labels (answered 2026-11-05) are
isolated in **one module**, `apps/server/src/cognition/brain/interpretation.ts`,
and listed in [§6](#6-founders-readings-of-the-diagram). Changing an
interpretation must not require touching any other file.

## 1. The diagram, as code

```
cognition/brain/
  index.ts                       BrainEngine.run(): the per-run flow (§3)
  interpretation.ts              every assumption about unclear diagram words (§6)
  self-management/
    identity.ts                  Self-Identity → Desire → Motivation (drives)
    self-narrative.ts            Self-Narrative Generator (+ BIO/Assets, Resource Connection)
    okr.ts                       Objectives and Key Results → TODO list
    role-arrangement.ts          Role Arrangement (Master of My Destiny) → "Assign Suitable Role to Workers"
    bazi.ts                      Eight Characters and Five Elements (pure; also used by OrgService)
    personality.ts               Personality / MBTI fit
    emotion.ts                   Sensibility / Emotion (+ Feedback / Update)
    human-nature.ts              Human Nature (update rules for emotion)
  todo-list.ts                   TODO List (Interruptible), subprocess value/cost
  metacognition/
    project-management.ts        Data-driven Analysis · Economic Concepts · Rollback/Failure Recovery ·
                                 Reflection/Replanning · Online Learning/Evolving
    monitoring.ts                OOD Monitoring · Calibration · Reverse Thinking · Truthful/Efficient/Good
    self-ability.ts              LLM Capability · Tools/MCP Capability · Budget/Resource → Competence
    target-understanding.ts      Problem Definition → Literature Review → Analysis (Perspectives) → Understanding
    confidence.ts                Confidence · Risk/Uncertainty · Fallback · Early Stop?
    cognitive-control.ts         Cognitive Control ∝ · Decomposition · Candidate Solutions
    solving-evaluation.ts        Solving → Solution → Feedback
    memory.ts                    Memory: Local Working Memory · Long-Term Memory
  global-memory.ts               Global Memory: Global Working Memory (Shared) · Episodic · Procedural · Conceptual
```

Every block runs inside a span whose `attributes["agentco.brain.block"]` is
its `BrainBlockId`, and calls `platform.agents.setActivity(…, block)` so the
console lights it up live. Purely computed blocks still get a (short) span —
the trace must show the whole diagram being walked, not only the LLM calls.

## 2. Block-by-block mapping

### Self-management

| Diagram block | Contents in the diagram | Implementation | Model |
|---|---|---|---|
| **Self-Identity** | Worldview · Life View · Value · BIO/Assets · Resource Connection; arrow Life View → Value | `identity.worldview`, `lifeView`, `values[]`, `assets[]`, `resourceConnections[]`. Rendered as the **identity charter** at the top of every LLM prompt. Values are presented as following from the life view. | — |
| → **Desire** | Task Driven · Curiosity · Epistemic · Vision | `identity.desires` (0..1) + `identity.vision` text. Drives: taskDriven → fewer perspectives, shorter loops; curiosity → literature-review breadth `k = 4 + 4·curiosity` and perspectives `2 + round(2·curiosity)`; epistemic → truthful gate `≥ 0.6 + 0.3·epistemic`; vision → value multiplier `1 + 0.5·vision·(0.5 + purpose)` for subprocesses aligned with vision/OKRs (purpose 0.5 = `1 + 0.5·vision`). | — |
| → **Motivation** | Freedom/Competence/Purpose · Maslow's needs | `identity.motivation` + computed `NeedsState`. Freedom (autonomy) low → escalate sooner (early-stop threshold +0.1). Competence feeds Self-ability. Purpose → OKR weighting: purpose scales the vision/OKR alignment multiplier (`alignmentMultiplier` in `interpretation.ts`). **Maslow's needs** are computed from facts; the lowest unmet need steers behaviour: physiological (any budget left) → only essential work; safety (budget headroom ≥ 20%, no failure streak) → conservation: cheapest acceptable candidate, no revisions; belonging (an active manager, and for a leader with reports at least one reachable report) → reach out first: a check-in with the manager, or — when the manager is missing/terminated — the next active ancestor (the Board when there is none, e.g. the CEO; `escalate` follows the same chain); unreachable reports are noted as a Self-ability gap; esteem (acceptance rate) → stricter self-evaluation; self-actualisation (OKR progress) → curiosity +0.1. | — |
| **Self-Narrative Generator** | linked to BIO/Assets and Resource Connection | After a Report: refresh `identity.narrative` (2-3 sentences, first person), append demonstrated skills/deliverables to `assets`, collaborators to `resourceConnections`. Runs every 3rd completed objective or on a notable event (failure, escalation, praise). | economy |
| **Objectives and Key Results** | ↓ arrow into the TODO list | `identity.okrs`. Feed the TODO list: subprocesses aligned with a KR get the vision multiplier; KR `current` is advanced on Report when the evaluated result maps to it; on a heartbeat (if enabled), the KR with the largest gap proposes a new objective. | economy (heartbeat only) |
| **Role Arrangement (Master of My Destiny)** | Personality/MBTI · Eight Characters and Five Elements; dashed "Assign Suitable Role to Workers" into the subprocesses | `role-arrangement.ts` ranks every candidate assignee for each decomposed subprocess by `fit = 0.75·mandateFit + 0.25·mbtiFit` (mandateFit = keyword/skill overlap with title, mandate, assets; mbtiFit = task-kind ↔ preference table, e.g. analysis → T/N, outreach → E/F, process → S/J). **Eight Characters and Five Elements is a tie-breaker only** (founder): candidates within 0.05 of the best fit are tied, and the tie goes to the best elementFit — the subprocess's element (from its department, table in `interpretation.ts`) against the assignee's five-element balance. Assignee must be an active direct report (CEO: anyone); the LLM's suggestion is one input, never trusted blindly. Also used by `hire_agent` to pick a persona for a new hire. | — |
| **Sensibility / Emotion** | ← Human Nature; → Motivation; ← Feedback/Update | `agent.affect` {valence, arousal, frustration}. Updated on every Report (Feedback/Update) using Human Nature's rules. → Motivation: frustration > 0.7 forces the early-stop gate (escalate) — only on a task with setbacks of its own (a failed attempt, an escalation, a rejected plan or a failed/blocked subtask), so frustration from other work never stops a fresh task; frustration relaxes 10% per Report and halves every 2 h idle; valence < −0.3 lowers autonomy by 0.1 for the next run; valence > 0.3 raises curiosity by 0.1 (bounded). | — |
| **Human Nature** | → Sensibility/Emotion; ↑ fed by the finished processes (founder) | `human-nature.ts`: every finished subprocess (done, failed, escalated, cancelled — its own and its reports') is an event, turned into emotion by these rules: negativity bias (a failure moves valence 1.5× a success), habituation (repeat outcomes count less), fatigue (arousal rises with queue length and consecutive runs — the real streak of runs without idle time, `MetricsView.runStreak` — and decays when idle), recognition (acceptance by the manager or Board moves valence 2× self-acceptance: when a manager's Feedback accepts subtasks, each WORKER's affect gets the recognition top-up; the Board's approval of a CEO objective counts as "board"), decay (valence relaxes toward 0 on every Report and over idle time, so the curiosity boost fades). Constants in `interpretation.ts`. | — |

`BaZiChart` (八字五行) is cast once per agent from its `createdAt` (the
agent's "birth"): four pillars by the sexagenary cycle — year (boundary
Lìchūn ≈ Feb 4), month (approximate solar-term boundaries), day (reference:
1900-01-01 is 甲戌, index 10), hour (2-hour branches) — and the five-element
count of the eight characters. `bazi.ts` is pure and deterministic;
`OrgService` stores it in `persona.baZi` at creation.

### TODO List (Interruptible)

| Diagram | Implementation |
|---|---|
| Subprocess 1…n with **Value** and **Cost** | The agent's open tasks on the company board, priority `value / max(cost, 0.01)`. Decomposition (below) creates new subprocesses here. |
| **Interruptible**, "Interrupt" arrow from the right | Between blocks the engine calls `platform.tasks.interruptFor(agentId, priority)`. If something more urgent waits (an unanswered human message, a higher-priority ready task, a report that woke a parent), the engine checkpoints `{block, partial results}` into `task.state.checkpoint` and returns outcome **`yielded`** (task back to `todo`, attempts unchanged). The next run resumes **at** the checkpointed block: working memory keeps what the earlier blocks produced (problem, literature, understanding, competence, OOD report, confidence, the chosen plan and candidate), so no earlier model call is redone. A task yields at most `TODO_YIELD.maxPerTask` (3) times, and never once Solving has started (the step and its Feedback finish first). A Feedback verdict (revision + 1, issues, rejected candidates) is persisted to the plan *before* re-planning, so a yield inside the re-plan keeps the revise budget. |
| Dashed "Assign Suitable Role to Workers" | Role Arrangement picks the assignee of each subprocess. |
| Callout from a subprocess into **Metacognition (on matters)** | Each subprocess (task) is processed by one pass of Metacognition (§3). |

### Metacognition (on matters)

| Diagram block | Contents | Implementation | Model |
|---|---|---|---|
| **Target Understanding** | Problem Definition → Literature Review → Analysis (Perspectives) → *Understanding* | (1) problem definition: `{problem, successCriteria[], constraints[], unknowns[], intent: chat|work}`; (2) literature review = Memory recall (local working memory + own long-term + global) and subtask results, no LLM; (3) analysis: N perspectives (curiosity), each `{lens, insight, implication}` → `understanding {summary, score 0..1}` | economy · — · standard |
| **Self-ability Understanding** | LLM Capability · Tools/MCP Capability · Budget/Resource → *Competence* | Computed: resolved model profile (tier, context window, tool support), allowed tools + direct reports and their mandates, budget remaining and time limit → `competence {score 0..1, gaps[]}` | — |
| **Confidence · Risk/Uncertainty** | ⇄ Competence / Fallback (Evaluation) with Self-ability; ⇄ Understanding / Fallback (Evaluation) with Target Understanding; ⇓ Calibration; → Early Stop?; → ∝ Cognitive Control | `{confidence, risks[], uncertainty, understandingEval {score, gaps[]}, competenceEval {score, gaps[]}}`, calibrated with Monitoring. The arrows are **double-sided**: Competence and Understanding flow in, and an **evaluation** flows back ("Fallback (EL)" = evaluation, founder). When an evaluation scores < 0.5, that block re-runs **with the evaluation's gaps** as input — Target Understanding re-defines the problem around the gaps with a wider literature review; Self-ability applies remedies targeted at its gaps (one-tier upgrade for this run if budget allows, a report with the missing skill, a budget request). At most one fallback pass each. **Early Stop?** when calibrated confidence < threshold (0.25, +0.1 if autonomy low) or frustration > 0.7 → escalate (manager; the CEO asks the Board) → outcome `blocked`. Confidence also names a `blocker` (the one fact or decision only someone else can give, or null) and whether a wrong action is `irreversible`; on a first attempt with no setbacks, a low-confidence stop with no blocker on a reversible task proceeds on stated assumptions instead (live models rate any unknown near 0), and an escalation asks for the blocker itself. | economy |
| **Cognitive Control** | ∝ from Confidence; → Decomposition; → Solving and Evaluation; Candidate Solutions | **Control level** `c ∝ uncertainty` (founder: "proportional to"; drawn like α, so `c = clamp(α·uncertainty)` with α = 1 in `interpretation.ts`): it sets decomposition granularity (max subprocesses `1 + round(3c)`), whether reverse thinking runs (`c ≥ 0.4`), and evaluation strictness. **Decomposition** → subprocesses `{title, description, value, cost, acceptanceCriteria}` (each assigned by Role Arrangement; written to the TODO list as delegated subtasks, or kept as own steps). **Candidate Solutions**: always the diagram's three — *Solution 1 High Cost* (thorough: higher tier, more steps, extra verification), *Solution 2 Low Cost* (same scope on cheaper tiers, fewer steps), *Solution 3 Low Effort* (smallest change that meets the criteria: reuse memory, existing files and subtask results) — each `{approach, estCostUsd, expectedValue}`; Economic Concepts picks one. | agent tier |
| **Solving and Evaluation** | Solving → *Solution* → Feedback; ← Memory | Solving: delegated subprocesses → outcome `waiting` (resumes at Feedback when they finish); else a bounded tool loop (≤ 6 steps) with recalled memory in context → solution. **Feedback**: evaluate solution against success criteria → `{score, issues[], decision: accept | revise | rollback | escalate}` | agent tier · standard |
| **Memory** | Local Working Memory · Long-Term Memory; ← Literature Review, → Solving | Local working memory = `task.state` (plan, checkpoint, answers, iteration) + run scratch. Long-term memory = the agent's own episodic/procedural/semantic memories (FTS5). | — |
| **Project Management** › Data-driven Analysis | | Before choosing: actual cost and outcome of similar past tasks (episodic memory + spend records) correct the candidates' cost estimates. | — |
| › Economic Concepts (Cost, Margin…) | ↑ from Calibration | Choose the candidate with the highest margin `expectedValue·visionMultiplier − estCost`, risk-adjusted by calibrated confidence; conservation (safety need low) → cheapest that meets the criteria. | — |
| › Rollback / Failure Recovery | | On `rollback` or a failed run: cancel open subtasks, restore the last checkpoint, try the next-best candidate solution. Crash recovery (ported Glass Box notice) enters here on trigger `recovery`. | — |
| › Reflection / Replanning | | On `revise`: feed Feedback issues back into Cognitive Control (≤ `BRAIN_MAX_REVISIONS`, 0 in conservation mode). | economy |
| › Online Learning / Evolving | | After accept: one procedural lesson to long-term memory; calibration sample (predicted confidence vs outcome); optimization insights from OOD Monitoring kept as procedural memories tagged `optimization` (newest 50 per agent; recalled by Data-driven Analysis next time the same block runs); global memory writes (§ Global Memory). | economy |
| **Monitoring** › OOD Monitoring (NCU/NKI) | ↕ with the blocks below the dashed line; ↑ Project Management | Out-of-distribution monitoring under constraints, in the spirit of hardware kernel profilers (founder: NCU/NKI relate to constraints, optimization and hardware deployment; NCU = NVIDIA Nsight Compute). The agent profiles its own *deployment* — the model each block runs on — like a kernel: every model call's latency, input/output tokens, context-window use, cost and error/invalid-JSON rate, against (a) that block's history for this agent (`platform.metrics.blockProfile`) and (b) hard constraints (context window, budget, run deadline, tool support). Three signals: **task OOD** (no similar episodic memory → confidence capped at 0.6, wider literature review); **performance OOD** (a call beyond the block's p95 latency, tokens or cost); **constraint pressure** (context > 70% of window, budget < 20%, < 25% of run time left). Pressure lowers Confidence and makes Cognitive Control decompose finer and favour Low Cost / Low Effort candidates. Every OOD event becomes an *optimization insight* `{block, tier, symptom, remedy}` for Online Learning — profile → plan → apply → keep what worked, as in profile-guided kernel-optimization agents. | — |
| › Calibration | ⇓ Confidence, ↑ Economic Concepts | `calibrated = raw − (meanConfidence − successRate)·min(1, samples/20)`; Brier score kept on the agent. | — |
| › Reverse Thinking | | Premortem on the chosen plan when `c ≥ 0.4`: "assume this failed — why?" → risks added; a fatal one triggers Reflection/Replanning. | economy |
| › Truthful / Efficient / Good | | The three gates Feedback scores: truthful (claims supported by sources/subtask results; threshold from epistemic desire), efficient (actual cost ≤ 1.5× estimate), good (meets the success criteria and the values). | (inside Feedback) |

### Global Memory

| Diagram block | Implementation |
|---|---|
| Global Working Memory (Shared) | The company blackboard (`blackboard_*` tools); managers+ write. |
| Long-Term Memory › Episodic Memory | Every Report logs one episodic memory (what happened, outcome, cost) — the diagram's "Logs". |
| Semantic Memory › Procedural | Lessons from Online Learning that generalise beyond the agent (managers+). |
| Semantic Memory › Conceptual | "General Understanding": durable facts/insights about the company, market or product from evaluated work. |
| "Logs / General Understanding" arrow | The write path above, plus the trace itself. |

### The loop on the right edge

**Report** (bottom right) → **Feedback / Update** (top right) into
Sensibility/Emotion and Identity, and → **Interrupt** into the TODO list.
In code: every terminal outcome produces a Report `{outcome, score, cost,
summary}` that (a) updates emotion via Human Nature, OKR progress and the
self-narrative, and (b) completes the task, which wakes the parent's TODO list
(trigger `subtasks_completed`) — an interrupt for the manager.

## 3. One run, in order

```
TODO List: select / resume checkpoint ─────────────────────────────── todo_list
Self-management: charter = identity + drives(desire → motivation ← emotion, needs)
Metacognition (on matters):
  Target Understanding: problem definition → literature review → analysis
  Self-ability Understanding → competence
  Monitoring: OOD, calibration
  Confidence / Risk / Uncertainty ──Fallback──▶ Target Understanding | Self-ability (≤1 each)
                                  └─Early stop?──▶ escalate → blocked
  Cognitive Control (∝): decomposition → subprocesses (Role Arrangement assigns) │ candidate solutions
  Project Management: data-driven analysis → economic concepts (choose)
  Monitoring: reverse thinking (c ≥ 0.4) ──fatal──▶ Reflection/Replanning
  Solving and Evaluation: solving (delegate → waiting | tool loop) → solution → feedback
      accept ─▶ Report   revise ─▶ Reflection/Replanning   rollback ─▶ Rollback/Failure Recovery
Report → Feedback/Update (emotion, OKRs, self-narrative) · Online Learning · Global Memory
(interruptFor() is checked between blocks → yielded with checkpoint)
```

Trigger variants: `message` → charter + Target Understanding only, then a
chat reply (intent chat) or a new objective on the own TODO list (intent work);
`subtasks_completed` → resume at Feedback; `human_answer` → resume at the
checkpointed block with the answer in local working memory; `recovery` →
Rollback/Failure Recovery first (inspect existing subtasks, never duplicate).

**Answers and the escalation budget** (`brain/escalation.ts`). Escalating —
Early Stop, a Feedback `escalate`, or an `escalate`/`ask_human` call inside the
Solving tool loop (which ends the loop; the engine reuses that escalation) —
checkpoints the run (`escalated to manager` / `asked the Board`) and counts it
in `task.state.escalation {count, answered}`. The answer comes back into local
working memory (`task.state.answers`, `wm.escalationAnswer` / `wm.boardAnswer`)
and into the planning and Solving prompts; the engine always reasons over the
task row `patchState` returns, never the run's input snapshot. Once a manager
or the Board has answered, the task cannot be escalated again (at most 2
escalations per task in any case): Early Stop proceeds with the guidance, the
tools are withdrawn from Solving, and Feedback settles on accept-partial
(score ≥ 0.4) or **fail** when no revision, rollback or escalation is left —
never an endless `revise` across wake-ups.

Model calls per full pass: problem definition (economy), analysis (standard),
confidence (economy), cognitive control (agent tier), reverse thinking
(economy, conditional), solving (agent tier, 0..6 tool steps), feedback
(standard), learning + narrative (economy). About a third of the 33 blocks
call a model; the rest are computed.

## 4. Stage routing defaults (`STAGE_ROUTING` keys)

| key | tier |
|---|---|
| `metacognition.target_understanding.problem_definition` | economy |
| `metacognition.target_understanding.analysis` | standard |
| `metacognition.confidence` | economy |
| `metacognition.cognitive_control` | agent |
| `metacognition.monitoring.reverse_thinking` | economy |
| `metacognition.solving_evaluation.solving` | agent |
| `metacognition.solving_evaluation.feedback` | standard |
| `metacognition.project_management.reflection_replanning` | economy |
| `metacognition.project_management.online_learning` | economy |
| `self_management.identity.self_narrative` | economy |
| `chat.reply` | standard |
| `reflex.step` | agent |

## 5. Console: the live brain view

Agent detail → **Brain** tab draws this diagram with the same geometry as the
founder's slide: Self-management band (Role Arrangement left; Identity centre
with Self-Identity, Desire, Motivation columns, Self-Narrative Generator and
OKRs under them; Sensibility/Emotion over Human Nature right), the TODO List
band (the agent's open tasks as subprocess cards with Value and Cost),
Metacognition (Project Management row, Monitoring row, a dashed rule, then
Self-ability and Target Understanding left, the Confidence ellipse and
Cognitive Control centre, Candidate Solutions and Solving and Evaluation
right, Memory bottom centre), and the Global Memory band. Each box has its
`BrainBlockId`; the agent's live `brainBlock` is highlighted, blocks visited in
the current run are tinted, and clicking a block lists its spans in the latest
run. Boxes show live values: identity fields, desire/motivation bars, needs,
affect gauges, calibration, the BaZi pillars and five-element bars, MBTI.

## 6. Founder's readings of the diagram

Answered 2026-11-05. Each lives as a constant or small function in
`interpretation.ts`.

| # | Diagram text | Reading |
|---|---|---|
| Q1 | Red Chinese labels beside Desire, Motivation and at the left of Metacognition | Labels only (shown in the console) |
| Q2 | "OOD Monitoring (NCU/NKI)" | NCU and NKI relate to constraints, optimization and hardware deployment → profile-guided OOD monitoring of each block's model calls against history and constraints (§2) |
| Q3 | "Fallback (EL)" | EL = evaluation; the arrows are double-sided: Confidence returns an evaluation with gaps and the block re-runs on them |
| Q4 | Symbol between Confidence and Cognitive Control | "Proportional to" (drawn like α): `c = clamp(α·uncertainty)`, α = 1 |
| Q5 | "BIO / Asserts…" | BIO / Assets |
| Q6 | "Solution 3" | Low **Effort** |
| Q7 | Characters after Life View and after Truthful / Efficient / Good | Labels only |
| Q8 | Arrow into Human Nature | Fed by the finished processes |
| Q9 | Eight Characters and Five Elements in role assignment | Tie-breaker only |

References for Q2: [NCU (Nsight Compute CLI)](https://docs.csc.fi/computing/ncu/);
[AccelOpt: self-improving LLM agents for AI accelerator kernel optimization
(AWS Neuron NKI)](https://arxiv.org/abs/2511.15915) — profiling feedback +
optimization memory + planner/executor loop.
