import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  buildPaywallConfig,
  createTollgatePaywall,
  injectBuyerExtras,
  isBrowserPaymentRequest,
  SESSION_TOKEN_PATH,
} from "../src/paywall.js";

const TEST_SELLER = "0x1234567890123456789012345678901234567890";
const TEST_SPLITTER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function merchantsJson(
  entries: Record<string, { seller: string; payTo: string; label: string }>,
): string {
  return JSON.stringify(entries);
}

describe("browser Smart Wallet paywall", () => {
  it("isBrowserPaymentRequest requires Accept text/html + Mozilla UA", () => {
    assert.equal(
      isBrowserPaymentRequest({
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120",
        },
      }),
      true,
    );
    assert.equal(
      isBrowserPaymentRequest({
        headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
      }),
      false,
    );
    assert.equal(
      isBrowserPaymentRequest({
        headers: { accept: "text/html", "user-agent": "curl/8.0" },
      }),
      false,
    );
  });

  it("buildPaywallConfig enables sessionTokenEndpoint when server CDP keys exist", () => {
    const withKeys = buildPaywallConfig(
      loadConfig({
        CDP_API_KEY_ID: "id",
        CDP_API_KEY_SECRET: "secret",
        CDP_CLIENT_API_KEY: "pk_test",
        X402_PAY_TO: TEST_SELLER,
      }),
    );
    assert.equal(withKeys.appName, "x402-micro-tollgate");
    assert.equal(withKeys.cdpClientKey, "pk_test");
    assert.equal(withKeys.sessionTokenEndpoint, SESSION_TOKEN_PATH);
    assert.equal(withKeys.testnet, true);

    const withoutKeys = buildPaywallConfig(loadConfig({}));
    assert.equal(withoutKeys.sessionTokenEndpoint, undefined);
  });

  it("injectBuyerExtras adds Onramp panel when sessionTokenEndpoint set", () => {
    const html = injectBuyerExtras("<html><body>pay</body></html>", {
      sessionTokenEndpoint: SESSION_TOKEN_PATH,
      cdpClientKey: "pk_test",
    });
    assert.match(html, /x402-get-usdc/);
    assert.match(html, /sessionTokenEndpoint/);
    assert.match(html, /pk_test/);
    assert.match(html, /pay\.coinbase\.com/);
  });

  it("createTollgatePaywall generates Coinbase Smart Wallet HTML", () => {
    const config = loadConfig({
      CDP_CLIENT_API_KEY: "pk_demo",
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "secret",
    });
    const paywall = createTollgatePaywall(config);
    const html = paywall.generateHtml({
      x402Version: 2,
      resource: { url: "https://example.com/v1/quote" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: TEST_SPLITTER,
          maxTimeoutSeconds: 300,
          amount: "1000",
          extra: { name: "USDC", version: "2" },
        },
      ],
    });
    assert.match(html, /Payment Required/i);
    assert.match(html, /Coinbase/i);
    assert.match(html, /x402-get-usdc/);
    assert.match(html, /pk_demo/);
  });

  it("browser GET gated route returns 402 HTML; JSON clients stay JSON", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      PRICE: "$0.001",
      NETWORK: "eip155:84532",
      GATED_PREFIX: "/v1",
      PUBLIC_BASE_URL: "https://tollgate.example.com",
      CDP_CLIENT_API_KEY: "pk_browser",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const browser = await request(app)
      .get("/v1/quote")
      .set("Accept", "text/html")
      .set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0");
    assert.equal(browser.status, 402);
    assert.match(browser.headers["content-type"] ?? "", /html/i);
    assert.ok(browser.headers["payment-required"]);
    assert.match(browser.text, /Payment Required/i);
    assert.match(browser.text, /Coinbase/i);

    const agent = await request(app)
      .get("/v1/quote")
      .set("Accept", "application/json")
      .set("User-Agent", "x402-agent/1.0");
    assert.equal(agent.status, 402);
    assert.match(agent.headers["content-type"] ?? "", /json/i);
    assert.equal(agent.body.error, "Payment Required");
  });

  it("POST /x402/session-token is free and 503 without CDP server keys", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
      }),
    });
    const { app } = await createApp({
      config,
      paymentLayer: createDemoPaymentLayer(config),
      disableMcp: true,
    });

    const missing = await request(app)
      .post(SESSION_TOKEN_PATH)
      .send({
        addresses: [{ address: TEST_SELLER, blockchains: ["base"] }],
      });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error.code, "onramp_not_configured");

    const bad = await request(app).post(SESSION_TOKEN_PATH).send({ addresses: [] });
    assert.equal(bad.status, 503);

    const health = await request(app).get("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.paywall.sessionTokenEndpoint, null);
    assert.equal(health.body.paywall.cdpClientKeyConfigured, false);
  });

  it("POST /x402/session-token validates addresses when CDP keys present", async () => {
    const config = loadConfig({
      X402_PAY_TO: TEST_SELLER,
      CDP_API_KEY_ID: "test-id",
      CDP_API_KEY_SECRET: "test-secret-not-a-real-key",
      CDP_CLIENT_API_KEY: "pk_test",
      MERCHANTS_JSON: merchantsJson({
        demo: { seller: TEST_SELLER, payTo: TEST_SPLITTER, label: "demo" },
      }),
    });
    // Force demo payment layer so we do not need live facilitator.
    const { app } = await createApp({
      config: { ...config, useLiveFacilitator: false },
      paymentLayer: createDemoPaymentLayer({ ...config, useLiveFacilitator: false }),
      disableMcp: true,
    });

    const health = await request(app).get("/health");
    assert.equal(health.body.paywall.sessionTokenEndpoint, SESSION_TOKEN_PATH);
    assert.equal(health.body.paywall.cdpClientKeyConfigured, true);

    const badAddr = await request(app)
      .post(SESSION_TOKEN_PATH)
      .send({ addresses: [{ address: "not-an-address" }] });
    assert.equal(badAddr.status, 400);
    assert.equal(badAddr.body.error.code, "invalid_addresses");
  });
});
