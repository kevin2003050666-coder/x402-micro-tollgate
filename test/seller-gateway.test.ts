import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import { predictFeeSplitterAddress } from "../src/resolve-pay-to.js";
import { OPERATOR_FEE_COLLECTOR } from "../src/merchants.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402Tollgate } from "../src/x402-tollgate.js";
import express from "express";

const SELLER = getAddress("0x1234567890123456789012345678901234567890");
const FACTORY = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const ASSET_SEPOLIA = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const TEST_SPLITTER = "0xC20bC6cAc978f8d2AE94Ee9D41F2DF396A5f10fE";

describe("permissionless seller gateway", () => {
  it("PRICE $0.001 (<$10) → payTo = seller EOA without MERCHANTS_JSON", async () => {
    const config = loadConfig({
      SELLER,
      PRICE: "$0.001",
      NETWORK: "eip155:84532",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      // Explicit empty registry — no hosted merchants.
      MERCHANTS_JSON: undefined,
      MERCHANTS_FILE: "/tmp/x402-no-merchants-file-does-not-exist.json",
    });
    assert.equal(config.seller, SELLER);
    assert.equal(Object.keys(config.merchants).length, 0);

    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/v1/quote");
    assert.equal(res.status, 402);
    const required = decodePaymentRequiredHeader(res.headers["payment-required"] as string);
    assert.equal(required.accepts[0]?.amount, "1000");
    assert.equal(required.accepts[0]?.payTo, SELLER);
  });

  it("PRICE $10 (≥ threshold) → payTo = predicted FeeSplitter", async () => {
    const config = loadConfig({
      SELLER,
      FACTORY_ADDRESS: FACTORY,
      PRICE: "$10",
      NETWORK: "eip155:84532",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_FILE: "/tmp/x402-no-merchants-file-does-not-exist.json",
    });
    const expected = predictFeeSplitterAddress({
      factoryAddress: FACTORY,
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET_SEPOLIA,
      feeBps: 10,
    });

    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get("/v1/quote");
    assert.equal(res.status, 402);
    const required = decodePaymentRequiredHeader(res.headers["payment-required"] as string);
    assert.equal(required.accepts[0]?.amount, "10000000");
    assert.equal(required.accepts[0]?.payTo, expected);
    assert.notEqual(required.accepts[0]?.payTo, SELLER);
  });

  it("invalid SELLER hard-fails loadConfig", () => {
    assert.throws(
      () =>
        loadConfig({
          SELLER: "not-an-address",
        }),
      /seller/,
    );
    assert.throws(
      () =>
        loadConfig({
          SELLER: "0xA922F38041B5EE227C96A547F106F1330447E30E",
        }),
      /checksum/,
    );
  });

  it("MERCHANTS_JSON ?merchant= path still works alongside seller", async () => {
    const config = loadConfig({
      SELLER,
      FACTORY_ADDRESS: FACTORY,
      PRICE: "$0.001",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_JSON: JSON.stringify({
        "web3-news-api": {
          seller: SELLER,
          payTo: TEST_SPLITTER,
          label: "web3 news",
        },
      }),
    });
    assert.ok(config.merchants["web3-news-api"]);

    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    // Explicit merchant → registry payTo (splitter), not seller threshold path.
    const byMerchant = await request(app)
      .get("/v1/quote")
      .query({ merchant: "web3-news-api" });
    assert.equal(byMerchant.status, 402);
    const mRequired = decodePaymentRequiredHeader(
      byMerchant.headers["payment-required"] as string,
    );
    assert.equal(mRequired.accepts[0]?.payTo, TEST_SPLITTER);

    // No merchant → permissionless seller (<$10 → seller EOA).
    const sellerPath = await request(app).get("/v1/quote");
    assert.equal(sellerPath.status, 402);
    const sRequired = decodePaymentRequiredHeader(
      sellerPath.headers["payment-required"] as string,
    );
    assert.equal(sRequired.accepts[0]?.payTo, SELLER);
  });

  it("x402Tollgate rejects invalid seller at init", async () => {
    await assert.rejects(
      () => x402Tollgate({ seller: "nope", env: {} }),
      /seller/,
    );
  });

  it("x402Tollgate middleware returns 402 with seller payTo for micro price", async () => {
    const mw = await x402Tollgate({
      seller: SELLER,
      env: {
        PRICE: "$0.001",
        NETWORK: "eip155:84532",
        PUBLIC_BASE_URL: "https://tollgate.example.com",
        MERCHANTS_FILE: "/tmp/x402-no-merchants-file-does-not-exist.json",
      },
    });
    const app = express();
    app.use("/v1", mw);
    app.use((_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app).get("/v1/quote");
    assert.equal(res.status, 402);
    const required = decodePaymentRequiredHeader(res.headers["payment-required"] as string);
    assert.equal(required.accepts[0]?.payTo, SELLER);
  });

  it("≥$10 without FACTORY_ADDRESS fails at payment layer init", () => {
    const config = loadConfig({
      SELLER,
      PRICE: "$10",
      NETWORK: "eip155:84532",
      MERCHANTS_FILE: "/tmp/x402-no-merchants-file-does-not-exist.json",
    });
    assert.throws(() => createDemoPaymentLayer(config), /FACTORY_ADDRESS/);
  });
});
