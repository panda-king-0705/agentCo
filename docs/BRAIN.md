# Brain-Inspired Agent Architecture — implementation spec

Spec of record for `BrainEngine` (executives and managers). It follows the
founder's diagram ("Brain-Inspired Agent Architecture") **block for block**:
every box is a module and a traced block id (`BrainBlockId` in
`packages/shared`), and every arrow is a data flow below. It supersedes the
stage table that used to be in `ARCHITECTURE.md`.

Working assumptions for words the diagram leaves unclear are isolated in
**one module**, `apps/server/src/cognition/brain/interpretation.ts`, and
listed in [Open questions](#open-questions-pending-the-founder). Changing an
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
| → **Desire** | Task Driven · Curiosity · Epistemic · Vision | `identity.desires` (0..1) + `identity.vision` text. Drives: taskDriven → fewer perspectives, shorter loops; curiosity → literature-review breadth `k = 4 + 4·curiosity` and perspectives `2 + round(2·curiosity)`; epistemic → truthful gate `≥ 0.6 + 0.3·epistemic`; vision → value multiplier `1 + 0.5·vision` for subprocesses aligned with vision/OKRs. | — |
| → **Motivation** | Freedom/Competence/Purpose · Maslow's needs | `identity.motivation` + computed `NeedsState`. Freedom (autonomy) low → escalate sooner (early-stop threshold +0.1). Competence feeds Self-ability. Purpose → OKR weighting. **Maslow's needs** are computed from facts; the lowest unmet need steers behaviour: physiological (any budget left) → only essential work; safety (budget headroom ≥ 20%, no failure streak) → conservation: cheapest acceptable candidate, no revisions; belonging (manager/reports reachable) → message the manager first; esteem (acceptance rate) → stricter self-evaluation; self-actualisation (OKR progress) → curiosity +0.1. | — |
| **Self-Narrative Generator** | linked to BIO/Assets and Resource Connection | After a Report: refresh `identity.narrative` (2-3 sentences, first person), append demonstrated skills/deliverables to `assets`, collaborators to `resourceConnections`. Runs every 3rd completed objective or on a notable event (failure, escalation, praise). | economy |
| **Objectives and Key Results** | ↓ arrow into the TODO list | `identity.okrs`. Feed the TODO list: subprocesses aligned with a KR get the vision multiplier; KR `current` is advanced on Report when the evaluated result maps to it; on a heartbeat (if enabled), the KR with the largest gap proposes a new objective. | economy (heartbeat only) |
| **Role Arrangement (Master of My Destiny)** | Personality/MBTI · Eight Characters and Five Elements; dashed "Assign Suitable Role to Workers" into the subprocesses | `role-arrangement.ts` scores every candidate assignee for each decomposed subprocess: `fit = w_mandate·mandateFit + w_mbti·mbtiFit + w_bazi·elementFit`. mandateFit = keyword/skill overlap with title, mandate, assets; mbtiFit = task-kind ↔ preference table (e.g. analysis → T/N, outreach → E/F, process → S/J); elementFit = the subprocess's element (from its department, table in `interpretation.ts`) against the assignee's five-element balance. Weights live in `interpretation.ts` (default pending the founder: 0.7 / 0.2 / 0.1). Assignee must be an active direct report (CEO: anyone); the LLM's suggestion is one input, never trusted blindly. Also used by `hire_agent` to pick a persona for a new hire. | — |
| **Sensibility / Emotion** | ← Human Nature; → Motivation; ← Feedback/Update | `agent.affect` {valence, arousal, frustration}. Updated on every Report (Feedback/Update) using Human Nature's rules. → Motivation: frustration > 0.7 forces the early-stop gate (escalate); valence < −0.3 lowers autonomy by 0.1 for the next run; valence > 0.3 raises curiosity by 0.1 (bounded). | — |
| **Human Nature** | → Sensibility/Emotion; ↑ fed from the work below | `human-nature.ts`: the update rules — negativity bias (a failure moves valence 1.5× a success), habituation (repeat outcomes count less), fatigue (arousal rises with queue length and consecutive runs, decays when idle), recognition (acceptance by the manager or Board moves valence 2× self-acceptance). Constants in `interpretation.ts`. | — |

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
| **Interruptible**, "Interrupt" arrow from the right | Between blocks the engine calls `platform.tasks.interruptFor(agentId, priority)`. If something more urgent waits (an unanswered human message, a higher-priority ready task, a report that woke a parent), the engine checkpoints `{block, partial results}` into `task.state.checkpoint` and returns outcome **`yielded`** (task back to `todo`, attempts unchanged). The next run resumes at the checkpointed block. |
| Dashed "Assign Suitable Role to Workers" | Role Arrangement picks the assignee of each subprocess. |
| Callout from a subprocess into **Metacognition (on matters)** | Each subprocess (task) is processed by one pass of Metacognition (§3). |

### Metacognition (on matters)

| Diagram block | Contents | Implementation | Model |
|---|---|---|---|
| **Target Understanding** | Problem Definition → Literature Review → Analysis (Perspectives) → *Understanding* | (1) problem definition: `{problem, successCriteria[], constraints[], unknowns[], intent: chat|work}`; (2) literature review = Memory recall (local working memory + own long-term + global) and subtask results, no LLM; (3) analysis: N perspectives (curiosity), each `{lens, insight, implication}` → `understanding {summary, score 0..1}` | economy · — · standard |
| **Self-ability Understanding** | LLM Capability · Tools/MCP Capability · Budget/Resource → *Competence* | Computed: resolved model profile (tier, context window, tool support), allowed tools + direct reports and their mandates, budget remaining and time limit → `competence {score 0..1, gaps[]}` | — |
| **Confidence · Risk/Uncertainty** | ← Competence, ← Understanding, ⇓ Calibration; → Fallback (to both), → Early Stop?, → ∝ Cognitive Control | `{confidence, risks[], uncertainty}`; calibrated with Monitoring. **Fallback** to Target Understanding when understanding.score < 0.5 (one extra pass, wider literature review); **Fallback** to Self-ability when competence.score < 0.5 (remedies: one-tier upgrade for this run if budget allows, delegate to a report with the missing skill, request budget). At most one fallback each. **Early Stop?** when calibrated confidence < threshold (0.25, +0.1 if autonomy low) or frustration > 0.7 → escalate (manager; the CEO asks the Board) → outcome `blocked`. | economy |
| **Cognitive Control** | ∝ from Confidence; → Decomposition; → Solving and Evaluation; Candidate Solutions | **Control level** `c = uncertainty` (working reading of "∝", see §6): it sets decomposition granularity (max subprocesses `1 + round(3c)`), whether reverse thinking runs (`c ≥ 0.4`), and evaluation strictness. **Decomposition** → subprocesses `{title, description, value, cost, acceptanceCriteria}` (each assigned by Role Arrangement; written to the TODO list as delegated subtasks, or kept as own steps). **Candidate Solutions**: always the diagram's three — *Solution 1 High Cost*, *Solution 2 Low Cost*, *Solution 3 Low Effect* — each `{approach, estCostUsd, expectedValue}`; Economic Concepts picks one. | agent tier |
| **Solving and Evaluation** | Solving → *Solution* → Feedback; ← Memory | Solving: delegated subprocesses → outcome `waiting` (resumes at Feedback when they finish); else a bounded tool loop (≤ 6 steps) with recalled memory in context → solution. **Feedback**: evaluate solution against success criteria → `{score, issues[], decision: accept | revise | rollback | escalate}` | agent tier · standard |
| **Memory** | Local Working Memory · Long-Term Memory; ← Literature Review, → Solving | Local working memory = `task.state` (plan, checkpoint, answers, iteration) + run scratch. Long-term memory = the agent's own episodic/procedural/semantic memories (FTS5). | — |
| **Project Management** › Data-driven Analysis | | Before choosing: actual cost and outcome of similar past tasks (episodic memory + spend records) correct the candidates' cost estimates. | — |
| › Economic Concepts (Cost, Margin…) | ↑ from Calibration | Choose the candidate with the highest margin `expectedValue·visionMultiplier − estCost`, risk-adjusted by calibrated confidence; conservation (safety need low) → cheapest that meets the criteria. | — |
| › Rollback / Failure Recovery | | On `rollback` or a failed run: cancel open subtasks, restore the last checkpoint, try the next-best candidate solution. Crash recovery (ported Glass Box notice) enters here on trigger `recovery`. | — |
| › Reflection / Replanning | | On `revise`: feed Feedback issues back into Cognitive Control (≤ `BRAIN_MAX_REVISIONS`, 0 in conservation mode). | economy |
| › Online Learning / Evolving | | After accept: one procedural lesson to long-term memory; calibration sample (predicted confidence vs outcome); global memory writes (§ Global Memory). | economy |
| **Monitoring** › OOD Monitoring | ↕ with the blocks below the dashed line | Out-of-distribution check: how many episodic memories resemble this problem (FTS score); none → `ood = true` → confidence capped at 0.6 and a broader literature review. | — |
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

## 6. Open questions (pending the founder)

Each is a constant or small function in `interpretation.ts`.

| # | Diagram text | Working assumption |
|---|---|---|
| Q1 | Red Chinese labels: beside Desire, beside Motivation, at the left of the Metacognition band (two labels) | Read as 愿力 (aspiration), 心力 (drive), 执行力 (execution), 能力 (ability); shown as labels only, no extra behaviour |
| Q2 | "OOD Monitoring (NKU/NKK)" | Out-of-distribution check against the agent's own experience; letters unread |
| Q3 | "Fallback (EL)" on both arrows back from Confidence | A loop back to that block for one more pass; letters unread |
| Q4 | Symbol between Confidence and Cognitive Control ("∝" or "α") | "∝": control effort proportional to uncertainty |
| Q5 | "BIO / Asserts…" (cut off) | "BIO / Assets": the agent's profile, skills and deliverables |
| Q6 | "Solution 3: Low Effect" | Low effect (cheap, smaller impact), not "low effort" |
| Q7 | Characters after "Life View" and after Truthful / Efficient / Good | Labels only |
| Q8 | Weight of Eight Characters and Five Elements in role assignment | Weights 0.7 mandate / 0.2 MBTI / 0.1 BaZi |
| Q9 | Arrow from below into Human Nature | Work events (outcomes, workload) feed Human Nature's update rules |
