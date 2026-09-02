import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { isFreePath, isGatedPath } from "./config.js";

/** Default short-term window for gateway-level PAYMENT-SIGNATURE replay protection. */
export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;

export interface SignatureDedupeCacheOptions {
  /** How long a settled signature fingerprint is remembered (ms). */
  ttlMs?: number;
  /** Hard cap on remembered fingerprints (LRU eviction). */
  maxEntries?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * In-memory LRU + TTL map of payment-signature fingerprints.
 *
 * Defense-in-depth only: CDP x402 `exact` + EIP-3009 authorizations are
 * single-use at the facilitator (nonce). This cache blocks duplicate HTTP
 * retries of the same PAYMENT-SIGNATURE string within a short window.
 * No Redis — keep gateway deps thin.
 */
export class SignatureDedupeCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** fingerprint → expiresAtMs (Map insertion order = LRU). */
  private readonly map = new Map<string, number>();

  constructor(options: SignatureDedupeCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Stable fingerprint so large EIP-3009 payloads stay memory-bounded. */
  fingerprint(signature: string): string {
    return createHash("sha256").update(signature, "utf8").digest("hex");
  }

  get size(): number {
    return this.map.size;
  }

  has(signature: string): boolean {
    this.evictExpired();
    const key = this.fingerprint(signature);
    const expiresAt = this.map.get(key);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.map.delete(key);
      return false;
    }
    // Touch for LRU: move to newest.
    this.map.delete(key);
    this.map.set(key, expiresAt);
    return true;
  }

  add(signature: string): void {
    const key = this.fingerprint(signature);
    this.map.delete(key);
    this.map.set(key, this.now() + this.ttlMs);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [key, expiresAt] of this.map) {
      if (expiresAt > t) break; // Map is roughly oldest-first; stop early
      this.map.delete(key);
    }
  }
}

export function readPaymentSignature(
  req: { header(name: string): string | undefined },
): string {
  return (
    req.header("payment-signature") ??
    req.header("PAYMENT-SIGNATURE") ??
    ""
  ).trim();
}

export interface PaymentSignatureDedupeOptions {
  cache?: SignatureDedupeCache;
  ttlMs?: number;
  maxEntries?: number;
  gatedPrefix: string;
}

/**
 * Reject replayed PAYMENT-SIGNATURE on gated paths (`400 {error:"payment_replay"}`).
 * After a successful settle (middleware calls `next()`), record the fingerprint.
 */
export function withPaymentSignatureDedupe(
  middleware: RequestHandler,
  options: PaymentSignatureDedupeOptions,
): RequestHandler {
  const cache =
    options.cache ??
    new SignatureDedupeCache({
      ttlMs: options.ttlMs,
      maxEntries: options.maxEntries,
    });

  return (req, res, next) => {
    if (isFreePath(req.path) || !isGatedPath(req.path, options.gatedPrefix)) {
      return middleware(req, res, next);
    }

    const signature = readPaymentSignature(req);
    if (signature && cache.has(signature)) {
      // Ops-clearable JSON (not a protocol PAYMENT-REQUIRED shape) → 400.
      res.status(400).json({ error: "payment_replay" });
      return;
    }

    const afterSettle: typeof next = (err?: unknown) => {
      // Successful settle path calls next() with no error before upstream.
      if (err == null && signature) {
        cache.add(signature);
      }
      if (err !== undefined) {
        next(err);
      } else {
        next();
      }
    };

    return middleware(req, res, afterSettle);
  };
}
