/**
 * Delegation tree layout for a trace (the founder, 2026-11-08: with Ava → Elena, Olivia, Kenji, Noah
 * the graph drew Elena → Chloe across Olivia → Lily — "make it such that no overlaps happen").
 *
 * A tidy tree: every agent sits centred over the agents it handed work to, siblings in the order they
 * were first delegated to, and each subtree gets its own columns, so no connector crosses another and
 * no two agents share a spot.
 *
 * - Who delegated to whom: a run's nearest ancestor span that belongs to another agent.
 * - An agent's first delegator is its parent. When a second manager also uses that agent, the agent is
 *   shown again under that manager as a dashed "also" leaf, without repeating its subtree.
 * - A hand-back up the chain (a report that wakes a manager) is not a delegation and is left out.
 *
 * Pure (no React), so it is unit-tested with the server tests.
 */

export interface DelegSpan {
  id: string;
  parentSpanId: string | null;
  agentId: string | null;
  kind: string;
  startedAt: string;
}

export interface DelegNode {
  /** Unique per drawn node: the agent id, or "<agent>@<delegator>" for an "also" leaf. */
  key: string;
  agentId: string;
  x: number;
  y: number;
  depth: number;
  /** Shown again under a second delegator. */
  ghost: boolean;
  parentKey: string | null;
}

export interface DelegEdge {
  key: string;
  from: DelegNode;
  to: DelegNode;
  /** How many runs this hand-off started. */
  handoffs: number;
}

export interface DelegLayout {
  nodes: DelegNode[];
  edges: DelegEdge[];
  width: number;
  height: number;
  /** Distinct agents in the trace. */
  agents: number;
}

/** Horizontal room per leaf column, vertical room per level, margins. */
export const DELEG_SLOT = 76;
export const DELEG_LEVEL = 80;
export const DELEG_TOP = 28;
export const DELEG_MIN_WIDTH = 300;
const BOTTOM = 40;

/** Who handed work to whom, in the order it first happened. */
export function delegationEdges(spans: readonly DelegSpan[]): { agents: string[]; edges: { from: string; to: string; handoffs: number }[] } {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const agents: string[] = [];
  const seen = new Set<string>();
  const edges = new Map<string, { from: string; to: string; handoffs: number }>();
  for (const s of [...spans].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    if (!s.agentId) continue;
    if (!seen.has(s.agentId)) {
      seen.add(s.agentId);
      agents.push(s.agentId);
    }
    if (s.kind !== "run") continue;
    let p = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    while (p && (!p.agentId || p.agentId === s.agentId)) p = p.parentSpanId ? byId.get(p.parentSpanId) : undefined;
    if (!p?.agentId) continue;
    const key = `${p.agentId}>${s.agentId}`;
    const e = edges.get(key) ?? { from: p.agentId, to: s.agentId, handoffs: 0 };
    e.handoffs += 1;
    edges.set(key, e);
  }
  return { agents, edges: [...edges.values()] };
}

interface TreeChild {
  agentId: string;
  ghost: boolean;
  handoffs: number;
}

export function layoutDelegation(spans: readonly DelegSpan[]): DelegLayout {
  const { agents, edges } = delegationEdges(spans);
  const parent = new Map<string, string>();
  const children = new Map<string, TreeChild[]>();
  const isAncestorOrSelf = (candidate: string, of: string): boolean => {
    for (let cur: string | undefined = of, guard = 0; cur && guard <= agents.length; cur = parent.get(cur), guard++) if (cur === candidate) return true;
    return false;
  };
  for (const e of edges) {
    if (e.from === e.to || isAncestorOrSelf(e.to, e.from)) continue; // a hand-back up the chain
    const list = children.get(e.from) ?? [];
    if (!parent.has(e.to)) {
      parent.set(e.to, e.from);
      list.push({ agentId: e.to, ghost: false, handoffs: e.handoffs });
    } else {
      list.push({ agentId: e.to, ghost: true, handoffs: e.handoffs });
    }
    children.set(e.from, list);
  }

  const nodes: DelegNode[] = [];
  const out: DelegEdge[] = [];
  let slot = 0;
  let maxDepth = 0;
  const place = (agentId: string, ghost: boolean, depth: number, parentNode: DelegNode | null, handoffs: number): DelegNode => {
    maxDepth = Math.max(maxDepth, depth);
    const key = ghost && parentNode ? `${agentId}@${parentNode.agentId}` : agentId;
    const node: DelegNode = { key, agentId, x: 0, y: DELEG_TOP + depth * DELEG_LEVEL, depth, ghost, parentKey: parentNode?.key ?? null };
    nodes.push(node);
    const kids = ghost ? [] : (children.get(agentId) ?? []);
    if (!kids.length) {
      node.x = slot * DELEG_SLOT + DELEG_SLOT / 2;
      slot += 1;
    } else {
      const placed = kids.map((k) => place(k.agentId, k.ghost, depth + 1, node, k.handoffs));
      node.x = (placed[0]!.x + placed[placed.length - 1]!.x) / 2;
    }
    if (parentNode) out.push({ key: `${parentNode.key}>${key}`, from: parentNode, to: node, handoffs });
    return node;
  };
  for (const id of agents) if (!parent.has(id)) place(id, false, 0, null, 0);

  const treeWidth = slot * DELEG_SLOT;
  const width = Math.max(DELEG_MIN_WIDTH, treeWidth);
  const shift = (width - treeWidth) / 2;
  for (const n of nodes) n.x += shift;
  return { nodes, edges: out, width, height: DELEG_TOP + maxDepth * DELEG_LEVEL + BOTTOM, agents: agents.length };
}

/**
 * Elbow connector: down from under the delegator's name, across, down into the agent. It starts below
 * the name label (drawn 27px under the node's centre), so no line runs through a name.
 */
export function elbowPath(from: { x: number; y: number }, to: { x: number; y: number }, r = 14, label = 21): string {
  const top = from.y + r + label;
  const bottom = to.y - r - 2;
  const mid = (top + bottom) / 2;
  if (Math.abs(from.x - to.x) < 0.5) return `M ${from.x} ${top} V ${bottom}`;
  return `M ${from.x} ${top} V ${mid} H ${to.x} V ${bottom}`;
}
