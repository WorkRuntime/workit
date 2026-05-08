/**
 * Bench 02 -- Promise.race vs run.race.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Workload: 3 provider calls. Anthropic at 10ms, OpenAI at 50ms, Gemini at 80ms.
 *
 * Native Promise.race: resolves with Anthropic at 10ms; OpenAI and Gemini
 * keep running and ARE STILL BILLING.
 *
 * run.race: resolves with Anthropic at 10ms and cancels OpenAI + Gemini at
 * the AbortSignal boundary so the underlying fetch can abort.
 */

import assert from "node:assert/strict";
import { CancellationError, run } from "../../dist/index.js";
import { makeClock, makeProbe, naiveSleep, sleep, jsonReplacer } from "./lib/baselines.mjs";

const result = { bench: "02-run-race-vs-promise-race", native: null, workit: null };

// --- Native Promise.race ------------------------------------------------
{
  const clock = makeClock();
  const probes = { openai: makeProbe("openai"), anthropic: makeProbe("anthropic"), gemini: makeProbe("gemini") };

  const make = (name, ms) => (async () => {
    probes[name].startedAt = clock.t();
    await naiveSleep(ms);
    probes[name].settledAt = clock.t();
    probes[name].settledAs = "fulfilled";
    return { provider: name };
  })();

  const winner = await Promise.race([make("openai", 50), make("anthropic", 10), make("gemini", 80)]);
  const winnerSettledAt = clock.t();

  await naiveSleep(120);   // let the "ghosts" settle

  result.native = {
    winner: winner.provider,
    winnerSettledAt,
    probes,
    losersStillRanForMs: {
      openai: probes.openai.settledAt - winnerSettledAt,
      gemini: probes.gemini.settledAt - winnerSettledAt,
    },
    losersWereCancelled: false,
  };
}

// --- WorkIt run.race ----------------------------------------------------
{
  const clock = makeClock();
  const probes = { openai: makeProbe("openai"), anthropic: makeProbe("anthropic"), gemini: makeProbe("gemini") };

  const make = (name, ms) => async (ctx) => {
    probes[name].startedAt = clock.t();
    ctx.defer(() => { probes[name].deferRanAt = clock.t(); });
    ctx.signal.addEventListener("abort", () => { probes[name].signalAbortedAt = clock.t(); }, { once: true });
    try {
      await sleep(ms, ctx.signal);
      probes[name].settledAt = clock.t();
      probes[name].settledAs = "fulfilled";
      return { provider: name };
    } catch (err) {
      probes[name].settledAt = clock.t();
      probes[name].settledAs = err instanceof CancellationError ? "cancelled" : "rejected";
      probes[name].cancelReasonKind = err instanceof CancellationError ? err.reason.kind : null;
      throw err;
    }
  };

  const winner = await run.race([make("openai", 50), make("anthropic", 10), make("gemini", 80)]);
  const winnerSettledAt = clock.t();

  result.workit = {
    winner: winner.provider,
    winnerSettledAt,
    probes,
    losersWereCancelled: probes.openai.settledAs === "cancelled" && probes.gemini.settledAs === "cancelled",
    cancelReasonKindForLosers: {
      openai: probes.openai.cancelReasonKind ?? null,
      gemini: probes.gemini.cancelReasonKind ?? null,
    },
  };

  assert.equal(winner.provider, "anthropic");
  assert.equal(probes.openai.settledAs, "cancelled");
  assert.equal(probes.gemini.settledAs, "cancelled");
  assert.equal(probes.openai.cancelReasonKind, "race_lost");
  assert.equal(probes.gemini.cancelReasonKind, "race_lost");
}

process.stdout.write(JSON.stringify(result, jsonReplacer, 2) + "\n");
