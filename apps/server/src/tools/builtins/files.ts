/**
 * workspace_write_file, workspace_read_file, workspace_list.
 *
 * A plain path (or shared/…) is the COMPANY DRIVE, so colleagues can read what you save; private/…
 * is your own notes. A read that misses checks what was saved on the same objective (the trace) by
 * anyone — teammates' drive files under another folder, or private files written before the drive
 * became the default — and returns the file with a note saying where it really is (2026-11-07,
 * T-171: the assembler searched for sections his colleagues had saved where only they could see).
 */
import type { FileWrite } from "../../db/repo-trace.ts";
import { droppedSections } from "../workspace.ts";
import { ALL_TIERS, fail, ok, type ToolDefinition, type ToolRunContext } from "../types.ts";

const MAX_LISTED = 12;

export const workspaceWriteFile: ToolDefinition = {
  name: "workspace_write_file",
  description:
    "Save a text file on the company drive, where colleagues can read it (use the exact path your brief names, e.g. launch-plan/finance.md — if a file is already there, it is replaced and the old version kept; never save a second copy of the same document under another name). " +
    "Start the path with private/ only for scratch notes nobody else needs. Saving over a file keeps the previous version. The result confirms the save and gives the word, line and character counts. " +
    "A long document (more than about 1,500 words) is saved in parts: the first part normally, each next part with append: true. To change part of an existing document, use workspace_edit_file instead of rewriting it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", maxLength: 300 },
      content: { type: "string", maxLength: 200000 },
      append: { type: "boolean", description: "true adds content to the end of the file instead of replacing it (for a long document saved in parts)." },
    },
    required: ["path", "content"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const content = String(args.content);
    const ws = ctx.services.workspaces;
    if (args.append === true) {
      const a = ws.append(ctx.agent.id, String(args.path), content);
      ctx.span.setAttributes({ "agentco.file.path": a.display, "agentco.file.area": a.area, "agentco.file.append": true });
      const t = measure(a.content);
      return ok(
        `Added ${content.length} chars to ${a.display}; the whole file is now ${t.chars} chars, ${t.words} words, ${t.lines} lines. Saved and verified on disk.${a.area === "private" ? " Private: only you can read it." : " Colleagues can read it at this path."}`,
        [{ kind: "file_written", path: a.display }],
        { path: a.display, appended: true, ...t },
      );
    }
    const w = ws.write(ctx.agent.id, String(args.path), content);
    ctx.span.setAttributes({ "agentco.file.path": w.display, "agentco.file.area": w.area });
    const where = w.area === "private" ? " Private: only you can read it." : " Colleagues can read it at this path.";
    const m = measure(content);
    // A rewrite that quietly drops sections (2026-11-08, trc_4469…: 19,845 → 6,385 chars, sections 5–7 gone).
    const dropped = w.replaced && w.previous ? droppedSections(w.previous, content) : [];
    if (dropped.length) ctx.span.setAttributes({ "agentco.file.dropped_sections": dropped.length });
    const warning = dropped.length
      ? ` WARNING: this version is ${Math.round(100 - (100 * content.length) / w.previous!.length)}% shorter than the one it replaced and leaves out ${dropped.length} section(s) it had: ${dropped.slice(0, 8).map((d) => `"${d}"`).join(", ")}. If you meant to change only part of the file, put them back now: workspace_read_file with version: 1 shows the replaced version, and workspace_edit_file changes one section without rewriting the rest.`
      : "";
    return ok(
      `Wrote ${w.display} (${m.chars} chars, ${m.words} words, ${m.lines} lines${w.replaced ? "; previous version kept" : ""}). Saved and verified on disk.${where}${warning}`,
      [{ kind: "file_written", path: w.display }],
      { path: w.display, ...m },
    );
  },
};

