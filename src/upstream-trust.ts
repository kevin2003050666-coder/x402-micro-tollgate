import { createHmac, timingSafeEqual } from "node:crypto";

/** Headers injected only after successful x402 payment verification / settle. */
export const TOLLGATE_SECRET_HEADER = "x-tollgate-secret";
export const TOLLGATE_PAID_HEADER = "x-tollgate-paid";
export const TOLLGATE_TIMESTAMP_HEADER = "x-tollgate-timestamp";

/** Client-supplied trust headers must be stripped before injection (anti-spoof). */
export const TOLLGATE_TRUST_HEADERS = [
  TOLLGATE_SECRET_HEADER,
  TOLLGATE_PAID_HEADER,
  TOLLGATE_TIMESTAMP_HEADER,
  "X-Tollgate-Secret",
  "X-Tollgate-Paid",
  "X-Tollgate-Timestamp",
] as const;

export interface UpstreamTrustMaterial {
  /** Raw shared secret (also sent as X-Tollgate-Secret for simple upstream checks). */
  secret: string;
  /** Unix ms timestamp used in the HMAC payload. */
  timestamp: string;
  /** hex(HMAC-SHA256(secret, `${timestamp}.${method}.${path}`)) */
  paidHmac: string;
}

/**
 * Build zero-trust stub headers for seller upstreams that only trust the tollgate.
 * Not mTLS — shared-secret + HMAC MVP. Upstream must require these and reject public direct hits.
 */
export function buildUpstreamTrustHeaders(
  secret: string,
  req: { method: string; path: string },
  nowMs: number = Date.now(),
): UpstreamTrustMaterial & { headers: Record<string, string> } {
  const timestamp = String(nowMs);
  const method = req.method.toUpperCase();
  const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
  const paidHmac = createHmac("sha256", secret)
    .update(`${timestamp}.${method}.${path}`, "utf8")
    .digest("hex");

  return {
    secret,
    timestamp,
    paidHmac,
    headers: {
      "X-Tollgate-Secret": secret,
      "X-Tollgate-Paid": paidHmac,
      "X-Tollgate-Timestamp": timestamp,
    },
  };
}

/** Optional helper for Express upstreams — verify HMAC (and optional raw secret). */
export function verifyUpstreamTrustHeaders(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  req: { method: string; path: string },
  options: { maxSkewMs?: number; nowMs?: number } = {},
): { ok: true } | { ok: false; reason: string } {
  const maxSkewMs = options.maxSkewMs ?? 5 * 60 * 1000;
  const nowMs = options.nowMs ?? Date.now();

  const read = (name: string): string => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) {
        return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
      }
    }
    return "";
  };

  const gotSecret = read(TOLLGATE_SECRET_HEADER);
  const gotPaid = read(TOLLGATE_PAID_HEADER);
  const gotTs = read(TOLLGATE_TIMESTAMP_HEADER);

  if (!gotSecret || !gotPaid || !gotTs) {
    return { ok: false, reason: "missing_tollgate_headers" };
  }
  if (!timingSafeStringEqual(gotSecret, secret)) {
    return { ok: false, reason: "bad_secret" };
  }
  const ts = Number(gotTs);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxSkewMs) {
    return { ok: false, reason: "bad_timestamp" };
  }
  const expected = buildUpstreamTrustHeaders(secret, req, ts).paidHmac;
  if (!timingSafeStringEqual(gotPaid, expected)) {
    return { ok: false, reason: "bad_hmac" };
  }
  return { ok: true };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
