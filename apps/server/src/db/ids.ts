/** Prefixed, shortened ids: agt_, dep_, tsk_, run_, spn_, trc_, cnv_, msg_, mem_, apr_, evt_. */
import { randomUUID } from "node:crypto";

export type IdPrefix = "agt" | "dep" | "tsk" | "run" | "spn" | "trc" | "cnv" | "msg" | "mem" | "apr" | "evt";

/** 16 hex chars (64 bits) after the prefix: short enough to read, unique enough for one node. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Trace ids are full 32-hex (OTel-compatible width). */
export function newTraceId(): string {
  return `trc_${randomUUID().replace(/-/g, "")}`;
}
