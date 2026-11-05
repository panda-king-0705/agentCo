// Console build: esbuild JS API, zero extra deps.
//   node apps/web/build.mjs          one-off production build (minified)
//   node apps/web/build.mjs --watch  rebuild on change (unminified, dev React)
import * as esbuild from "esbuild";
import { copyFile, mkdir, rm, watch as fsWatch } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const watching = process.argv.includes("--watch");

async function copyStatic() {
  await mkdir(join(dist, "assets"), { recursive: true });
  await copyFile(join(root, "index.html"), join(dist, "index.html"));
  await copyFile(join(root, "src", "styles.css"), join(dist, "assets", "styles.css"));
  await copyFile(join(root, "src", "views.css"), join(dist, "assets", "views.css"));
}

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [join(root, "src", "main.tsx")],
  outfile: join(dist, "assets", "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  sourcemap: true,
  minify: !watching,
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watching ? "development" : "production") },
};

if (!watching) await rm(dist, { recursive: true, force: true });
await copyStatic();

if (watching) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[web] watching src/ for changes");
  for (const file of ["index.html", join("src", "styles.css"), join("src", "views.css")]) {
    (async () => {
      for await (const _ of fsWatch(join(root, file))) {
        await copyStatic().catch((err) => console.error("[web] copy failed", err));
        console.log(`[web] copied ${file}`);
      }
    })();
  }
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  const out = result.metafile.outputs[Object.keys(result.metafile.outputs).find((k) => k.endsWith("app.js"))];
  console.log(`[web] built dist/assets/app.js (${Math.round((out?.bytes ?? 0) / 1024)} kB)`);
}
