import { createHash } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { isFreePath, isGatedPath } from "./config.js";

/** Default short-term window for gateway-level payment proof replay protection. */
export const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;

/** Local / facilitator verify budget (ms). Settle uses a longer separate timeout. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
/**
 * Facilitator / on-chain settle wait (ms). Base congestion can take minutes —
 * do not treat HTTP abort as "payment failed" for the buyer.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 180_000; // 3 minutes

export type PaymentDedupeStatus = "pending" | "settled" | "consumed";

export interface PaymentDedupeRecord {
  status: PaymentDedupeStatus;
  expiresAt: number;
  /** Optional facilitator / demo receipt (PAYMENT-RESPONSE header value, etc.). */
  receipt?: string;
  updatedAt: number;
}

/**
 * Durable-ish payment proof store (set-if-absent / state transitions).
 * Default is in-process memory; swap for Redis by implementing this interface.
 */
export interface PaymentDedupeStore {
  get(idempotencyKey: string): PaymentDedupeRecord | undefined | Promise<PaymentDedupeRecord | undefined>;
  /**
   * Create `pending` only if absent (or expired). Returns the record after the attempt
   * and whether this caller created the pending reservation.
   */
  tryBeginPending(
    idempotencyKey: string,
  ):
    | { record: PaymentDedupeRecord; created: boolean }
    | Promise<{ record: PaymentDedupeRecord; created: boolean }>;
  /** Transition pending → settled after facilitator settle success (before upstream). */
  markSettled(
    idempotencyKey: string,
    receipt?: string,
  ): PaymentDedupeRecord | undefined | Promise<PaymentDedupeRecord | undefined>;
  /** Transition settled → consumed when upstream is about to run (anti double-proxy). */
  markConsumed(
    idempotencyKey: string,
  ): PaymentDedupeRecord | undefined | Promise<PaymentDedupeRecord | undefined>;
  /**
   * Drop a pending reservation so honest retries are not bricked after verify/settle failure.
   * No-op if status is already settled/consumed.
   */
  releasePending(idempotencyKey: string): void | Promise<void>;
}

export interface MemoryPaymentDedupeStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * In-memory LRU + TTL `PaymentDedupeStore` (single Node process).
 * Structure is Redis-ready: keys are opaque idempotency hashes.
 */
export class MemoryPaymentDedupeStore implements PaymentDedupeStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly map = new Map<string, PaymentDedupeRecord>();

  constructor(options: MemoryPaymentDedupeStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_DEDUPE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  get(idempotencyKey: string): PaymentDedupeRecord | undefined {
    this.evictExpired();
    const record = this.map.get(idempotencyKey);
    if (!record) return undefined;
    if (this.now() >= record.expiresAt) {
      this.map.delete(idempotencyKey);
      return undefined;
    }
    this.touch(idempotencyKey, record);
    return record;
  }

  tryBeginPending(idempotencyKey: string): { record: PaymentDedupeRecord; created: boolean } {
    this.evictExpired();
    const existing = this.map.get(idempotencyKey);
    if (existing && this.now() < existing.expiresAt) {
      this.touch(idempotencyKey, existing);
      return { record: existing, created: false };
    }
    const record: PaymentDedupeRecord = {
      status: "pending",
      expiresAt: this.now() + this.ttlMs,
      updatedAt: this.now(),
    };
    this.map.set(idempotencyKey, record);
    this.evictOverflow();
    return { record, created: true };
  }

  markSettled(idempotencyKey: string, receipt?: string): PaymentDedupeRecord | undefined {
    const existing = this.get(idempotencyKey);
    if (!existing) {
      const record: PaymentDedupeRecord = {
        status: "settled",
        expiresAt: this.now() + this.ttlMs,
        updatedAt: this.now(),
        ...(receipt !== undefined ? { receipt } : {}),
      };
      this.map.set(idempotencyKey, record);
      this.evictOverflow();
      return record;
    }
    if (existing.status === "consumed") return existing;
    existing.status = "settled";
    existing.updatedAt = this.now();
    existing.expiresAt = this.now() + this.ttlMs;
    if (receipt !== undefined) existing.receipt = receipt;
    this.touch(idempotencyKey, existing);
    return existing;
  }

  markConsumed(idempotencyKey: string): PaymentDedupeRecord | undefined {
    const existing = this.get(idempotencyKey);
    if (!existing) {
      const record: PaymentDedupeRecord = {
        status: "consumed",
        expiresAt: this.now() + this.ttlMs,
        updatedAt: this.now(),
      };
      this.map.set(idempotencyKey, record);
      this.evictOverflow();
      return record;
    }
    existing.status = "consumed";
    existing.updatedAt = this.now();
    existing.expiresAt = this.now() + this.ttlMs;
    this.touch(idempotencyKey, existing);
    return existing;
  }

  releasePending(idempotencyKey: string): void {
    const existing = this.map.get(idempotencyKey);
    if (!existing) return;
    if (existing.status === "pending") {
      this.map.delete(idempotencyKey);
    }
  }

  private touch(key: string, record: PaymentDedupeRecord): void {
    this.map.delete(key);
    this.map.set(key, record);
  }

  private evictExpired(): void {
    const t = this.now();
    for (const [key, record] of this.map) {
      if (record.expiresAt > t) break;
      this.map.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/**
 * @deprecated Prefer `MemoryPaymentDedupeStore`. Thin compatibility wrapper that
 * fingerprints raw PAYMENT-SIGNATURE strings.
 */
export class SignatureDedupeCache {
  private readonly store: MemoryPaymentDedupeStore;

  constructor(options: MemoryPaymentDedupeStoreOptions = {}) {
    this.store = new MemoryPaymentDedupeStore(options);
  }

  fingerprint(signature: string): string {
    return paymentIdempotencyKey(signature);
  }

  get size(): number {
    return this.store.size;
  }

  has(signature: string): boolean {
    const record = this.store.get(this.fingerprint(signature));
    return record?.status === "consumed" || record?.status === "settled";
  }

  add(signature: string): void {
    const key = this.fingerprint(signature);
    this.store.markSettled(key);
    this.store.markConsumed(key);
  }

  clear(): void {
    this.store.clear();
  }

  /** Expose underlying store for the idempotency middleware. */
  getStore(): MemoryPaymentDedupeStore {
    return this.store;
  }
}

/** Stable idempotency key from payment proof (PAYMENT-SIGNATURE header body). */
export function paymentIdempotencyKey(signature: string): string {
  return createHash("sha256").update(signature, "utf8").digest("hex");
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

/** In-process per-key mutex (cluster-less). Replace with Redis lock for multi-instance. */
export class KeyMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    let releaseCurrent!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => gate);
    this.chains.set(key, next);
    await prev;
    return () => {
      releaseCurrent();
      // Drop completed chain tip when no further waiters linked through `next`.
      void next.then(() => {
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
        }
      });
    };
  }
}

