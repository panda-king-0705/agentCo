// Hand-rolled hash router: "#/traces/trc_1?span=spn_2" → { segments: ["traces","trc_1"], query }.
import { useSyncExternalStore } from "react";

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart = "/", queryPart = ""] = raw.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  return { path, segments: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(queryPart) };
}

let current = parse();
const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  current = parse();
  for (const l of listeners) l();
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const hash = to.startsWith("#") ? to : `#${to}`;
  if (opts.replace) {
    history.replaceState(null, "", hash);
    current = parse();
    for (const l of listeners) l();
  } else window.location.hash = hash;
}

/** Build a hash href; `query` entries with null/undefined/"" are dropped. */
export function href(path: string, query?: Record<string, string | null | undefined>): string {
  const q = query ? Object.entries(query).filter(([, v]) => v != null && v !== "") : [];
  return `#${path}${q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`).join("&")}` : ""}`;
}

/** Replace one query param on the current route without adding a history entry. */
export function setQuery(key: string, value: string | null): void {
  const q = new URLSearchParams(current.query);
  if (value == null || value === "") q.delete(key);
  else q.set(key, value);
  const s = q.toString();
  navigate(`${current.path}${s ? `?${s}` : ""}`, { replace: true });
}
