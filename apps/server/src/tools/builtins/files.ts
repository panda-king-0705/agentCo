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
    const { content, truncated } = ctx.services.workspaces.read(ctx.agent.id, String(args.path));
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
