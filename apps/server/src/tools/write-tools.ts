/**
 * Tool calls that save, commit or hand out work — a task's deliverable — as opposed to reading.
 * Used by the tool loop's empty-"done" guard and to tell a retry what its earlier attempt did
 * (2026-11-08, trc_92d7…).
 */
export const WRITE_TOOL = /^(workspace_(write|edit)_file|delegate_task|hire_agent)$|^[a-z0-9-]+_(create|push|update|delete|merge|add|put|post|write|edit|commit|upload|insert)/i;
