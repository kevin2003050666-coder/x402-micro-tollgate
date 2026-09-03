/**
 * Three-dimensional buyer-side circuit breaker for createX402Fetch.
 *
 * Inspected BEFORE budget checks / EIP-3009 signing on HTTP 402 pay paths:
 * 1. Rate — max paid 402s per rolling 60s window
 * 2. Minute spend — max USDC paid in rolling 60s
 * 3. Fingerprint dead-loop — same sanitized request fingerprint ≥2 prior times
 */

import { createHash } from "node:crypto";

/** Rolling window for rate / spend / fingerprint (ms). */
export const CIRCUIT_BREAKER_WINDOW_MS = 60_000;

/** Default max paid 402s in the rolling window (N_max). */
export const DEFAULT_MAX_PAID_REQUESTS_PER_MINUTE = 10;

/** Default max USDC paid in the rolling window (S_max). */
export const DEFAULT_MAX_SPEND_USDC_PER_MINUTE = 0.05;

/** Truncate non-JSON / oversized body strings before hashing. */
export const FINGERPRINT_BODY_MAX_CHARS = 4096;

/**
 * Keys stripped from JSON bodies before fingerprinting (case-insensitive).
 * Covers uuid / timestamp / Date.now patterns / nonce / requestId / random.
 */
const DYNAMIC_KEY_RE =
  /^(uuids?|timestamps?|nonce|request[_-]?ids?|randoms?|date[_.]?now|datenow|ts)$/i;

export type CircuitBreakerLimits = {
  maxPaidRequestsPerMinute: number;
  maxSpendUsdcPerMinute: number;
  enableFingerprintBreaker: boolean;
};

export type CircuitBreakerEvent = {
  at: number;
  fingerprint: string;
  amountUsdc: number;
};

export type CircuitBreaker = {
  events: CircuitBreakerEvent[];
  readonly limits: CircuitBreakerLimits;
  readonly windowMs: number;
};

export type CircuitBreakerConfig = Partial<CircuitBreakerLimits> & {
  windowMs?: number;
};

export function createCircuitBreaker(
  config: CircuitBreakerConfig = {},
): CircuitBreaker {
  const maxPaidRequestsPerMinute =
    config.maxPaidRequestsPerMinute ?? DEFAULT_MAX_PAID_REQUESTS_PER_MINUTE;
  const maxSpendUsdcPerMinute =
    config.maxSpendUsdcPerMinute ?? DEFAULT_MAX_SPEND_USDC_PER_MINUTE;
  const enableFingerprintBreaker = config.enableFingerprintBreaker ?? true;
  const windowMs = config.windowMs ?? CIRCUIT_BREAKER_WINDOW_MS;

  if (
    !(maxPaidRequestsPerMinute > 0) ||
    !Number.isFinite(maxPaidRequestsPerMinute) ||
    !Number.isInteger(maxPaidRequestsPerMinute)
  ) {
    throw new Error("maxPaidRequestsPerMinute must be a positive integer");
  }
  if (!(maxSpendUsdcPerMinute > 0) || !Number.isFinite(maxSpendUsdcPerMinute)) {
    throw new Error("maxSpendUsdcPerMinute must be a finite number > 0");
  }
  if (!(windowMs > 0) || !Number.isFinite(windowMs)) {
    throw new Error("windowMs must be a finite number > 0");
  }

  return {
    events: [],
    windowMs,
    limits: {
      maxPaidRequestsPerMinute,
      maxSpendUsdcPerMinute,
      enableFingerprintBreaker,
    },
  };
}

/** Drop events older than the rolling window. */
export function pruneCircuitBreaker(
  breaker: CircuitBreaker,
  now = Date.now(),
): void {
  const cutoff = now - breaker.windowMs;
  if (breaker.events.length === 0) return;
  if (breaker.events[0]!.at >= cutoff) return;
  breaker.events = breaker.events.filter((e) => e.at >= cutoff);
}

/**
 * Recursively strip dynamic keys from JSON-compatible values.
 * Used so fingerprints ignore uuid / timestamp / nonce churn.
 */
export function stripDynamicKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDynamicKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (DYNAMIC_KEY_RE.test(key)) continue;
      out[key] = stripDynamicKeys(child);
    }
    return out;
  }
  return value;
}

