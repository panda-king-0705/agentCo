/**
 * MCP servers the company connects to — read from a JSON file on the host (MCP_CONFIG, default
 * <DATA_DIR>/mcp.json). Keys never live in the file: "${FIRECRAWL_API_KEY}" is replaced from the
 * environment (.env), and a server whose variables are not set is skipped, not an error.
 *
 * {
 *   "servers": {
 *     "firecrawl": {
 *       "url": "https://mcp.firecrawl.dev/v2/mcp",
 *       "headers": { "Authorization": "Bearer ${FIRECRAWL_API_KEY}" },
 *       "grants": ["web"],
 *       "access": { "roles": ["cmo"], "agents": ["Morgan Patel"], "departments": ["product"], "catalog": ["marketing/marketing-seo-specialist"] },
 *       "tools": ["firecrawl_search", "firecrawl_scrape"],
 *       "noApproval": [],
 *       "dailyCallLimit": 40
 *     },
 *     "local": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "KEY": "${SOME_API_KEY}" } }
 *   }
 * }
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Capability } from "../org/capabilities.ts";

export interface McpAccess {
  /** Role template ids ("cmo", "backend-engineer"). */
  roles: string[];
  /** Agent names or ids. */
  agents: string[];
  /** Department slugs ("marketing"). */
  departments: string[];
  /** Specialist catalog ids ("marketing/marketing-seo-specialist"). */
  catalog: string[];
}

export interface McpServerConfig {
  name: string;
  /** Streamable HTTP endpoint, or… */
  url?: string;
  headers: Record<string, string>;
  /** …a local process speaking MCP over stdio. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** What the server's tools let the company do (org/capabilities.ts). */
  grants: Capability[];
  access: McpAccess;
  /** Allow-list of the server's tool names; empty = every tool it lists. */
  tools: string[];
  /** Tools that change something but may run without the Board's approval (read-only tools never need it). */
  noApproval: string[];
  /** Calls per agent per day across this server's tools (0 = no limit). */
  dailyCallLimit: number;
  /** Values substituted from the environment: redacted from every message and span. */
  secrets: string[];
}

export interface McpConfigResult {
  servers: McpServerConfig[];
  /** Servers left out (missing variables, bad entries), with why — logged at boot. */
  skipped: { name: string; reason: string }[];
  path: string | null;
}

const CAPABILITIES: readonly Capability[] = ["email", "web", "code", "payments", "accounts", "git", "data"];

export function mcpConfigPath(dataDir: string, env: NodeJS.ProcessEnv): string {
  return env.MCP_CONFIG?.trim() || join(dataDir, "mcp.json");
}

export function loadMcpConfig(path: string, env: NodeJS.ProcessEnv): McpConfigResult {
  if (!existsSync(path)) return { servers: [], skipped: [], path: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { servers: [], skipped: [{ name: "(file)", reason: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}` }], path };
  }
  return parseMcpConfig(raw, env, path);
}

export function parseMcpConfig(raw: unknown, env: NodeJS.ProcessEnv, path: string | null = null): McpConfigResult {
  const servers: McpServerConfig[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const entries = obj(obj(raw).servers);
  for (const [name, value] of Object.entries(entries)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/i.test(name)) {
      skipped.push({ name, reason: "server names are letters, digits, - and _ (at most 24)" });
      continue;
    }
    const s = obj(value);
    if (s.disabled === true) {
      skipped.push({ name, reason: "disabled" });
      continue;
    }
    const secrets: string[] = [];
    const missing: string[] = [];
    const sub = (text: unknown): string =>
      String(text ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_m, key: string) => {
        const v = env[key]?.trim();
        if (!v) {
          missing.push(key);
          return "";
        }
        secrets.push(v);
        return v;
      });
    const url = typeof s.url === "string" ? sub(s.url) : undefined;
    const command = typeof s.command === "string" ? sub(s.command) : undefined;
    if (!url === !command) {
      skipped.push({ name, reason: "give either a url or a command" });
      continue;
    }
    const headers = Object.fromEntries(Object.entries(obj(s.headers)).map(([k, v]) => [k, sub(v)]));
    const childEnv = Object.fromEntries(Object.entries(obj(s.env)).map(([k, v]) => [k, sub(v)]));
    const args = strs(s.args).map(sub);
    if (missing.length) {
      skipped.push({ name, reason: `not set in the environment: ${[...new Set(missing)].join(", ")}` });
      continue;
    }
    const access = obj(s.access);
    servers.push({
      name,
      url,
      headers,
      command,
      args,
      env: childEnv,
      grants: strs(s.grants).filter((g): g is Capability => (CAPABILITIES as readonly string[]).includes(g)),
      access: { roles: strs(access.roles), agents: strs(access.agents), departments: strs(access.departments), catalog: strs(access.catalog) },
      tools: strs(s.tools),
      noApproval: strs(s.noApproval),
      dailyCallLimit: typeof s.dailyCallLimit === "number" && s.dailyCallLimit >= 0 ? Math.floor(s.dailyCallLimit) : 50,
      secrets: [...new Set(secrets)].filter((v) => v.length >= 4),
    });
  }
  return { servers, skipped, path };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}
