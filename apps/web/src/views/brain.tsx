// The live brain view: an SVG redrawn from the founder's "Brain-Inspired Agent Architecture" slide.
// Every box carries a BrainBlockId. The agent's live brainBlock gets a thick outline and a NOW tag,
// blocks visited in the selected run are tinted and carry a check + visit count, and a click lists
// that block's spans. Status never relies on colour alone: outline weight, tags and text carry it too.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { duration, money, pct, truncate } from "../format";
import { href } from "../router";
import { useApi, useLive } from "../live";
import { Button, Empty, KindSwatch, RelTime, SpanStatusBadge } from "../ui/kit";
import type { AgentDetail, BaZiChart, BrainBlockId, FiveElement, Span, Task } from "../types";
import { blockLabel } from "./common";

interface Ctx {
  active: string | null;
  visited: Map<string, number>;
  selected: string | null;
  select: (id: BrainBlockId) => void;
}
const BrainCtx = createContext<Ctx>({ active: null, visited: new Map(), selected: null, select: () => {} });

const ELEMENT_CHAR: Record<FiveElement, string> = { wood: "木", fire: "火", earth: "土", metal: "金", water: "水" };
const ELEMENTS: FiveElement[] = ["wood", "fire", "earth", "metal", "water"];

// ───────────── drawing primitives ─────────────
function wrapText(text: string, cpl: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > cpl && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncate(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, cpl);
    return kept;
  }
  return lines;
}

// The founder's diagram labels (docs/BRAIN.md §6, Q1 and Q7): drawn as labels only, never interpreted.
// Mirrors Q1_LABELS / Q7_LABELS in apps/server/src/cognition/brain/interpretation.ts.
const Q1_LABELS = { desire: "愿力", motivation: "心力", metacognitionLeft: ["执行力", "能力"] } as const;
const Q7_LABELS = { lifeView: "生", truthful: "真", efficient: "善", good: "美" } as const;

function T({ x, y, size = 11, bold, anchor, cls = "bt", children }: { x: number; y: number; size?: number; bold?: boolean; anchor?: "start" | "middle" | "end"; cls?: string; children: ReactNode }) {
  return (
    <text x={x} y={y} fontSize={size} fontWeight={bold ? 650 : 400} textAnchor={anchor} className={cls}>
      {children}
    </text>
  );
}

function Wrap({ x, y, w, size = 10, lh, lines, text, anchor, cls = "bv" }: { x: number; y: number; w: number; size?: number; lh?: number; lines: number; text: string; anchor?: "start" | "middle" | "end"; cls?: string }) {
  const cpl = Math.max(6, Math.floor(w / (size * 0.54)));
  const l = wrapText(text, cpl, lines);
  const step = lh ?? size * 1.22;
  return (
    <text x={x} y={y} fontSize={size} textAnchor={anchor} className={cls}>
      {l.map((s, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : step}>
          {s}
        </tspan>
      ))}
    </text>
  );
}

function Bar({ x, y, w, v, label, text, labelW = 64, h = 7, threshold, diverging }: { x: number; y: number; w: number; v: number; label?: string; text?: string; labelW?: number; h?: number; threshold?: number; diverging?: boolean }) {
  const bx = label ? x + labelW : x;
  const bw = w - (label ? labelW : 0) - (text ? 30 : 0);
  const val = Math.max(0, Math.min(1, diverging ? (v + 1) / 2 : v));
  const mid = bx + bw / 2;
  return (
    <g>
      {label ? <T x={x} y={y + h - 0.5} size={10.5} cls="bv">{label}</T> : null}
      <rect x={bx} y={y} width={bw} height={h} rx={h / 2} className="btrack" />
      {diverging ? (
        <>
          <rect x={Math.min(mid, bx + bw * val)} y={y} width={Math.abs(bx + bw * val - mid)} height={h} rx={h / 2} className={v < 0 ? "bfill neg" : "bfill"} />
          <line x1={mid} x2={mid} y1={y - 2} y2={y + h + 2} className="bmid" />
        </>
      ) : (
        <rect x={bx} y={y} width={Math.max(bw * val, val > 0 ? h : 0)} height={h} rx={h / 2} className={threshold != null && v >= threshold ? "bfill hot" : "bfill"} />
      )}
      {threshold != null ? <line x1={bx + bw * threshold} x2={bx + bw * threshold} y1={y - 2} y2={y + h + 2} className="bthr" /> : null}
      {text ? <T x={bx + bw + 4} y={y + h - 0.5} size={10} cls="bv num">{text}</T> : null}
    </g>
  );
}

