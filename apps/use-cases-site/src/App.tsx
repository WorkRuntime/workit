/**
 * WorkIt examples site application shell.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { SiteHeader } from "./components/SiteHeader";
import { UseCaseRail } from "./components/UseCaseRail";
import { UseCaseWorkbench } from "./components/UseCaseWorkbench";
import { defaultUseCase, useCases } from "./data/useCases";
import { ScenarioStudio } from "./labs/ScenarioStudio";
import { runLiveExample } from "./runtimeApi";
import type { ExampleRunResult, RunPhase, UseCase } from "./types";

/** Render the responsive WorkIt examples workbench. */
export default function App() {
  const [selectedId, setSelectedId] = useState(defaultUseCase.id);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [runStep, setRunStep] = useState(0);
  const [runResult, setRunResult] = useState<ExampleRunResult | null>(null);
  const runTimersRef = useRef<number[]>([]);
  const runGenerationRef = useRef(0);

  const selected = useMemo(
    () => useCases.find((useCase) => useCase.id === selectedId) ?? defaultUseCase,
    [selectedId],
  );

  function clearRunTimers() {
    for (const timer of runTimersRef.current) {
      window.clearTimeout(timer);
    }
    runTimersRef.current = [];
  }

  function selectUseCase(useCase: UseCase) {
    clearRunTimers();
    runGenerationRef.current++;
    setSelectedId(useCase.id);
    setPhase("idle");
    setRunStep(0);
    setRunResult(null);
  }

  function runScenario() {
    clearRunTimers();
    const generation = ++runGenerationRef.current;
    setPhase("running");
    setRunStep(0);
    setRunResult(null);

    runTimersRef.current = [
      window.setTimeout(() => setRunStep(1), 180),
      window.setTimeout(() => setRunStep(2), 420),
      window.setTimeout(() => setRunStep(3), 700),
      window.setTimeout(() => setRunStep(4), 920),
      window.setTimeout(() => {
        setPhase((current) => current === "running" ? "completed" : current);
        setRunStep(0);
        runTimersRef.current = [];
      }, 1_180),
    ];

    void resolveLiveRun(selected, "completed", generation);
  }

  function abortScenario() {
    clearRunTimers();
    const generation = ++runGenerationRef.current;
    setPhase("aborted");
    setRunStep(0);
    setRunResult(null);
    void resolveLiveRun(selected, "aborted", generation);
  }

  function resetScenario() {
    clearRunTimers();
    runGenerationRef.current++;
    setPhase("idle");
    setRunStep(0);
    setRunResult(null);
  }

  useEffect(() => clearRunTimers, []);

  async function resolveLiveRun(useCase: UseCase, fallbackPhase: RunPhase, generation: number) {
    const live = await runLiveExample(useCase.id);

    if (generation !== runGenerationRef.current) {
      return;
    }

    setRunResult(live ?? capturedRun(useCase, fallbackPhase));
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-zinc-950">
      <SiteHeader />
      <ScenarioStudio />
      <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          <div className="order-2 lg:order-1">
            <UseCaseRail selectedId={selectedId} onSelect={selectUseCase} />
          </div>
          <div className="order-1 min-w-0 lg:order-2">
            <UseCaseWorkbench
              selected={selected}
              phase={phase}
              runStep={runStep}
              runResult={runResult}
              onRun={runScenario}
              onAbort={abortScenario}
              onReset={resetScenario}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

function capturedRun(useCase: UseCase, phase: RunPhase): ExampleRunResult {
  return {
    source: "captured-build",
    sample: useCase.id,
    events: useCase.events[phase],
    receipt: useCase.receipt[phase],
    code: useCase.code,
  };
}
