import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RequestHandler } from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  SignatureDedupeCache,
  MemoryPaymentDedupeStore,
  KeyMutex,
  withPaymentSignatureDedupe,
  paymentIdempotencyKey,
} from "../src/payment-dedupe.js";

describe("MemoryPaymentDedupeStore", () => {
  it("tryBeginPending is set-if-absent", () => {
    const store = new MemoryPaymentDedupeStore({ ttlMs: 60_000 });
    const key = paymentIdempotencyKey("sig-a");
    const first = store.tryBeginPending(key);
    assert.equal(first.created, true);
    assert.equal(first.record.status, "pending");
    const second = store.tryBeginPending(key);
    assert.equal(second.created, false);
    assert.equal(second.record.status, "pending");
  });

  it("releasePending frees failed verify so retries work", () => {
    const store = new MemoryPaymentDedupeStore({ ttlMs: 60_000 });
    const key = paymentIdempotencyKey("sig-b");
    store.tryBeginPending(key);
    store.releasePending(key);
    assert.equal(store.get(key), undefined);
    const again = store.tryBeginPending(key);
    assert.equal(again.created, true);
  });

  it("does not release settled or consumed records", () => {
    const store = new MemoryPaymentDedupeStore({ ttlMs: 60_000 });
    const key = paymentIdempotencyKey("sig-c");
    store.tryBeginPending(key);
    store.markSettled(key, "receipt");
    store.releasePending(key);
    assert.equal(store.get(key)?.status, "settled");
    store.markConsumed(key);
    store.releasePending(key);
    assert.equal(store.get(key)?.status, "consumed");
  });

  it("expires after TTL", () => {
    let now = 1_000_000;
    const store = new MemoryPaymentDedupeStore({
      ttlMs: 1_000,
      now: () => now,
    });
    const key = paymentIdempotencyKey("sig-ttl");
    store.markSettled(key);
    store.markConsumed(key);
    assert.equal(store.get(key)?.status, "consumed");
    now += 1_001;
    assert.equal(store.get(key), undefined);
  });
});

describe("SignatureDedupeCache compat", () => {
  it("fingerprints and expires after TTL", () => {
    let now = 1_000_000;
    const cache = new SignatureDedupeCache({
      ttlMs: 1_000,
      maxEntries: 10,
      now: () => now,
    });

    assert.equal(cache.has("sig-a"), false);
    cache.add("sig-a");
    assert.equal(cache.has("sig-a"), true);
    assert.equal(cache.has("sig-b"), false);

    now += 999;
    assert.equal(cache.has("sig-a"), true);

    now += 2;
    assert.equal(cache.has("sig-a"), false);
  });

  it("evicts oldest when over maxEntries", () => {
    const cache = new SignatureDedupeCache({
      ttlMs: 60_000,
      maxEntries: 2,
    });
    cache.add("a");
    cache.add("b");
    cache.add("c");
    assert.equal(cache.has("a"), false);
    assert.equal(cache.has("b"), true);
    assert.equal(cache.has("c"), true);
  });
});

