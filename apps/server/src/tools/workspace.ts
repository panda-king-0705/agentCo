/**
 * Agent workspaces: data/workspaces/shared/ (the company drive) and
 * data/workspaces/<agentId>/ (private notes).
 *
 * Paths are addressed as `shared/…` (company drive), `private/…` (the agent's own notes) or plain
 * `…`, which means the COMPANY DRIVE: work files are visible to colleagues by default, so a brief
 * that says "save launch-plan/x.md" lands where the person assembling it will look (2026-11-07,
 * T-171: four executives saved their sections privately and the assembler never found them).
 * A plain path that is not on the drive but exists in the agent's private folder (written before
 * the default changed) is still found by read/exists/list.
 *
 * Overwriting a file keeps the previous version under <root>/.history/ (hidden from listings).
 * Every path is resolved and checked to stay inside its root (traversal, absolute paths, NUL bytes
 * and symlink escapes are rejected).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
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

  /**
   * Resolves a model-supplied path to an absolute path inside the right root, or throws WorkspaceError.
   * `shared/…` → company drive, `private/…` → the agent's own folder, anything else → company drive
   * (`explicit: false`, so reads can still fall back to a legacy private file).
   */
  resolve(agentId: string, input: string): ResolvedPath {
    const raw = String(input ?? "").trim().replace(/^\.\/+/, "");
    if (raw.includes("\0")) throw new WorkspaceError("path contains a NUL byte");
    if (raw.includes("\\")) throw new WorkspaceError("use forward slashes in paths");
    if (isAbsolute(raw)) throw new WorkspaceError("absolute paths are not allowed; use a path relative to your workspace");
    const prefix = /^(shared|private)(\/|$)/.exec(raw)?.[1] as "shared" | "private" | undefined;
    const area: Area = prefix === "private" ? "private" : "shared";
    const base = area === "private" ? this.ensure(agentId) : this.sharedDir();
    mkdirSync(base, { recursive: true });
    const rest = (prefix ? raw.slice(prefix.length) : raw).replace(/^\/+/, "");
    const absolute = resolve(base, rest || ".");
    if (absolute !== base && !absolute.startsWith(base + sep)) throw new WorkspaceError(`path escapes the workspace: ${raw}`);
    assertNoSymlinkEscape(base, absolute);
    const rel = relative(base, absolute).split(sep).join("/");
    return { base, absolute, area, explicit: !!prefix, rel, display: `${area}/${rel}` };
  }

  /** Where a file at `path` actually is: the drive, or (plain path, legacy) the agent's private folder. */
  locate(agentId: string, path: string): ResolvedPath {
    const target = this.resolve(agentId, path);
    if (target.explicit || isFile(target.absolute)) return target;
    const legacy = this.resolve(agentId, `private/${target.rel}`);
    return isFile(legacy.absolute) ? legacy : target;
  }

  /** Writes the file (company drive unless the path says private/); the previous version is kept in .history/. */
  write(agentId: string, path: string, content: string): { display: string; area: Area; replaced: boolean } {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new WorkspaceError(`file too large (${bytes} bytes > ${MAX_FILE_BYTES})`);
    const target = this.resolve(agentId, path);
    if (target.absolute === target.base) throw new WorkspaceError("a file path is required");
    if (target.rel.split("/").some((part) => part.startsWith("."))) throw new WorkspaceError("file and folder names must not start with a dot");
    mkdirSync(dirname(target.absolute), { recursive: true });
    let replaced = false;
    if (isFile(target.absolute)) {
      if (readFileSync(target.absolute, "utf8") === content) return { display: target.display, area: target.area, replaced: false };
      const kept = join(target.base, ".history", `${target.rel}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(dirname(kept), { recursive: true });
      copyFileSync(target.absolute, kept);
      replaced = true;
    }
    writeFileSync(target.absolute, content, "utf8");
    // The tool tells the agent the save is verified: make that true.
    if (readFileSync(target.absolute, "utf8") !== content) throw new WorkspaceError(`saved ${target.display} does not read back as written`);
    return { display: target.display, area: target.area, replaced };
  }

  /** Whether a file exists at the path (an invalid path throws, as for read). */
  exists(agentId: string, path: string): boolean {
    return isFile(this.locate(agentId, path).absolute);
  }

  read(agentId: string, path: string): { content: string; truncated: boolean; display: string } {
    const target = this.locate(agentId, path);
    if (!isFile(target.absolute)) throw new WorkspaceError(`no such file: ${path}`);
    const content = readFileSync(target.absolute, "utf8");
    return content.length > MAX_READ_CHARS ? { content: content.slice(0, MAX_READ_CHARS), truncated: true, display: target.display } : { content, truncated: false, display: target.display };
  }

  /**
   * Entries of a directory ("x/" for folders). The root ("", "shared") lists the company drive plus
   * "private/" when the agent has private notes; a plain folder missing from the drive falls back to
   * the agent's private folder of that name (legacy). Dot-entries (.history) are hidden.
   */
  list(agentId: string, dir = ""): string[] {
    const target = this.resolve(agentId, dir);
    let entries = entriesOf(target.absolute);
    if (!target.explicit && target.rel === "") {
      if (entriesOf(this.agentDir(agentId)).length > 0) entries = [...entries, "private/"];
    } else if (!target.explicit && entries.length === 0) {
      entries = entriesOf(this.resolve(agentId, `private/${target.rel}`).absolute);
    }
    return entries;
  }

  /** The company drive's files, newest first (dot-folders skipped): what planning sees before naming paths. */
  recentShared(limit = 25): { rel: string; chars: number; modified: string }[] {
    const out: { rel: string; chars: number; modifiedMs: number }[] = [];
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > 6 || !existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, `${prefix}${entry.name}/`, depth + 1);
        else if (entry.isFile()) {
          const st = statSync(abs);
          out.push({ rel: `${prefix}${entry.name}`, chars: st.size, modifiedMs: st.mtimeMs });
        }
      }
    };
    walk(this.sharedDir(), "", 0);
    return out
      .sort((a, b) => b.modifiedMs - a.modifiedMs)
      .slice(0, limit)
      .map((f) => ({ rel: f.rel, chars: f.chars, modified: new Date(f.modifiedMs).toISOString() }));
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

type Area = "shared" | "private";

export interface ResolvedPath {
  base: string;
  absolute: string;
  area: Area;
  /** The path named its area (shared/… or private/…). */
  explicit: boolean;
  /** Path relative to the area's root, forward slashes ("" = the root). */
  rel: string;
  /** How tools show it: "shared/x/y.md" or "private/x.md". */
  display: string;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function entriesOf(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name))
    .sort();
}

function assertNoSymlinkEscape(base: string, absolute: string): void {
  let probe = absolute;
  while (!existsSync(probe) && probe !== base) probe = dirname(probe);
  const real = realpathSync(probe);
  const realBase = realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + sep)) throw new WorkspaceError("path resolves outside the workspace");
}
