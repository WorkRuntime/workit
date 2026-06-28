/**
 * Type-level cancellation contract fixture for the WorkIt contracts subpath.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * This fixture proves compile-time composition boundaries. It intentionally
 * does not claim to prove that a task body observes `ctx.signal`.
 */

import type { TaskFn } from "../../dist/index.js";
import {
  cancellable,
  discardCancellation,
  getTaskContract,
  shielded,
  typedGroup,
  type CancellableTask,
  type ShieldedTask,
  type TypedTaskSpawner,
} from "../../dist/contracts/index.js";

const plainTask: TaskFn<string> = async () => "plain";
const ownedTask: CancellableTask<string> = cancellable(async () => "owned");
const shieldedTask: ShieldedTask<string> = shielded(async () => "shielded", { timeout: 50 });
const discardedTask: ShieldedTask<string> = discardCancellation(ownedTask, "flush_audit", { timeout: 50 });

const value: string = await typedGroup(async (spawn: TypedTaskSpawner) => {
  const owned = await spawn(ownedTask);
  const background = spawn.background(ownedTask);
  const shieldedValue = await spawn.shielded(shieldedTask);
  const discardedValue = await spawn.shielded(discardedTask);

  await background;
  return `${owned}:${shieldedValue}:${discardedValue}`;
});

if (value.length === 0) throw new Error("typed contract fixture failed");
if (getTaskContract(discardedTask)?.kind !== "shielded") throw new Error("contract metadata missing");

// @ts-expect-error plain tasks must be declared before entering a typed scope.
await typedGroup(async (spawn) => await spawn(plainTask));

// @ts-expect-error shielded tasks must use the explicit shielded spawn boundary.
await typedGroup(async (spawn) => await spawn(shieldedTask));

// @ts-expect-error cancellable tasks are not accepted by the shielded boundary.
await typedGroup(async (spawn) => await spawn.shielded(ownedTask));

// @ts-expect-error discardCancellation only accepts declared cancellable tasks.
discardCancellation(plainTask, "missing_contract", { timeout: 50 });

