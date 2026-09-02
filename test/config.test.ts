import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  isFreePath,
  isGatedPath,
  gatedRoutePatterns,
} from "../src/config.js";
import {
  BUILTIN_DEMO_MERCHANTS,
  OPERATOR_FEE_COLLECTOR,
} from "../src/merchants.js";

describe("config", () => {
  it("defaults port, price, development network, operator feeCollector, demo merchant", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.port, 8402);
    assert.equal(cfg.price, "$0.001");
    assert.equal(cfg.environment, "development");
    assert.equal(cfg.network, "eip155:84532");
    assert.equal(cfg.gatedPrefix, "/v1");
    assert.equal(cfg.useLiveFacilitator, false);
    assert.equal(cfg.feeBps, 10);
    assert.equal(cfg.feeCollector, OPERATOR_FEE_COLLECTOR);
    assert.equal(cfg.contactEmail, "2767111713@qq.com");
    assert.equal(cfg.defaultMerchant, "demo");
    assert.equal(cfg.merchants.demo?.payTo, BUILTIN_DEMO_MERCHANTS.demo.payTo);
    assert.equal(cfg.payTo, BUILTIN_DEMO_MERCHANTS.demo.payTo);
  });

  it("parses FEE_BPS and FEE_COLLECTOR without changing explicit payTo", () => {
    const cfg = loadConfig({
      FEE_BPS: "10",
      FEE_COLLECTOR: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
      MERCHANTS_JSON: JSON.stringify({
        demo: {
          seller: "0x1234567890123456789012345678901234567890",
          payTo: "0x1234567890123456789012345678901234567890",
          label: "demo",
        },
      }),
    });
    assert.equal(cfg.feeBps, 10);
    assert.equal(cfg.feeCollector, "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    assert.equal(cfg.payTo, "0x1234567890123456789012345678901234567890");
  });

  it("loads MERCHANTS_JSON and DEFAULT_MERCHANT", () => {
    const cfg = loadConfig({
      DEFAULT_MERCHANT: "shop",
      MERCHANTS_JSON: JSON.stringify({
        shop: {
          seller: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          label: "Shop",
        },
        demo: {
          seller: OPERATOR_FEE_COLLECTOR,
          payTo: BUILTIN_DEMO_MERCHANTS.demo.payTo,
          label: "demo",
        },
      }),
    });
    assert.equal(cfg.defaultMerchant, "shop");
    assert.equal(cfg.payTo, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("falls back CONTACT_EMAIL from legacy WAITLIST_EMAIL", () => {
    const cfg = loadConfig({ WAITLIST_EMAIL: "ops@example.com" });
    assert.equal(cfg.contactEmail, "ops@example.com");
  });

  it("uses production defaults when environment is production", () => {
    const cfg = loadConfig({ X402_ENVIRONMENT: "production" });
    assert.equal(cfg.environment, "production");
    assert.equal(cfg.network, "eip155:8453");
  });

  it("enables live facilitator when CDP keys + payTo are set", () => {
    const cfg = loadConfig({
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "secret",
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    assert.equal(cfg.useLiveFacilitator, true);
    assert.equal(cfg.payTo, "0x1234567890123456789012345678901234567890");
  });

  it("rejects invalid payTo and falls back to default merchant payTo", () => {
    const cfg = loadConfig({ X402_PAY_TO: "not-an-address" });
    assert.equal(cfg.payTo, BUILTIN_DEMO_MERCHANTS.demo.payTo);
    assert.equal(cfg.useLiveFacilitator, false);
  });

  it("classifies free and gated paths including /merchants", () => {
    assert.equal(isFreePath("/health"), true);
    assert.equal(isFreePath("/"), true);
    assert.equal(isFreePath("/merchants"), true);
    assert.equal(isFreePath("/v1/merchants"), true);
    assert.equal(isGatedPath("/health", "/v1"), false);
    assert.equal(isGatedPath("/merchants", "/v1"), false);
    assert.equal(isGatedPath("/v1/merchants", "/v1"), false);
    assert.equal(isGatedPath("/v1/quote", "/v1"), true);
    assert.equal(isGatedPath("/other", "/v1"), false);
    assert.equal(isGatedPath("/other", ""), true);
  });

  it("builds gated route patterns for x402", () => {
    assert.deepEqual(gatedRoutePatterns("/v1"), ["* /v1", "* /v1/*"]);
    assert.deepEqual(gatedRoutePatterns(""), ["* /*"]);
  });
});
