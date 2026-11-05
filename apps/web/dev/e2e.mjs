// End-to-end check of the console in a real browser (Playwright + system Chrome).
//   node apps/web/build.mjs && node apps/web/dev/e2e.mjs
// Boots the fixture server on an ephemeral port, or targets E2E_BASE_URL (e.g. the real server).
// Exercises every route plus: create agent -> DM -> pause -> destroy, answer an approval, open a trace and a
// span, open an executive's Brain tab. Fails on any console error. Screenshots go to E2E_SHOTS (default below).
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/claude/.npm-global/lib/node_modules/playwright");

const SHOTS = process.env.E2E_SHOTS ?? "/tmp/claude-0/-home-claude/06e36f00-0262-5301-81ed-9eb96c3615c1/scratchpad/web-shots";
await mkdir(SHOTS, { recursive: true });

let server = null;
let base = process.env.E2E_BASE_URL;
if (!base) {
  const { startFixtureServer } = await import("./fixture-server.mjs");
  server = await startFixtureServer({ port: 0, quiet: true, latencyMs: 10 });
  base = server.url;
}
console.log(`[e2e] target ${base}`);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let phase = "";
let finished = false;

function watch(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error" && !finished) errors.push(`[${label}/${phase}] console: ${m.text()}`);
  });
  page.on("pageerror", (e) => {
    if (!finished) errors.push(`[${label}/${phase}] pageerror: ${e.message}`);
  });
}

const go = async (page, hash) => {
  await page.goto(`${base}/#${hash}`);
  await page.waitForLoadState("domcontentloaded");
};
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(250);
  await page.evaluate(() => document.querySelector(".toasts")?.replaceChildren());
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: !!opts.full });
};
const step = async (name, fn) => {
  phase = name;
  process.stdout.write(`[e2e] ${name} ... `);
  try {
    await fn();
    console.log("ok");
  } catch (e) {
    console.log("FAILED");
    errors.push(`[step ${name}] ${e.message}`);
  }
};

