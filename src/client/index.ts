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

export {
  createCircuitBreaker,
  assertCircuitAllowsPayment,
  recordCircuitPayment,
  pruneCircuitBreaker,
  fingerprintRequest,
  sanitizeBodyForFingerprint,
  stripDynamicKeys,
  resolveRequestParts,
  bodyInitToString,
  CIRCUIT_BREAKER_WINDOW_MS,
  DEFAULT_MAX_PAID_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_SPEND_USDC_PER_MINUTE,
  FINGERPRINT_BODY_MAX_CHARS,
  type CircuitBreaker,
  type CircuitBreakerLimits,
  type CircuitBreakerConfig,
  type CircuitBreakerEvent,
} from "./circuit-breaker.js";
