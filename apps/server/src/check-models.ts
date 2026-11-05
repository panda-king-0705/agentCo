/**
 * npm run check:models [-- --fallbacks]
 * One tiny real call (max_tokens 16) per configured live tier; see models/check.ts.
 * Reads .env like the server; real environment variables win.
 */
import { loadDotEnv } from "./config.ts";
import { checkModels } from "./models/check.ts";

loadDotEnv();
const report = await checkModels(process.env, { includeFallbacks: process.argv.includes("--fallbacks") });
process.exitCode = report.exitCode;
