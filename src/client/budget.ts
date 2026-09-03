/**
 * Buyer-side USDC spend budgets for createX402Fetch.
 *
 * Amounts in PAYMENT-REQUIRED accepts[] are atomic token units (USDC = 6 decimals
 * unless `extra.decimals` says otherwise).
 */

export const DEFAULT_MAX_SINGLE_SPEND_USDC = 0.05;
export const DEFAULT_MAX_TOTAL_SPEND_USDC = 1.0;

/** Default USDC / stablecoin decimals when the accept does not advertise one. */
export const DEFAULT_ASSET_DECIMALS = 6;

export type BudgetLimits = {
  maxSingleSpendUsdc: number;
  maxTotalSpendUsdc: number;
};

export type BudgetTracker = {
  /** Cumulative USDC spent (signed) on this fetch instance. */
  totalSpentUsdc: number;
  readonly limits: BudgetLimits;
};

export function createBudgetTracker(
  limits: Partial<BudgetLimits> = {},
): BudgetTracker {
  const maxSingleSpendUsdc =
    limits.maxSingleSpendUsdc ?? DEFAULT_MAX_SINGLE_SPEND_USDC;
  const maxTotalSpendUsdc =
    limits.maxTotalSpendUsdc ?? DEFAULT_MAX_TOTAL_SPEND_USDC;
  if (!(maxSingleSpendUsdc > 0) || !Number.isFinite(maxSingleSpendUsdc)) {
    throw new Error("maxSingleSpendUsdc must be a finite number > 0");
  }
  if (!(maxTotalSpendUsdc > 0) || !Number.isFinite(maxTotalSpendUsdc)) {
    throw new Error("maxTotalSpendUsdc must be a finite number > 0");
  }
  if (maxSingleSpendUsdc > maxTotalSpendUsdc) {
    throw new Error(
      `maxSingleSpendUsdc (${maxSingleSpendUsdc}) cannot exceed maxTotalSpendUsdc (${maxTotalSpendUsdc})`,
    );
  }
  return {
    totalSpentUsdc: 0,
    limits: { maxSingleSpendUsdc, maxTotalSpendUsdc },
  };
}

/** Read asset decimals from accept.extra, falling back to USDC 6. */
export function decimalsFromAccept(extra: Record<string, unknown> | undefined): number {
  const raw = extra?.decimals;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 36) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 0 && n <= 36) return n;
  }
  return DEFAULT_ASSET_DECIMALS;
}

/** Atomic token units → USDC (or token) decimal number. */
export function atomicToUsdc(amountAtomic: string | bigint, decimals = DEFAULT_ASSET_DECIMALS): number {
  const atomic = typeof amountAtomic === "bigint" ? amountAtomic : BigInt(amountAtomic);
  if (atomic < 0n) {
    throw new Error(`negative payment amount: ${amountAtomic}`);
  }
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const frac = atomic % scale;
  const fracStr = frac.toString().padStart(decimals, "0");
  return Number(`${whole}.${fracStr}`);
}

export function usdcFromAccept(accept: {
  amount?: string;
  extra?: Record<string, unknown>;
}): number {
  if (accept.amount === undefined || accept.amount === "") {
    throw new Error("payment accept missing amount");
  }
  return atomicToUsdc(accept.amount, decimalsFromAccept(accept.extra));
}

/**
 * Enforce single + total budgets before signing.
 * @throws Error with a clear budget message when exceeded
 */
export function assertWithinBudget(amountUsdc: number, tracker: BudgetTracker): void {
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) {
    throw new Error(`invalid payment amount USDC: ${amountUsdc}`);
  }
  const { maxSingleSpendUsdc, maxTotalSpendUsdc } = tracker.limits;
  if (amountUsdc > maxSingleSpendUsdc) {
    throw new Error(
      `x402 budget exceeded: single payment ${formatUsdc(amountUsdc)} USDC > maxSingleSpendUsdc (${formatUsdc(maxSingleSpendUsdc)})`,
    );
  }
  const nextTotal = tracker.totalSpentUsdc + amountUsdc;
  if (nextTotal > maxTotalSpendUsdc) {
    throw new Error(
      `x402 budget exceeded: total spend would be ${formatUsdc(nextTotal)} USDC > maxTotalSpendUsdc (${formatUsdc(maxTotalSpendUsdc)}) (already spent ${formatUsdc(tracker.totalSpentUsdc)})`,
    );
  }
}

export function recordSpend(tracker: BudgetTracker, amountUsdc: number): void {
  assertWithinBudget(amountUsdc, tracker);
  tracker.totalSpentUsdc += amountUsdc;
}

function formatUsdc(n: number): string {
  // Trim noisy float tails for error messages (budgets are small).
  return Number(n.toFixed(6)).toString();
}
