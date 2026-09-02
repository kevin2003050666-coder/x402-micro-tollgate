import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  SignatureDedupeCache,
  withPaymentSignatureDedupe,
} from "../src/payment-dedupe.js";
import type { RequestHandler } from "express";

describe("SignatureDedupeCache", () => {
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
  it("first paid demo request succeeds; same PAYMENT-SIGNATURE replay → 400 payment_replay", async () => {
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
    assert.equal(replay.status, 400);
    assert.deepEqual(replay.body, { error: "payment_replay" });
  });

  it("unpaid gated requests are not recorded as settled fingerprints", async () => {
    const config = loadConfig({ GATED_PREFIX: "/v1" });
    const cache = new SignatureDedupeCache();
    const allowOnce: RequestHandler = (_req, res, next) => {
      // Simulate settle only when signature present — unpaid path never calls next.
      res.status(402).json({ error: "Payment Required" });
      void next;
    };
    const { app } = await createApp({
      config,
      paymentLayer: {
        mode: "demo",
        middleware: withPaymentSignatureDedupe(allowOnce, {
          cache,
          gatedPrefix: config.gatedPrefix,
        }),
      },
      disableMcp: true,
    });

    const unpaid = await request(app)
      .get("/v1/quote")
      .set("PAYMENT-SIGNATURE", "never-settled-payload");
    assert.equal(unpaid.status, 402);
    assert.equal(cache.has("never-settled-payload"), false);
  });
});
