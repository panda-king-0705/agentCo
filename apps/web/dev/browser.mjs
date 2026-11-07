// Shared browser setup for the console's end-to-end scripts (e2e.mjs in CI, e2e-live.mjs against a real
// server). Portable: CI failed on every run because the scripts loaded Playwright from one dev machine's
// global path, launched /usr/bin/google-chrome and wrote screenshots to that machine's scratch folder.
//   Playwright   the project's node_modules, then PLAYWRIGHT_MODULE, then the global npm root.
//   Browser      E2E_BROWSER=chromium → Playwright's bundled Chromium (CI); else E2E_CHROME or
//                /usr/bin/google-chrome when present; else the bundled Chromium.
//   Screenshots  E2E_SHOTS, default <os tmpdir>/agentco-e2e-shots.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  const tried = [];
  for (const id of ["playwright", process.env.PLAYWRIGHT_MODULE].filter(Boolean)) {
    try {
      return require(id);
    } catch {
      tried.push(id);
    }
  }
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return require(join(globalRoot, "playwright"));
  } catch {
    tried.push("npm root -g");
  }
  throw new Error(`Playwright not found (tried ${tried.join(", ")}). Install it: npm install --no-save playwright && npx playwright install chromium`);
}

export function launchOptions() {
  const args = ["--no-sandbox"];
  if (process.env.E2E_BROWSER === "chromium") return { args };
  const chrome = process.env.E2E_CHROME ?? "/usr/bin/google-chrome";
  return existsSync(chrome) ? { executablePath: chrome, args } : { args };
}

export async function shotsDir() {
  const dir = process.env.E2E_SHOTS ?? join(tmpdir(), "agentco-e2e-shots");
  await mkdir(dir, { recursive: true });
  return dir;
}
