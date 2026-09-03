import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";
import {
  createX402Fetch,
  createCircuitBreaker,
  assertCircuitAllowsPayment,
  recordCircuitPayment,
  fingerprintRequest,
  sanitizeBodyForFingerprint,
  stripDynamicKeys,
  DEFAULT_MAX_PAID_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_SPEND_USDC_PER_MINUTE,
} from "../src/client/index.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1234567890123456789012345678901234567890";

function paymentRequiredHeader(amountAtomic: string): string {
  const paymentRequired = {
    x402Version: 2 as const,
    error: "Payment required",
    resource: {
      url: "https://example.test/v1/quote",
      description: "test",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453" as const,
        amount: amountAtomic,
        asset: USDC_BASE,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD Coin",
          version: "2",
          decimals: 6,
        },
      },
    ],
  };
  return encodePaymentRequiredHeader(
    paymentRequired as unknown as Parameters<typeof encodePaymentRequiredHeader>[0],
  );
}

function mock402Response(amountAtomic: string): Response {
  return new Response(JSON.stringify({ error: "Payment required", price: "$0.01" }), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": paymentRequiredHeader(amountAtomic),
    },
  });
}

/** Affordable paid path: 402 once, then 200 with PAYMENT-SIGNATURE. */
function affordablePaidFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const hasSig =
      req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("payment-signature");
    if (!hasSig) {
      return mock402Response("10000"); // 0.01 USDC
    }
    return new Response(JSON.stringify({ paid: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({ success: true }),
          "utf8",
        ).toString("base64"),
      },
    });
  };
}

describe("circuit breaker sanitize / fingerprint", () => {
  it("stripDynamicKeys removes uuid / timestamp / nonce / requestId / random", () => {
    const cleaned = stripDynamicKeys({
      query: "weather",
      uuid: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: 1710000000000,
      dateNow: Date.now(),
      nonce: "abc",
      requestId: "req-1",
      request_id: "req-2",
      random: 0.42,
      nested: { uuid: "x", keep: true },
    }) as Record<string, unknown>;

    assert.equal(cleaned.query, "weather");
    assert.equal(cleaned.nested && (cleaned.nested as { keep: boolean }).keep, true);
    assert.equal("uuid" in cleaned, false);
    assert.equal("timestamp" in cleaned, false);
    assert.equal("dateNow" in cleaned, false);
    assert.equal("nonce" in cleaned, false);
    assert.equal("requestId" in cleaned, false);
    assert.equal("request_id" in cleaned, false);
    assert.equal("random" in cleaned, false);
    assert.equal(
      "uuid" in (cleaned.nested as Record<string, unknown>),
      false,
    );
  });

  it("sanitizeBodyForFingerprint strips uuid/timestamp from JSON; truncates non-JSON", () => {
    const a = sanitizeBodyForFingerprint(
      JSON.stringify({
        action: "pay",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        timestamp: 1,
      }),
    );
    const b = sanitizeBodyForFingerprint(
      JSON.stringify({
        action: "pay",
        uuid: "00000000-0000-0000-0000-000000000000",
        timestamp: 999,
      }),
    );
    assert.equal(a, b);
    assert.equal(a, JSON.stringify({ action: "pay" }));

    const raw = "not-json-" + "x".repeat(5000);
    const sanitized = sanitizeBodyForFingerprint(raw);
    assert.ok(sanitized.length <= 4096);
    assert.ok(sanitized.startsWith("not-json-"));
  });

  it("fingerprint ignores dynamic JSON keys", () => {
    const fp1 = fingerprintRequest(
      "POST",
      "https://example.test/v1/quote",
      JSON.stringify({ q: "hi", uuid: "a", timestamp: 1 }),
    );
    const fp2 = fingerprintRequest(
      "POST",
      "https://example.test/v1/quote",
      JSON.stringify({ q: "hi", uuid: "b", timestamp: 2 }),
    );
    assert.equal(fp1, fp2);
    assert.notEqual(
      fp1,
      fingerprintRequest("GET", "https://example.test/v1/quote", JSON.stringify({ q: "hi" })),
    );
  });
});

