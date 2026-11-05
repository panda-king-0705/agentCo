#!/usr/bin/env node
/**
 * Re-vendors the msitarzewski/agency-agents specialist catalog into catalog/agency-agents/.
 *
 *   node scripts/update-catalog.mjs <path-to-agency-agents-clone> [--commit <sha>] [--dry-run]
 *
 * Copies, unmodified: LICENSE, divisions.json and every *.md file under each division
 * directory listed in divisions.json (nested sub-folders such as game-development/unity/
 * included). strategy/, integrations/, examples/ and scripts/ are not divisions (see the
 * `_note` in divisions.json) and are never copied. The previous vendored copy is replaced
 * wholesale, so agents removed upstream disappear here too. VENDOR.md is regenerated with
 * the source URL, the commit (from --commit, else read from the clone's .git without
 * running git), the date and the file count.
 *
 * Zero dependencies; never touches anything outside catalog/agency-agents/.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_URL = "https://github.com/msitarzewski/agency-agents";
const NON_DIVISIONS = new Set(["strategy", "integrations", "examples", "scripts"]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "catalog", "agency-agents");

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("usage: node scripts/update-catalog.mjs <path-to-agency-agents-clone> [--commit <sha>] [--dry-run]");
  process.exit(2);
}

const args = process.argv.slice(2);
let source = null;
let commit = null;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--commit") commit = args[++i] ?? usage("--commit needs a value");
  else if (a === "--dry-run") dryRun = true;
  else if (a === "-h" || a === "--help") usage();
  else if (!source) source = resolve(a);
  else usage(`unexpected argument ${a}`);
}
if (!source) usage("missing the clone path");
if (!existsSync(join(source, "divisions.json"))) usage(`${source} has no divisions.json (is it an agency-agents clone?)`);

/** The clone's HEAD commit, read from .git files (no git binary needed); null when unknown. */
function readCommit(repo) {
  const git = join(repo, ".git");
  if (!existsSync(git)) return null;
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
  const head = read(join(git, "HEAD"));
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = head.startsWith("ref: ") ? head.slice(5).trim() : "";
  if (ref) {
    const loose = read(join(git, ref));
    if (/^[0-9a-f]{40}$/.test(loose)) return loose;
    const branch = ref.split("/").pop();
    for (const line of read(join(git, "packed-refs")).split("\n")) {
      const [sha, name] = line.split(" ");
      if (sha && /^[0-9a-f]{40}$/.test(sha) && (name === ref || name === `refs/remotes/origin/${branch}`)) return sha;
    }
  }
  const shallow = read(join(git, "shallow")).split("\n")[0] ?? "";
  return /^[0-9a-f]{40}$/.test(shallow) ? shallow : null;
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...markdownFiles(p));
    else if (st.isFile() && entry.endsWith(".md")) out.push(p);
  }
  return out;
}

const divisionsDoc = JSON.parse(readFileSync(join(source, "divisions.json"), "utf8"));
const divisions = Object.keys(divisionsDoc.divisions ?? {}).filter((d) => !NON_DIVISIONS.has(d));
if (divisions.length === 0) usage("divisions.json lists no divisions");
commit = commit ?? readCommit(source) ?? "unknown";

const plan = [];
for (const division of divisions) {
  const dir = join(source, division);
  if (!existsSync(dir)) {
    console.warn(`warning: division "${division}" has no directory in the clone; skipped`);
    continue;
  }
  for (const file of markdownFiles(dir)) plan.push(relative(source, file));
}
console.log(`agency-agents @ ${commit}: ${plan.length} agent files in ${divisions.length} divisions`);
if (dryRun) process.exit(0);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const rel of ["LICENSE", "divisions.json", ...plan]) {
  const to = join(target, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(join(source, rel), to);
}

const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(target, "VENDOR.md"),
  `# Vendored: agency-agents

| | |
|---|---|
| Source | ${REPO_URL} |
| Commit | \`${commit}\` |
| Vendored on | ${date} |
| Files | ${plan.length} agent markdown files in ${divisions.length} divisions, plus \`LICENSE\` and \`divisions.json\` |
| Licence | MIT — Copyright (c) 2025 AgentLand Contributors; full text in [\`LICENSE\`](LICENSE) |

The agent files are copied **unmodified**. AgentCo parses them at boot
(\`apps/server/src/catalog/\`) into a specialist catalog and compiles each one into
a compact "specialist playbook" for worker prompts; see [docs/CATALOG.md](../../docs/CATALOG.md).

Only the division directories listed in \`divisions.json\` are vendored. \`strategy/\`,
\`integrations/\`, \`examples/\` and \`scripts/\` are not agent divisions (see the
\`_note\` in \`divisions.json\`) and are left out.

## Updating

\`\`\`bash
git clone --depth 1 ${REPO_URL} /tmp/agency-agents
node scripts/update-catalog.mjs /tmp/agency-agents          # or --commit <sha> to record it explicitly
node --disable-warning=ExperimentalWarning --test "apps/server/test/core/catalog*.test.ts"
\`\`\`

The script replaces this directory wholesale (so agents deleted upstream disappear) and
regenerates this file. After an update, re-run the catalog tests: they fail when a worker
template's \`catalogId\` or an entry of \`catalog/division-map.json\` no longer exists, or
when a new division has no department mapping.
`,
);
console.log(`wrote ${relative(root, target)} (${plan.length} agents)`);