describe("payment signature dedupe middleware", () => {
  it("first paid demo request succeeds; same PAYMENT-SIGNATURE replay → 409 payment_already_used", async () => {
    const config = loadConfig({ GATED_PREFIX: "/v1" });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const first = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(first.status, 200);

    const replay = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "demo-settled");
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, "payment_already_used");
    assert.match(String(replay.body.message), /payment already used/i);
  });

  it("unpaid gated requests are not recorded as settled fingerprints", async () => {
    const config = loadConfig({ GATED_PREFIX: "/v1" });
    const store = new MemoryPaymentDedupeStore();
    const allowOnce: RequestHandler = (_req, res, next) => {
      res.status(402).json({ error: "Payment Required" });
      void next;
    };
    const { app } = await createApp({
      config,
      paymentLayer: {
        mode: "demo",
        middleware: withPaymentSignatureDedupe(allowOnce, {
          store,
          gatedPrefix: config.gatedPrefix,
          settleTimeoutMs: 5_000,
        }),
      },
      disableMcp: true,
    });

    const unpaid = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "never-settled-payload");
    assert.equal(unpaid.status, 402);
    assert.equal(store.get(paymentIdempotencyKey("never-settled-payload")), undefined);
  });

  it("concurrent same proof: one winner, loser gets payment_already_used or payment_pending", async () => {
    const config = loadConfig({ GATED_PREFIX: "/v1" });
    const store = new MemoryPaymentDedupeStore();
    const mutex = new KeyMutex();
    let inFlight = 0;
    let maxInFlight = 0;
    let upstreamHits = 0;

    const slowSettle: RequestHandler = (_req, _res, next) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        next();
      }, 80);
    };

    const { app } = await createApp({
      config,
      paymentLayer: {
        mode: "demo",
        middleware: withPaymentSignatureDedupe(slowSettle, {
          store,
          mutex,
          gatedPrefix: config.gatedPrefix,
          settleTimeoutMs: 5_000,
        }),
      },
      disableMcp: true,
      upstreamHandler: (_req, res) => {
        upstreamHits += 1;
        res.status(200).json({ ok: true, hits: upstreamHits });
      },
    });

    const [a, b] = await Promise.all([
      request(app).get("/v1/quote").set("PAYMENT-SIGNATURE", "concurrent-proof"),
      request(app).get("/v1/quote").set("PAYMENT-SIGNATURE", "concurrent-proof"),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.equal(maxInFlight, 1, "mutex should serialize settle");
    assert.equal(upstreamHits, 1, "upstream should run once");
    assert.ok(statuses.includes(200));
    assert.ok(statuses.includes(409) || statuses.includes(202));
  });

  it("settle slow → 202 payment_pending → retry same proof → single upstream success", async () => {
    const config = loadConfig({ GATED_PREFIX: "/v1" });
    const store = new MemoryPaymentDedupeStore();
    let settleCalls = 0;
    let upstreamHits = 0;
    let releaseSettle!: () => void;
    const settleGate = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });

    const slowSettle: RequestHandler = (_req, res, next) => {
      settleCalls += 1;
      res.setHeader(
        "PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify({ success: true, demo: true }), "utf8").toString("base64"),
      );
      void settleGate.then(() => next());
    };

    const { app } = await createApp({
      config,
      paymentLayer: {
        mode: "demo",
        middleware: withPaymentSignatureDedupe(slowSettle, {
          store,
          gatedPrefix: config.gatedPrefix,
          settleTimeoutMs: 50,
          delay: (ms) => new Promise((r) => setTimeout(r, ms)),
        }),
      },
      disableMcp: true,
      upstreamHandler: (_req, res) => {
        upstreamHits += 1;
        res.status(200).json({ ok: true, upstreamHits });
      },
    });

    const pending = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "slow-settle-proof");
    assert.equal(pending.status, 202);
    assert.equal(pending.body.error, "payment_pending");
    assert.equal(pending.body.retry_with_same_proof, true);

    // Background settle completes after the HTTP timeout response.
    releaseSettle();
    await new Promise((r) => setTimeout(r, 30));

    const key = paymentIdempotencyKey("slow-settle-proof");
    // Wait until store observes settled (background mark).
    for (let i = 0; i < 40; i++) {
      const rec = store.get(key);
      if (rec?.status === "settled") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(store.get(key)?.status, "settled");

    const retry = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "slow-settle-proof");
    assert.equal(retry.status, 200);
    assert.equal(retry.body.ok, true);
    assert.equal(settleCalls, 1, "must not re-settle the same proof");
    assert.equal(upstreamHits, 1, "upstream once after resume");

    const replay = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "slow-settle-proof");
    assert.equal(replay.status, 409);
    assert.equal(upstreamHits, 1);
  });
});
