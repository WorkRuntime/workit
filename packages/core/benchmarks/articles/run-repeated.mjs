/**
 * benchmarks/articles/run-repeated.mjs -- runs article benches repeatedly and
 * emits raw runs plus summary statistics.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single-pass runner proves semantic invariants. This runner preserves the
 * same invariant checks while collecting timing distributions for publication
 * figures. It intentionally has no external dependencies.
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const files = (await listBenchFiles(args.filter)).sort();

if (files.length === 0) {
  throw new Error(`No benchmark files matched filter ${String(args.filter ?? "<none>")}`);
}

const summary = {
  author: "Admilson B. F. Cossa",
  spdxLicense: "Apache-2.0",
  artifact: "workit-article-benchmark-repeated-run",
  runCount: args.runs,
  filter: args.filter ?? null,
  startedAt: new Date().toISOString(),
  benches: [],
};

for (const file of files) {
  const runs = [];
  for (let iteration = 1; iteration <= args.runs; iteration++) {
    const run = await runBench(file, iteration);
    runs.push(run);
    if (run.exitCode !== 0) {
      process.stderr.write(
        `FAIL ${file} iteration ${iteration} (exit ${run.exitCode})\n${run.stderr ?? ""}\n`,
      );
    }
  }

  summary.benches.push({
    file,
    runs,
    stats: summarizeRuns(runs),
  });
}

summary.finishedAt = new Date().toISOString();
summary.passed = summary.benches.reduce(
  (count, bench) => count + bench.runs.filter((run) => run.exitCode === 0).length,
  0,
);
summary.failed = summary.benches.reduce(
  (count, bench) => count + bench.runs.filter((run) => run.exitCode !== 0).length,
  0,
);

const text = JSON.stringify(summary, null, 2) + "\n";
if (args.out !== undefined) {
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, text);
} else {
  process.stdout.write(text);
}

process.exit(summary.failed > 0 ? 1 : 0);

function parseArgs(argv) {
  const parsed = {
    runs: 30,
    filter: undefined,
    out: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runs") {
      parsed.runs = parsePositiveInteger(readValue(argv, ++i, arg), arg);
    } else if (arg.startsWith("--runs=")) {
      parsed.runs = parsePositiveInteger(arg.slice("--runs=".length), "--runs");
    } else if (arg === "--filter") {
      parsed.filter = readValue(argv, ++i, arg);
    } else if (arg.startsWith("--filter=")) {
      parsed.filter = arg.slice("--filter=".length);
    } else if (arg === "--out") {
      parsed.out = path.resolve(readValue(argv, ++i, arg));
    } else if (arg.startsWith("--out=")) {
      parsed.out = path.resolve(arg.slice("--out=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`${flag} must be a positive integer`);
  }
  return n;
}

function printHelp() {
  process.stdout.write(`Usage: node benchmarks/articles/run-repeated.mjs [options]

Options:
  --runs N       Number of runs per benchmark (default: 30)
  --filter TEXT  Run only benchmark filenames containing TEXT
  --out PATH     Write JSON output to PATH instead of stdout
  -h, --help     Show this help
`);
}

async function listBenchFiles(filter) {
  const files = await readdir(here);
  return files.filter((file) => {
    if (!/^\d{2}-.*\.mjs$/.test(file)) return false;
    return filter === undefined || file.includes(filter);
  });
}

async function runBench(file, iteration) {
  const t0 = Date.now();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
  const wallMs = Date.now() - t0;

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(out.stdout);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  return {
    iteration,
    exitCode: out.code,
    wallMs,
    stderr: out.stderr.trim() || null,
    parseError,
    report: parsed,
  };
}

function summarizeRuns(runs) {
  const numeric = new Map();
  addMetric(numeric, "wallMs", runs.map((run) => run.wallMs));

  for (const run of runs) {
    if (run.report !== null) {
      flattenNumbers(run.report, "report", numeric);
    }
  }

  const metrics = {};
  for (const [name, values] of numeric) {
    if (values.length === 0) continue;
    metrics[name] = summarize(values);
  }

  return {
    attempts: runs.length,
    passed: runs.filter((run) => run.exitCode === 0).length,
    failed: runs.filter((run) => run.exitCode !== 0).length,
    parseFailures: runs.filter((run) => run.parseError !== null).length,
    metrics,
  };
}

function addMetric(metrics, name, values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return;
  const existing = metrics.get(name) ?? [];
  existing.push(...finite);
  metrics.set(name, existing);
}

function flattenNumbers(value, prefix, metrics) {
  if (typeof value === "number") {
    addMetric(metrics, prefix, [value]);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      flattenNumbers(value[i], `${prefix}[${i}]`, metrics);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    flattenNumbers(child, `${prefix}.${key}`, metrics);
  }
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const q1 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const q3 = percentile(sorted, 0.75);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    count: sorted.length,
    min,
    q1,
    median,
    q3,
    iqr: q3 - q1,
    max,
    mean,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  const weight = index - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

