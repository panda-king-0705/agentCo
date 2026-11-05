// Markdown-lite: paragraphs, bullet/numbered lists, fenced code, headings, **bold**, *em*, `code`,
// [links](#/...) and T-n task references. Renders React nodes only (no innerHTML).
import type { ReactNode } from "react";
import { href } from "../router";
import { getLive } from "../live";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; lang: string; text: string };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      out.push({ t: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      continue;
    }
    const li = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]!);
      const kind = ordered ? "ol" : "ul";
      const prev = out[out.length - 1];
      if (prev && prev.t === kind) prev.items.push(li[2]!);
      else out.push({ t: kind, items: [li[2]!] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

function taskIdForNumber(n: number): string | null {
  const tasks = getLive().tasks;
  for (const id in tasks) if (tasks[id]!.number === n) return id;
  return null;
}

let keySeq = 0;
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))|(\bT-\d+\b)|(\n)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `i${keySeq++}`;
    if (m[1]) nodes.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={k}>{inline(tok.slice(2, -2))}</strong>);
    else if (m[3]) nodes.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else if (m[4]) {
      const [, label = "", url = ""] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok) ?? [];
      const safe = /^(#\/|https?:\/\/)/.test(url) ? url : "#";
      nodes.push(
        <a key={k} href={safe} target={safe.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
          {label}
        </a>,
      );
    } else if (m[5]) {
      const id = taskIdForNumber(Number(tok.slice(2)));
      nodes.push(
        id ? (
          <a key={k} className="task-ref" href={href(`/tasks/${id}`)}>
            {tok}
          </a>
        ) : (
          tok
        ),
      );
    } else if (m[6]) nodes.push(<br key={k} />);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={`md ${className ?? ""}`}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{inline(b.text)}</p>;
          case "h":
            return <p key={i} className="md-h">{inline(b.text)}</p>;
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={i} className="md-code">
                <code>{b.text}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
