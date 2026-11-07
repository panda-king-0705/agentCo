/**
 * catalog_search — browse the agency-agents specialist catalog (docs/CATALOG.md): executives before
 * hiring with hire_agent {catalogId}, and recruiters (People) who find and recommend candidates for
 * the hiring manager (founder, 2026-11-07: "managers hire, recruiter sources"). Read-only; the reply
 * is compact (one line per specialist). Any tier may hold it; only agents given the tool have it.
 */
import { ALL_TIERS, fail, ok, type ToolDefinition } from "../types.ts";

const DESCRIPTION_CHARS = 140;

export const catalogSearch: ToolDefinition = {
  name: "catalog_search",
  description:
    "Search the specialist catalog (~280 agency-agents specialists) for someone to hire. Returns id, name, department and a one-line description. The head of the team the specialist joins hires them with hire_agent {catalogId}; a recruiter recommends the id and why.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, maxLength: 200, description: "Skills or role, e.g. 'postgres performance' or 'tiktok growth'." },
      division: { type: "string", maxLength: 60, description: "Optional division filter, e.g. engineering, marketing, sales, security, design." },
    },
    required: ["query"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const catalog = ctx.services.catalog;
    if (!catalog || catalog.size === 0) return fail("No specialist catalog is loaded.");
    const division = typeof args.division === "string" && args.division.trim() ? args.division.trim().toLowerCase() : null;
    if (division && !catalog.divisions().some((d) => d.id === division)) {
      return fail(`Unknown division ${division}. Divisions: ${catalog.divisions().map((d) => d.id).join(", ")}.`);
    }
    const hits = catalog.search(String(args.query), { division, limit: 8 });
    if (hits.length === 0) return ok(`No specialists match "${String(args.query)}"${division ? ` in ${division}` : ""}. Try broader words.`);
    const { org } = ctx.services;
    const hired = new Map<string, number>();
    for (const a of org.listActiveAgents()) if (a.catalogId) hired.set(a.catalogId, (hired.get(a.catalogId) ?? 0) + 1);
    const lines = hits.map((a) => {
      const dept = org.departmentNameForSlug(catalog.departmentSlugFor(a.id));
      const desc = a.description.length > DESCRIPTION_CHARS ? `${a.description.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : a.description;
      const staffed = hired.get(a.id) ? ` [${hired.get(a.id)} on staff]` : "";
      return `- ${a.id} — ${a.emoji ? `${a.emoji} ` : ""}${a.name} → ${dept}${staffed}: ${desc}`;
    });
    return ok(`${hits.length} specialist(s):\n${lines.join("\n")}\nHire one with hire_agent {catalogId, justification}.`, [], { ids: hits.map((a) => a.id) });
  },
};
