// Hand-rolled SVG charts: sparkline, timeseries with crosshair, horizontal bars, gauges.
// Marks follow the console's dataviz rules: 2px lines, ~10% area wash, 4px rounded bar ends,
// hairline recessive grid, text in ink tokens (never the series colour), hover on every mark.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { clamp } from "../format";
import type { TimeseriesPoint } from "../types";

function useWidth(initial = 300) {
  const [w, setW] = useState(initial);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = (el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver((entries) => {
      const cw = Math.floor(entries[0]?.contentRect.width ?? initial);
      if (cw > 0) setW((p) => (p === cw ? p : cw));
    });
    ro.current.observe(el);
  };
  return [w, ref] as const;
}

function hourLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", hour12: false }) + ":00";
}

/** Compact trend line with end dot and hover readout. */
export function Sparkline({ points, format, height = 44, label, color = "var(--series-1)" }: { points: TimeseriesPoint[]; format: (v: number) => string; height?: number; label: string; color?: string }) {
  const [w, ref] = useWidth(240);
  const [hover, setHover] = useState<number | null>(null);
  const pad = 5;
  const max = Math.max(...points.map((p) => p.value), 0) || 1;
  const xs = (i: number) => pad + (i / Math.max(points.length - 1, 1)) * (w - pad * 2);
  const ys = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join("");
  const area = points.length ? `${line}L${xs(points.length - 1)},${height - pad}L${xs(0)},${height - pad}Z` : "";
  const last = points[points.length - 1];
  const hp = hover != null ? points[hover] : null;
  return (
    <div className="spark" ref={ref}>
      <svg width={w} height={height} role="img" aria-label={label} onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - pad) / (w - pad * 2)) * (points.length - 1));
        setHover(clamp(i, 0, points.length - 1));
      }}>
        <line x1={pad} x2={w - pad} y1={height - pad} y2={height - pad} className="axis" />
        {points.length > 1 ? (
          <>
            <path d={area} fill={color} opacity={0.1} />
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        ) : null}
        {hover != null && hp ? <line x1={xs(hover)} x2={xs(hover)} y1={pad} y2={height - pad} className="crosshair" /> : null}
        {last ? <circle cx={xs(hover ?? points.length - 1)} cy={ys((hp ?? last).value)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} /> : null}
      </svg>
      {hp ? (
        <div className="tip" style={{ left: clamp(xs(hover!) - 50, 0, w - 110) }}>
          <strong>{format(hp.value)}</strong> <span className="muted">{hourLabel(hp.t)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Timeseries with y ticks, hourly x labels, hairline grid and a crosshair tooltip. */
export function TimeChart({ points, format, height = 200, label, color = "var(--series-1)" }: { points: TimeseriesPoint[]; format: (v: number) => string; height?: number; label: string; color?: string }) {
  const [w, ref] = useWidth(600);
  const [hover, setHover] = useState<number | null>(null);
  const m = { l: 56, r: 12, t: 12, b: 26 };
  const iw = Math.max(10, w - m.l - m.r);
  const ih = height - m.t - m.b;
  const raw = Math.max(...points.map((p) => p.value), 0);
  const ticks = niceTicks(raw);
  const max = ticks[ticks.length - 1] || 1;
  const xs = (i: number) => m.l + (i / Math.max(points.length - 1, 1)) * iw;
  const ys = (v: number) => m.t + ih - (v / max) * ih;
  const line = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join("");
  const area = points.length ? `${line}L${xs(points.length - 1)},${m.t + ih}L${xs(0)},${m.t + ih}Z` : "";
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(iw / 70))));
  const hp = hover != null ? points[hover] : null;
  return (
    <div className="timechart" ref={ref}>
      <svg width={w} height={height} role="img" aria-label={label} onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left - m.l) / iw) * (points.length - 1));
        setHover(clamp(i, 0, points.length - 1));
      }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={m.l + iw} y1={ys(t)} y2={ys(t)} className={t === 0 ? "axis" : "grid"} />
            <text x={m.l - 8} y={ys(t)} className="tick" textAnchor="end" dominantBaseline="middle">
              {format(t)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % every === 0 ? (
            <text key={p.t} x={xs(i)} y={height - 8} className="tick" textAnchor="middle">
              {hourLabel(p.t)}
            </text>
          ) : null,
        )}
        {points.length > 1 ? (
          <>
            <path d={area} fill={color} opacity={0.1} />
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        ) : null}
        {hp ? (
          <>
            <line x1={xs(hover!)} x2={xs(hover!)} y1={m.t} y2={m.t + ih} className="crosshair" />
            <circle cx={xs(hover!)} cy={ys(hp.value)} r={4.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
          </>
        ) : null}
      </svg>
      {hp ? (
        <div className="tip" style={{ left: clamp(xs(hover!) - 60, 0, w - 130), top: 4 }}>
          <strong>{format(hp.value)}</strong>
          <div className="muted">{new Date(hp.t).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</div>
        </div>
      ) : null}
    </div>
  );
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1]! < max) out.push(Math.round((out[out.length - 1]! + step) * 1e6) / 1e6);
  return out;
}

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number;
  color?: string;
  sub?: ReactNode;
  title?: string;
}

