/**
 * web_fetch — opt-in (WEB_FETCH_ENABLED); GET, text only, 20 kB cap, public hosts only.
 *
 * SSRF guard (every hop): the hostname is resolved with node:dns (all addresses) and the
 * request is refused when ANY address is private, loopback, link-local, unspecified,
 * multicast/reserved, CGNAT, or an IPv6 form embedding one of those (IPv4-mapped
 * ::ffff:a.b.c.d, IPv4-compatible, NAT64 64:ff9b::/96, 6to4 2002::/16). Literal IP
 * hosts are checked the same way, in every spelling the URL parser accepts.
 * Redirects are followed manually (redirect: "manual"), at most 5 hops, and every
 * Location is re-checked before it is fetched.
 *
 * Residual risk (documented in SECURITY.md): fetch resolves the name again when it
 * connects, so a DNS-rebinding server with a ~0 TTL can still race the check.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ALL_TIERS, fail, ok, type ToolDefinition } from "../types.ts";

export const WEB_FETCH_MAX_CHARS = 20_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript))/i;
const PRIVATE_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)\.?$/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface WebFetchDeps {
  /** All addresses for a hostname (default: node:dns lookup with all: true). */
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  fetch: typeof fetch;
  timeoutMs: number;
}

const defaultDeps: WebFetchDeps = {
  lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  fetch: (input, init) => fetch(input, init),
  timeoutMs: 10_000,
};

// ───────────── address classification ─────────────

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

function privateIPv4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // "this network", 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && o[2] === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal (no brackets, optional zone, optional dotted IPv4 tail) to 8 hextets. */
function ipv6Hextets(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4Octets(text.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const hextets = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  if (tail.length) hextets.splice(6, 2, ...tail);
  return hextets.length === 8 ? hextets : null;
}

function embeddedV4(h: number[], from: number): number[] {
  return [h[from]! >> 8, h[from]! & 0xff, h[from + 1]! >> 8, h[from + 1]! & 0xff];
}

function privateIPv6(h: number[]): boolean {
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (zeros(8)) return true; // ::
  if (zeros(7) && h[7] === 1) return true; // ::1
  if (zeros(5) && h[5] === 0xffff) return privateIPv4(embeddedV4(h, 6)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeros(4) && h[4] === 0xffff && h[5] === 0) return privateIPv4(embeddedV4(h, 6)); // ::ffff:0:a.b.c.d (SIIT)
  if (zeros(6)) return privateIPv4(embeddedV4(h, 6)); // ::a.b.c.d (IPv4-compatible, deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return privateIPv4(embeddedV4(h, 6)); // NAT64
  if (h[0] === 0x2002) return privateIPv4(embeddedV4(h, 1)); // 6to4
  const first = h[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}

/** True for any address web_fetch must not reach. Unparseable input counts as private (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const kind = isIP(bare.split("%")[0]!);
  if (kind === 4) {
    const o = ipv4Octets(bare);
    return !o || privateIPv4(o);
  }
  if (kind === 6) {
    const h = ipv6Hextets(bare);
    return !h || privateIPv6(h);
  }
  return true;
}

/** null when the URL may be fetched, else the reason it may not. Resolves DNS for names. */
export async function checkPublicUrl(url: URL, lookup: WebFetchDeps["lookup"]): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http(s) URLs are allowed.";
  if (url.username || url.password) return "URLs with credentials are not allowed.";
  const host = url.hostname;
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(literal)) return isPrivateAddress(literal) ? `Private, loopback and link-local hosts are not allowed (${host}).` : null;
  if (!host || PRIVATE_NAME.test(host)) return `Private, loopback and link-local hosts are not allowed (${host || "empty host"}).`;
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host.replace(/\.$/, ""));
  } catch (error) {
    return `Could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (addresses.length === 0) return `Could not resolve ${host}.`;
  const blocked = addresses.filter((a) => isPrivateAddress(a.address));
  if (blocked.length > 0) return `Private, loopback and link-local hosts are not allowed (${host} resolves to ${blocked.map((a) => a.address).join(", ")}).`;
  return null;
}

// ───────────── the tool ─────────────

export function createWebFetch(overrides: Partial<WebFetchDeps> = {}): ToolDefinition {
  const deps: WebFetchDeps = { ...defaultDeps, ...overrides };
  return {
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
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(deps.timeoutMs)]);
      for (let hop = 0; ; hop++) {
        const refused = await checkPublicUrl(url, deps.lookup);
        if (refused) return fail(hop === 0 ? refused : `Redirect refused: ${refused}`);
        const response = await deps.fetch(url, { redirect: "manual", signal, headers: { accept: "text/*, application/json" } });
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) return fail(`HTTP ${response.status} without a Location header from ${url.href}`);
          if (hop + 1 > WEB_FETCH_MAX_REDIRECTS) return fail(`Too many redirects (more than ${WEB_FETCH_MAX_REDIRECTS}).`);
          try {
            url = new URL(location, url);
          } catch {
            return fail(`Invalid redirect location: ${location}`);
          }
          continue;
        }
        const type = response.headers.get("content-type") ?? "";
        if (!TEXTUAL.test(type)) {
          await response.body?.cancel().catch(() => undefined);
          return fail(`Unsupported content-type: ${type || "unknown"} (text only).`);
        }
        const text = await readCapped(response, WEB_FETCH_MAX_CHARS);
        return ok(`HTTP ${response.status} ${url.href}\n\n${text}`, [], { status: response.status, url: url.href, redirects: hop });
      }
    },
  };
}

export const webFetch: ToolDefinition = createWebFetch();

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
