/**
 * AWS Lambda-style handler sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs locally without AWS credentials while preserving the import and handler
 * shape used by Node.js Lambda functions.
 */

import { work } from "../dist/index.js";

export async function handler(event) {
  const records = event.records ?? [];
  const output = await work(records)
    .inParallel(4)
    .onError("continue")
    .do(async (record) => ({ id: record.id, bytes: record.body.length }));

  return {
    statusCode: output.errors.length === 0 ? 200 : 207,
    body: JSON.stringify({
      processed: output.results.length,
      failed: output.errors.length,
      bytes: output.results.reduce((sum, item) => sum + item.bytes, 0),
    }),
  };
}

const response = await handler({
  records: [
    { id: "a", body: "hello" },
    { id: "b", body: "workjs" },
  ],
});

console.log(JSON.stringify({ sample: "aws-lambda-handler", response }));
