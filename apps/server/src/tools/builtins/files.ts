/** workspace_write_file, workspace_read_file, workspace_list (own workspace; `shared/…` = company drive). */
import { ALL_TIERS, ok, type ToolDefinition } from "../types.ts";

export const workspaceWriteFile: ToolDefinition = {
  name: "workspace_write_file",
  description: "Write a text file in your workspace. Paths starting with shared/ go to the company drive.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", maxLength: 300 }, content: { type: "string", maxLength: 200000 } },
    required: ["path", "content"],
  },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const display = ctx.services.workspaces.write(ctx.agent.id, String(args.path), String(args.content));
    return ok(`Wrote ${display} (${String(args.content).length} chars).`, [{ kind: "file_written", path: display }], { path: display });
  },
};

export const workspaceReadFile: ToolDefinition = {
  name: "workspace_read_file",
  description: "Read a text file from your workspace (or shared/… from the company drive).",
  parameters: { type: "object", properties: { path: { type: "string", maxLength: 300 } }, required: ["path"] },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const path = String(args.path);
    const ws = ctx.services.workspaces;
    if (!ws.exists(ctx.agent.id, path)) {
      // Not there (yet): say what IS there instead of a red error — often a sibling's file still being written.
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const near = ws.list(ctx.agent.id, dir);
      return ok(`No file "${path}" yet. ${near.length ? `In ${dir || "your workspace"}: ${near.slice(0, 40).join(", ")}.` : `${dir || "Your workspace"} is empty.`}`, [], { found: false });
    }
    const { content, truncated } = ws.read(ctx.agent.id, path);
    return ok(truncated ? content + "\n[truncated]" : content);
  },
};

export const workspaceList: ToolDefinition = {
  name: "workspace_list",
  description: "List files in your workspace directory (dir optional; shared/ for the company drive).",
  parameters: { type: "object", properties: { dir: { type: "string", maxLength: 300 } } },
  tiers: ALL_TIERS,
  run(args, ctx) {
    const entries = ctx.services.workspaces.list(ctx.agent.id, typeof args.dir === "string" ? args.dir : "");
    return ok(entries.length ? entries.join("\n") : "(empty)", [], { entries });
  },
};