interface BlkProps {
  id: BrainBlockId;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: "rect" | "ellipse";
  label: string;
  className?: string;
  noTag?: boolean;
  children?: ReactNode;
}
/** A box that is a diagram block: carries the id, shows live/visited/selected state, is clickable. */
function Blk({ id, x, y, w, h, shape = "rect", label, className = "", noTag, children }: BlkProps) {
  const { active, visited, selected, select } = useContext(BrainCtx);
  const isActive = active === id;
  const n = visited.get(id) ?? 0;
  const isSel = selected === id;
  const cls = `bb${n ? " visited" : ""}${isActive ? " active" : ""}${isSel ? " selected" : ""} ${className}`;
  const aria = `${label}${isActive ? ", active now" : ""}${n ? `, visited ${n} time${n === 1 ? "" : "s"} in this run` : ""}`;
  const tagY = shape === "ellipse" ? y + h / 2 - h / 2 - 2 : y - 7;
  const right = x + w - (shape === "ellipse" ? 40 : 0);
  return (
    <g
      className="bblk"
      data-block={id}
      data-active={isActive ? "true" : undefined}
      data-visited={n ? String(n) : undefined}
      role="button"
      tabIndex={0}
      aria-label={aria}
      aria-pressed={isSel}
      onClick={() => select(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(id);
        }
      }}
    >
      <title>{`${label} (${id})`}</title>
      {shape === "ellipse" ? (
        <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} className={cls} />
      ) : (
        <rect x={x} y={y} width={w} height={h} rx={7} className={cls} />
      )}
      {children}
      {isActive && !noTag ? (
        <g className="tag now" transform={`translate(${right - 36},${tagY})`}>
          <rect width="36" height="14" rx="7" />
          <text x="18" y="10.5" textAnchor="middle" fontSize="9" fontWeight="700">NOW</text>
        </g>
      ) : null}
      {n && !noTag ? (
        <g className="tag seen" transform={`translate(${right - (isActive ? 36 + 34 : 30)},${tagY})`}>
          <rect width="28" height="14" rx="7" />
          <text x="14" y="10.5" textAnchor="middle" fontSize="9" fontWeight="650">{`✓${n > 1 ? n : ""}`}</text>
        </g>
      ) : null}
    </g>
  );
}

function Box({ x, y, w, h, children, className = "" }: { x: number; y: number; w: number; h: number; children?: ReactNode; className?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} className={`bsub ${className}`} />
      {children}
    </g>
  );
}

