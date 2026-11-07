/**
 * A minimal MCP client (no dependencies): JSON-RPC 2.0 over Streamable HTTP (a POST per message; the
 * reply is JSON or a short SSE stream) or over stdio (newline-delimited JSON to a child process).
 * Enough for initialize → tools/list → tools/call; no sampling, roots or resources.
 *
 * Keys substituted into the server's URL, headers or env are redacted from every error message.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpServerConfig } from "./config.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpCallResult {
  ok: boolean;
  text: string;
}

export interface McpClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
  clientVersion?: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  readonly server: McpServerConfig;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clientVersion: string;
  private sessionId: string | null = null;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private buffer = "";
  connected = false;

  constructor(server: McpServerConfig, options: McpClientOptions = {}) {
    this.server = server;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clientVersion = options.clientVersion ?? "1";
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.server.command) this.startProcess();
    const result = (await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agentco", version: this.clientVersion } }, signal)) as {
      protocolVersion?: string;
    };
    if (typeof result?.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    await this.notify("notifications/initialized");
    this.connected = true;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {}, signal)) as { tools?: unknown[]; nextCursor?: string };
      for (const t of r?.tools ?? []) {
        const o = t as Record<string, unknown>;
        if (typeof o.name !== "string") continue;
        tools.push({
          name: o.name,
          title: typeof o.title === "string" ? o.title : undefined,
          description: typeof o.description === "string" ? o.description : "",
          inputSchema: o.inputSchema && typeof o.inputSchema === "object" ? (o.inputSchema as Record<string, unknown>) : { type: "object", properties: {} },
          annotations: o.annotations && typeof o.annotations === "object" ? (o.annotations as McpTool["annotations"]) : {},
        });
      }
      if (!r?.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const call = () => this.request("tools/call", { name, arguments: args }, signal);
    let r: unknown;
    try {
      r = await call();
    } catch (error) {
      // An expired HTTP session: start a new one once and retry.
      if (!(error instanceof McpError && /session/i.test(error.message)) || this.server.command) throw error;
      this.sessionId = null;
      await this.connect(signal);
      r = await call();
    }
    const o = (r ?? {}) as { content?: unknown[]; isError?: boolean; structuredContent?: unknown };
    const parts: string[] = [];
    for (const c of o.content ?? []) {
      const item = c as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
        const res = item.resource as Record<string, unknown>;
        parts.push(typeof res.text === "string" ? res.text : `[resource ${String(res.uri ?? "")}]`);
      } else if (item.type === "resource_link") parts.push(`[link ${String(item.uri ?? "")}]`);
      else if (typeof item.type === "string") parts.push(`[${item.type}]`);
    }
    if (parts.length === 0 && o.structuredContent !== undefined) parts.push(JSON.stringify(o.structuredContent));
    return { ok: o.isError !== true, text: this.redact(parts.join("\n")) };
  }

  close(): void {
    this.connected = false;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    for (const p of this.pending.values()) p.reject(new McpError("connection closed"));
    this.pending.clear();
    if (this.server.url && this.sessionId) {
      // Best effort: end the session on the server.
      void this.fetchImpl(this.server.url, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
    }
    this.sessionId = null;
  }

  /** Removes every substituted key from a message. */
  redact(text: string): string {
    let out = text;
    for (const s of this.server.secrets) out = out.split(s).join("[redacted]");
    return out;
  }

  // ───────────── transport ─────────────

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const response = this.server.command ? await this.sendStdio(id, message, signal) : await this.sendHttp(message, id, signal);
    if (response.error) throw new McpError(this.redact(`${this.server.name}: ${response.error.message} (${response.error.code})`));
    return response.result;
  }

  private async notify(method: string): Promise<void> {
    const message = { jsonrpc: "2.0", method };
    if (this.server.command) {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    await this.post(message, AbortSignal.timeout(this.timeoutMs)).then((r) => r.body?.cancel().catch(() => undefined));
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...this.server.headers,
    };
  }

  private post(message: unknown, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(this.server.url!, { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal });
  }

  private async sendHttp(message: { id: number }, id: number, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.post(message, combined);
    } catch (error) {
      throw new McpError(this.redact(`${this.server.name}: request failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (response.status === 404 && this.sessionId) throw new McpError(`${this.server.name}: session expired`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new McpError(this.redact(`${this.server.name}: HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`));
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) return this.readSse(response, id);
    const body = (await response.json()) as JsonRpcResponse | JsonRpcResponse[];
    const found = (Array.isArray(body) ? body : [body]).find((m) => m.id === id);
    if (!found) throw new McpError(`${this.server.name}: no reply to request ${id}`);
    return found;
  }

  /** Reads an SSE reply until the message answering `id` arrives. */
  private async readSse(response: Response, id: number): Promise<JsonRpcResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new McpError(`${this.server.name}: empty event stream`);
    const decoder = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) text += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = text.search(/\r?\n\r?\n/)) >= 0) {
          const event = text.slice(0, cut);
          text = text.slice(cut).replace(/^\r?\n\r?\n/, "");
          const data = event
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          try {
            const msg = JSON.parse(data) as JsonRpcResponse;
            if (msg.id === id) return msg;
          } catch {
            // not JSON: ignore
          }
        }
        if (done) break;
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    throw new McpError(`${this.server.name}: the event stream ended without a reply`);
  }

  private startProcess(): void {
    if (this.child) return;
    const child = spawn(this.server.command!, this.server.args, { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", ...this.server.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!.resolve(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          // a log line on stdout: ignore
        }
      }
    });
    child.stderr.on("data", () => undefined);
    const fail = (why: string) => {
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new McpError(this.redact(`${this.server.name}: ${why}`)));
      this.pending.clear();
      this.child = null;
    };
    child.on("exit", (code) => fail(`process exited (${code ?? "signal"})`));
    child.on("error", (error) => fail(`could not start: ${error.message}`));
  }

  private sendStdio(id: number, message: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (!this.child) this.startProcess();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${this.server.name}: no reply within ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`${this.server.name}: cancelled`));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.child!.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }
}
