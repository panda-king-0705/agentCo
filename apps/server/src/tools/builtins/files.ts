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
import { ALL_TIERS, ok, type ToolDefinition, type ToolRunContext } from "../types.ts";

const MAX_LISTED = 12;

export const workspaceWriteFile: ToolDefinition = {
  name: "workspace_write_file",
  description:
    "Save a text file on the company drive, where colleagues can read it (use the exact path your brief names, e.g. launch-plan/finance.md). " +
    "Start the path with private/ only for scratch notes nobody else needs. Saving over a file keeps the previous version.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", maxLength: 300 }, content: { type: "string", maxLength: 200000 } },
    required: ["path", "content"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const content = String(args.content);
    const w = ctx.services.workspaces.write(ctx.agent.id, String(args.path), content);
    ctx.span.setAttributes({ "agentco.file.path": w.display, "agentco.file.area": w.area });
    const where = w.area === "private" ? " Private: only you can read it." : " Colleagues can read it at this path.";
    return ok(`Wrote ${w.display} (${content.length} chars${w.replaced ? "; previous version kept" : ""}).${where}`, [{ kind: "file_written", path: w.display }], { path: w.display });
  },
};

export const workspaceReadFile: ToolDefinition = {
  name: "workspace_read_file",
  description: "Read a text file from the company drive (or private/… for your own notes). If it is not at that path, files with that name saved on this objective are found for you.",
  parameters: { type: "object", properties: { path: { type: "string", maxLength: 300 } }, required: ["path"] },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const path = String(args.path);
    const ws = ctx.services.workspaces;
    if (ws.exists(ctx.agent.id, path)) {
      const { content, truncated } = ws.read(ctx.agent.id, path);
      return ok(truncated ? content + "\n[truncated]" : content);
    }
    const found = findOnObjective(ctx, path);
    if (found) {
      const { best, others } = found;
      const { content, truncated } = ws.read(best.agentId, best.display);
      const theirs = best.area === "private" && best.agentId !== ctx.agent.id;
      const header =
        `[Not at ${path}; found ${theirs ? `${nameOf(ctx, best.agentId)}'s private file ${best.rel}` : best.display}, saved by ${nameOf(ctx, best.agentId)} on this objective.` +
        (theirs ? " Save a copy on the drive if others need it." : "") +
        (others.length ? ` Other files with that name: ${others.map((w) => describe(ctx, w)).join(", ")}.` : "") +
        "]\n";
      return ok(header + content + (truncated ? "\n[truncated]" : ""), [], { found: true, path: best.display });
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
