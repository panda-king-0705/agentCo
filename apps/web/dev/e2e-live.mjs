// Smoke run against the REAL server (E2E_BASE_URL required): every route, a Boardroom message, then
// screenshots of Overview, the new trace and the CEO's Brain tab while it works. Fails on console errors.
import { launchOptions, loadPlaywright, shotsDir } from "./browser.mjs";
const { chromium } = loadPlaywright();
const base = process.env.E2E_BASE_URL;
if (!base) throw new Error("set E2E_BASE_URL");
const SHOTS = await shotsDir();
const browser = await chromium.launch(launchOptions());
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" })).newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 300)));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
const go = (h) => page.goto(`${base}/#${h}`);
const shot = async (n, full) => { await page.waitForTimeout(400); await page.evaluate(() => { const t = document.querySelector(".toasts"); if (t) t.style.display = "none"; }); await page.screenshot({ path: `${SHOTS}/real-${n}.png`, fullPage: !!full }); };
const org = await (await fetch(`${base}/api/org`)).json();
const CEO = org.agents.find((a) => a.roleId === "ceo").id;
for (const r of ["/", "/org", "/chat", "/traces", "/tasks", "/approvals", "/costs", "/memory", `/agents/${CEO}`, `/agents/${CEO}?tab=brain`]) {
  await go(r); await page.waitForTimeout(700);
  const txt = await page.locator("main").innerText();
  console.log(r, "->", txt.replace(/\s+/g, " ").slice(0, 70));
}
await go("/chat");
await page.waitForSelector(".conv");
await page.locator(".conv", { hasText: "Boardroom" }).click();
await page.locator(".composer textarea").fill("Plan the launch of our first product");
await page.keyboard.press("Enter");
await page.waitForSelector(".msg.mine");
console.log("sent");
await page.waitForTimeout(2500);
await go("/"); await page.waitForSelector(".agent-chip"); await shot("overview", true);
await go(`/agents/${CEO}?tab=brain`); await page.waitForSelector(".brain-svg [data-block]");
await page.waitForTimeout(3000); await shot("brain", true);
console.log("active:", await page.locator('.brain-svg [data-active="true"]').count(), "visited:", await page.locator(".brain-svg [data-visited]").count());
await go("/traces"); await page.waitForTimeout(1500);
const rows = page.locator('[data-testid="trace-table"] tbody tr');
console.log("traces:", await rows.count());
if (await rows.count()) { await rows.first().click(); await page.waitForSelector(".wf-row"); console.log("spans:", await page.locator(".wf-row").count()); await page.locator(".wf-row").nth(3).click(); await shot("trace", true); }
await go("/chat"); await page.waitForTimeout(8000); await shot("chat");
await browser.close();
console.log(errors.length ? "PROBLEMS:\n" + [...new Set(errors)].join("\n") : "no console errors");
process.exit(errors.length ? 1 : 0);
