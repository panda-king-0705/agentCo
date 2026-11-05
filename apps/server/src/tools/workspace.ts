/**
 * Agent workspaces: data/workspaces/<agentId>/ (private) and
 * data/workspaces/shared/ (company drive, addressed as `shared/...`).
 * Every path is resolved and checked to stay inside its root (traversal,
 * absolute paths, NUL bytes and symlink escapes are rejected).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 200_000;
export const MAX_READ_CHARS = 20_000;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class Workspaces {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, "workspaces");
  }

  agentDir(agentId: string): string {
    return join(this.root, agentId);
  }

  sharedDir(): string {
    return join(this.root, "shared");
  }

  /** Creates the agent's private workspace (idempotent). */
  ensure(agentId: string): string {
    const dir = this.agentDir(agentId);
    mkdirSync(dir, { recursive: true });
    mkdirSync(this.sharedDir(), { recursive: true });
    return dir;
  }

  /** Resolves a model-supplied path to an absolute path inside the right root, or throws WorkspaceError. */
  resolve(agentId: string, input: string): { base: string; absolute: string; display: string } {
    const raw = String(input ?? "").trim();
    if (raw.includes("\0")) throw new WorkspaceError("path contains a NUL byte");
    if (raw.includes("\\")) throw new WorkspaceError("use forward slashes in paths");
    if (isAbsolute(raw)) throw new WorkspaceError("absolute paths are not allowed; use a path relative to your workspace");
    const shared = raw === "shared" || raw.startsWith("shared/");
    const base = shared ? this.sharedDir() : this.ensure(agentId);
    mkdirSync(base, { recursive: true });
    const rest = shared ? raw.slice("shared".length).replace(/^\/+/, "") : raw;
    const absolute = resolve(base, rest || ".");
    if (absolute !== base && !absolute.startsWith(base + sep)) throw new WorkspaceError(`path escapes the workspace: ${raw}`);
    assertNoSymlinkEscape(base, absolute);
    return { base, absolute, display: (shared ? "shared/" : "") + relative(base, absolute) };
  }

  write(agentId: string, path: string, content: string): string {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new WorkspaceError(`file too large (${bytes} bytes > ${MAX_FILE_BYTES})`);
    const target = this.resolve(agentId, path);
    if (target.absolute === target.base) throw new WorkspaceError("a file path is required");
    mkdirSync(dirname(target.absolute), { recursive: true });
    writeFileSync(target.absolute, content, "utf8");
    return target.display;
  }

  read(agentId: string, path: string): { content: string; truncated: boolean } {
    const target = this.resolve(agentId, path);
    if (!existsSync(target.absolute) || !statSync(target.absolute).isFile()) throw new WorkspaceError(`no such file: ${path}`);
    const content = readFileSync(target.absolute, "utf8");
    return content.length > MAX_READ_CHARS ? { content: content.slice(0, MAX_READ_CHARS), truncated: true } : { content, truncated: false };
  }

  list(agentId: string, dir = ""): string[] {
    const target = this.resolve(agentId, dir);
    if (!existsSync(target.absolute)) return [];
    return readdirSync(target.absolute, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name))
      .sort();
  }

  /** Moves the agent's workspace to workspaces/.terminated/<agentId> (kept for audit). */
  archive(agentId: string): string | null {
    const source = this.agentDir(agentId);
    if (!existsSync(source)) return null;
    const targetRoot = join(this.root, ".terminated");
    mkdirSync(targetRoot, { recursive: true });
    let target = join(targetRoot, agentId);
    if (existsSync(target)) target = `${target}-${Date.now()}`;
    renameSync(source, target);
    return target;
  }
}

function assertNoSymlinkEscape(base: string, absolute: string): void {
  let probe = absolute;
  while (!existsSync(probe) && probe !== base) probe = dirname(probe);
  const real = realpathSync(probe);
  const realBase = realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + sep)) throw new WorkspaceError("path resolves outside the workspace");
}
