# ADR-0006: OTel-GenAI-shaped spans as the traceability backbone

- Status: accepted
- Date: 2026-11-04
- Requirements: FR-9, NFR-4

## Context
The reference "Glass Box" middleware records per-step events keyed by agent
and run. A company of agents needs one trace across many agents.

## Decision
A trace = one objective. Spans (objective, run, stage, llm, tool, delegation,
memory, system) carry traceId/parentSpanId and attributes following the
OpenTelemetry GenAI conventions (`gen_ai.*`, still "Development" status in
open-telemetry/semantic-conventions-genai) plus `agentco.*`. Delegation spans
are the parent of the delegate's run span, so the waterfall crosses agents.
Inputs/outputs are redacted (ported two-tier redactor) and truncated.

## Consequences
+ Exportable to OTel backends later with little mapping.
+ `failingSpanId` names the step that broke.
− Convention names may still change upstream; isolated in the tracer.
