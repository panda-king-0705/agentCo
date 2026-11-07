// The company directory: every active agent's "address" (id) published to every agent, like a staff
// email list. Used by the company_directory tool, by send_message / delegate_task to resolve a
// colleague from a name, title or role word, and by the charter ("your key contacts").
import type { Agent } from "../../../../packages/shared/src/index.ts";
import type { OrgView } from "../contracts.ts";

export interface DirectoryEntry {
  id: string;
  name: string;
  title: string;
  department: string;
  managerName: string | null;
  tier: Agent["tier"];
  status: Agent["status"];
}

export function directory(org: OrgView): DirectoryEntry[] {
  const agents = org.listActiveAgents();
  const byId = new Map(agents.map((a) => [a.id, a]));
  return agents
    .map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title,
      department: org.departmentName(a.departmentId),
      managerName: a.managerId ? (byId.get(a.managerId)?.name ?? null) : null,
      tier: a.tier,
      status: a.status,
    }))
    .sort((x, y) => tierRank(x.tier) - tierRank(y.tier) || x.department.localeCompare(y.department) || x.name.localeCompare(y.name));
}

const tierRank = (t: Agent["tier"]) => (t === "executive" ? 0 : t === "manager" ? 1 : 2);

export function formatEntry(e: DirectoryEntry): string {
  return `${e.name} — ${e.title}, ${e.department}${e.managerName ? ` (reports to ${e.managerName})` : ""} — id ${e.id}`;
}

/** Common role words → the title they mean ("ceo" → "Chief Executive Officer"). */
const ROLE_WORDS: Record<string, string> = {
  ceo: "chief executive officer",
  cfo: "chief financial officer",
  cto: "chief technology officer",
  coo: "chief operating officer",
  cmo: "chief marketing officer",
  cpo: "chief people officer",
  cro: "chief revenue officer",
  "chief of staff": "chief of staff",
  "general counsel": "general counsel",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "Chief Financial Officer" → "cfo" (null when the title has no common short form). */
export function roleWordFor(title: string): string | null {
  const t = norm(title);
  for (const [word, full] of Object.entries(ROLE_WORDS)) if (full === t && !word.includes(" ")) return word;
  return null;
}

/**
 * Resolve a colleague from an id, a name ("Ava Chen", "Ava"), a title ("Chief Financial Officer"),
 * a role word ("ceo", "cfo") or "manager" / "my manager" (relative to `self`). Ambiguous → null.
 */
export function resolveAgent(org: OrgView, ref: string, self?: Agent | null): Agent | null {
  const raw = ref.trim();
  if (!raw) return null;
  const direct = org.getAgent(raw);
  if (direct && direct.status !== "terminated") return direct;
  const q = norm(raw).replace(/^(my|the|our) /, "");
  if (self && (q === "manager" || q === "boss" || q === "lead")) return self.managerId ? org.getAgent(self.managerId) : null;
  const agents = org.listActiveAgents();
  const title = ROLE_WORDS[q] ?? q;
  const exact = agents.filter((a) => norm(a.name) === q || norm(a.title) === title);
  if (exact.length === 1) return exact[0]!;
  const first = agents.filter((a) => norm(a.name).split(" ")[0] === q);
  if (first.length === 1) return first[0]!;
  const partial = agents.filter((a) => norm(a.title).includes(title) || norm(a.name).includes(q));
  return partial.length === 1 ? partial[0]! : null;
}

/** Search the directory by free text (name, title, department, role words); empty query = everyone. */
export function searchDirectory(org: OrgView, query: string): DirectoryEntry[] {
  const all = directory(org);
  const q = norm(query);
  if (!q) return all;
  const terms = q.split(" ").map((t) => ROLE_WORDS[t] ?? t);
  return all.filter((e) => {
    const hay = norm(`${e.name} ${e.title} ${e.department}`);
    return terms.every((t) => hay.includes(t));
  });
}

/** The few addresses every agent needs at hand: manager, CEO, direct reports (charter line). */
export function keyContacts(org: OrgView, agent: Agent): string {
  const lines: string[] = [];
  const manager = agent.managerId ? org.getAgent(agent.managerId) : null;
  if (manager) lines.push(`your manager ${manager.name} (${manager.title}, id ${manager.id})`);
  const ceo = org.listActiveAgents().find((a) => !a.managerId && a.tier === "executive");
  if (ceo && ceo.id !== agent.id && ceo.id !== manager?.id) lines.push(`the CEO ${ceo.name} (id ${ceo.id})`);
  const reports = org.directReports(agent.id).filter((a) => a.status !== "terminated");
  if (reports.length) lines.push(`your reports ${reports.slice(0, 12).map((r) => `${r.name} (${r.title}, id ${r.id})`).join(", ")}${reports.length > 12 ? ` and ${reports.length - 12} more` : ""}`);
  if (!lines.length) return "";
  return `Key contacts: ${lines.join("; ")}. Everyone else: company_directory; how the company works: company_handbook. Your task result goes back to whoever assigned the task automatically; message someone only to tell them something else.`;
}
