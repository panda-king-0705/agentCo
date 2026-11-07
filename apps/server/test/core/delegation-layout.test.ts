// 2026-11-08: the trace's delegation graph put each level in one row, spread evenly, so with Ava →
// Elena, Olivia, Kenji, Noah the line Elena → Chloe crossed Olivia → Lily. The founder: "make it such
// that no overlaps happen in the future". Now a tidy tree: children centred under their delegator,
// each subtree in its own columns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationEdges, layoutDelegation, type DelegLayout, type DelegSpan } from "../../../web/src/views/delegation-layout.ts";

let clock = 0;
const at = () => new Date(Date.UTC(2026, 10, 8, 0, 0, clock++)).toISOString();

/** A run of `agent` started from inside `parentRun` (a delegate span of the parent's run), or a root run. */
function trace(steps: [agent: string, delegator: string | null][]): DelegSpan[] {
  const spans: DelegSpan[] = [];
  const runOf = new Map<string, string>();
  for (const [agent, delegator] of steps) {
    let parentSpanId: string | null = null;
    if (delegator) {
      const d = `del_${spans.length}`;
      spans.push({ id: d, parentSpanId: runOf.get(delegator)!, agentId: null, kind: "delegation", startedAt: at() });
      parentSpanId = d;
    }
    const id = `run_${spans.length}`;
    spans.push({ id, parentSpanId, agentId: agent, kind: "run", startedAt: at() });
    if (!runOf.has(agent)) runOf.set(agent, id);
  }
  return spans;
}

interface Seg { x1: number; y1: number; x2: number; y2: number }

/** The drawn connectors as straight segments (elbows: down, across, down). */
function segments(l: DelegLayout): Seg[] {
  const out: Seg[] = [];
  for (const e of l.edges) {
    const mid = (e.from.y + e.to.y) / 2;
    out.push({ x1: e.from.x, y1: e.from.y, x2: e.from.x, y2: mid }, { x1: e.from.x, y1: mid, x2: e.to.x, y2: mid }, { x1: e.to.x, y1: mid, x2: e.to.x, y2: e.to.y });
  }
  return out;
}

/** Two segments cross (not merely share a point or run along the same line from the same delegator). */
function cross(a: Seg, b: Seg): boolean {
  const aH = a.y1 === a.y2;
  const bH = b.y1 === b.y2;
  if (aH === bH) {
    if (aH && a.y1 === b.y1) {
      // Two horizontal pieces on one level overlap only if their spans overlap by more than a point.
      const [a0, a1] = [Math.min(a.x1, a.x2), Math.max(a.x1, a.x2)];
      const [b0, b1] = [Math.min(b.x1, b.x2), Math.max(b.x1, b.x2)];
      return Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
    }
    return false;
  }
  const h = aH ? a : b;
  const v = aH ? b : a;
  const [h0, h1] = [Math.min(h.x1, h.x2), Math.max(h.x1, h.x2)];
  const [v0, v1] = [Math.min(v.y1, v.y2), Math.max(v.y1, v.y2)];
  return v.x1 > h0 + 0.5 && v.x1 < h1 - 0.5 && h.y1 > v0 + 0.5 && h.y1 < v1 - 0.5;
}

function assertTidy(l: DelegLayout): void {
  // No two nodes on one spot (closer than a column apart on the same level).
  for (const a of l.nodes) for (const b of l.nodes) if (a !== b && a.y === b.y) assert.ok(Math.abs(a.x - b.x) >= 60, `${a.key} and ${b.key} overlap`);
  // Connectors from different delegators never cross or run over each other.
  const segs = l.edges.map((e) => ({ from: e.from.key, segs: segments({ ...l, edges: [e] }) }));
  for (const a of segs) for (const b of segs) if (a.from !== b.from) for (const s of a.segs) for (const t of b.segs) assert.ok(!cross(s, t), `${a.from}'s line crosses ${b.from}'s`);
  // Every child sits below its delegator, and every delegator is centred over its children.
  for (const n of l.nodes) {
    const kids = l.nodes.filter((k) => k.parentKey === n.key);
    for (const k of kids) assert.ok(k.y > n.y);
    if (kids.length) assert.equal(n.x, (kids[0]!.x + kids[kids.length - 1]!.x) / 2);
  }
}

