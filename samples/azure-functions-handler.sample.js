/**
 * Azure Functions-style HTTP handler sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs locally without Azure credentials while preserving the async handler
 * shape used by JavaScript and TypeScript Azure Functions.
 */

import { run } from "../dist/index.js";

export async function handler(context, request) {
  const names = request.body?.names ?? [];
  const greetings = await run.pool(3, names.map((name) => async () => `hello ${name}`));

  context.res = {
    status: 200,
    jsonBody: {
      greetings,
      count: greetings.length,
    },
  };
}

const context = {};
await handler(context, { body: { names: ["aws", "azure", "next"] } });

console.log(JSON.stringify({ sample: "azure-functions-handler", response: context.res }));
