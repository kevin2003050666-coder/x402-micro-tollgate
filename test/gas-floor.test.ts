import { describe, it } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createDemoPaymentLayer } from "../src/payment.js";
import {
  atomicUsdcToDollarPrice,
  clampTtl,
  computeEffectiveMins,
  createBaseFeeOracle,
  createGasFloorService,
  dollarPriceToAtomic,
  estimateGasCostUsd,
  usdToAtomicUsdc,
  DEFAULT_ETH_USD,
  DEFAULT_GAS_COST_MAX_FRACTION,
  DEFAULT_GAS_USED_ESTIMATE,
} from "../src/gas-floor.js";

describe("gas-floor pure math", () => {
  it("parses dollar prices and formats atomic USDC", () => {
    assert.equal(dollarPriceToAtomic("$0.001"), 1000n);
    assert.equal(dollarPriceToAtomic("$1"), 1_000_000n);
    assert.equal(atomicUsdcToDollarPrice(1000n), "$0.001");
    assert.equal(atomicUsdcToDollarPrice(1_000_000n), "$1");
  });

  it("estimates gas cost from baseFee * gas * ethUsd", () => {
    // 0.1 gwei base fee, 100k gas, $4000 ETH → 0.00001 ETH * 4000 = $0.04
    const baseFeeWei = 100_000_000n; // 0.1 gwei
    const usd = estimateGasCostUsd(baseFeeWei, 100_000, 4_000);
    assert.ok(Math.abs(usd - 0.04) < 1e-9);
  });

  it("keeps demo $0.001 when dynamic is off", () => {
    const out = computeEffectiveMins({
      priceAtomic: 1000n,
      minPriceUsdc: 0n,
      feeFreeBelowUsdc: 10_000_000n,
      dynamicMinEnabled: false,
      gasCostUsd: 1, // would otherwise force a huge bump
      gasCostMaxFraction: 0.5,
      feeBps: 10,
    });
    assert.equal(out.effectiveMinPriceAtomic, 1000n);
    assert.equal(out.effectiveFeeFreeBelowUsdc, 10_000_000n);
    assert.equal(out.bumped, false);
    assert.equal(out.reason, "disabled");
  });

  it("applies static X402_MIN_PRICE_USDC floor", () => {
    const out = computeEffectiveMins({
      priceAtomic: 1000n,
      minPriceUsdc: 5_000n,
      feeFreeBelowUsdc: 10_000_000n,
      dynamicMinEnabled: false,
      gasCostUsd: null,
      gasCostMaxFraction: 0.5,
      feeBps: 10,
    });
    assert.equal(out.effectiveMinPriceAtomic, 5_000n);
    assert.equal(out.reason, "min_floor");
    assert.equal(out.bumped, true);
  });

  it("bumps min accept when gas exceeds max fraction of payment", () => {
    // $0.001 payment, gas $0.001 → fraction 100% > 50% → min = 0.001/0.5 = $0.002
    const out = computeEffectiveMins({
      priceAtomic: 1000n,
      minPriceUsdc: 0n,
      feeFreeBelowUsdc: 10_000_000n,
      dynamicMinEnabled: true,
      gasCostUsd: 0.001,
      gasCostMaxFraction: 0.5,
      feeBps: 10,
    });
    assert.equal(out.effectiveMinPriceAtomic, usdToAtomicUsdc(0.002));
    assert.equal(out.reason, "gas");
    assert.equal(out.bumped, true);
  });

  it("raises feeFreeBelow so protocol fee can cover release gas", () => {
    // gas $0.05, fee 0.1% → coverage min = $50 = 50_000_000 atomic
    const out = computeEffectiveMins({
      priceAtomic: 1000n,
      minPriceUsdc: 0n,
      feeFreeBelowUsdc: 10_000_000n,
      dynamicMinEnabled: true,
      gasCostUsd: 0.05,
      gasCostMaxFraction: 0.5,
      feeBps: 10,
    });
    assert.ok(out.effectiveMinPriceAtomic > 1000n);
    assert.equal(out.effectiveFeeFreeBelowUsdc, usdToAtomicUsdc(0.05 / 0.001));
    assert.equal(out.reason, "gas");
  });

  it("does not bump when gas is a small fraction of payment", () => {
    // gas $0.0001 on $0.001 → 10% < 50%
    const out = computeEffectiveMins({
      priceAtomic: 1000n,
      minPriceUsdc: 0n,
      feeFreeBelowUsdc: 10_000_000n,
      dynamicMinEnabled: true,
      gasCostUsd: 0.0001,
      gasCostMaxFraction: 0.5,
      feeBps: 10,
    });
    assert.equal(out.effectiveMinPriceAtomic, 1000n);
    // feeFreeBelow may still rise for release coverage: 0.0001/0.001 = $0.1 < $10
    assert.equal(out.effectiveFeeFreeBelowUsdc, 10_000_000n);
    assert.equal(out.bumped, false);
  });
});

