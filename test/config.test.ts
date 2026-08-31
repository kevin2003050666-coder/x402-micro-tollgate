import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadConfig,
  isFreePath,
  isGatedPath,
  gatedRoutePatterns,
} from "../src/config.js";

describe("config", () => {
  it("defaults port, price, development network", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.port, 8402);
    assert.equal(cfg.price, "$0.001");
    assert.equal(cfg.environment, "development");
    assert.equal(cfg.network, "eip155:84532");
    assert.equal(cfg.gatedPrefix, "/v1");
    assert.equal(cfg.useLiveFacilitator, false);
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

  it("rejects invalid payTo", () => {
    const cfg = loadConfig({ X402_PAY_TO: "not-an-address" });
    assert.equal(cfg.payTo, undefined);
    assert.equal(cfg.useLiveFacilitator, false);
  });

  it("classifies free and gated paths", () => {
    assert.equal(isFreePath("/health"), true);
    assert.equal(isFreePath("/"), true);
    assert.equal(isGatedPath("/health", "/v1"), false);
    assert.equal(isGatedPath("/v1/quote", "/v1"), true);
    assert.equal(isGatedPath("/other", "/v1"), false);
    assert.equal(isGatedPath("/other", ""), true);
  });

  it("builds gated route patterns for x402", () => {
    assert.deepEqual(gatedRoutePatterns("/v1"), ["* /v1", "* /v1/*"]);
    assert.deepEqual(gatedRoutePatterns(""), ["* /*"]);
  });
});
