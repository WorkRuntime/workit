/**
 * Frozen strict-TypeScript consumer for the 0.6.0 compatibility baseline.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ContextBagImpl,
  createContextKey,
  group,
  run,
  type ContextBag,
  type TaskContext,
} from "@workit/core";
import * as activity from "@workit/core/activity";
import * as ai from "@workit/core/ai";
import * as analysis from "@workit/core/analysis";
import * as candidates from "@workit/core/candidates";
import * as channel from "@workit/core/channel";
import * as contracts from "@workit/core/contracts";
import * as diagnostics from "@workit/core/diagnostics";
import * as fault from "@workit/core/fault";
import * as ledger from "@workit/core/ledger";
import * as observability from "@workit/core/observability";
import * as otel from "@workit/core/otel";
import * as replay from "@workit/core/replay";
import * as resources from "@workit/core/resources";
import * as timePolicy from "@workit/core/time-policy";
import * as worker from "@workit/core/worker";

const RequestId = createContextKey<string>("request-id");
const initialContext: ContextBag = new ContextBagImpl().with(RequestId, "compatibility-check");

export const execute = () => group(
  async (task) => task(async (ctx: TaskContext) =>
    ctx.context.getOrThrow(RequestId), { name: "compatibility" }),
  { context: initialContext },
);

export const timeout = run.timeout;

export type PublishedModules = readonly [
  typeof activity,
  typeof ai,
  typeof analysis,
  typeof candidates,
  typeof channel,
  typeof contracts,
  typeof diagnostics,
  typeof fault,
  typeof ledger,
  typeof observability,
  typeof otel,
  typeof replay,
  typeof resources,
  typeof timePolicy,
  typeof worker,
];
