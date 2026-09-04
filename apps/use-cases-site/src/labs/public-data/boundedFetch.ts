/**
 * Bounded JSON transport shared by allowlisted public-data adapters.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 262_144;

export type PublicDataErrorCode =
  | "aborted"
  | "invalid_response"
  | "rate_limited"
  | "response_too_large"
  | "source_unavailable"
  | "timeout";

/** Safe public-data error without upstream response bodies. */
export class PublicDataImportError extends Error {
  readonly code: PublicDataErrorCode;
  readonly retryAt?: number;

  constructor(code: PublicDataErrorCode, message: string, retryAt?: number) {
    super(message);
    this.name = "PublicDataImportError";
    this.code = code;
    this.retryAt = retryAt;
  }
}

export interface BoundedFetchOptions {
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Fetch JSON with a hard timeout, byte limit, safe status mapping, and cancellation. */
export async function fetchBoundedJson(
  url: URL,
  options: BoundedFetchOptions = {},
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("public data timeout")), timeoutMs);

  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    assertResponseStatus(response);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new PublicDataImportError("response_too_large", "Public data response exceeded the safe size limit.");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new PublicDataImportError("invalid_response", "Public data source returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof PublicDataImportError) throw error;
    if (options.signal?.aborted === true) {
      throw new PublicDataImportError("aborted", "Public data import was cancelled.");
    }
    if (controller.signal.aborted) {
      throw new PublicDataImportError("timeout", "Public data source did not respond before the timeout.");
    }
    throw new PublicDataImportError("source_unavailable", "Public data source is unavailable.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function assertResponseStatus(response: Response): void {
  if (response.ok) return;
  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    throw new PublicDataImportError(
      "rate_limited",
      "Public data rate limit reached. Try again after the reset window.",
      Number.isFinite(reset) ? reset * 1_000 : undefined,
    );
  }
  throw new PublicDataImportError("source_unavailable", "Public data source is unavailable.");
}
