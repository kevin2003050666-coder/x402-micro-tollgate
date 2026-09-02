import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FEE_BPS,
  feeAmountAtomic,
  sellerAmountAtomic,
} from "../src/fee-bps.js";

describe("fee-bps (FeeSplitter math)", () => {
  it("defaults to 10 bps (0.1%)", () => {
    assert.equal(DEFAULT_FEE_BPS, 10);
  });

  it("$0.001 USDC (1000 atomic) at 10 bps yields 1 atomic fee", () => {
    const balance = 1000n;
    const fee = feeAmountAtomic(balance, 10);
    assert.equal(fee, 1n);
    assert.equal(sellerAmountAtomic(balance, 10), 999n);
  });

  it("floors to 0 when balance * feeBps < 10000", () => {
    // 999 * 10 = 9990 < 10000 → fee 0
    assert.equal(feeAmountAtomic(999n, 10), 0n);
    assert.equal(sellerAmountAtomic(999n, 10), 999n);
  });

  it("splits larger balances at 10 bps", () => {
    const balance = 1_000_000n; // $1 USDC → 0.1% = 1000 atomic
    assert.equal(feeAmountAtomic(balance, 10), 1000n);
    assert.equal(sellerAmountAtomic(balance, 10), 999_000n);
  });

  it("rejects out-of-range feeBps", () => {
    assert.throws(() => feeAmountAtomic(1000n, -1), RangeError);
    assert.throws(() => feeAmountAtomic(1000n, 10_001), RangeError);
  });
});
