import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  BUILTIN_DEMO_MERCHANTS,
  OPERATOR_FEE_COLLECTOR,
} from "../src/merchants.js";
import {
  buildDiscoverDocument,
  DISCOVER_ALIAS_PATH,
  DISCOVER_PATH,
  DISCOVER_VERSION,
  resolveDiscoverStatus,
} from "../src/discover.js";
import { isFreePath, isGatedPath } from "../src/config.js";

const TEST_SELLER = "0x1234567890123456789012345678901234567890";
const TEST_SPLITTER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("discover document shape", () => {
  it("builds yellow pages from merchants + PUBLIC_BASE_URL", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      NETWORK: "eip155:8453",
      PRICE: "$0.001",
      MERCHANTS_JSON: JSON.stringify({
        demo: {
          seller: OPERATOR_FEE_COLLECTOR,
          payTo: TEST_SPLITTER,
          label: "demo (operator is also seller)",
        },
        acme: {
          seller: TEST_SELLER,
          payTo: "0x9999999999999999999999999999999999999999",
          label: "Acme API",
        },
      }),
    });

    const fixed = new Date("2026-09-03T12:00:00.000Z");
    const doc = buildDiscoverDocument(config, fixed);

    assert.equal(doc.version, DISCOVER_VERSION);
    assert.equal(doc.network, "eip155:8453");
    assert.equal(doc.updatedAt, "2026-09-03T12:00:00.000Z");
    assert.equal(doc.source, "merchants");
    assert.equal(doc.services.length, 2);

    const acme = doc.services.find((s) => s.id === "acme");
    assert.ok(acme);
    assert.equal(acme.label, "Acme API");
    assert.equal(acme.endpoint, "https://tollgate.example.com/v1/quote?merchant=acme");
    assert.equal(acme.mcp, "https://tollgate.example.com/mcp");
    assert.deepEqual(acme.capabilities, ["quote", "proxy", "fetch-md"]);
    assert.equal(acme.price, "$0.001");
    assert.equal(acme.asset, "USDC");
    assert.equal(acme.payTo, "0x9999999999999999999999999999999999999999");
    assert.equal(acme.seller, TEST_SELLER);
    assert.equal(acme.status, "demo");

    const demo = doc.services.find((s) => s.id === "demo");
    assert.ok(demo);
    assert.equal(demo.payTo, TEST_SPLITTER);
  });

  it("marks status live only with CDP facilitator credentials", () => {
    const demoCfg = loadConfig({ X402_PAY_TO: TEST_SELLER });
    assert.equal(resolveDiscoverStatus(demoCfg), "demo");

    const liveCfg = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "secret",
      NETWORK: "eip155:8453",
      X402_ENVIRONMENT: "production",
    });
    assert.equal(resolveDiscoverStatus(liveCfg), "live");
    assert.equal(buildDiscoverDocument(liveCfg).services[0]?.status, "live");
  });

  it("emits seller service when registry empty under SELLER mode", () => {
    // With SELLER set, loadMerchantsRegistry({ optional: true }) skips example/builtin.
    // No merchants.json in repo → empty registry → one synthetic seller service.
    const sellerOnly = loadConfig({
      SELLER: TEST_SELLER,
      PUBLIC_BASE_URL: "https://seller.example.com",
    });
    assert.equal(Object.keys(sellerOnly.merchants).length, 0);
    assert.ok(sellerOnly.seller);

    const doc = buildDiscoverDocument(sellerOnly);
    assert.equal(doc.source, "seller");
    assert.equal(doc.services.length, 1);
    assert.equal(doc.services[0]?.id, "seller");
    assert.equal(doc.services[0]?.endpoint, "https://seller.example.com/v1/quote");
    assert.equal(doc.services[0]?.seller, TEST_SELLER);
    assert.equal(doc.services[0]?.payTo, TEST_SELLER);
  });

  it("falls back to built-in demo merchants", () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://127.0.0.1:8402",
    });
    const doc = buildDiscoverDocument(config);
    assert.ok(doc.services.some((s) => s.id === "demo"));
    const demo = doc.services.find((s) => s.id === "demo")!;
    assert.equal(demo.payTo, BUILTIN_DEMO_MERCHANTS.demo.payTo);
    assert.equal(demo.seller, BUILTIN_DEMO_MERCHANTS.demo.seller);
  });
});

describe("discover free HTTP path", () => {
  it("classifies /x402/discover and /discover as free", () => {
    assert.equal(isFreePath(DISCOVER_PATH), true);
    assert.equal(isFreePath(DISCOVER_ALIAS_PATH), true);
    assert.equal(isGatedPath(DISCOVER_PATH, "/v1"), false);
    assert.equal(isGatedPath(DISCOVER_ALIAS_PATH, "/v1"), false);
    assert.equal(isGatedPath(DISCOVER_PATH, ""), false);
  });

  it("GET /x402/discover returns 200 without payment", async () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      MERCHANTS_JSON: JSON.stringify({
        demo: {
          seller: OPERATOR_FEE_COLLECTOR,
          payTo: TEST_SPLITTER,
          label: "demo",
        },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const res = await request(app).get(DISCOVER_PATH);
    assert.equal(res.status, 200);
    assert.equal(res.body.version, 1);
    assert.equal(res.body.network, config.network);
    assert.ok(typeof res.body.updatedAt === "string");
    assert.ok(Array.isArray(res.body.services));
    assert.equal(res.body.services[0]?.id, "demo");
    assert.equal(
      res.body.services[0]?.endpoint,
      "https://tollgate.example.com/v1/quote?merchant=demo",
    );
    assert.ok(res.headers["x-request-id"]);

    const alias = await request(app).get(DISCOVER_ALIAS_PATH);
    assert.equal(alias.status, 200);
    assert.equal(alias.body.version, 1);
    assert.deepEqual(
      alias.body.services.map((s: { id: string }) => s.id),
      res.body.services.map((s: { id: string }) => s.id),
    );
  });

  it("does not require PAYMENT-SIGNATURE on discover", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      GATED_PREFIX: "/v1",
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const discover = await request(app).get("/x402/discover");
    assert.equal(discover.status, 200);
    assert.equal(discover.headers["payment-required"], undefined);

    const gated = await request(app).get("/v1/quote");
    assert.equal(gated.status, 402);
  });
});