async function run(scheme, interactive) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  watch(page, scheme);
  const S = (n, o) => shot(page, `${scheme}-${n}`, o);

  await step(`${scheme} overview`, async () => {
    await go(page, "/");
    await page.waitForSelector(".kpis .kpi");
    await page.waitForSelector(".agent-chip");
    assert.ok(await page.locator(".lane").count() >= 3, "expected several department lanes");
    assert.ok(await page.getByText(/MOCK models|LIVE models/).count(), "models badge");
    assert.ok(await page.locator(".feed-item").count() > 0, "activity feed has items");
    await S("overview", { full: true });
  });

  await step(`${scheme} org`, async () => {
    await go(page, "/org");
    await page.waitForSelector(".org-card");
    assert.ok(await page.locator(".org-card").count() >= 10, "org chart shows agents");
    await S("org", { full: true });
  });

  if (interactive) {
    await step("kill switch confirm", async () => {
      await go(page, "/");
      await page.getByRole("button", { name: "Pause all" }).click();
      await page.waitForSelector('[role="dialog"]');
      await page.getByRole("button", { name: "Cancel" }).click();
    });

    await step("hire agent", async () => {
      await go(page, "/org");
      await page.waitForSelector(".org-card");
      await page.getByRole("button", { name: "Hire agent" }).first().click();
      const dlg = page.locator('[role="dialog"]');
      await dlg.waitFor();
      await dlg.locator("select").first().waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] select option').length > 5);
      const value = await dlg.locator("select").first().evaluate((sel) => {
        const opts = [...sel.options].filter((o) => o.value);
        return (opts.find((o) => /worker|engineer|writer/i.test(o.textContent)) ?? opts[0]).value;
      });
      await dlg.locator("select").first().selectOption(value);
      await dlg.locator('input[type="text"]').first().fill("E2E Tester");
      await S("hire-modal");
      await dlg.getByRole("button", { name: "Hire agent" }).click();
      await page.waitForSelector('.org-card[data-agent] a.oc-name:text("E2E Tester")', { timeout: 8000 });
    });

    await step("DM the new agent", async () => {
      await page.getByRole("button", { name: "Chat with E2E Tester" }).click();
      await page.waitForSelector(".composer textarea");
      assert.match(page.url(), /#\/chat\/.+/);
      await page.locator(".composer textarea").fill("Hello from the e2e run");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
      await page.keyboard.type("second line");
      assert.ok((await page.locator(".composer textarea").inputValue()).includes("\n"), "Shift+Enter adds a newline");
      await page.keyboard.press("Enter");
      await page.waitForSelector(".msg.mine");
      await page.waitForSelector(".msg:not(.mine)", { timeout: 15000 });
      await S("chat");
    });

    await step("pause, resume, destroy", async () => {
      await go(page, "/org");
      await page.getByRole("button", { name: "Pause E2E Tester" }).click();
      await page.getByRole("button", { name: "Resume E2E Tester" }).waitFor();
      await page.getByRole("button", { name: "Destroy E2E Tester" }).click();
      await page.getByText(/aborted/).first().waitFor();
      await page.getByRole("button", { name: "Destroy agent" }).click();
      await page.waitForSelector('[data-testid="destroy-result"]');
      await page.getByRole("button", { name: "Done" }).click();
      await page.waitForFunction(() => !document.querySelector('.org-card a.oc-name')?.parentElement || ![...document.querySelectorAll(".org-card a.oc-name")].some((a) => a.textContent === "E2E Tester"));
    });

    await step("answer an approval", async () => {
      await go(page, "/approvals");
      await page.waitForSelector(".apr-card");
      await S("approvals", { full: true });
      const before = await page.locator(".apr-card").count();
      const card = page.locator(".apr-card", { hasText: "Question" }).first();
      await card.locator("textarea").fill("Approve 15%, hold the rest.");
      await card.getByRole("button", { name: "Send answer" }).click();
      await page.waitForFunction((n) => document.querySelectorAll(".apr-card").length === n - 1, before);
      assert.ok(await page.locator("[data-history]").count() > 0, "history list");
    });

    await step("create a task", async () => {
      await go(page, "/tasks");
      await page.waitForSelector(".tcard");
      await page.getByRole("button", { name: "New task" }).click();
      await page.locator('[role="dialog"] input[type="text"]').first().fill("E2E task: check the footer");
      await page.getByRole("button", { name: "Create task" }).click();
      await page.waitForSelector(".drawer");
      await page.getByText("E2E task: check the footer").first().waitFor();
      await page.keyboard.press("Escape");
    });

    await step("worker has no Brain tab", async () => {
      await go(page, "/agents/agt_be");
      await page.waitForSelector(".tabs");
      assert.equal(await page.getByRole("tab", { name: "Brain" }).count(), 0, "workers have no Brain tab");
      await page.getByRole("tab", { name: "Work" }).click();
      await page.getByRole("tab", { name: "Memory" }).click();
      await page.getByRole("tab", { name: "Chat" }).click();
      await page.waitForSelector(".composer textarea");
    });

    await step("agent overview + edit", async () => {
      await go(page, "/agents/agt_ceo?tab=overview");
      await page.waitForSelector(".panel");
      await S("agent-overview", { full: true });
    });
  }

  await step(`${scheme} traces list`, async () => {
    await go(page, "/traces");
    await page.waitForSelector('[data-testid="trace-table"] tbody tr');
    await S("traces");
  });

  await step(`${scheme} trace detail + span`, async () => {
    await go(page, "/traces");
    await page.locator('[data-testid="trace-table"] tbody tr', { hasText: "Launch self-serve pricing page" }).first().click();
    await page.waitForSelector(".wf-row");
    assert.ok(await page.locator(".wf-row").count() > 20, "waterfall has spans");
    await page.locator(".wf-row", { hasText: "llm" }).first().click();
    await page.waitForSelector(".span-panel");
    assert.ok(await page.locator(".span-panel").getByText("Attributes").count(), "attributes shown");
    await S("trace-detail", { full: true });
  });

  await step(`${scheme} brain tab`, async () => {
    // The fixture walks the CTO through the brain blocks on a heartbeat; wait until it lights a block.
    await go(page, "/agents/agt_cto?tab=brain");
    await page.waitForSelector(".brain-svg [data-block]");
    assert.ok(await page.locator(".brain-svg [data-block]").count() >= 33, "every block is drawn");
    await page.waitForSelector('.brain-svg [data-active="true"]', { timeout: 20000 });
    await page.waitForSelector(".brain-svg [data-visited]", { timeout: 20000 });
    await page.locator('.brain-svg [data-block="metacognition.cognitive_control.candidate_solutions"]').first().click();
    await page.waitForSelector(".block-inspector");
    await S("brain", { full: true });
    await page.locator(".block-inspector button").first().click();
  });

  await step(`${scheme} tasks`, async () => {
    await go(page, "/tasks");
    await page.waitForSelector(".tcard");
    await S("tasks");
    await page.locator(".tcard").first().click();
    await page.waitForSelector(".drawer");
    await S("task-drawer");
    await page.keyboard.press("Escape");
  });

  await step(`${scheme} chat`, async () => {
    await go(page, "/chat");
    await page.waitForSelector(".conv");
    await page.waitForSelector(".msg");
    await S("chat-boardroom");
  });

  await step(`${scheme} costs`, async () => {
    await go(page, "/costs");
    await page.waitForSelector(".hbars");
    await S("costs", { full: true });
  });

  await step(`${scheme} memory`, async () => {
    await go(page, "/memory");
    await page.waitForSelector(".mem-item");
    await page.waitForSelector(".bb-row");
    await S("memory");
  });

  if (scheme === "light") {
    await step("slash focuses search", async () => {
      await go(page, "/tasks");
      await page.waitForSelector(".tcard");
      await page.locator("body").click({ position: { x: 700, y: 20 } });
      await page.keyboard.press("/");
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      assert.equal(focused, "Search tasks");
    });
  }
  await ctx.close();
}

await run("light", true);
await run("dark", false);

// Smaller laptop: Overview and Brain.
{
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: "light" });
  const page = await ctx.newPage();
  watch(page, "1024");
  await step("1024 overview", async () => {
    await go(page, "/");
    await page.waitForSelector(".agent-chip");
    await shot(page, "light-overview-1024", { full: true });
  });
  await step("1024 brain", async () => {
    await go(page, "/agents/agt_ceo?tab=brain");
    await page.waitForSelector(".brain-svg [data-block]");
    await shot(page, "light-brain-1024", { full: true });
  });
  await ctx.close();
}

finished = true;
await browser.close();
if (server) await server.close();

if (errors.length) {
  console.error(`\n[e2e] ${errors.length} problem(s):`);
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`\n[e2e] all steps passed with no console errors. Screenshots: ${SHOTS}`);
process.exit(0);