/**
 * Sanitize a request body for fingerprinting:
 * - JSON: parse → strip dynamic keys → stable stringify
 * - non-JSON: raw string truncated to FINGERPRINT_BODY_MAX_CHARS
 */
export function sanitizeBodyForFingerprint(body: string): string {
  const raw = body.length > FINGERPRINT_BODY_MAX_CHARS
    ? body.slice(0, FINGERPRINT_BODY_MAX_CHARS)
    : body;
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(stripDynamicKeys(parsed));
  } catch {
    return raw;
  }
}

/** SHA-256 hex of method + url + sanitized body. */
export function fingerprintRequest(
  method: string,
  url: string,
  body: string,
): string {
  const sanitized = sanitizeBodyForFingerprint(body);
  const material = `${method.toUpperCase()}\n${url}\n${sanitized}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Convert fetch body init to a string for fingerprinting.
 * Best-effort: strings / URLSearchParams / buffers; otherwise empty.
 */
export async function bodyInitToString(
  body: BodyInit | null | undefined,
): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body as ArrayBufferView);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.text();
  }
  // FormData / ReadableStream — not stably stringifiable for fingerprint
  return "";
}

/** Resolve method / url / body text from fetch arguments. */
export async function resolveRequestParts(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ method: string; url: string; bodyText: string }> {
  const method = (
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.method
      : "GET")
  ).toUpperCase();

  let url: string;
  if (typeof input === "string") {
    url = input;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    url = input.url;
  }

  let bodyText = "";
  if (init?.body != null) {
    bodyText = await bodyInitToString(init.body);
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    try {
      bodyText = await input.clone().text();
    } catch {
      bodyText = "";
    }
  }

  return { method, url, bodyText };
}

/**
 * Enforce the three circuit dimensions before signing a 402 payment.
 * @throws Error with a `CIRCUIT_BREAKER:` prefix when halted
 */
export function assertCircuitAllowsPayment(
  breaker: CircuitBreaker,
  fingerprint: string,
  amountUsdc: number,
  now = Date.now(),
): void {
  pruneCircuitBreaker(breaker, now);
  const { limits, events, windowMs } = breaker;
  const windowSec = Math.round(windowMs / 1000);

  // 1. Rate — max paid 402s in rolling window
  if (events.length >= limits.maxPaidRequestsPerMinute) {
    throw new Error(
      `CIRCUIT_BREAKER: Rate limit — ${events.length} paid 402s in rolling ${windowSec}s (max ${limits.maxPaidRequestsPerMinute})`,
    );
  }

  // 2. Minute spend — max USDC in rolling window
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) {
    throw new Error(`CIRCUIT_BREAKER: invalid payment amount USDC: ${amountUsdc}`);
  }
  const spentInWindow = events.reduce((sum, e) => sum + e.amountUsdc, 0);
  const nextSpend = spentInWindow + amountUsdc;
  if (nextSpend > limits.maxSpendUsdcPerMinute) {
    throw new Error(
      `CIRCUIT_BREAKER: Minute spend — would pay ${formatUsdc(nextSpend)} USDC in rolling ${windowSec}s (max ${formatUsdc(limits.maxSpendUsdcPerMinute)}; already ${formatUsdc(spentInWindow)})`,
    );
  }

  // 3. Fingerprint dead-loop — same fingerprint ≥2 prior times
  if (limits.enableFingerprintBreaker) {
    const prior = events.filter((e) => e.fingerprint === fingerprint).length;
    if (prior >= 2) {
      throw new Error(
        `CIRCUIT_BREAKER: Dead loop — fingerprint ${fingerprint.slice(0, 16)}… appeared ${prior} prior times in rolling ${windowSec}s`,
      );
    }
  }
}

/** Record a successfully signed paid 402 into the rolling window. */
export function recordCircuitPayment(
  breaker: CircuitBreaker,
  fingerprint: string,
  amountUsdc: number,
  now = Date.now(),
): void {
  pruneCircuitBreaker(breaker, now);
  breaker.events.push({ at: now, fingerprint, amountUsdc });
}

function formatUsdc(n: number): string {
  return Number(n.toFixed(6)).toString();
}