/** After a settle-timeout 202, mute further writes from a lingering facilitator callback. */
function muteResponse(res: Response): void {
  const noopSet = (() => res) as Response["setHeader"];
  res.status = (() => res) as Response["status"];
  res.json = ((body?: unknown) => {
    void body;
    return res;
  }) as Response["json"];
  res.send = ((body?: unknown) => {
    void body;
    return res;
  }) as Response["send"];
  res.end = ((..._args: unknown[]) => res) as Response["end"];
  res.write = ((..._args: unknown[]) => true) as Response["write"];
  res.setHeader = noopSet;
  if (typeof res.appendHeader === "function") {
    res.appendHeader = (() => res) as Response["appendHeader"];
  }
}

export interface PaymentSignatureDedupeOptions {
  /** @deprecated Use `store`. */
  cache?: SignatureDedupeCache;
  store?: PaymentDedupeStore;
  mutex?: KeyMutex;
  ttlMs?: number;
  maxEntries?: number;
  gatedPrefix: string;
  /**
   * Max time to wait for payment middleware to call `next()` after settle.
   * On expiry → `202 payment_pending` + `retry_with_same_proof` (settle may still confirm).
   */
  settleTimeoutMs?: number;
  /** Reserved for verify-phase budgets / docs; settle uses `settleTimeoutMs`. */
  verifyTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable timer (tests). */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}

function paymentAlreadyUsed(res: Response): void {
  res.status(409).json({
    error: "payment_already_used",
    message: "payment already used",
  });
}

function paymentPending(res: Response, settleTimeoutMs: number): void {
  res.status(202).json({
    error: "payment_pending",
    message:
      "Settlement is still in progress (facilitator / chain may be congested). Retry with the same payment proof — do not create a new payment.",
    retry_with_same_proof: true,
    settleTimeoutMs,
  });
}

/**
 * Payment proof idempotency + settle-latency guard for gated paths.
 *
 * Policy:
 * 1. Idempotency key = SHA-256(PAYMENT-SIGNATURE).
 * 2. Acquire in-process mutex for that key, then consult `PaymentDedupeStore`.
 * 3. `consumed` → 409 payment_already_used (proof already delivered upstream).
 * 4. `pending` (another request settling) → 202 payment_pending / retry_with_same_proof.
 * 5. `settled` (paid but upstream not delivered — e.g. prior HTTP timeout) → skip re-settle, proxy once, mark consumed.
 * 6. Otherwise begin `pending`, run verify+settle; **mark settled only after settle success**.
 * 7. If settle exceeds `settleTimeoutMs`, respond 202 payment_pending but leave reservation
 *    pending/settled so a retry resumes instead of charging again. Never tell the buyer the
 *    payment "failed" solely because HTTP timed out while settle may still confirm.
 * 8. Verify/settle hard failure → `releasePending` so honest retries are not bricked.
 */