describe("gas-floor oracle cache", () => {
  it("clamps TTL to 15–60s", () => {
    assert.equal(clampTtl(1_000), 15_000);
    assert.equal(clampTtl(30_000), 30_000);
    assert.equal(clampTtl(120_000), 60_000);
  });

  it("caches baseFee and does not re-fetch within TTL", async () => {
    let calls = 0;
    let now = 1_000_000;
    const oracle = createBaseFeeOracle({
      rpcUrl: "http://127.0.0.1:9",
      ttlMs: 30_000,
      now: () => now,
      fetchBaseFee: async () => {
        calls += 1;
        return 50_000_000n;
      },
    });
    assert.equal(await oracle.getBaseFeeWei(), 50_000_000n);
    assert.equal(await oracle.getBaseFeeWei(), 50_000_000n);
    assert.equal(calls, 1);
    now += 31_000;
    assert.equal(await oracle.getBaseFeeWei(), 50_000_000n);
    assert.equal(calls, 2);
  });
});

describe("gas-floor config + health", () => {
  it("defaults dynamic min OFF and conservative ethUsd", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.dynamicMinEnabled, false);
    assert.equal(cfg.minPriceUsdc, 0n);
    assert.equal(cfg.gasCostMaxFraction, DEFAULT_GAS_COST_MAX_FRACTION);
    assert.equal(cfg.ethUsd, DEFAULT_ETH_USD);
    assert.equal(cfg.gasUsedEstimate, DEFAULT_GAS_USED_ESTIMATE);
    assert.equal(cfg.facilitatorUrl, undefined);
  });

  it("parses X402_MIN_PRICE_USDC, dynamic knobs, fee-free alias, facilitator URL", () => {
    const cfg = loadConfig({
      X402_MIN_PRICE_USDC: "2500",
      X402_DYNAMIC_MIN_ENABLED: "true",
      X402_GAS_COST_MAX_FRACTION: "0.25",
      X402_FEE_FREE_BELOW_USDC: "20000000",
      X402_ETH_USD: "3500",
      X402_GAS_USED_ESTIMATE: "80000",
      X402_GAS_ORACLE_TTL_MS: "45000",
      X402_FACILITATOR_URL: "https://facilitator.example.com/x402",
    });
    assert.equal(cfg.minPriceUsdc, 2500n);
    assert.equal(cfg.dynamicMinEnabled, true);
    assert.equal(cfg.gasCostMaxFraction, 0.25);
    assert.equal(cfg.feeFreeBelowUsdc, 20_000_000n);
    assert.equal(cfg.ethUsd, 3500);
    assert.equal(cfg.gasUsedEstimate, 80_000);
    assert.equal(cfg.gasOracleTtlMs, 45_000);
    assert.equal(cfg.facilitatorUrl, "https://facilitator.example.com/x402");
  });

  it("exposes effective mins on /health with mocked gas", async () => {
    const config = loadConfig({
      PRICE: "$0.001",
      X402_DYNAMIC_MIN_ENABLED: "true",
      X402_GAS_COST_MAX_FRACTION: "0.5",
      X402_ETH_USD: "4000",
      X402_GAS_USED_ESTIMATE: "100000",
      MERCHANTS_FILE: "/tmp/x402-no-merchants-for-gas-floor-test.json",
    });
    // ~1 gwei * 100k * $4000 ≈ $0.4 gas → min bump to $0.8
    const gasFloor = createGasFloorService(config, {
      fetchBaseFee: async () => 1_000_000_000n,
    });
    await gasFloor.refresh();
    const { app } = await createApp({
      config,
      gasFloor,
      paymentLayer: createDemoPaymentLayer(config, { gasFloor }),
      disableMcp: true,
    });
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.gasFloor.enabled, true);
    assert.equal(res.body.gasFloor.bumped, true);
    assert.equal(res.body.gasFloor.reason, "gas");
    assert.ok(Number(res.body.gasFloor.effectiveMinPriceAtomic) > 1000);
    assert.ok(res.body.gasFloor.estimatedGasCostUsd > 0);
  });

  it("demo 402 advertises bumped amount when gas floor is hot", async () => {
    const config = loadConfig({
      PRICE: "$0.001",
      X402_DYNAMIC_MIN_ENABLED: "true",
      X402_GAS_COST_MAX_FRACTION: "0.5",
      X402_ETH_USD: "4000",
      X402_GAS_USED_ESTIMATE: "100000",
    });
    const gasFloor = createGasFloorService(config, {
      fetchBaseFee: async () => 1_000_000_000n,
    });
    await gasFloor.refresh();
    const { app } = await createApp({
      config,
      gasFloor,
      paymentLayer: createDemoPaymentLayer(config, { gasFloor }),
      disableMcp: true,
    });
    const res = await request(app).get("/v1/quote").set("accept", "application/json");
    assert.equal(res.status, 402);
    const mins = gasFloor.getSnapshotSync();
    assert.equal(res.body.price, `${mins.effectiveMinPrice} USDC`);
    const header = res.headers["payment-required"];
    assert.ok(typeof header === "string" && header.length > 0);
  });
});