export const workspaceReadFile: ToolDefinition = {
  name: "workspace_read_file",
  description:
    "Read a text file from the company drive (or private/… for your own notes); the result ends with the file's word, line and character counts. If it is not at that path, files with that name saved on this objective are found for you. " +
    "Saving over a file keeps the old version: version: 1 reads the version the current one replaced, 2 the one before that.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", maxLength: 300 },
      version: { type: "integer", minimum: 1, maximum: 50, description: "An earlier version: 1 = the one the current file replaced. Omit for the current file." },
    },
    required: ["path"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const path = String(args.path);
    const ws = ctx.services.workspaces;
    if (typeof args.version === "number" && ws.exists(ctx.agent.id, path)) {
      const n = Math.floor(args.version);
      const v = ws.readVersion(ctx.agent.id, path, n);
      if (!v) {
        const count = ws.history(ctx.agent.id, path).length;
        return ok(`${path} has ${count === 0 ? "no earlier versions" : `only ${count} earlier version${count === 1 ? "" : "s"}`}.`, [], { found: false, versions: count });
      }
      const header = `[Earlier version ${n} of ${v.versions} of ${v.display}, saved ${v.at.slice(0, 16).replace("T", " ")} UTC — the current file is newer]\n`;
      return ok(header + v.content + footer(v.display, v.content, v.truncated), [], { path: v.display, version: n, ...measure(v.content) });
    }
    if (ws.exists(ctx.agent.id, path)) {
      const { content, truncated, display } = ws.read(ctx.agent.id, path);
      return ok(content + footer(display, content, truncated), [], { path: display, ...measure(content) });
    }
    const found = findOnObjective(ctx, path);
    if (found) {
      const { best, others } = found;
      const { content, truncated, display } = ws.read(best.agentId, best.display);
      const theirs = best.area === "private" && best.agentId !== ctx.agent.id;
      const header =
        `[Not at ${path}; found ${theirs ? `${nameOf(ctx, best.agentId)}'s private file ${best.rel}` : best.display}, saved by ${nameOf(ctx, best.agentId)} on this objective.` +
        (theirs ? " Save a copy on the drive if others need it." : "") +
        (others.length ? ` Other files with that name: ${others.map((w) => describe(ctx, w)).join(", ")}.` : "") +
        "]\n";
      return ok(header + content + footer(display, content, truncated), [], { found: true, path: best.display, ...measure(content) });
    }
    // Not there (yet): say what IS there instead of a red error — often a colleague's file still being written.
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const near = ws.list(ctx.agent.id, dir);
    const saved = savedOnObjective(ctx);
    return ok(
      `No file "${path}" yet. ${near.length ? `In ${dir || "the drive's top level"}: ${near.slice(0, 40).join(", ")}.` : `${dir || "The drive"} is empty.`}` +
        (saved.length ? ` Saved on this objective so far: ${saved.join("; ")}.` : " Nothing has been saved on this objective yet."),
      [],
      { found: false },
    );
  },
};

/**
 * workspace_edit_file: change part of a document without rewriting it (2026-11-08, trc_4469…: an
 * analyst asked to fix one section rewrote the whole 19,845-character investor update from memory and
 * saved 6,385 characters — sections 5 to 7 gone, including the one to fix).
 */
export const workspaceEditFile: ToolDefinition = {
  name: "workspace_edit_file",
  description:
    "Change part of an existing file on the drive without rewriting it; the rest stays exactly as it is and the previous version is kept. Either replace an exact passage (find: the text copied exactly from the file, replace: the new text; replace \"\" deletes it), " +
    'or replace a whole section by its heading (section: e.g. "6. Margins", content: the section\'s new text, heading line included; content "" removes the section). Use this for edits to a document; workspace_write_file is for new files or a deliberate full rewrite.',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", maxLength: 300 },
      find: { type: "string", maxLength: 20000, description: "Exact text to change; it must occur once in the file." },
      replace: { type: "string", maxLength: 100000, description: "The new text for find." },
      section: { type: "string", maxLength: 300, description: "A heading in the file, with or without the #s." },
      content: { type: "string", maxLength: 100000, description: "The section's new text, heading line included." },
    },
    required: ["path"],
  },
  tiers: ALL_TIERS,
  // Whoever can save files can edit them (no per-agent tool list to update).
  allowed: (agent) => agent.tools.includes("workspace_write_file"),
  run(args, ctx) {
    const path = String(args.path);
    const byText = typeof args.find === "string" && typeof args.replace === "string";
    const bySection = typeof args.section === "string" && typeof args.content === "string";
    if (byText === bySection) return fail('Give either find and replace (an exact passage) or section and content (a whole section) — one of the two.');
    const e = ctx.services.workspaces.edit(ctx.agent.id, path, byText ? { find: String(args.find), replace: String(args.replace) } : { section: String(args.section), content: String(args.content) });
    ctx.span.setAttributes({ "agentco.file.path": e.display, "agentco.file.area": e.area, "agentco.file.edit": byText ? "text" : "section" });
    const m = measure(e.content);
    return ok(
      `Edited ${e.display}: ${e.changed}. The file is now ${m.chars} chars, ${m.words} words, ${m.lines} lines (was ${e.previous.length} chars). Saved and verified on disk; previous version kept.${e.area === "private" ? " Private: only you can read it." : " Colleagues can read it at this path."}`,
      [{ kind: "file_written", path: e.display }],
      { path: e.display, ...m },
    );
  },
};