export function withPaymentSignatureDedupe(
  middleware: RequestHandler,
  options: PaymentSignatureDedupeOptions,
): RequestHandler {
  const store: PaymentDedupeStore =
    options.store ??
    options.cache?.getStore() ??
    new MemoryPaymentDedupeStore({
      ttlMs: options.ttlMs,
      maxEntries: options.maxEntries,
      now: options.now,
    });
  const mutex = options.mutex ?? new KeyMutex();
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const delay = options.delay ?? defaultDelay;

  return (req, res, next) => {
    if (isFreePath(req.path) || !isGatedPath(req.path, options.gatedPrefix)) {
      return middleware(req, res, next);
    }

    const signature = readPaymentSignature(req);
    if (!signature) {
      return middleware(req, res, next);
    }

    const key = paymentIdempotencyKey(signature);

    void (async () => {
      const releaseMutex = await mutex.acquire(key);
      let mutexReleased = false;
      const releaseOnce = () => {
        if (!mutexReleased) {
          mutexReleased = true;
          releaseMutex();
        }
      };

      try {
        const existing = await store.get(key);

        if (existing?.status === "consumed") {
          releaseOnce();
          paymentAlreadyUsed(res);
          return;
        }

        if (existing?.status === "pending") {
          releaseOnce();
          paymentPending(res, settleTimeoutMs);
          return;
        }

        if (existing?.status === "settled") {
          // Paid previously; upstream not delivered (client should retry same proof).
          await store.markConsumed(key);
          releaseOnce();
          if (existing.receipt && !res.getHeader("payment-response")) {
            res.setHeader("PAYMENT-RESPONSE", existing.receipt);
          }
          next();
          return;
        }

        const began = await store.tryBeginPending(key);
        if (!began.created) {
          // Lost set-if-absent race (should be rare under mutex; still defensive).
          releaseOnce();
          if (began.record.status === "consumed") {
            paymentAlreadyUsed(res);
          } else {
            paymentPending(res, settleTimeoutMs);
          }
          return;
        }

        let settleFinished = false;
        let settleError: unknown;
        let timedOut = false;
        let paymentResponseHeader: string | undefined;
        const settleAbort = new AbortController();

        const capturePaymentResponse = () => {
          const value = res.getHeader("payment-response") ?? res.getHeader("PAYMENT-RESPONSE");
          if (typeof value === "string") paymentResponseHeader = value;
        };

        const settlePromise = new Promise<"settled" | "failed">((resolve) => {
          const afterSettle: typeof next = (err?: unknown) => {
            settleFinished = true;
            capturePaymentResponse();
            if (err != null) {
              settleError = err;
              resolve("failed");
              return;
            }
            resolve("settled");
          };

          // If middleware answers 402/4xx without calling next(), treat as failed settle path.
          const onFinish = () => {
            if (!settleFinished && !timedOut) {
              settleFinished = true;
              resolve("failed");
            }
          };
          res.once("finish", onFinish);
          res.once("close", onFinish);

          try {
            middleware(req, res, afterSettle);
          } catch (err) {
            settleFinished = true;
            settleError = err;
            resolve("failed");
          }
        });

        const timeoutPromise = delay(settleTimeoutMs, settleAbort.signal).then(
          () => "timeout" as const,
          () => "aborted" as const,
        );

        const outcome = await Promise.race([settlePromise, timeoutPromise]);
        settleAbort.abort();

        if (outcome === "aborted") {
          // Should not win the race; treat as settle path continuing.
        }

        if (outcome === "timeout") {
          timedOut = true;
          // Leave pending (or allow background settlePromise to mark settled).
          void settlePromise.then(async (result) => {
            if (result === "settled") {
              capturePaymentResponse();
              await store.markSettled(key, paymentResponseHeader);
            } else {
              await store.releasePending(key);
            }
          });
          releaseOnce();
          if (!res.headersSent) {
            paymentPending(res, settleTimeoutMs);
            muteResponse(res);
          }
          return;
        }

        if (outcome === "failed") {
          await store.releasePending(key);
          releaseOnce();
          if (settleError !== undefined) {
            next(settleError);
          }
          // Else middleware already wrote the response (e.g. 402).
          return;
        }

        // Settled successfully — durable mark, then upstream once.
        capturePaymentResponse();
        await store.markSettled(key, paymentResponseHeader);
        await store.markConsumed(key);
        releaseOnce();
        next();
      } catch (err) {
        try {
          await store.releasePending(key);
        } catch {
          // ignore store errors during unwind
        }
        releaseOnce();
        next(err);
      }
    })();
  };
}
