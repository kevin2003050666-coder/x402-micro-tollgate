import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createX402Fetch,
  createBudgetTracker,
  assertWithinBudget,
  atomicToUsdc,
  MAX_AUTOMATIC_PAYMENT_RETRIES,
  DEFAULT_MAX_SINGLE_SPEND_USDC,
  DEFAULT_MAX_TOTAL_SPEND_USDC,
} from "../src/client/index.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1234567890123456789012345678901234567890";

/** Build a protocol-shaped PAYMENT-REQUIRED header (atomic USDC amount). */
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
  return new Response(JSON.stringify({ error: "Payment required", price: "$0.10" }), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": paymentRequiredHeader(amountAtomic),
    },
  });
}

describe("client budget helpers", () => {
  it("defaults and rejects over-single / over-total", () => {
    const tracker = createBudgetTracker();
    assert.equal(tracker.limits.maxSingleSpendUsdc, DEFAULT_MAX_SINGLE_SPEND_USDC);
    assert.equal(tracker.limits.maxTotalSpendUsdc, DEFAULT_MAX_TOTAL_SPEND_USDC);

    assert.equal(atomicToUsdc("50000"), 0.05); // 0.05 USDC
    assert.throws(
      () => assertWithinBudget(0.06, tracker),
      /budget exceeded.*single payment/i,
    );

    assertWithinBudget(0.04, tracker);
    tracker.totalSpentUsdc = 0.98;
    assert.throws(
      () => assertWithinBudget(0.05, tracker),
      /budget exceeded.*total spend/i,
    );
  });

  it("hardcodes max automatic payment retries to 1", () => {
    assert.equal(MAX_AUTOMATIC_PAYMENT_RETRIES, 1);
  });
});

describe("createX402Fetch", () => {
  const privateKey = generatePrivateKey();

  it("passes through non-402 responses without a payment retry", async () => {
    let calls = 0;
    const fetch402 = createX402Fetch({
      privateKey,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const res = await fetch402("https://example.test/health");
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("rejects over-budget 402 before signing (no payment retry)", async () => {
    let calls = 0;
    // 1.00 USDC atomic @ 6 decimals = 1_000_000; default maxSingle = 0.05
    const fetch402 = createX402Fetch({
      privateKey,
      maxSingleSpendUsdc: 0.05,
      maxTotalSpendUsdc: 1,
      fetch: async () => {
        calls += 1;
        return mock402Response("1000000");
      },
    });

    await assert.rejects(
      () => fetch402("https://example.test/v1/quote"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /budget exceeded/i);
        assert.match(err.message, /single payment|maxSingleSpendUsdc/i);
        return true;
      },
    );
    // Initial 402 only — must not retry with PAYMENT-SIGNATURE
    assert.equal(calls, 1);
  });

  it("retries at most once with PAYMENT-SIGNATURE on affordable 402", async () => {
    let calls = 0;
    const seenPaymentSignature: boolean[] = [];
    // 0.01 USDC = 10000 atomic
    const fetch402 = createX402Fetch({
      privateKey,
      maxSingleSpendUsdc: 0.05,
      maxTotalSpendUsdc: 1,
      fetch: async (input, init) => {
        calls += 1;
        const req = new Request(input, init);
        const hasSig =
          req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("payment-signature");
        seenPaymentSignature.push(hasSig);
        if (!hasSig) {
          return mock402Response("10000");
        }
        // Paid retry succeeds — if a second payment retry happened we'd see calls > 2
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
      },
    });

    const res = await fetch402("https://example.test/v1/quote");
    assert.equal(res.status, 200);
    assert.equal(calls, 2, "exactly one unpaid fetch + one paid retry");
    assert.equal(MAX_AUTOMATIC_PAYMENT_RETRIES, 1);
    assert.deepEqual(seenPaymentSignature, [false, true]);
    assert.deepEqual(await res.json(), { paid: true });
  });

  it("accepts a viem account instead of privateKey", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    let calls = 0;
    const fetch402 = createX402Fetch({
      account,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const res = await fetch402("https://example.test/");
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });
});
