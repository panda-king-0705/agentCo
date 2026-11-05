#!/usr/bin/env node
// Dev runner (no dependencies): rebuilds the console on change and restarts the server on change.
//   npm run dev            → console watch build + server on http://127.0.0.1:3000
// Environment (.env, PORT, DATA_DIR, ...) is passed through to the server unchanged.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let stopping = false;

function start(name, args, color) {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) out.write(tag + line + "\n");
    });
    stream.on("end", () => pending && out.write(tag + pending + "\n"));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${tag}exited (${signal ?? code}); stopping the dev runner`);
    stop(code ?? 1);
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start("web", ["apps/web/build.mjs", "--watch"], "36");
start("server", ["--disable-warning=ExperimentalWarning", "--watch-path=apps/server/src", "--watch", "apps/server/src/index.ts"], "35");
