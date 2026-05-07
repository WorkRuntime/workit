/**
 * Next.js server route-style sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs locally without a Next.js dependency while preserving the App Router
 * `POST(request)` shape used by server routes and actions.
 */

import { run } from "../dist/index.js";

export async function POST(request) {
  const payload = await request.json();
  const winner = await run.race([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "slow-provider";
    },
    async () => "fast-provider",
  ]);

  return Response.json({
    query: payload.query,
    provider: winner,
  });
}

const response = await POST(new Request("https://workjs.local/search", {
  method: "POST",
  body: JSON.stringify({ query: "structured concurrency" }),
}));

console.log(JSON.stringify({ sample: "next-server-route", response: await response.json() }));