/** Ranked horizontal bars: label left, value at the bar tip, one colour per entity (not per rank). */
export function HBars({ items, format, max, empty = "No data yet" }: { items: BarItem[]; format: (v: number) => string; max?: number; empty?: string }) {
  const top = max ?? Math.max(...items.map((i) => i.value), 0);
  if (!items.length) return <div className="muted small pad">{empty}</div>;
  return (
    <ul className="hbars">
      {items.map((it) => {
        const w = top > 0 ? (it.value / top) * 100 : 0;
        return (
          <li key={it.key} title={it.title ?? `${typeof it.label === "string" ? it.label : it.key}: ${format(it.value)}`}>
            <span className="hb-label">{it.label}</span>
            <span className="hb-track">
              <span className="hb-bar" style={{ width: `${Math.max(w, it.value > 0 ? 1.5 : 0)}%`, background: it.color ?? "var(--series-1)" }} />
              <span className="hb-value">{format(it.value)}</span>
            </span>
            {it.sub ? <span className="hb-sub">{it.sub}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A 0..1 (or −1..1 diverging) gauge with an optional threshold tick. */
export function Gauge({ value, min = 0, max = 1, threshold, label, format, diverging }: { value: number; min?: number; max?: number; threshold?: number; label: string; format?: (v: number) => string; diverging?: boolean }) {
  const pos = (v: number) => ((clamp(v, min, max) - min) / (max - min)) * 100;
  const mid = pos(0);
  const p = pos(value);
  const over = threshold != null && value >= threshold;
  return (
    <div className={`gauge${over ? " over" : ""}`}>
      <div className="g-head">
        <span>{label}</span>
        <span className="num">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <div className="g-track" role="meter" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}>
        {diverging ? (
          <div className={`g-fill ${value < 0 ? "neg" : "pos"}`} style={{ left: `${Math.min(mid, p)}%`, width: `${Math.abs(p - mid)}%` }} />
        ) : (
          <div className="g-fill" style={{ left: 0, width: `${p}%` }} />
        )}
        {diverging ? <div className="g-mid" style={{ left: `${mid}%` }} /> : null}
        {threshold != null ? <div className="g-threshold" style={{ left: `${pos(threshold)}%` }} title={`Threshold ${threshold}`} /> : null}
      </div>
    </div>
  );
}

/** Small multi-segment bar of parts (used for token in/out, tasks by status). */
export function SegBar({ parts, height = 8, label }: { parts: { key: string; value: number; color: string; label: string }[]; height?: number; label: string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  const shown = useMemo(() => parts.filter((p) => p.value > 0), [parts]);
  return (
    <div className="segbar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`} style={{ height }}>
      {shown.map((p) => (
        <span key={p.key} style={{ flexGrow: total ? p.value / total : 0, background: p.color }} title={`${p.label}: ${p.value}`} />
      ))}
    </div>
  );
}
