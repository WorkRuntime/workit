/**
 * Start Vite and the local WorkIt Node runtime together.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const children = [];

await runBuild();

start("runtime", process.execPath, ["server/runtime-server.mjs"]);
if (process.platform === "win32") {
  start("vite", "cmd.exe", ["/d", "/s", "/c", "npm run dev:vite -- --host 127.0.0.1 --port 4175"]);
} else {
  start("vite", npmBin, ["run", "dev:vite", "--", "--host", "127.0.0.1", "--port", "4175"]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of children) {
      child.kill(signal);
    }
  });
}

await Promise.race(children.map((child) => once(child, "exit")));

for (const child of children) {
  if (!child.killed) child.kill();
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "cmd.exe" : npmBin, process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run build"]
      : ["run", "build"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Root build failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: siteRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      process.stderr.write(`${name} exited with code ${code}\n`);
    }
  });

  children.push(child);
}