describe("circuit breaker unit HALT paths", () => {
  it("defaults match N_max=10 and S_max=0.05", () => {
    const breaker = createCircuitBreaker();
    assert.equal(
      breaker.limits.maxPaidRequestsPerMinute,
      DEFAULT_MAX_PAID_REQUESTS_PER_MINUTE,
    );
    assert.equal(
      breaker.limits.maxSpendUsdcPerMinute,
      DEFAULT_MAX_SPEND_USDC_PER_MINUTE,
    );
    assert.equal(breaker.limits.enableFingerprintBreaker, true);
  });

  it("HALT rate: max paid 402s per rolling window", () => {
    const breaker = createCircuitBreaker({ maxPaidRequestsPerMinute: 2 });
    const fpA = fingerprintRequest("GET", "https://a.test/1", "");
    const fpB = fingerprintRequest("GET", "https://a.test/2", "");
    recordCircuitPayment(breaker, fpA, 0.001, 1000);
    recordCircuitPayment(breaker, fpB, 0.001, 1001);
    assert.throws(
      () => assertCircuitAllowsPayment(breaker, fingerprintRequest("GET", "https://a.test/3", ""), 0.001, 1002),
      /CIRCUIT_BREAKER: Rate limit/,
    );
  });

  it("HALT minute spend: max USDC in rolling window", () => {
    const breaker = createCircuitBreaker({
      maxPaidRequestsPerMinute: 100,
      maxSpendUsdcPerMinute: 0.02,
      enableFingerprintBreaker: false,
    });
    const fp = fingerprintRequest("GET", "https://a.test/spend", "");
    recordCircuitPayment(breaker, fp + "1", 0.01, 1000);
    assert.throws(
      () => assertCircuitAllowsPayment(breaker, fp + "2", 0.015, 1001),
      /CIRCUIT_BREAKER: Minute spend/,
    );
  });

  it("HALT fingerprint dead-loop: same fingerprint ≥2 prior times", () => {
    const breaker = createCircuitBreaker({
      maxPaidRequestsPerMinute: 100,
      maxSpendUsdcPerMinute: 1,
      enableFingerprintBreaker: true,
    });
    const fp = fingerprintRequest(
      "POST",
      "https://example.test/v1/quote",
      JSON.stringify({ q: "loop", uuid: "1" }),
    );
    recordCircuitPayment(breaker, fp, 0.01, 1000);
    recordCircuitPayment(breaker, fp, 0.01, 1001);
    assert.throws(
      () => assertCircuitAllowsPayment(breaker, fp, 0.01, 1002),
      /CIRCUIT_BREAKER: Dead loop/,
    );
  });
});

describe("createX402Fetch circuit breaker integration", () => {
  const privateKey = generatePrivateKey();

  it("HALTs on rate limit before signing (no paid retry)", async () => {
    let calls = 0;
    const fetch402 = createX402Fetch({
      privateKey,
      maxPaidRequestsPerMinute: 2,
      maxSpendUsdcPerMinute: 1,
      enableFingerprintBreaker: false,
      maxSingleSpendUsdc: 0.05,
      maxTotalSpendUsdc: 1,
      fetch: async (input, init) => {
        calls += 1;
        return affordablePaidFetch()(input, init);
      },
    });

    await fetch402("https://example.test/v1/a");
    await fetch402("https://example.test/v1/b");
    const callsAfterTwo = calls;

    await assert.rejects(
      () => fetch402("https://example.test/v1/c"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /CIRCUIT_BREAKER: Rate limit/);
        return true;
      },
    );
    // Third attempt: initial 402 only — must not sign / retry
    assert.equal(calls, callsAfterTwo + 1);
  });

  it("HALTs on minute spend before signing", async () => {
    let calls = 0;
    const fetch402 = createX402Fetch({
      privateKey,
      maxPaidRequestsPerMinute: 100,
      maxSpendUsdcPerMinute: 0.015, // one 0.01 OK; second 0.01 would exceed
      enableFingerprintBreaker: false,
      maxSingleSpendUsdc: 0.05,
      maxTotalSpendUsdc: 1,
      fetch: async (input, init) => {
        calls += 1;
        return affordablePaidFetch()(input, init);
      },
    });

    await fetch402("https://example.test/v1/spend-a");
    const callsAfterOne = calls;

    await assert.rejects(
      () => fetch402("https://example.test/v1/spend-b"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /CIRCUIT_BREAKER: Minute spend/);
        return true;
      },
    );
    assert.equal(calls, callsAfterOne + 1);
  });

  it("HALTs on fingerprint dead-loop with clear CIRCUIT_BREAKER: Dead loop Error", async () => {
    let calls = 0;
    const fetch402 = createX402Fetch({
      privateKey,
      maxPaidRequestsPerMinute: 100,
      maxSpendUsdcPerMinute: 1,
      enableFingerprintBreaker: true,
      maxSingleSpendUsdc: 0.05,
      maxTotalSpendUsdc: 1,
      fetch: async (input, init) => {
        calls += 1;
        return affordablePaidFetch()(input, init);
      },
    });

    const url = "https://example.test/v1/quote";
    await fetch402(url, {
      method: "POST",
      body: JSON.stringify({ action: "quote", uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", timestamp: 1 }),
    });
    await fetch402(url, {
      method: "POST",
      body: JSON.stringify({ action: "quote", uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", timestamp: 2 }),
    });
    const callsAfterTwo = calls;

    await assert.rejects(
      () =>
        fetch402(url, {
          method: "POST",
          body: JSON.stringify({ action: "quote", uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc", timestamp: 3 }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /CIRCUIT_BREAKER: Dead loop/);
        return true;
      },
    );
    assert.equal(calls, callsAfterTwo + 1);
  });
});
