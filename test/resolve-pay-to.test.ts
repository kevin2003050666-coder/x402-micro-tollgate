import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import {
  resolvePayTo,
  predictFeeSplitterAddress,
  feeSplitterSalt,
  DEFAULT_FEE_FREE_BELOW_USDC,
} from "../src/resolve-pay-to.js";
import { assertValidSeller } from "../src/address.js";
import { OPERATOR_FEE_COLLECTOR } from "../src/merchants.js";

const SELLER = getAddress("0x1234567890123456789012345678901234567890");
const FACTORY = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const ASSET = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");

describe("assertValidSeller", () => {
  it("accepts lowercase and checksummed addresses", () => {
    assert.equal(assertValidSeller(SELLER.toLowerCase()), SELLER);
    assert.equal(assertValidSeller(SELLER), SELLER);
  });

  it("rejects empty, short, and bad-checksum mixed-case", () => {
    assert.throws(() => assertValidSeller(""), /seller/);
    assert.throws(() => assertValidSeller("0x123"), /seller/);
    assert.throws(
      () => assertValidSeller("0xA922F38041B5EE227C96A547F106F1330447E30E"),
      /checksum/,
    );
  });
});

describe("resolvePayTo threshold", () => {
  it("amount < $10 (10_000_000) → payTo = seller", () => {
    assert.equal(DEFAULT_FEE_FREE_BELOW_USDC, 10_000_000n);
    const payTo = resolvePayTo({
      amountAtomic: 9_999_999n,
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET,
      factoryAddress: FACTORY,
    });
    assert.equal(payTo, SELLER);
  });

  it("amount ≥ $10 → payTo = predicted CREATE2 FeeSplitter", () => {
    const predicted = predictFeeSplitterAddress({
      factoryAddress: FACTORY,
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET,
      feeBps: 10,
    });
    const atThreshold = resolvePayTo({
      amountAtomic: 10_000_000n,
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET,
      factoryAddress: FACTORY,
    });
    assert.equal(atThreshold, predicted);
    assert.notEqual(atThreshold, SELLER);

    const above = resolvePayTo({
      amountAtomic: "10000001",
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET,
      factoryAddress: FACTORY,
    });
    assert.equal(above, predicted);
  });

  it("≥ threshold without FACTORY_ADDRESS throws", () => {
    assert.throws(
      () =>
        resolvePayTo({
          amountAtomic: 10_000_000n,
          seller: SELLER,
          feeCollector: OPERATOR_FEE_COLLECTOR,
          asset: ASSET,
        }),
      /FACTORY_ADDRESS/,
    );
  });

  it("predictAddress is stable and salt matches factory formula", () => {
    const a = predictFeeSplitterAddress({
      factoryAddress: FACTORY,
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET,
    });
    const b = predictFeeSplitterAddress({
      factoryAddress: FACTORY,
      seller: SELLER,
      feeCollector: OPERATOR_FEE_COLLECTOR,
      asset: ASSET,
    });
    assert.equal(a, b);
    assert.match(a, /^0x[a-fA-F0-9]{40}$/);
    assert.equal(feeSplitterSalt(SELLER).length, 66); // 0x + 64 hex
  });
});
