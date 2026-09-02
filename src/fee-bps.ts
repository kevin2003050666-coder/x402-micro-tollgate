/**
 * FeeSplitter-compatible basis-point math (Solidity integer division).
 * fee = balance * feeBps / 10000; floors when balance * feeBps < 10000.
 */
export function feeAmountAtomic(balance: bigint, feeBps: number): bigint {
  if (feeBps < 0 || feeBps > 10_000) {
    throw new RangeError("feeBps must be in [0, 10000]");
  }
  if (balance < 0n) {
    throw new RangeError("balance must be non-negative");
  }
  return (balance * BigInt(feeBps)) / 10_000n;
}

export function sellerAmountAtomic(balance: bigint, feeBps: number): bigint {
  return balance - feeAmountAtomic(balance, feeBps);
}

/** Default operator take: 10 bps = 0.1%. */
export const DEFAULT_FEE_BPS = 10;
