/** web_fetch — opt-in (WEB_FETCH_ENABLED); GET, text only, 20 kB cap, no private/loopback hosts. */
import { ALL_TIERS, fail, ok, type ToolDefinition } from "../types.ts";

export const WEB_FETCH_MAX_CHARS = 20_000;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[?::1?\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript))/i;

export const webFetch: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch a public web page (HTTP GET) and return its text, capped at 20 kB.",
  parameters: { type: "object", properties: { url: { type: "string", maxLength: 2000 } }, required: ["url"] },
  tiers: ALL_TIERS,
  enabled: (config) => config.webFetchEnabled,
  async run(args, ctx) {
    let url: URL;
    try {
      url = new URL(String(args.url));
    } catch {
      return fail("Invalid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return fail("Only http(s) URLs are allowed.");
    if (PRIVATE_HOST.test(url.hostname)) return fail("Private, loopback and link-local hosts are not allowed.");
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]), headers: { accept: "text/*, application/json" } });
    const type = response.headers.get("content-type") ?? "";
    if (!TEXTUAL.test(type)) return fail(`Unsupported content-type: ${type || "unknown"} (text only).`);
    const text = await readCapped(response, WEB_FETCH_MAX_CHARS);
    return ok(`HTTP ${response.status} ${url.href}\n\n${text}`, [], { status: response.status });
  },
};

async function readCapped(response: Response, maxChars: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < maxChars) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated at 20 kB]" : text;
}