export const workspaceList: ToolDefinition = {
  name: "workspace_list",
  description: "List a folder on the company drive (empty = the top level; private/ = your own notes). Also shows what has been saved on this objective so far.",
  parameters: { type: "object", properties: { dir: { type: "string", maxLength: 300 } } },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const dir = typeof args.dir === "string" ? args.dir.trim() : "";
    const entries = ctx.services.workspaces.list(ctx.agent.id, dir);
    const root = ["", ".", "shared", "shared/", "private", "private/"].includes(dir);
    const saved = root || entries.length === 0 ? savedOnObjective(ctx) : [];
    const text = (entries.length ? entries.join("\n") : "(empty)") + (saved.length ? `\n\nSaved on this objective so far: ${saved.join("; ")}` : "");
    return ok(text, [], { entries });
  },
};

/**
 * The file's size as a tool measured it (2026-11-07, test 4: leaders asked for "a word count from a
 * tool" and no tool gave one, so every section failed that check and was redone). Words are
 * whitespace-separated tokens with a letter or digit, so markdown bullets and table bars don't count.
 */
export function measure(text: string): { chars: number; words: number; lines: number } {
  const words = text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  const lines = text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
  return { chars: text.length, words, lines };
}

/** Read-back footer: the whole file was returned (or where it was cut), with the tool's counts. */
function footer(display: string, content: string, truncated: boolean): string {
  const m = measure(content);
  return truncated
    ? `\n[read tool's note, not part of the file: cut at ${m.chars} chars — ${display} is longer than one read returns; counts below cover the part shown — ${m.words} words, ${m.lines} lines]`
    : `\n[read tool's note, not part of the file: end of ${display} — complete: ${m.words} words, ${m.lines} lines, ${m.chars} chars]`;
}

function nameOf(ctx: ToolRunContext, agentId: string): string {
  if (agentId === ctx.agent.id) return "you";
  return ctx.services.org.getAgent(agentId)?.name ?? agentId;
}

function describe(ctx: ToolRunContext, w: FileWrite): string {
  if (w.area === "shared") return `${w.display} (${nameOf(ctx, w.agentId)})`;
  return w.agentId === ctx.agent.id ? `${w.display} (yours)` : `${w.rel} (${nameOf(ctx, w.agentId)}'s private notes)`;
}

/** Newest write per location (a private file belongs to its author), still on disk, newest first. */
function locations(ctx: ToolRunContext): FileWrite[] {
  const writes = ctx.services.traceFiles?.(ctx.traceId) ?? [];
  const latest = new Map<string, FileWrite>();
  for (const w of writes) latest.set(`${w.area === "private" ? w.agentId : "shared"}:${w.rel}`, w);
  const ws = ctx.services.workspaces;
  return [...latest.values()].reverse().filter((w) => {
    try {
      return ws.exists(w.agentId, w.display);
    } catch {
      return false;
    }
  });
}

function savedOnObjective(ctx: ToolRunContext): string[] {
  const locs = locations(ctx);
  const shown = locs.slice(0, MAX_LISTED).map((w) => describe(ctx, w));
  return locs.length > MAX_LISTED ? [...shown, `${locs.length - MAX_LISTED} more`] : shown;
}

/** The file someone saved on this objective under the requested path, or else the requested file name. */
function findOnObjective(ctx: ToolRunContext, path: string): { best: FileWrite; others: FileWrite[] } | null {
  let want: string;
  try {
    want = ctx.services.workspaces.resolve(ctx.agent.id, path).rel;
  } catch {
    return null;
  }
  if (!want) return null;
  const name = want.split("/").pop()!;
  const locs = locations(ctx);
  const exact = locs.filter((w) => w.rel === want);
  const matches = exact.length ? exact : locs.filter((w) => w.rel.split("/").pop() === name);
  return matches.length ? { best: matches[0]!, others: matches.slice(1) } : null;
}
