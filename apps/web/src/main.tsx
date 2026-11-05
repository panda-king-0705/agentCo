// App shell: left nav with live counts, quick find, theme, connection state, hash-routed views.
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { setErrorHandler } from "./api";
import { href, navigate, useRoute } from "./router";
import { startLive, useLive } from "./live";
import { Icon, StatusGlyph, ToastHost, toast } from "./ui/kit";
import { TokenGate } from "./ui/token-gate";
import { Overview } from "./views/overview";
import { OrgView } from "./views/org";
import { AgentView } from "./views/agent";
import { ChatView } from "./views/chat";
import { TracesView } from "./views/traces";
import { TasksView } from "./views/tasks";
import { ApprovalsView } from "./views/approvals";
import { CostsView } from "./views/costs";
import { MemoryView } from "./views/memory";
import { CatalogView } from "./views/catalog";

setErrorHandler((err, label) => toast(err.message, "error", label));

type Theme = "system" | "light" | "dark";
function readTheme(): Theme {
  try {
    const t = localStorage.getItem("agentco.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
function applyTheme(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem("agentco.theme");
    else localStorage.setItem("agentco.theme", t);
  } catch {
    /* storage unavailable */
  }
}

const NAV: { id: string; path: string; label: string; icon: string }[] = [
  { id: "", path: "/", label: "Overview", icon: "overview" },
  { id: "org", path: "/org", label: "Org chart", icon: "org" },
  { id: "catalog", path: "/catalog", label: "Catalog", icon: "catalog" },
  { id: "chat", path: "/chat", label: "Chat", icon: "chat" },
  { id: "traces", path: "/traces", label: "Traces", icon: "traces" },
  { id: "tasks", path: "/tasks", label: "Tasks", icon: "tasks" },
  { id: "approvals", path: "/approvals", label: "Approvals", icon: "approvals" },
  { id: "costs", path: "/costs", label: "Costs", icon: "costs" },
  { id: "memory", path: "/memory", label: "Memory", icon: "memory" },
];

function QuickFind() {
  const agents = useLive((s) => s.agents);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const hits = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return Object.values(agents)
      .filter((a) => a.status !== "terminated" && (a.name.toLowerCase().includes(n) || a.title.toLowerCase().includes(n) || (a.activity ?? "").toLowerCase().includes(n)))
      .slice(0, 8);
  }, [q, agents]);
  const go = (id: string) => {
    navigate(`/agents/${id}`);
    setQ("");
    setOpen(false);
  };
  return (
    <div className="quickfind">
      <label className="search">
        <Icon name="search" size={14} />
        <input
          type="search"
          value={q}
          data-quickfind=""
          placeholder="Find an agent"
          aria-label="Find an agent"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setIdx(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIdx((i) => Math.min(i + 1, hits.length - 1));
            else if (e.key === "ArrowUp") setIdx((i) => Math.max(i - 1, 0));
            else if (e.key === "Enter" && hits[idx]) go(hits[idx]!.id);
            else if (e.key === "Escape") {
              setQ("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <kbd aria-hidden="true">/</kbd>
      </label>
      {open && hits.length ? (
        <div className="qf-results" role="listbox">
          {hits.map((a, i) => (
            <a key={a.id} className={`qf-item${i === idx ? " on" : ""}`} href={href(`/agents/${a.id}`)} onMouseDown={(e) => { e.preventDefault(); go(a.id); }}>
              <StatusGlyph status={a.status} />
              <span className="grow ellipsis">{a.name}</span>
              <span className="muted tiny ellipsis">{a.title}</span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Nav({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const route = useRoute();
  const company = useLive((s) => s.company);
  const approvals = useLive((s) => s.approvals);
  const tasks = useLive((s) => s.tasks);
  const connection = useLive((s) => s.connection);
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === "pending").length, [approvals]);
  const blocked = useMemo(() => Object.values(tasks).filter((t) => t.status === "blocked").length, [tasks]);
  const active = route.segments[0] === "agents" ? "org" : route.segments[0] ?? "";
  const nextTheme: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  return (
    <nav className="nav" aria-label="Main">
      <a className="brand" href={href("/")}>
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="brand-text">
          <div className="brand-name">{company?.settings.name ?? "AgentCo"}</div>
          <div className="brand-sub">Console</div>
        </span>
      </a>
      <QuickFind />
      <ul className="nav-list">
        {NAV.map((n) => {
          const count = n.id === "approvals" ? pending : n.id === "tasks" ? blocked : 0;
          return (
            <li key={n.id}>
              <a className={`nav-item${active === n.id ? " on" : ""}`} href={href(n.path)} aria-current={active === n.id ? "page" : undefined} title={n.label}>
                <Icon name={n.icon} />
                <span className="label">{n.label}</span>
                {count > 0 ? (
                  <span className={`nav-count ${n.id === "approvals" ? "hot" : "bad"}`} aria-label={`${count} ${n.id === "approvals" ? "pending" : "blocked"}`}>
                    {count}
                  </span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
      <div className="grow" />
      <div className="nav-foot">
        <div className={`conn ${connection}`} title={`Event stream: ${connection}`}>
          <span className="conn-dot" aria-hidden="true" />
          <span className="conn-label">{connection === "live" ? "Live" : connection === "polling" ? "Polling" : connection === "reconnecting" ? "Reconnecting" : "Connecting"}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme}. Click for ${nextTheme}.`}>
          <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"} size={14} />
          <span className="theme-label">Theme: {theme}</span>
        </button>
      </div>
    </nav>
  );
}

function NotFound() {
  return (
    <div className="pad">
      <h1 style={{ marginBottom: 8 }}>Not found</h1>
      <p className="muted">
        That page does not exist. <a href={href("/")}>Back to Overview</a>
      </p>
    </div>
  );
}

function Routes() {
  const { segments } = useRoute();
  const [a, b] = segments;
  switch (a) {
    case undefined:
      return <Overview />;
    case "org":
      return <OrgView />;
    case "agents":
      return b ? <AgentView agentId={b} /> : <OrgView />;
    case "chat":
      return <ChatView conversationId={b ?? null} />;
    case "traces":
      return <TracesView traceId={b ?? null} />;
    case "tasks":
      return <TasksView taskId={b ?? null} />;
    case "approvals":
      return <ApprovalsView />;
    case "costs":
      return <CostsView />;
    case "memory":
      return <MemoryView />;
    case "catalog":
      return <CatalogView />;
    default:
      return <NotFound />;
  }
}

function App() {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const route = useRoute();
  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
  };
  useEffect(() => {
    void startLive();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const el = document.querySelector<HTMLInputElement>("[data-page-search]") ?? document.querySelector<HTMLInputElement>("[data-quickfind]");
      if (el) {
        e.preventDefault();
        el.focus();
        el.select();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.segments[0], route.segments[1]]);
  return (
    <div className="app">
      <Nav theme={theme} setTheme={setTheme} />
      <main className="main" id="main">
        <Routes />
      </main>
      <ToastHost />
      <TokenGate />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
