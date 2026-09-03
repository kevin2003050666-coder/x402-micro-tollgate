/**
 * Buyer / agent client entry (`x402-micro-tollgate/client`).
 *
 * Thin wrapper around official `@x402/fetch` + `@x402/evm` ExactEvmScheme.
 */

export {
  createX402Fetch,
  createBudgetSelector,
  MAX_AUTOMATIC_PAYMENT_RETRIES,
  type CreateX402FetchOptions,
  type X402Fetch,
  type X402BuyerAccount,
} from "./create-x402-fetch.js";

export {
  createBudgetTracker,
  assertWithinBudget,
  recordSpend,
  atomicToUsdc,
  usdcFromAccept,
  decimalsFromAccept,
  DEFAULT_MAX_SINGLE_SPEND_USDC,
  DEFAULT_MAX_TOTAL_SPEND_USDC,
  DEFAULT_ASSET_DECIMALS,
  type BudgetLimits,
  type BudgetTracker,
} from "./budget.js";