function Cont({ x, y, w, h, className = "", rx = 10 }: { x: number; y: number; w: number; h: number; className?: string; rx?: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={rx} className={`bc ${className}`} />;
}

function Arrow({ d, cls = "", both }: { d: string; cls?: string; both?: boolean }) {
  return <path d={d} className={`arr ${cls}`} markerEnd="url(#ah)" markerStart={both ? "url(#ahs)" : undefined} fill="none" />;
}

// ───────────── diagram content ─────────────
function Pillars({ chart, x, y }: { chart: BaZiChart | null; x: number; y: number }) {
  if (!chart) return <T x={x} y={y + 20} size={10} cls="bv">No chart cast</T>;
  const max = Math.max(...Object.values(chart.elements), 1);
  const names = ["Year", "Month", "Day", "Hour"];
  return (
    <g>
      {chart.pillars.map((p, i) => (
        <g key={i} transform={`translate(${x + i * 42},${y})`}>
          <rect width="38" height="36" rx="4" className={`bpillar${i === 2 ? " day" : ""}`} />
          <text x="19" y="19" textAnchor="middle" fontSize="16" className="bt">{p}</text>
          <text x="19" y="31" textAnchor="middle" fontSize="8" className="bv">{names[i]}</text>
        </g>
      ))}
      {ELEMENTS.map((el, i) => {
        const n = chart.elements[el] ?? 0;
        const hgt = (n / max) * 34;
        const cx = x + i * 33.5;
        return (
          <g key={el}>
            <title>{`${el}: ${n}`}</title>
            <rect x={cx} y={y + 46} width="28" height="34" rx="3" className="btrack" />
            <rect x={cx} y={y + 80 - hgt} width="28" height={hgt} rx="3" className={`bel el-${el}`} />
            <text x={cx + 14} y={y + 92} textAnchor="middle" fontSize="10" className="bv">{ELEMENT_CHAR[el]}{n}</text>
          </g>
        );
      })}
      <T x={x} y={y + 107} size={9.5} cls="bv">Day master {chart.dayMaster} ({chart.dayMasterElement})</T>
    </g>
  );
}

function SelfManagement({ d, live }: { d: AgentDetail; live: AgentDetail["agent"] }) {
  const id = live.identity;
  const needs = d.needs;
  const okrProgress = useMemo(() => {
    const krs = id.okrs.flatMap((o) => o.keyResults);
    if (!krs.length) return 0;
    return krs.reduce((s, k) => s + (k.target > 0 ? Math.min(1, k.current / k.target) : 0), 0) / krs.length;
  }, [id.okrs]);
  const chip = (x: number, y: number, label: string, v: "ok" | "low") => (
    <g key={label}>
      <rect x={x} y={y} width="98" height="15" rx="7.5" className={`bchip ${v}`} />
      <text x={x + 8} y={y + 10.5} fontSize="9.5" className="bt">{v === "ok" ? "✓" : "!"} {label}</text>
    </g>
  );
  return (
    <g>
      <T x={630} y={17} size={14} bold anchor="middle">Self-management</T>
      <rect x={10} y={26} width={1210} height={328} rx={12} className="band self" />

      {/* Role Arrangement */}
      <Blk id="self_management.role_arrangement" x={24} y={42} w={196} h={300} label="Role Arrangement">
        <Wrap x={122} y={60} w={180} size={11.5} lines={2} text="Role Arrangement (Master of My Destiny)" anchor="middle" cls="bt bold" />
        <Box x={36} y={88} w={172} h={66}>
          <T x={122} y={104} size={10.5} anchor="middle" cls="bv">Personality / MBTI</T>
          <T x={122} y={136} size={24} bold anchor="middle">{live.persona.personalityType ?? "—"}</T>
        </Box>
        <Box x={36} y={164} w={172} h={170}>
          <Wrap x={122} y={180} w={160} size={10.5} lines={2} text="Eight Characters and Five Elements" anchor="middle" cls="bt" />
          <Pillars chart={live.persona.baZi} x={40} y={200} />
        </Box>
      </Blk>

      {/* Identity */}
      <Cont x={236} y={42} w={640} h={300} />
      <T x={556} y={60} size={13} bold anchor="middle">Identity</T>

      <Blk id="self_management.identity.self_identity" x={248} y={70} w={186} h={262} label="Self-Identity">
        <T x={341} y={87} size={12} bold anchor="middle">Self-Identity</T>
        {[
          ["Worldview", id.worldview],
          ["Life View", id.lifeView],
          ["Value", id.values.join(" · ")],
          ["BIO / Assets", id.assets.length ? `${id.assets.length}: ${id.assets.join(", ")}` : "none yet"],
          ["Resource Connection", id.resourceConnections.length ? `${id.resourceConnections.length}: ${id.resourceConnections.join(", ")}` : "none yet"],
        ].map(([label, text], i) => (
          <Box key={label} x={258} y={96 + i * 47} w={166} h={40}>
            <T x={266} y={96 + i * 47 + 13} size={11} bold>
              {label}
              {/* Q7: the character after Life View — a label only */}
              {label === "Life View" ? <tspan className="red" fontWeight={400} dx={4}>{Q7_LABELS.lifeView}</tspan> : null}
            </T>
            <Wrap x={266} y={96 + i * 47 + 26} w={150} size={9.5} lines={1} text={text ?? ""} />
            <title>{text}</title>
          </Box>
        ))}
        <Arrow d="M341,184 V 192" cls="thin" />
      </Blk>
      <Arrow d="M436,166 H 450" cls="thick" />
      <Arrow d="M624,166 H 634" cls="thick" />

      <Blk id="self_management.identity.desire" x={452} y={70} w={170} h={196} label="Desire">
        <T x={470} y={87} size={12} bold>Desire</T>
        <T x={604} y={87} size={12} cls="red" anchor="end">{Q1_LABELS.desire}</T>
        {([["Task Driven", id.desires.taskDriven], ["Curiosity", id.desires.curiosity], ["Epistemic", id.desires.epistemic], ["Vision", id.desires.vision]] as const).map(([label, v], i) => (
          <Box key={label} x={462} y={96 + i * 41} w={150} h={36}>
            <T x={470} y={96 + i * 41 + 13} size={11}>{label}</T>
            <Bar x={470} y={96 + i * 41 + 21} w={134} v={v} text={v.toFixed(2)} />
            {label === "Vision" ? <title>{id.vision}</title> : null}
          </Box>
        ))}
      </Blk>

      <Blk id="self_management.identity.motivation" x={636} y={70} w={228} h={196} label="Motivation">
        <T x={654} y={87} size={12} bold>Motivation</T>
        <T x={848} y={87} size={12} cls="red" anchor="end">{Q1_LABELS.motivation}</T>
        <Box x={646} y={96} w={208} h={80}>
          <T x={654} y={110} size={10.5} bold>Freedom / Competence / Purpose</T>
          <Bar x={654} y={118} w={192} v={id.motivation.autonomy} label="Freedom" labelW={72} text={id.motivation.autonomy.toFixed(2)} />
          <Bar x={654} y={134} w={192} v={id.motivation.competence} label="Competence" labelW={72} text={id.motivation.competence.toFixed(2)} />
          <Bar x={654} y={150} w={192} v={id.motivation.purpose} label="Purpose" labelW={72} text={id.motivation.purpose.toFixed(2)} />
        </Box>
        <Box x={646} y={184} w={208} h={74}>
          <T x={654} y={198} size={10.5} bold>Maslow's needs</T>
          {chip(652, 204, "Physiological", needs.physiological)}
          {chip(752, 204, "Safety", needs.safety)}
          {chip(652, 222, "Belonging", needs.belonging)}
          {chip(752, 222, "Esteem", needs.esteem)}
          <Bar x={654} y={242} w={192} v={needs.selfActualization} label="Self-actualis." labelW={72} text={pct(needs.selfActualization)} />
        </Box>
      </Blk>

      <Blk id="self_management.identity.self_narrative" x={452} y={276} w={170} h={58} label="Self-Narrative Generator">
        <T x={462} y={290} size={11} bold>Self-Narrative Generator</T>
        <Wrap x={462} y={303} w={152} size={9.5} lines={3} text={id.narrative || "No narrative yet"} />
        <title>{id.narrative}</title>
      </Blk>
      <Blk id="self_management.identity.okr" x={636} y={276} w={228} h={58} label="Objectives and Key Results">
        <T x={646} y={290} size={11} bold>Objectives and Key Results</T>
        <Wrap x={646} y={303} w={208} size={9.5} lines={1} text={id.okrs[0]?.objective ?? "No objectives"} />
        <Bar x={646} y={314} w={208} v={okrProgress} text={pct(okrProgress)} />
      </Blk>
      <Arrow d="M452,306 H 440 V 262 H 426" cls="thin dotted" />

      {/* Emotion and human nature */}
      <T x={1064} y={70} size={10.5} anchor="middle" cls="bv">Feedback / Update</T>
      <Blk id="self_management.sensibility_emotion" x={962} y={78} w={200} h={124} label="Sensibility / Emotion">
        <T x={1062} y={96} size={12} bold anchor="middle">Sensibility / Emotion</T>
        <T x={974} y={116} size={10.5} cls="bv">Valence</T>
        <Bar x={974} y={120} w={176} v={live.affect.valence} diverging text={live.affect.valence.toFixed(2)} />
        <T x={974} y={146} size={10.5} cls="bv">Arousal</T>
        <Bar x={974} y={150} w={176} v={live.affect.arousal} text={live.affect.arousal.toFixed(2)} />
        <T x={974} y={176} size={10.5} cls="bv">Frustration (escalates at 0.7)</T>
        <Bar x={974} y={180} w={176} v={live.affect.frustration} threshold={0.7} text={live.affect.frustration.toFixed(2)} />
      </Blk>
      <Blk id="self_management.human_nature" x={962} y={240} w={200} h={84} label="Human Nature">
        <T x={1062} y={258} size={12} bold anchor="middle">Human Nature</T>
        <T x={1062} y={276} size={9.5} anchor="middle" cls="bv">negativity bias · habituation</T>
        <T x={1062} y={289} size={9.5} anchor="middle" cls="bv">fatigue · recognition</T>
        <T x={1062} y={309} size={9.5} anchor="middle" cls="bv">fed by finished processes</T>
      </Blk>
      <Arrow d="M1062,239 V 205" cls="thick" />
      <Arrow d="M961,140 H 866" cls="thick" />
    </g>
  );
}

function TodoBand({ tasks, currentTaskId }: { tasks: Task[]; currentTaskId: string | null }) {
  const shown = tasks.slice(0, 4);
  const more = tasks.length - 3;
  const cards = tasks.length > 4 ? tasks.slice(0, 3) : shown;
  return (
    <g>
      <Blk id="todo_list" x={10} y={372} w={1210} h={84} label="TODO List (Interruptible)" className="band-blk">
        <T x={26} y={406} size={13} bold>TODO List</T>
        <T x={26} y={422} size={11} cls="bv">(Interruptible)</T>
        <T x={26} y={438} size={9.5} cls="bv">{tasks.length} open · by value ÷ cost</T>
      </Blk>
      {cards.map((t, i) => {
        const x = 232 + i * 236;
        const cur = t.id === currentTaskId;
        return (
          <a key={t.id} href={href(`/tasks/${t.id}`)} className="bcard-link" aria-label={`Subprocess T-${t.number}: ${t.title}. Value ${t.value}, cost ${money(t.estCostUsd)}${cur ? ". In progress now" : ""}`}>
            <rect x={x} y={384} width={220} height={60} rx={7} className={`bcard${cur ? " cur" : ""}`} />
            <T x={x + 10} y={402} size={11} bold>T-{t.number} {truncate(t.title, cur ? 17 : 26)}</T>
            <T x={x + 10} y={419} size={10.5} cls="bv">Value: {t.value}</T>
            <T x={x + 10} y={435} size={10.5} cls="bv">Cost: {money(t.estCostUsd)}</T>
            <T x={x + 210} y={435} size={9.5} anchor="end" cls="bv">{t.status.replace("_", " ")}</T>
            {cur ? <text x={x + 210} y={402} textAnchor="end" fontSize="9" fontWeight="700" className="bnow">● NOW</text> : null}
            <title>{t.title}</title>
          </a>
        );
      })}
      {tasks.length > 4 ? (
        <g>
          <rect x={232 + 3 * 236} y={384} width={220} height={60} rx={7} className="bcard more" />
          <T x={232 + 3 * 236 + 110} y={410} size={13} bold anchor="middle">… {more} more</T>
          <T x={232 + 3 * 236 + 110} y={428} size={10} anchor="middle" cls="bv">lower priority subprocesses</T>
        </g>
      ) : null}
      {!tasks.length ? <T x={620} y={420} size={12} anchor="middle" cls="bv">No open subprocesses. The TODO list is empty.</T> : null}
    </g>
  );
}

function Metacognition({ d, live, memoryCounts }: { d: AgentDetail; live: AgentDetail["agent"]; memoryCounts: Record<string, number> | null }) {
  const profileId = live.modelOverride;
  const budgetLeft = Math.max(0, live.monthlyBudgetUsd - d.stats.spentMonthUsd);
  const budgetRatio = live.monthlyBudgetUsd > 0 ? budgetLeft / live.monthlyBudgetUsd : 0;
  const pmBoxes: [BrainBlockId, string][] = [
    ["metacognition.project_management.data_driven_analysis", "Data-driven Analysis"],
    ["metacognition.project_management.economic_concepts", "Economic Concepts (Cost, Margin…)"],
    ["metacognition.project_management.rollback_failure_recovery", "Rollback / Failure Recovery"],
    ["metacognition.project_management.reflection_replanning", "Reflection / Replanning"],
    ["metacognition.project_management.online_learning", "Online Learning / Evolving"],
  ];
  return (
    <g>
      <rect x={10} y={470} width={1210} height={492} rx={12} className="band meta" />
      <T x={820} y={490} size={14} bold anchor="middle">Metacognition (on matters)</T>
      {/* Q1: the red labels at the left of the Metacognition band — labels only */}
      <T x={24} y={490} size={12} cls="red">{Q1_LABELS.metacognitionLeft[0]}</T>
      <T x={68} y={490} size={12} cls="red">{Q1_LABELS.metacognitionLeft[1]}</T>

      {/* Project Management */}
      <Cont x={24} y={498} w={1172} h={64} />
      <T x={40} y={535} size={12.5} bold>Project Management</T>
      {pmBoxes.map(([id, label], i) => (
        <Blk key={id} id={id} x={232 + i * 190} y={508} w={176} h={44} label={label}>
          <Wrap x={232 + i * 190 + 88} y={527} w={150} size={11} lines={2} text={label} anchor="middle" cls="bt" />
        </Blk>
      ))}

      {/* Monitoring */}
      <Cont x={24} y={574} w={1172} h={58} />
      <T x={40} y={608} size={12.5} bold>Monitoring</T>
      <Blk id="metacognition.monitoring.ood" x={232} y={582} w={200} h={42} label="OOD Monitoring (NCU/NKI)">
        <T x={332} y={600} size={11} anchor="middle">OOD Monitoring (NCU/NKI)</T>
        <T x={332} y={614} size={9} anchor="middle" cls="bv">profile calls vs history + limits</T>
      </Blk>
      <Blk id="metacognition.monitoring.calibration" x={446} y={582} w={170} h={42} label="Calibration">
        <T x={531} y={600} size={11} anchor="middle">Calibration</T>
        <T x={531} y={614} size={9.5} anchor="middle" cls="bv num">Brier {live.calibration.brier.toFixed(2)} · n={live.calibration.samples}</T>
      </Blk>
      <Blk id="metacognition.monitoring.reverse_thinking" x={630} y={582} w={170} h={42} label="Reverse Thinking">
        <T x={715} y={600} size={11} anchor="middle">Reverse Thinking</T>
        <T x={715} y={614} size={9} anchor="middle" cls="bv">premortem when c ≥ 0.4</T>
      </Blk>
      <Blk id="metacognition.monitoring.truthful_efficient_good" x={814} y={582} w={354} h={42} label="Truthful / Efficient / Good">
        {/* Q7: the characters after Truthful / Efficient / Good — labels only */}
        <T x={991} y={600} size={11} anchor="middle">
          Truthful <tspan className="red">{Q7_LABELS.truthful}</tspan> / Efficient <tspan className="red">{Q7_LABELS.efficient}</tspan> / Good <tspan className="red">{Q7_LABELS.good}</tspan>
        </T>
        <T x={991} y={614} size={9} anchor="middle" cls="bv">the three gates Feedback scores</T>
      </Blk>
      <Arrow d="M531,580 V 554" cls="thick" />
      <Arrow d="M332,626 V 676" cls="thin" both />
      <Arrow d="M715,626 V 700" cls="thin" both />
      <Arrow d="M991,626 V 652" cls="thin" both />
      <line x1={24} x2={1196} y1={642} y2={642} className="dashrule" />

      {/* Self-ability */}
      <Blk id="metacognition.self_ability" x={24} y={654} w={380} h={108} label="Self-ability Understanding">
        <T x={38} y={672} size={12} bold>Self-ability Understanding</T>
        <Box x={34} y={682} w={112} h={70}>
          <T x={90} y={698} size={10.5} anchor="middle" bold>LLM Capability</T>
          <T x={90} y={716} size={10} anchor="middle" cls="bv">{live.modelTier}</T>
          <T x={90} y={730} size={9} anchor="middle" cls="bv">{profileId ? truncate(profileId, 18) : "tier default"}</T>
        </Box>
        <Box x={154} y={682} w={112} h={70}>
          <T x={210} y={698} size={10.5} anchor="middle" bold>Tools/MCP Capability</T>
          <T x={210} y={718} size={10} anchor="middle" cls="bv">{live.tools.length} tools</T>
          <T x={210} y={732} size={9} anchor="middle" cls="bv">{d.reports.length} reports</T>
        </Box>
        <Box x={274} y={682} w={122} h={70}>
          <T x={335} y={698} size={10.5} anchor="middle" bold>Budget/Resource</T>
          <T x={335} y={716} size={10} anchor="middle" cls="bv num">{money(budgetLeft)} left</T>
          <Bar x={288} y={726} w={94} v={budgetRatio} h={6} />
        </Box>
      </Blk>

      {/* Target Understanding */}
      <Cont x={24} y={772} w={380} h={114} />
      <T x={38} y={790} size={12} bold>Target Understanding</T>
      {([
        ["metacognition.target_understanding.problem_definition", "Problem Definition", 34],
        ["metacognition.target_understanding.literature_review", "Literature Review", 150],
        ["metacognition.target_understanding.analysis", "Analysis (Perspectives)", 266],
      ] as [BrainBlockId, string, number][]).map(([id, label, x]) => (
        <Blk key={id} id={id} x={x} y={800} w={110} h={74} label={label}>
          <Wrap x={x + 55} y={832} w={96} size={11} lines={2} text={label} anchor="middle" cls="bt" />
        </Blk>
      ))}
      <Arrow d="M145,837 H 149" cls="thin" />
      <Arrow d="M261,837 H 265" cls="thin" />

      {/* Confidence / Cognitive control */}
      <Blk id="metacognition.confidence" x={526} y={714} w={228} h={96} shape="ellipse" label="Confidence, Risk and Uncertainty">
        <T x={640} y={754} size={13.5} bold anchor="middle">Confidence</T>
        <T x={640} y={771} size={11.5} anchor="middle">Risk / Uncertainty</T>
        <T x={640} y={789} size={9.5} anchor="middle" cls="bv num">mean {live.calibration.meanConfidence.toFixed(2)} · success {pct(live.calibration.successRate)}</T>
      </Blk>
      <Arrow d="M546,632 V 690 L 574,724" cls="fat" />
      <Arrow d="M404,708 L 536,756" cls="thin" />
      <T x={414} y={700} size={10.5} cls="bv">Competence</T>
      <Arrow d="M404,736 L 530,774" cls="thin" both />
      <T x={414} y={760} size={9.5} cls="bv">Fallback (Evaluation)</T>
      <Arrow d="M404,846 L 536,800" cls="thin" />
      <T x={414} y={866} size={10.5} cls="bv">Understanding</T>
      <Arrow d="M404,812 L 530,786" cls="thin" both />
      <T x={414} y={804} size={9.5} cls="bv">Fallback (Evaluation)</T>
      <Arrow d="M600,808 L 592,826" cls="thin" />
      <T x={592} y={840} size={10.5} anchor="middle" cls="bv">Early Stop?</T>
      <T x={772} y={756} size={20} anchor="middle" cls="bt">∝</T>
      <Arrow d="M756,768 H 788" cls="thick" />

      <Blk id="metacognition.cognitive_control.decomposition" x={790} y={736} w={120} h={64} label="Cognitive Control">
        <T x={850} y={764} size={12} bold anchor="middle">Cognitive</T>
        <T x={850} y={780} size={12} bold anchor="middle">Control</T>
      </Blk>
      {[0, 1].map((i) => (
        <Blk key={i} id="metacognition.cognitive_control.decomposition" x={794 + i * 64} y={660} w={58} h={44} label={`Decomposition subprocess ${i + 1}`} noTag>
          <T x={794 + i * 64 + 29} y={679} size={9} anchor="middle">Subprocess {i + 1}</T>
          <T x={794 + i * 64 + 29} y={693} size={9} anchor="middle" cls="bv">Value: xx</T>
        </Blk>
      ))}
      <Arrow d="M840,735 V 708" cls="thin" />
      <T x={848} y={724} size={9.5} cls="bv">Decomposition</T>

      <Blk id="metacognition.cognitive_control.candidate_solutions" x={940} y={654} w={266} h={96} label="Candidate Solutions">
        <T x={954} y={671} size={12} bold>Candidate Solutions</T>
        {(["Solution 1", "High Cost", "Solution 2", "Low Cost", "Solution 3", "Low Effort"] as const).reduce<ReactNode[]>((acc, _, i, a) => {
          if (i % 2) return acc;
          const k = i / 2;
          acc.push(
            <Box key={k} x={950 + k * 84} y={682} w={78} h={58}>
              <T x={950 + k * 84 + 39} y={705} size={10} anchor="middle">{a[i]}</T>
              <T x={950 + k * 84 + 39} y={722} size={10.5} anchor="middle" bold>{a[i + 1]}</T>
            </Box>,
          );
          return acc;
        }, [])}
      </Blk>
      <Arrow d="M910,756 H 970 V 752" cls="thin" />
      <Arrow d="M910,788 H 938" cls="thick" />

      {/* Solving and Evaluation */}
      <Cont x={940} y={770} w={266} h={116} />
      <T x={1073} y={788} size={12} bold anchor="middle">Solving and Evaluation</T>
      <Blk id="metacognition.solving_evaluation.solving" x={950} y={800} w={104} h={74} label="Solving">
        <T x={1002} y={842} size={12} anchor="middle" bold>Solving</T>
      </Blk>
      <Blk id="metacognition.solving_evaluation.feedback" x={1090} y={800} w={106} h={74} label="Feedback">
        <T x={1143} y={842} size={12} anchor="middle" bold>Feedback</T>
      </Blk>
      <Arrow d="M1056,846 H 1088" cls="thick" />
      <T x={1072} y={838} size={9} anchor="middle" cls="bv">Solution</T>

      {/* Memory */}
      <Cont x={560} y={868} w={340} h={84} />
      <T x={730} y={885} size={12} bold anchor="middle">Memory</T>
      <Blk id="metacognition.memory.local_working" x={572} y={894} w={152} h={48} label="Local Working Memory">
        <Wrap x={648} y={914} w={140} size={11} lines={2} text="Local Working Memory" anchor="middle" cls="bt" />
      </Blk>
      <Blk id="metacognition.memory.long_term" x={736} y={894} w={152} h={48} label="Long-Term Memory">
        <Wrap x={812} y={914} w={140} size={11} lines={2} text="Long-Term Memory" anchor="middle" cls="bt" />
      </Blk>
      <Arrow d="M404,878 H 558" cls="thin" />
      <Arrow d="M902,912 H 1000 V 888" cls="thin" />
      <T x={738} y={977} size={9.5} cls="bv">Logs / General Understanding</T>
      <Arrow d="M730,953 V 990" cls="thin" />
    </g>
  );
}

function GlobalMemory({ counts, keys }: { counts: Record<string, number> | null; keys: number | null }) {
  const c = (k: string) => (counts ? `${counts[k] ?? 0} items` : "…");
  return (
    <g>
      <rect x={10} y={988} width={1210} height={92} rx={12} className="band glob" />
      <Cont x={24} y={1000} w={92} h={64} />
      <T x={70} y={1028} size={11.5} bold anchor="middle">Global</T>
      <T x={70} y={1044} size={11.5} bold anchor="middle">Memory</T>
      <Blk id="global_memory.working" x={130} y={1000} w={230} h={64} label="Global Working Memory (Shared)">
        <T x={245} y={1027} size={12} anchor="middle" bold>Global Working Memory</T>
        <T x={245} y={1043} size={10.5} anchor="middle" cls="bv">(Shared) · {keys == null ? "…" : `${keys} blackboard keys`}</T>
      </Blk>
      <Cont x={376} y={1000} w={120} h={64} />
      <T x={436} y={1028} size={11.5} bold anchor="middle">Long-Term</T>
      <T x={436} y={1044} size={11.5} bold anchor="middle">Memory</T>
      <Blk id="global_memory.episodic" x={510} y={1000} w={190} h={64} label="Episodic Memory">
        <T x={605} y={1027} size={12} anchor="middle" bold>Episodic Memory</T>
        <T x={605} y={1043} size={10.5} anchor="middle" cls="bv">logs · {c("episodic")}</T>
      </Blk>
      <Cont x={714} y={996} w={492} h={72} />
      <T x={728} y={1036} size={12} bold>Semantic Memory</T>
      <Blk id="global_memory.procedural" x={852} y={1004} w={166} h={56} label="Procedural">
        <T x={935} y={1029} size={12} anchor="middle" bold>Procedural</T>
        <T x={935} y={1046} size={10.5} anchor="middle" cls="bv">{c("procedural")}</T>
      </Blk>
      <Blk id="global_memory.conceptual" x={1032} y={1004} w={166} h={56} label="Conceptual">
        <T x={1115} y={1029} size={12} anchor="middle" bold>Conceptual</T>
        <T x={1115} y={1046} size={10.5} anchor="middle" cls="bv">{c("conceptual")}</T>
      </Blk>
    </g>
  );
}

// ───────────── the view ─────────────
const STAGE_BLOCK = "agentco.brain.block";
export function spanBlock(s: Span): string | null {
  const b = s.attributes?.[STAGE_BLOCK];
  return typeof b === "string" ? b : null;
}

export function BrainView({ detail }: { detail: AgentDetail }) {
  const agentId = detail.agent.id;
  const live = useLive((s) => s.agents[agentId]) ?? detail.agent;
  const liveTasks = useLive((s) => s.tasks);
  const liveSpans = useLive((s) => s.spans);
  const [runChoice, setRunChoice] = useState<string>("latest");
  const [selected, setSelected] = useState<BrainBlockId | null>(null);

  const runs = detail.recentRuns;
  const defaultRun = runs.find((r) => r.status === "running") ?? runs[0];
  const run = runChoice === "latest" ? defaultRun : runs.find((r) => r.id === runChoice) ?? defaultRun;
  const runDetail = useApi(run ? `run:${run.id}` : null, () => api.run(run!.id), {
    refreshOn: ["span.ended", "run.completed"],
    refreshIf: (ev) => ev.runId === run?.id,
    throttleMs: 2500,
  });
  const mem = useApi("global-memory-all", () => api.memory({}), { throttleMs: 8000 });
  const bb = useApi("blackboard", () => api.blackboard());

  const spans = useMemo(() => {
    const byId = new Map<string, Span>();
    for (const s of runDetail.data?.spans ?? []) byId.set(s.id, s);
    if (run) for (const s of Object.values(liveSpans)) if (s.runId === run.id) byId.set(s.id, { ...byId.get(s.id), ...s });
    return [...byId.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }, [runDetail.data, liveSpans, run]);

  const visited = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of spans) {
      const b = spanBlock(s);
      if (b) m.set(b, (m.get(b) ?? 0) + 1);
    }
    return m;
  }, [spans]);

  const tasks = useMemo(() => {
    const open = Object.values(liveTasks).filter((t) => t.assigneeId === agentId && !["done", "failed", "cancelled"].includes(t.status));
    const list = open.length ? open : detail.openTasks;
    return [...list].sort((a, b) => b.priority - a.priority);
  }, [liveTasks, detail.openTasks, agentId]);

  const memoryCounts = useMemo(() => {
    if (!mem.data) return null;
    const c: Record<string, number> = {};
    for (const m of mem.data) c[m.kind] = (c[m.kind] ?? 0) + 1;
    return c;
  }, [mem.data]);

  const ctx: Ctx = { active: live.brainBlock, visited, selected, select: (id) => setSelected((p) => (p === id ? null : id)) };
  const selSpans = selected ? spans.filter((s) => spanBlock(s) === selected) : [];

  return (
    <BrainCtx.Provider value={ctx}>
      <div className="brain-toolbar">
        <div className="row wrap">
          <span className={`now-pill${live.brainBlock ? " on" : ""}`} role="status">
            {live.brainBlock ? (
              <>
                <span className="now-dot" aria-hidden="true" /> In <strong>{blockLabel(live.brainBlock)}</strong> <span className="muted">({live.status})</span>
              </>
            ) : (
              <>Not in a block ({live.status})</>
            )}
          </span>
          {live.activity ? <span className="muted small ellipsis" style={{ maxWidth: 420 }}>{live.activity}</span> : null}
        </div>
        <div className="grow" />
        <div className="row wrap small">
          <label className="row">
            <span className="muted">Run</span>
            <select value={runChoice} onChange={(e) => setRunChoice(e.target.value)} aria-label="Run to show visited blocks for" style={{ maxWidth: 260 }}>
              <option value="latest">Latest{defaultRun ? ` (${defaultRun.status})` : ""}</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>{r.trigger} · {r.status} · {r.llmCalls} LLM · {money(r.costUsd)}</option>
              ))}
            </select>
          </label>
          <span className="legend-key"><i className="k-active" />NOW: agent is here</span>
          <span className="legend-key"><i className="k-visited" />✓ visited in run</span>
          <span className="legend-key"><i className="k-sel" />selected</span>
        </div>
      </div>
      <div className="brain-wrap">
        <svg className="brain-svg" viewBox="0 0 1260 1090" role="group" aria-label={`Brain-inspired architecture of ${live.name}: 33 blocks. ${live.brainBlock ? `Active block: ${blockLabel(live.brainBlock)}.` : "No active block."}`}>
          <defs>
            <marker id="ah" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" className="arrowhead" />
            </marker>
            <marker id="ahs" viewBox="0 0 10 10" refX="1.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M10,1 L1,5 L10,9 z" className="arrowhead" />
            </marker>
          </defs>
          <SelfManagement d={detail} live={live} />
          <Arrow d="M120,344 V 362 H 1190" cls="thin dashed" />
          {[0, 1, 2, 3].map((i) => <Arrow key={i} d={`M${340 + i * 236},362 V 380`} cls="thin dashed" />)}
          <T x={130} y={359} size={9.5} cls="bv">Assign Suitable Role to Workers</T>
          <Arrow d="M750,336 V 382" cls="thick" />
          <TodoBand tasks={tasks} currentTaskId={live.currentTaskId} />
          <path d="M490,446 L 806,478 M 676,446 L 806,478" className="funnel" />
          <Metacognition d={detail} live={live} memoryCounts={memoryCounts} />
          <GlobalMemory counts={memoryCounts} keys={bb.data ? bb.data.length : null} />
          {/* right-edge loop: Report → Feedback / Update, and Interrupt into the TODO list */}
          <Arrow d="M1206,830 H 1240 V 110 H 1164" cls="thin" />
          <text x={1249} y={760} fontSize={10.5} textAnchor="middle" className="bv" transform="rotate(90 1249 760)">Report</text>
          <Arrow d="M1240,414 H 1212" cls="thin" />
          <T x={1196} y={404} size={10.5} anchor="end" cls="bv">Interrupt</T>
        </svg>
      </div>
      {selected ? (
        <aside className="block-inspector" aria-label="Spans for selected block">
          <header>
            <div>
              <div className="bi-title">{blockLabel(selected)}</div>
              <div className="mono tiny muted">{selected}</div>
            </div>
            <Button size="sm" variant="ghost" icon="x" onClick={() => setSelected(null)} aria-label="Close block details" />
          </header>
          <div className="bi-body">
            {!run ? (
              <Empty title="No runs yet" icon="brain">This agent has not run, so no spans exist for this block.</Empty>
            ) : selSpans.length ? (
              <>
                <div className="muted small" style={{ marginBottom: 6 }}>{selSpans.length} span{selSpans.length === 1 ? "" : "s"} in run {run.trigger}, {run.status}</div>
                <ul className="bi-list">
                  {selSpans.map((s) => (
                    <li key={s.id}>
                      <a href={href(`/traces/${s.traceId}`, { span: s.id })}>
                        <KindSwatch kind={s.kind} /> <span className="mono">{s.name}</span>
                      </a>
                      <span className="muted tiny num">{duration(s.durationMs)}{s.costUsd ? ` · ${money(s.costUsd)}` : ""}</span>
                      <SpanStatusBadge status={s.status} />
                      <RelTime iso={s.startedAt} className="rel tiny muted" />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="muted small">This block has no spans in the selected run{live.brainBlock === selected ? ", but the agent is in it right now" : ""}. Pick another run, or wait for the agent to reach it.</p>
            )}
          </div>
        </aside>
      ) : null}
    </BrainCtx.Provider>
  );
}
