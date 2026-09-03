/**
 * Unit-ish test for buyer-agent PoC (mock fetch — no live chain / network pay).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";
import {
  SAFETY_BANNER,
  configFromEnv,
  createObservingFetch,
  runBuyerAgentPoc,
} from "../scripts/buyer-agent-poc.js";

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

function mock402(amountAtomic: string): Response {
  return new Response(JSON.stringify({ error: "Payment required" }), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": paymentRequiredHeader(amountAtomic),
    },
  });
}

describe("buyer-agent-poc helpers", () => {
  it("prints a clear hot-wallet safety banner", () => {
    assert.match(SAFETY_BANNER, /\$5–\$10 USDC|\$5-\$10 USDC|≤ \$5/i);
    assert.match(SAFETY_BANNER, /Never commit keys/i);
  });

  it("configFromEnv requires BUYER_PRIVATE_KEY and applies defaults", () => {
    assert.throws(() => configFromEnv({}), /BUYER_PRIVATE_KEY/);
    const pk = generatePrivateKey();
    const cfg = configFromEnv({ BUYER_PRIVATE_KEY: pk });
    assert.equal(cfg.targetUrl, "https://x402-micro-tollgate.onrender.com/v1/quote");
    assert.equal(cfg.maxSingleUsdc, 0.05);
    assert.equal(cfg.maxTotalUsdc, 1);
    assert.equal(cfg.rounds, 3);
  });

  it("observing fetch tracks auto-pay and session spend", async () => {
    let calls = 0;
    const base: typeof globalThis.fetch = async (input, init) => {
      calls += 1;
      const req = new Request(input, init);
      const hasSig =
        req.headers.has("PAYMENT-SIGNATURE") ||
        req.headers.has("payment-signature");
      if (!hasSig) return mock402("10000"); // 0.01 USDC
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const observer = createObservingFetch(base);

    // unpaid
    const r1 = await observer.fetch("https://example.test/v1/quote");
    assert.equal(r1.status, 402);
    assert.equal(observer.consumeAutoPaid(), false);
    assert.equal(observer.getSessionSpendUsdc(), 0);

    // paid retry
    const r2 = await observer.fetch("https://example.test/v1/quote", {
      headers: { "PAYMENT-SIGNATURE": "dummy" },
    });
    assert.equal(r2.status, 200);
    assert.equal(observer.consumeAutoPaid(), true);
    assert.equal(observer.getSessionSpendUsdc(), 0.01);
    assert.equal(calls, 2);
  });
});

describe("runBuyerAgentPoc (mock fetch path)", () => {
  it("loops rounds, auto-pays affordable 402, stops on budget", async () => {
    const privateKey = generatePrivateKey();
    const lines: string[] = [];
    const errs: string[] = [];

    // 0.04 USDC per pay; maxTotal 0.1 → two pays then budget stop on 3rd
    const results = await runBuyerAgentPoc({
      privateKey,
      targetUrl: "https://example.test/v1/quote",
      maxSingleUsdc: 0.05,
      maxTotalUsdc: 0.1,
      rounds: 5,
      log: (l) => lines.push(l),
      logErr: (l) => errs.push(l),
      fetch: async (input, init) => {
        const req = new Request(input, init);
        const hasSig =
          req.headers.has("PAYMENT-SIGNATURE") ||
          req.headers.has("payment-signature");
        if (!hasSig) return mock402("40000"); // 0.04 USDC
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

    assert.ok(errs.some((e) => e.includes("SAFETY") || e.includes("Hot wallet")));
    assert.ok(results.length >= 2);
    assert.equal(results[0]!.status, 200);
    assert.equal(results[0]!.autoPaid, true);
    assert.ok(results[0]!.sessionSpendUsdc > 0);

    const last = results[results.length - 1]!;
    assert.ok(
      last.stopped === "budget" ||
        (last.error !== undefined && /budget exceeded/i.test(last.error)),
      `expected budget stop, got ${JSON.stringify(last)}`,
    );
    assert.ok(last.sessionSpendUsdc <= 0.1 + 1e-9);
  });

  it("passes through free 200 without marking autoPaid", async () => {
    const privateKey = generatePrivateKey();
    const results = await runBuyerAgentPoc({
      privateKey,
      targetUrl: "https://example.test/health",
      maxSingleUsdc: 0.05,
      maxTotalUsdc: 1,
      rounds: 2,
      log: () => {},
      logErr: () => {},
      fetch: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    assert.equal(results.length, 2);
    assert.equal(results[0]!.status, 200);
    assert.equal(results[0]!.autoPaid, false);
    assert.equal(results[0]!.sessionSpendUsdc, 0);
    assert.equal(results[1]!.stopped, "rounds");
  });
});
