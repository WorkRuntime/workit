/**
 * CPU worker module used by the worker offload sample.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { threadId } from "node:worker_threads";

export function fibonacci(input) {
  return {
    input,
    value: fib(input),
    threadId,
  };
}

function fib(n) {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}