test("the founder's screenshot: Elena's team sits under Elena, Olivia's under Olivia — nothing crosses", () => {
  const l = layoutDelegation(
    trace([
      ["ava", null],
      ["elena", "ava"],
      ["olivia", "ava"],
      ["kenji", "ava"],
      ["noah", "ava"],
      ["chloe", "elena"],
      ["lily", "olivia"],
      ["sam", "kenji"],
      ["ivy", "kenji"],
    ]),
  );
  assertTidy(l);
  const x = (k: string) => l.nodes.find((n) => n.key === k)!.x;
  assert.ok(x("chloe") < x("lily") && x("lily") < x("sam") && x("sam") < x("ivy"), "grandchildren keep their parents' order");
  assert.equal(x("chloe"), x("elena"), "an only child sits straight under its delegator");
  assert.equal(x("ava"), (x("elena") + x("noah")) / 2);
  assert.equal(l.agents, 9);
});

test("a deep chain with repeat hand-offs stays one column and counts the hand-offs", () => {
  const l = layoutDelegation(
    trace([
      ["ava", null],
      ["victoria", "ava"],
      ["eva", "victoria"],
      ["victoria", "ava"],
      ["eva", "victoria"],
      ["eva", "victoria"],
    ]),
  );
  assertTidy(l);
  assert.deepEqual(new Set(l.nodes.map((n) => n.x)).size, 1);
  assert.deepEqual(
    l.edges.map((e) => [e.from.agentId, e.to.agentId, e.handoffs]),
    [
      ["victoria", "eva", 3],
      ["ava", "victoria", 2],
    ],
  );
});

test("a specialist used by two managers appears again as a dashed leaf, not a crossing line", () => {
  const l = layoutDelegation(
    trace([
      ["ava", null],
      ["elena", "ava"],
      ["victoria", "ava"],
      ["chloe", "elena"],
      ["eva", "elena"],
      ["eva", "victoria"],
    ]),
  );
  assertTidy(l);
  const evas = l.nodes.filter((n) => n.agentId === "eva");
  assert.deepEqual(
    evas.map((n) => [n.ghost, n.parentKey]),
    [
      [false, "elena"],
      [true, "victoria"],
    ],
  );
  assert.equal(l.agents, 5);
});

test("a report back up the chain is not drawn as a delegation", () => {
  const spans = trace([
    ["ava", null],
    ["elena", "ava"],
    ["chloe", "elena"],
    ["ava", "chloe"], // Chloe's message wakes Ava
  ]);
  assert.equal(delegationEdges(spans).edges.length, 3);
  const l = layoutDelegation(spans);
  assertTidy(l);
  assert.deepEqual(
    l.edges.map((e) => `${e.from.agentId}>${e.to.agentId}`),
    ["elena>chloe", "ava>elena"],
  );
});

test("an agent that started on its own (a new hire's first run) is a second root beside the tree; later delegation adopts it", () => {
  const alone = layoutDelegation(trace([["ava", null], ["elena", "ava"], ["chloe", "elena"], ["quinn", null]]));
  assertTidy(alone);
  assert.deepEqual(alone.nodes.filter((n) => n.depth === 0).map((n) => n.agentId), ["ava", "quinn"]);
  const adopted = layoutDelegation(trace([["ava", null], ["quinn", null], ["elena", "ava"], ["quinn", "elena"]]));
  assertTidy(adopted);
  assert.equal(adopted.nodes.find((n) => n.agentId === "quinn")!.parentKey, "elena");
});

test("a wide team gets a wider picture instead of squeezed labels", () => {
  const steps: [string, string | null][] = [["ava", null]];
  for (let i = 0; i < 10; i++) steps.push([`a${i}`, "ava"]);
  const l = layoutDelegation(trace(steps));
  assertTidy(l);
  assert.ok(l.width >= 10 * 70);
  const small = layoutDelegation(trace([["ava", null], ["eva", "ava"]]));
  assert.equal(small.width, 300);
  assert.equal(small.nodes[0]!.x, 150, "a small tree is centred");
});
