/**
 * Boot: .env → config → model config → engines → createApp → listen.
 *   node --disable-warning=ExperimentalWarning apps/server/src/index.ts
 */
import { createApp } from "./app.ts";
import { createEngines } from "./cognition/index.ts";
import { ConfigError, loadConfig, loadDotEnv } from "./config.ts";
import { loadModelConfig, modelsInfo } from "./models/config.ts";
import { createModelRouter } from "./models/router.ts";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const modelConfig = loadModelConfig(process.env);
  const app = await createApp(config, {
    engines: createEngines({ reflexMaxSteps: config.reflexMaxSteps, brainMaxRevisions: config.brainMaxRevisions }),
    createRouter: (deps) => createModelRouter({ ...deps, config: modelConfig }),
    modelsInfo: () => modelsInfo(modelConfig),
  });
  const url = await app.listen();
  const info = app.platform.modelsInfo();
  const { bootstrapResult: boot } = app.platform;
  console.log(`AgentCo "${app.platform.company.settings().name}" listening on ${url}`);
  console.log(`  org: ${boot?.created ? `bootstrapped ${boot.agents} agents in ${boot.departments} departments` : `${app.platform.repos.agents.countActive()} agents`} · models: ${info.live ? "LIVE" : "MOCK (offline, deterministic)"}`);
  if (config.authRequired) console.log("  auth: bearer token required (APP_AUTH_TOKEN)");

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down (running work resumes on the next boot)`);
    app.close().then(
      () => process.exit(0),
      (error) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
