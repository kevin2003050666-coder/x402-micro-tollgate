/**
 * Library entry for permissionless seller + gateway helpers.
 * CLI remains `dist/cli.js` (npm bin).
 */
export { x402Tollgate, loadSellerConfig, type X402TollgateOptions } from "./x402-tollgate.js";
export {
  resolvePayTo,
  predictFeeSplitterAddress,
  feeSplitterSalt,
  DEFAULT_FEE_FREE_BELOW_USDC,
  type ResolvePayToParams,
  type PredictFeeSplitterParams,
} from "./resolve-pay-to.js";
export { assertValidSeller, assertValidAddress, tryParseAddress } from "./address.js";
export { loadConfig, type TollgateConfig } from "./config.js";
export { createApp, type AppOptions, type CreatedApp } from "./app.js";
export {
  createPaymentLayer,
  createDemoPaymentLayer,
  createLivePaymentLayer,
  type PaymentLayer,
} from "./payment.js";
export {
  OPERATOR_FEE_COLLECTOR,
  loadMerchantsRegistry,
  type MerchantEntry,
  type MerchantRegistry,
} from "./merchants.js";
export {
  buildDiscoverDocument,
  resolveDiscoverStatus,
  DISCOVER_PATH,
  DISCOVER_ALIAS_PATH,
  DISCOVER_VERSION,
  type DiscoverDocument,
  type DiscoverService,
  type DiscoverServiceStatus,
} from "./discover.js";
export {
  buildX402WellKnownDocument,
  buildAgentCardDocument,
  WELL_KNOWN_X402_PATH,
  WELL_KNOWN_X402_ALIAS_PATH,
  WELL_KNOWN_AGENT_CARD_PATH,
  WELL_KNOWN_AGENT_ALIAS_PATH,
  type X402WellKnownDocument,
  type AgentCardDocument,
} from "./well-known.js";
export { PACKAGE_VERSION } from "./version.js";
export { FEE_SPLITTER_CREATION_BYTECODE } from "./fee-splitter-bytecode.js";
export {
  SignatureDedupeCache,
  MemoryPaymentDedupeStore,
  KeyMutex,
  withPaymentSignatureDedupe,
  paymentIdempotencyKey,
  type PaymentDedupeStore,
  type PaymentDedupeRecord,
  type PaymentDedupeStatus,
} from "./payment-dedupe.js";
export {
  buildUpstreamTrustHeaders,
  verifyUpstreamTrustHeaders,
  TOLLGATE_SECRET_HEADER,
  TOLLGATE_PAID_HEADER,
} from "./upstream-trust.js";
export {
  createTollgatePaywall,
  buildPaywallConfig,
  isBrowserPaymentRequest,
  patchPaywallConnectors,
  injectBuyerExtras,
  acceptPickerHtml,
  SESSION_TOKEN_PATH,
  type TollgatePaywallConfig,
} from "./paywall.js";
export { createSessionTokenHandler, resolveClientIp } from "./session-token.js";
export {
  NETWORK_CATALOG,
  parseAcceptSpecs,
  parseNetworksList,
  fullNetworkMatrixPublic,
  normalizeNetworkId,
  type AcceptSpec,
} from "./networks.js";
export {
  isBlockedIp,
  assertSafePublicHttpUrl,
  assertSafePublicHttpUrlPinned,
} from "./ssrf.js";
export {
  createGasFloorService,
  computeEffectiveMins,
  estimateGasCostUsd,
  dollarPriceToAtomic,
  atomicUsdcToDollarPrice,
  type GasFloorService,
  type GasFloorSnapshot,
} from "./gas-floor.js";
