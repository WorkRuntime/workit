/**
 * Lifecycle evidence: resource ownership helper contracts.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { run } from "../../../dist/index.js";
import { bracketShared } from "../../../dist/resources/index.js";
import { createSuite, sleep } from "../harness.mjs";

const suite = createSuite("lifecycle");

await suite.proof(
  "LIFE-006",
  "shared scope resource acquires and releases once",
  "parallel tasks using one shared helper observe one acquisition and one scope-owned release",
  async () => {
    let acquired = 0;
    let released = 0;
    const shared = bracketShared(
      async () => {
        acquired++;
        return { id: acquired };
      },
      async (resource, ctx) => {
        await sleep(5, ctx.signal);
        return resource.id;
      },
      async () => {
        released++;
      },
    );

    const values = await run.scope(async (scope) => {
      const first = scope.spawn(shared, { name: "resource.first" });
      const second = scope.spawn(shared, { name: "resource.second" });
      return await Promise.all([first, second]);
    });

    return {
      ok: values.join(":") === "1:1" && acquired === 1 && released === 1,
      values,
      acquired,
      released,
    };
  },
);

const summary = suite.summary();
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.failed > 0 ? 1 : 0);
