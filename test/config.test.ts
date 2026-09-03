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
    assert.deepEqual(cfg.networks, ["eip155:84532"]);
    assert.equal(cfg.accepts.length, 1);
    assert.equal(cfg.accepts[0]?.symbol, "USDC");
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
    assert.equal(isFreePath("/x402/session-token"), true);
    assert.equal(isFreePath("/x402/discover"), true);
    assert.equal(isFreePath("/discover"), true);
    assert.equal(isFreePath("/llms.txt"), true);
    assert.equal(isFreePath("/.well-known/llms.txt"), true);
    assert.equal(isGatedPath("/health", "/v1"), false);
    assert.equal(isGatedPath("/merchants", "/v1"), false);
    assert.equal(isGatedPath("/v1/merchants", "/v1"), false);
    assert.equal(isGatedPath("/x402/session-token", "/v1"), false);
    assert.equal(isGatedPath("/x402/discover", "/v1"), false);
    assert.equal(isGatedPath("/discover", "/v1"), false);
    assert.equal(isGatedPath("/llms.txt", "/v1"), false);
    assert.equal(isGatedPath("/.well-known/llms.txt", "/v1"), false);
    assert.equal(isGatedPath("/v1/quote", "/v1"), true);
    assert.equal(isGatedPath("/other", "/v1"), false);
    assert.equal(isGatedPath("/other", ""), true);
  });

  it("parses CDP_CLIENT_API_KEY for browser paywall", () => {
    const cfg = loadConfig({
      CDP_CLIENT_API_KEY: " test-client-key ",
      CDP_API_KEY_ID: "id",
      CDP_API_KEY_SECRET: "secret",
      X402_PAY_TO: "0x1234567890123456789012345678901234567890",
    });
    assert.equal(cfg.cdpClientApiKey, "test-client-key");
    assert.equal(cfg.useLiveFacilitator, true);
  });

  it("parses SELLER / FEE_FREE_BELOW_USDC / FACTORY_ADDRESS", () => {
    const seller = "0x1234567890123456789012345678901234567890";
    const factory = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    const cfg = loadConfig({
      SELLER: seller,
      FEE_FREE_BELOW_USDC: "10000000",
      FACTORY_ADDRESS: factory,
      MERCHANTS_FILE: "/tmp/x402-no-merchants-file-does-not-exist.json",
    });
    assert.equal(cfg.seller?.toLowerCase(), seller.toLowerCase());
    assert.equal(cfg.feeFreeBelowUsdc, 10_000_000n);
    assert.equal(cfg.factoryAddress?.toLowerCase(), factory.toLowerCase());
    assert.equal(cfg.payTo?.toLowerCase(), seller.toLowerCase());
    assert.equal(Object.keys(cfg.merchants).length, 0);
  });

  it("accepts X402_FEE_FREE_BELOW_USDC alias", () => {
    const cfg = loadConfig({ X402_FEE_FREE_BELOW_USDC: "1234567" });
    assert.equal(cfg.feeFreeBelowUsdc, 1_234_567n);
  });

  it("defaults feeFreeBelowUsdc to 10_000_000 and seller undefined", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.seller, undefined);
    assert.equal(cfg.feeFreeBelowUsdc, 10_000_000n);
    assert.equal(cfg.factoryAddress, undefined);
    assert.equal(cfg.dynamicMinEnabled, false);
    assert.equal(cfg.minPriceUsdc, 0n);
  });

  it("parses settle/verify timeouts and upstream shared secret aliases", () => {
    const defaults = loadConfig({});
    assert.equal(defaults.settleTimeoutMs, 180_000);
    assert.equal(defaults.verifyTimeoutMs, 15_000);
    assert.equal(defaults.upstreamSharedSecret, undefined);

    const cfg = loadConfig({
      X402_SETTLE_TIMEOUT_MS: "120000",
      X402_VERIFY_TIMEOUT_MS: "8000",
      X402_UPSTREAM_SECRET: "upstream-secret",
    });
    assert.equal(cfg.settleTimeoutMs, 120_000);
    assert.equal(cfg.verifyTimeoutMs, 8_000);
    assert.equal(cfg.upstreamSharedSecret, "upstream-secret");

    const alias = loadConfig({ UPSTREAM_SHARED_SECRET: "shared" });
    assert.equal(alias.upstreamSharedSecret, "shared");
  });
});
