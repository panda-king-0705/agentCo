/**
 * playbook_read — the founder's own skills as playbooks (2026-11-07: "importing my connectors and
 * skills from claude"). A playbook is a Claude skill folder (SKILL.md, frontmatter name/description)
 * or a single .md file in PLAYBOOKS_DIR. Agents read the instructions; scripts a skill ships are not
 * run (the company cannot run code), so only instruction-only skills carry over fully.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALL_TIERS, fail, ok, type ToolDefinition } from "../types.ts";

export const PLAYBOOK_MAX_CHARS = 12_000;

export interface Playbook {
  name: string;
  description: string;
  path: string;
  /** Other files in the skill's folder (scripts, templates): listed, not read. */
  extras: string[];
}

const cache = new Map<string, { at: number; list: Playbook[] }>();

/** The playbooks in a folder (re-read at most every 30 s: the tool list asks on every model step). */
export function listPlaybooks(dir: string): Playbook[] {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = readPlaybooks(dir);
  cache.set(dir, { at: Date.now(), list });
  return list;
}

function readPlaybooks(dir: string): Playbook[] {
  if (!dir || !existsSync(dir)) return [];
  const out: Playbook[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".") || entry.toLowerCase() === "readme.md") continue;
    const full = join(dir, entry);
    let file: string | null = null;
    let extras: string[] = [];
    try {
      if (statSync(full).isDirectory()) {
        const files = readdirSync(full);
        const skill = files.find((f) => f.toLowerCase() === "skill.md");
        if (!skill) continue;
        file = join(full, skill);
        extras = files.filter((f) => f !== skill && !f.startsWith("."));
      } else if (entry.toLowerCase().endsWith(".md")) file = full;
    } catch {
      continue;
    }
    if (!file) continue;
    const head = readFileSync(file, "utf8").slice(0, 4000);
    const fm = frontmatter(head);
    out.push({ name: (fm.name || entry.replace(/\.md$/i, "")).trim(), description: (fm.description || "").trim().slice(0, 240), path: file, extras });
  }
  return out;
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function createPlaybookRead(dir: () => string): ToolDefinition {
  return {
    name: "playbook_read",
    description: "Read one of the company's playbooks (step-by-step instructions for a kind of work). Without a name: the list of playbooks with what each is for.",
    parameters: { type: "object", properties: { name: { type: "string", maxLength: 120 } } },
    tiers: ALL_TIERS,
    universal: true,
    enabled: () => listPlaybooks(dir()).length > 0,
    run(args) {
      const all = listPlaybooks(dir());
      const want = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      if (!want) return ok(all.length ? `Playbooks:\n${all.map((p) => `- ${p.name}${p.description ? ` — ${p.description}` : ""}`).join("\n")}` : "No playbooks yet.", [], { names: all.map((p) => p.name) });
      const p = all.find((x) => x.name.toLowerCase() === want) ?? all.find((x) => x.name.toLowerCase().includes(want));
      if (!p) return fail(`No playbook "${args.name}". Playbooks: ${all.map((x) => x.name).join(", ") || "none"}.`);
      const body = readFileSync(p.path, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      const cut = body.length > PLAYBOOK_MAX_CHARS ? `${body.slice(0, PLAYBOOK_MAX_CHARS)}\n[cut at ${PLAYBOOK_MAX_CHARS} chars]` : body;
      const extra = p.extras.length ? `\n\n[This playbook also ships ${p.extras.join(", ")}: scripts and templates cannot be run here — follow the instructions with the tools you have.]` : "";
      return ok(`# Playbook: ${p.name}\n${cut}${extra}`, [], { name: p.name });
    },
  };
}
